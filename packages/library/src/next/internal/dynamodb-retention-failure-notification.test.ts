import type { Logger } from "../../logger";
import type { RetentionFailure } from "../retention-failure";
import { notifyDynamoDBRetentionFailure } from "./dynamodb-retention-failure-notification";

test("logs a retention failure and sends the same failure to the additional callback", async () => {
  const cause = new Error("delete failed");
  const error = jest.fn();
  const callback = jest.fn();
  const logger: Logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error,
  };
  await notifyDynamoDBRetentionFailure("Order-1", cause, logger, callback);
  expect(error).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledTimes(1);
  const failure = error.mock.calls[0][0] as RetentionFailure;
  expect(failure).toEqual({
    kind: "retention-failure",
    aggregateId: "Order-1",
    cause,
  });
  expect(callback).toHaveBeenCalledWith(failure);
});

test("uses console when the logger and callback are omitted", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      notifyDynamoDBRetentionFailure("Order-1", "failure"),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith({
      kind: "retention-failure",
      aggregateId: "Order-1",
      cause: "failure",
    });
  } finally {
    log.mockRestore();
  }
});

test.each(["throw", "reject"])(
  "continues to the callback after logger %s and protects callback failure",
  async (mode) => {
    const loggingCause = new Error("logging failed");
    const callbackCause = new Error("callback failed");
    const error = jest.fn(() => {
      if (mode === "throw") throw loggingCause;
      return Promise.reject(loggingCause);
    });
    const callback = jest.fn(() => {
      if (mode === "throw") throw callbackCause;
      return Promise.reject(callbackCause);
    });
    const fallback = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        notifyDynamoDBRetentionFailure(
          "Order-1",
          "retention failed",
          {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error,
          },
          callback,
        ),
      ).resolves.toBeUndefined();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "retention failure notification failed",
        loggingCause,
      );
      expect(error).toHaveBeenCalledWith(
        "retention failure notification failed",
        callbackCause,
      );
      expect(fallback).toHaveBeenCalledTimes(2);
    } finally {
      fallback.mockRestore();
    }
  },
);

test("records callback rejection with the logger and protects failure of every notification path", async () => {
  const cause = new Error("callback failed");
  const error = jest.fn();
  await notifyDynamoDBRetentionFailure(
    "Order-1",
    "retention failed",
    {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error,
    },
    async () => {
      throw cause;
    },
  );
  expect(error).toHaveBeenLastCalledWith(
    "retention failure notification failed",
    cause,
  );
  const unavailable = jest.spyOn(console, "error").mockImplementation(() => {
    throw new Error("console failed");
  });
  try {
    await expect(
      notifyDynamoDBRetentionFailure(
        "Order-1",
        "retention failed",
        undefined,
        () => {
          throw cause;
        },
      ),
    ).resolves.toBeUndefined();
  } finally {
    unavailable.mockRestore();
  }
});
