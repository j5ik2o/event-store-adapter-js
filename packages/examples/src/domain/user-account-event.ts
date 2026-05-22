import { UserAccountCreated } from "./user-account-created";
import { convertJSONToUserAccountId } from "./user-account-id";
import { UserAccountRenamed } from "./user-account-renamed";

type UserAccountEvent = UserAccountCreated | UserAccountRenamed;
type UserAccountEventType = "UserAccountCreated" | "UserAccountRenamed";

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
  data: {
    id: string;
    aggregateId: { value: string };
    name: string;
    sequenceNumber: number;
    occurredAt: string;
  };
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
  return {
    type: json.type,
    data: json.data,
  };
}

function isUserAccountEventType(json: unknown): json is UserAccountEventType {
  return json === "UserAccountCreated" || json === "UserAccountRenamed";
}

function isEventData(json: unknown): json is {
  id: string;
  aggregateId: { value: string };
  name: string;
  sequenceNumber: number;
  occurredAt: string;
} {
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
    typeof json.occurredAt === "string"
  );
}

export { convertJSONToUserAccountEvent, type UserAccountEvent };
