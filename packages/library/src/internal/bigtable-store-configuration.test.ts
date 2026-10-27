import { renderConfigurationJson } from "./bigtable-configuration-json";
import {
  initializeBigtableStoreRows,
  verifyBigtableStore,
} from "./bigtable-store-configuration";
import { fakeBigtable, rowResponse } from "./test/bigtable-fake-client";

const settings = {
  tables: { journal: "j", head: "h" },
  retentionCount: undefined as number | undefined,
  envelopeLimitBytes: 1048576,
};
const STORE_ID = "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11";
const record = (over: Record<string, unknown> = {}) => ({
  storeId: STORE_ID,
  layoutVersion: 1,
  keepSnapshotCount: null as number | null,
  retentionMode: "delete",
  envelopeLimitBytes: 1048576,
  ...over,
});
const configRow = (over: Record<string, unknown> = {}) =>
  rowResponse(Buffer.from([0]), [
    ["config", "metadata", renderConfigurationJson(record(over))],
  ]);
const ONE_VERSION = { rule: "maxNumVersions", maxNumVersions: 1 };
const families = (names: readonly string[], gcRule: unknown = ONE_VERSION) =>
  Object.fromEntries(
    names.map((name) => [name, { gcRule: name === "config" ? null : gcRule }]),
  );
const JOURNAL = ["event", "history", "config"];
const HEAD = ["head", "snapshot", "config"];

type Plan = {
  schemas?: (Record<string, unknown> | undefined)[];
  reads?: object[][];
  matched?: boolean[];
};
const clientOf = (plan: Plan) => {
  let read = 0;
  let schema = 0;
  let mutate = 0;
  return fakeBigtable({
    unary: (config) => {
      if (config.method === "getTable") {
        const columnFamilies = plan.schemas?.[schema++];
        return columnFamilies === undefined
          ? { error: Object.assign(new Error("nf"), { code: 5 }) }
          : { response: { columnFamilies } };
      }
      return {
        response: { predicateMatched: plan.matched?.[mutate++] ?? false },
      };
    },
    stream: () => plan.reads?.[read++] ?? [],
  });
};
const verify = (plan: Plan, over: Partial<typeof settings> = {}) =>
  verifyBigtableStore(
    { bigtable: clientOf(plan), instanceId: "inst" },
    { ...settings, ...over },
  );
const good = {
  schemas: [families(JOURNAL), families(HEAD)],
  reads: [[configRow()], [configRow()]],
};

describe("verifyBigtableStore", () => {
  test("accepts tables whose families and configuration rows match", async () => {
    await expect(verify(good)).resolves.toBeUndefined();
  });

  test("accepts a recorded retention count that equals the client's", async () => {
    await expect(
      verify(
        {
          ...good,
          reads: [
            [configRow({ keepSnapshotCount: 2 })],
            [configRow({ keepSnapshotCount: 2 })],
          ],
        },
        { retentionCount: 2 },
      ),
    ).resolves.toBeUndefined();
  });

  test.each([
    ["a missing table", { ...good, schemas: [undefined, families(HEAD)] }],
    [
      "a missing column family",
      { ...good, schemas: [families(["event", "config"]), families(HEAD)] },
    ],
    [
      "a family without a garbage collection rule",
      { ...good, schemas: [families(JOURNAL, null), families(HEAD)] },
    ],
    [
      "an age-based rule",
      {
        ...good,
        schemas: [
          families(JOURNAL, { rule: "maxAge", maxAge: { seconds: 5 } }),
          families(HEAD),
        ],
      },
    ],
    [
      "a rule that keeps two versions",
      {
        ...good,
        schemas: [
          families(JOURNAL, { rule: "maxNumVersions", maxNumVersions: 2 }),
          families(HEAD),
        ],
      },
    ],
    [
      "a missing configuration row on the journal table",
      { ...good, reads: [[], [configRow()]] },
    ],
    [
      "a missing configuration row on the head table",
      { ...good, reads: [[configRow()], []] },
    ],
    [
      "different configurations in the two tables",
      {
        ...good,
        reads: [
          [configRow()],
          [configRow({ storeId: "6f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11" })],
        ],
      },
    ],
    [
      "layout version 2",
      {
        ...good,
        reads: [
          [configRow({ layoutVersion: 2 })],
          [configRow({ layoutVersion: 2 })],
        ],
      },
    ],
    [
      "retention mode ttl",
      {
        ...good,
        reads: [
          [configRow({ retentionMode: "ttl" })],
          [configRow({ retentionMode: "ttl" })],
        ],
      },
    ],
    [
      "a store_id that is not a lower-case UUID",
      {
        ...good,
        reads: [
          [configRow({ storeId: STORE_ID.toUpperCase() })],
          [configRow({ storeId: STORE_ID.toUpperCase() })],
        ],
      },
    ],
    [
      "a different keep_snapshot_count",
      {
        ...good,
        reads: [
          [configRow({ keepSnapshotCount: 2 })],
          [configRow({ keepSnapshotCount: 2 })],
        ],
      },
    ],
    [
      "a different envelope limit",
      {
        ...good,
        reads: [
          [configRow({ envelopeLimitBytes: 2097152 })],
          [configRow({ envelopeLimitBytes: 2097152 })],
        ],
      },
    ],
  ])("rejects %s as a configuration error", async (_name, plan) => {
    await expect(verify(plan as Plan)).rejects.toMatchObject({
      type: "configuration-error",
    });
  });
});

describe("initializeBigtableStoreRows", () => {
  const initialize = (plan: Plan) => {
    const bigtable = clientOf(plan);
    return {
      bigtable,
      done: initializeBigtableStoreRows(
        { bigtable, instanceId: "inst" },
        settings,
      ),
    };
  };
  const empty = {
    schemas: [families(JOURNAL), families(HEAD)],
    reads: [[], []],
  };

  test("writes the same configuration to both tables when neither has one", async () => {
    const { bigtable, done } = initialize(empty);
    await done;
    const writes = bigtable.calls.filter(
      (c) => c.method === "checkAndMutateRow",
    );
    expect(writes).toHaveLength(2);
    const json = (call: (typeof writes)[number]) =>
      JSON.parse(
        Buffer.from(
          (call.reqOpts.falseMutations as { setCell: { value: Buffer } }[])[0]
            .setCell.value,
        ).toString(),
      );
    expect(json(writes[0])).toEqual(json(writes[1]));
    expect(json(writes[0])).toMatchObject({
      layout_version: 1,
      keep_snapshot_count: null,
    });
  });

  test.each([
    [
      "the journal table already has a configuration",
      { ...empty, reads: [[configRow()], []] },
    ],
    [
      "the head table already has a configuration",
      { ...empty, reads: [[], [configRow()]] },
    ],
    [
      "a configuration that appears before the conditional write",
      { ...empty, matched: [true] },
    ],
  ])("refuses to initialize when %s", async (_name, plan) => {
    const { bigtable, done } = initialize(plan as Plan);
    await expect(done).rejects.toMatchObject({ type: "configuration-error" });
    if (!("matched" in plan))
      expect(
        bigtable.calls.filter((c) => c.method === "checkAndMutateRow"),
      ).toHaveLength(0);
  });
});
