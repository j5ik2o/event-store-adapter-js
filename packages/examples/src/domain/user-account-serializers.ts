import type { PayloadSerializer } from "event-store-adapter-js";
import { UserAccount } from "./user-account";
import { UserAccountEvent } from "./user-account-event";

export function userAccountSerializers(): {
  eventSerializer: PayloadSerializer<UserAccountEvent>;
  snapshotSerializer: PayloadSerializer<UserAccount>;
} {
  return {
    eventSerializer: {
      serialize: (event) => new TextEncoder().encode(JSON.stringify(UserAccountEvent.toJSON(event))),
      deserialize: (bytes, manifest) => {
        if (manifest !== "" && manifest !== "UserAccountEvent.v1") throw new Error("Unsupported event manifest");
        return UserAccountEvent.fromJSON(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      },
    },
    snapshotSerializer: {
      serialize: (account) => new TextEncoder().encode(JSON.stringify(UserAccount.toJSON(account))),
      deserialize: (bytes, manifest) => {
        if (manifest !== "UserAccount.v1") throw new Error("Unsupported snapshot manifest");
        return UserAccount.fromJSON(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      },
    },
  };
}
