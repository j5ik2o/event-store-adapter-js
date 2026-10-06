import { withCaseStore } from "./conformance-case-store-scope";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

const creation = {
  config: { retentionCount: null, retentionMode: "delete" as const },
  seedItems: [],
  faults: [],
};

const bindingReturning = (
  created: ConformanceOutcome<ConformanceCreatedStore<unknown, unknown>>,
): ConformanceStoreBinding<unknown, unknown> => ({
  backend: "memory",
  createStore: jest.fn().mockResolvedValue(created),
  buildAggregateId: jest.fn(),
  buildEvent: jest.fn(),
  buildSnapshot: jest.fn(),
});

const okStore = () => {
  const dispose = jest.fn().mockResolvedValue(undefined);
  return {
    dispose,
    outcome: {
      kind: "ok" as const,
      value: { store: {} as never, hooks: {}, dispose },
    },
  };
};

describe("withCaseStore", () => {
  test("disposes once after a successful body", async () => {
    const { dispose, outcome } = okStore();
    const result = await withCaseStore(
      bindingReturning(outcome),
      creation,
      async () => 42,
    );
    expect(result).toBe(42);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("disposes once and rethrows when the body throws", async () => {
    const { dispose, outcome } = okStore();
    await expect(
      withCaseStore(bindingReturning(outcome), creation, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("does not dispose when creation returned an error", async () => {
    const error = {
      kind: "error" as const,
      category: "storage" as const,
      message: "x",
    };
    const result = await withCaseStore(
      bindingReturning(error),
      creation,
      async (c) => c.kind,
    );
    expect(result).toBe("error");
  });
});
