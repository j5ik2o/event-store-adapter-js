const test = require("node:test");
const { consumeMemory, consumeDynamoDB, consumeSqlite } = require("../fixtures/consume.cjs");
const { withDynamoDB } = require("./dynamodb.cjs");

test("built package uses four Memory operations, domain serializers, sharing, isolation and original cause", consumeMemory);
test("built package uses four real DynamoDB operations and domain restoration", { timeout: 120000 }, async () => {
  await withDynamoDB(consumeDynamoDB);
});
test("built package uses four real SQLite operations from the ./sqlite entry and reopens the file", consumeSqlite);
