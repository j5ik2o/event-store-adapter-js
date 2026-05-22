import { UserAccountCreated } from "./user-account-created";
import { convertJSONToUserAccountId } from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

type UserAccountEvent = UserAccountCreated | UserAccountRenamed;
type UserAccountEventType = "UserAccountCreated" | "UserAccountRenamed";
type UserAccountEventData = {
  id: string;
  aggregateId: { value: string };
  name: string;
  sequenceNumber: number;
  occurredAt: string;
};

function convertJSONToUserAccountEvent(json: unknown): UserAccountEvent {
  const payload = parseEventPayload(json);
  const aggregateId = convertJSONToUserAccountId(payload.data.aggregateId);
  const occurredAt = new Date(payload.data.occurredAt);

  switch (payload.type) {
    case "UserAccountCreated":
      return new UserAccountCreated(
        payload.data.id,
        aggregateId,
        payload.data.name,
        payload.data.sequenceNumber,
        occurredAt,
      );
    case "UserAccountRenamed":
      return new UserAccountRenamed(
        payload.data.id,
        aggregateId,
        payload.data.name,
        payload.data.sequenceNumber,
        occurredAt,
      );
    default: {
      const exhaustiveCheck: never = payload.type;
      throw new Error(`Unknown UserAccountEvent type: ${exhaustiveCheck}`);
    }
  }
}

function parseEventPayload(json: unknown): {
  type: UserAccountEventType;
  data: UserAccountEventData;
} {
  if (
    typeof json !== "object" ||
    json === null ||
    !("type" in json) ||
    !isUserAccountEventType(json.type) ||
    !("data" in json) ||
    !isEventData(json.data)
  ) {
    throw new Error("Invalid UserAccountEvent JSON");
  }
  const type: UserAccountEventType = json.type;
  const data: UserAccountEventData = json.data;
  return {
    type,
    data,
  };
}

function isUserAccountEventType(json: unknown): json is UserAccountEventType {
  return json === "UserAccountCreated" || json === "UserAccountRenamed";
}

function isEventData(json: unknown): json is UserAccountEventData {
  return (
    typeof json === "object" &&
    json !== null &&
    "id" in json &&
    typeof json.id === "string" &&
    "aggregateId" in json &&
    typeof json.aggregateId === "object" &&
    json.aggregateId !== null &&
    "value" in json.aggregateId &&
    typeof json.aggregateId.value === "string" &&
    json.aggregateId.value.length > 0 &&
    "name" in json &&
    typeof json.name === "string" &&
    json.name.length > 0 &&
    "sequenceNumber" in json &&
    typeof json.sequenceNumber === "number" &&
    "occurredAt" in json &&
    typeof json.occurredAt === "string" &&
    !Number.isNaN(Date.parse(json.occurredAt))
  );
}

export { convertJSONToUserAccountEvent, type UserAccountEvent };
