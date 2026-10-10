import { EventStore } from "event-store-adapter-js";
import { userAccountSerializers } from "./domain/user-account-serializers";
import { createEventStoreTables, startDynamoDBContainer } from "./dynamodb-container";
import { runUserAccountExample, unwrap } from "./run-user-account-example";

async function main(): Promise<void> {
  const dynamodb = await startDynamoDBContainer();
  try {
    const layout = await createEventStoreTables(dynamodb.client);
    const store = unwrap(await EventStore.createDynamoDB({ ...layout, client: dynamodb.client, ...userAccountSerializers() }));
    await runUserAccountExample("dynamodb", store);
  } finally { await dynamodb.stop(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
