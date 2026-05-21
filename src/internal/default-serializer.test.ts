import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./default-serializer";
import type { UserAccount } from "./test/user-account";
import type { UserAccountEvent } from "./test/user-account-event";
import type { UserAccountId } from "./test/user-account-id";

const encoder = new TextEncoder();

describe("default serializers", () => {
  test("wraps event converter errors with converter context", () => {
    const serializer = new JsonEventSerializer<
      UserAccountId,
      UserAccountEvent
    >();
    const bytes = encoder.encode("{}");

    expect(() =>
      serializer.deserialize(bytes, () => {
        throw new Error("invalid event payload");
      }),
    ).toThrow("eventConverter failed: invalid event payload");
  });

  test("wraps snapshot converter errors with converter context", () => {
    const serializer = new JsonSnapshotSerializer<UserAccountId, UserAccount>();
    const bytes = encoder.encode("{}");

    expect(() =>
      serializer.deserialize(bytes, () => {
        throw new Error("invalid snapshot payload");
      }),
    ).toThrow("snapshotConverter failed: invalid snapshot payload");
  });
});
