import {
  createJsonEventSerializer,
  createJsonSnapshotSerializer,
} from "../default-serializer";
import { convertJSONToUserAccount, UserAccount } from "./user-account";
import { UserAccountCreated } from "./user-account-created";
import {
  convertJSONtoUserAccountEvent,
  UserAccountEvent,
} from "./user-account-event";
import { UserAccountId } from "./user-account-id";

describe("UserAccount JSON brand restoration", () => {
  test("restores aggregate id brand from JSON", () => {
    const id = UserAccountId.create("user-1");
    const parsed = JSON.parse(JSON.stringify(id));

    expect(UserAccountId.is(id)).toBe(true);
    expect(UserAccountId.is(parsed)).toBe(false);

    const restored = UserAccountId.fromJSON(parsed);

    expect(UserAccountId.is(restored)).toBe(true);
    expect(restored.asString()).toBe(id.asString());
  });

  test("restores event brand from direct JSON round-trip", () => {
    const created = createUserAccountCreated();
    const parsed = JSON.parse(JSON.stringify(created));

    expect(UserAccountCreated.is(created)).toBe(true);
    expect(UserAccountCreated.is(parsed)).toBe(false);

    const restored = UserAccountCreated.fromJSON(parsed);

    expect(UserAccountCreated.is(restored)).toBe(true);
    expect(restored.occurredAt.toISOString()).toBe(
      created.occurredAt.toISOString(),
    );
  });

  test("restores aggregate brand from direct JSON round-trip", () => {
    const id = UserAccountId.create("user-1");
    const [account] = UserAccount.create(id, "Alice");
    const parsed = JSON.parse(JSON.stringify(account));

    expect(UserAccount.is(account)).toBe(true);
    expect(UserAccount.is(parsed)).toBe(false);

    const restored = UserAccount.fromJSON(parsed);

    expect(UserAccount.is(restored)).toBe(true);
    expect(UserAccountId.is(restored.id)).toBe(true);
    expect(restored.name).toBe("Alice");
  });

  test("default serializers restore branded values through converters", () => {
    const id = UserAccountId.create("user-1");
    const [account, created] = UserAccount.create(id, "Alice");
    const eventSerializer = createJsonEventSerializer();
    const snapshotSerializer = createJsonSnapshotSerializer();

    const restoredEvent = eventSerializer.deserialize(
      eventSerializer.serialize(created),
      convertJSONtoUserAccountEvent,
    );
    const restoredSnapshot = snapshotSerializer.deserialize(
      snapshotSerializer.serialize(account),
      convertJSONToUserAccount,
    );

    expect(UserAccountEvent.is(restoredEvent)).toBe(true);
    expect(UserAccountCreated.is(restoredEvent)).toBe(true);
    expect(UserAccount.is(restoredSnapshot)).toBe(true);
    expect(UserAccountId.is(restoredSnapshot.id)).toBe(true);
  });

  test("rejects structural ids and invalid JSON discriminants", () => {
    const structuralId = {
      typeName: "user-account",
      value: "user-1",
      asString: () => "user-account-user-1",
    } as UserAccountId;
    const created = createUserAccountCreated();
    const createdJson = UserAccountCreated.toJSON(created);

    expect(UserAccountId.is(structuralId)).toBe(false);
    expect(() => UserAccount.create(structuralId, "Alice")).toThrow(
      "UserAccount id must be a branded UserAccountId",
    );
    expect(() =>
      UserAccountCreated.create({
        id: "event-1",
        aggregateId: structuralId,
        name: "Alice",
        sequenceNumber: 1,
        occurredAt: new Date("2026-05-25T00:00:00.000Z"),
      }),
    ).toThrow("UserAccountCreated aggregateId must be a branded UserAccountId");
    expect(() =>
      UserAccountId.fromJSON({ typeName: "other", value: "user-1" }),
    ).toThrow("Invalid UserAccountId JSON");
    expect(() => UserAccountId.fromJSON({ typeName: "user-account" })).toThrow(
      "Invalid UserAccountId JSON",
    );
    expect(() =>
      UserAccountEvent.fromJSON({ type: "Unknown", data: {} }),
    ).toThrow("Invalid UserAccountEvent JSON");
    expect(() =>
      UserAccountEvent.fromJSON({
        ...createdJson,
        data: {
          ...createdJson.data,
          occurredAt: "not-a-date",
        },
      }),
    ).toThrow("Invalid UserAccountCreated JSON");
  });
});

function createUserAccountCreated(): UserAccountCreated {
  return UserAccountCreated.create({
    id: "event-1",
    aggregateId: UserAccountId.create("user-1"),
    name: "Alice",
    sequenceNumber: 1,
    occurredAt: new Date("2026-05-25T00:00:00.000Z"),
  });
}
