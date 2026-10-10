import { withCaseStore } from "./conformance-case-store-scope";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceStoreBinding } from "./conformance-store-binding";

const creation = {
  config: { retentionCount: null, retentionMode: "delete" as const },
  seedItems: [],
  faults: [],
};

const bindingReturning = (
  created: ConformanceCreatedStore<unknown, unknown>,
): ConformanceStoreBinding<unknown, unknown> => ({
  backend: "memory",
  createStore: jest.fn().mockResolvedValue(created),
  buildAggregateId: jest.fn(),
  buildEvent: jest.fn(),
  buildSnapshot: jest.fn(),
  validateSeqNrValue: jest.fn(),
});

test.each([false, true])("disposes after creation error=%s", async (error) => {
  const dispose = jest.fn().mockResolvedValue(undefined);
  const created: ConformanceCreatedStore<unknown, unknown> = {
    outcome: error
      ? { kind: "error", category: "storage", message: "creation" }
      : { kind: "ok", value: {} as never },
    hooks: { evidence: () => "observed" },
    dispose,
  };
  const result = await withCaseStore(
    bindingReturning(created),
    creation,
    async (session) => {
      expect(session.hooks.evidence?.()).toBe("observed");
      return session.outcome.kind;
    },
  );
  expect(result).toBe(error ? "error" : "ok");
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("disposes once before rethrowing a body failure", async () => {
  const dispose = jest.fn().mockResolvedValue(undefined);
  await expect(
    withCaseStore(
      bindingReturning({
        outcome: { kind: "ok", value: {} as never },
        hooks: {},
        dispose,
      }),
      creation,
      async () => {
        throw new Error("body failed");
      },
    ),
  ).rejects.toThrow("body failed");
  expect(dispose).toHaveBeenCalledTimes(1);
});
