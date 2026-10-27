import { notifyJournalWriteFailure } from "./bigtable-journal-write-failure-notification";

test("sends one frozen failure to the logger and to the callback", async () => {
  const cause = new Error("tail failed");
  const error = jest.fn();
  const callback = jest.fn();
  await notifyJournalWriteFailure(
    "Order-1",
    2,
    cause,
    { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error },
    callback,
  );
  const failure = error.mock.calls[0][0];
  expect(failure).toEqual({
    kind: "journal-write-failure",
    aggregateId: "Order-1",
    seqNr: 2,
    cause,
  });
  expect(Object.isFrozen(failure)).toBe(true);
  expect(callback).toHaveBeenCalledWith(failure);
});

test("uses the console when no logger is given, and needs no callback", async () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await notifyJournalWriteFailure("Order-1", 2, new Error("x"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      kind: "journal-write-failure",
    });
  } finally {
    spy.mockRestore();
  }
});
