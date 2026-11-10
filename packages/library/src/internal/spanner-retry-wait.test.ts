import { Root } from "protobufjs/light";
import { retryInfoSchema } from "./spanner-retry-info-schema";
import {
  decideRetryWait,
  durationWait,
  retryClock,
  waitForRetry,
} from "./spanner-retry-wait";

const info = Root.fromJSON(retryInfoSchema).lookupType("google.rpc.RetryInfo");
const hint = (retryDelay?: object) =>
  Buffer.from(info.encode(info.fromObject({ retryDelay })).finish());
const cause = (...entries: unknown[]) => ({
  code: 10,
  metadata: { get: () => entries },
});

test.each([
  [{}, 1],
  [{ nanos: 1 }, 1],
  [{ nanos: 999999 }, 1],
  [{ nanos: 1000000 }, 1],
  [{ nanos: 1000001 }, 2],
  [{ seconds: 1, nanos: 1 }, 1001],
  [{ seconds: 60 }, 60000],
])("rounds a present duration %p upward to %i", (duration, milliseconds) => {
  expect(
    decideRetryWait(cause(hint(duration)), 1, () => {
      throw Error("random");
    }),
  ).toEqual({ kind: "server", milliseconds });
});

test.each([
  { seconds: 60, nanos: 1 },
  { seconds: "315576000000", nanos: 999999999 },
  { seconds: "9007199254740991" },
])(
  "stops long valid durations and falls back for out-of-range %p",
  (duration) => {
    const expected =
      duration.seconds === "9007199254740991"
        ? { kind: "fallback", milliseconds: 25 }
        : { kind: "stop" };
    expect(decideRetryWait(cause(hint(duration)), 1, () => 0)).toEqual(
      expected,
    );
  },
);

test.each([
  { seconds: -1 },
  { seconds: 315576000001 },
  { nanos: -1 },
  { nanos: 1000000000 },
  { seconds: 1, nanos: -1 },
  { seconds: NaN },
  { seconds: Infinity },
  { seconds: 0.1 },
  { seconds: Number.MAX_SAFE_INTEGER + 1 },
  { seconds: "01" },
  { seconds: "1.0" },
  { seconds: {} },
  { seconds: null },
  { nanos: "1" },
  { nanos: undefined },
])("rejects invalid structured duration %p", (duration) =>
  expect(durationWait(duration)).toBeUndefined(),
);

test.each([undefined, null, "bad", 1])(
  "rejects missing or wrong duration %p",
  (duration) => expect(durationWait(duration)).toBeUndefined(),
);

test("skips malformed, missing and invalid entries, accepts unknown fields and first valid only", () => {
  const unknownField = Buffer.from([0x98, 0x06, 0x01]);
  expect(
    decideRetryWait(
      cause(
        "bad",
        Buffer.from([10, 255]),
        hint(),
        hint({ nanos: -1 }),
        Buffer.concat([hint({ nanos: 1000001 }), unknownField]),
        hint({ seconds: 61 }),
      ),
      1,
      () => 0,
    ),
  ).toEqual({ kind: "server", milliseconds: 2 });
  expect(
    decideRetryWait(cause(hint({ seconds: 61 }), hint({})), 1, () => 0),
  ).toEqual({ kind: "stop" });
});

test("metadata absence and access errors fall back", () => {
  for (const error of [
    null,
    {},
    { metadata: null },
    {
      metadata: {
        get: () => {
          throw Error();
        },
      },
    },
    { metadata: { get: () => null } },
    cause(hint()),
  ]) {
    expect(decideRetryWait(error, 1, () => 0)).toEqual({
      kind: "fallback",
      milliseconds: 25,
    });
  }
});

test.each([1, 2, 3, 4, 5, 6, Number.MAX_SAFE_INTEGER])(
  "equal jitter endpoints for retry %i",
  (ordinal) => {
    const cap = [50, 100, 200, 400, 800][ordinal - 1] ?? 1000;
    expect(decideRetryWait({}, ordinal, () => 0)).toEqual({
      kind: "fallback",
      milliseconds: cap / 2,
    });
    expect(decideRetryWait({}, ordinal, () => 1 - Number.EPSILON)).toEqual({
      kind: "fallback",
      milliseconds: cap,
    });
  },
);

test("re-reserves the positive rounded monotonic remainder after early wake", async () => {
  let now = 0;
  const sleep = jest.fn(async () => {
    now += sleep.mock.calls.length === 1 ? 0.25 : 1.75;
  });
  await waitForRetry(2, { now: () => now, random: () => 0, sleep });
  expect(sleep.mock.calls).toEqual([[2], [2]]);
});

test("the production sleeper retains its timer reference", async () => {
  const original = global.setTimeout;
  let referenced = false;
  const timer = jest
    .spyOn(global, "setTimeout")
    .mockImplementation((callback, ms) => {
      const handle = original(callback, ms);
      referenced = handle.hasRef();
      return handle;
    });
  try {
    await retryClock.sleep(1);
    expect(referenced).toBe(true);
  } finally {
    timer.mockRestore();
  }
});

test.each(["0a020d3d", "0a02153d", "0a01083d", "083d", "0a002a03ff"])(
  "ignores malformed wire %s before valid metadata or fallback",
  (hex) => {
    const malformed = Buffer.from(hex, "hex");
    expect(
      decideRetryWait(cause(malformed, hint({ nanos: 1000001 })), 1, () => 0),
    ).toEqual({ kind: "server", milliseconds: 2 });
    expect(decideRetryWait(cause(malformed), 1, () => 0)).toEqual({
      kind: "fallback",
      milliseconds: 25,
    });
  },
);

test.each([
  "1801",
  "190000000000000000",
  "1a02ffff",
  "1b08011c",
  "1b230801241c",
  "1d00000000",
])("preserves legal unknown fields %s in both messages", (hex) => {
  const unknown = Buffer.from(hex, "hex");
  const duration = Buffer.concat([Buffer.from([0x10, 1]), unknown]);
  const encoded = Buffer.concat([
    Buffer.from([0x0a, duration.length]),
    duration,
  ]);
  for (const entry of [Buffer.concat([hint({ nanos: 1 }), unknown]), encoded]) {
    expect(
      decideRetryWait(cause(entry), 1, () => {
        throw Error("random");
      }),
    ).toEqual({ kind: "server", milliseconds: 1 });
  }
});

test.each([
  "0a001b24",
  "0a05ff",
  "0a001b",
  "0a001c",
  "0a001900",
  "0a001a02ff",
  "0a001d00",
  "0a0018ffffffffffffffffff02",
  "0a000000",
  "0a001affffffff1000",
])("skips an invalid unknown field boundary in %s", (hex) => {
  expect(
    decideRetryWait(
      cause(Buffer.from(hex, "hex"), hint({ nanos: 1000001 })),
      1,
      () => 0,
    ),
  ).toEqual({ kind: "server", milliseconds: 2 });
});
