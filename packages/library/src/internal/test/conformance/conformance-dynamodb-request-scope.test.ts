import { checkDynamoDBRequestScope } from "./conformance-dynamodb-request-scope";

const scope = {
  apis: [
    "GetItem",
    "BatchGetItem",
    "Query",
    "TransactWriteItems",
    "BatchWriteItem",
    "UpdateItem",
  ],
  aid: "aggregate_id",
};
const own = { S: "Order-9" };
const other = { S: "Customer-5" };

const requestsFor = (aid: { S: string }) => [
  { commandName: "GetItemCommand", input: { Key: { aid } } },
  {
    commandName: "BatchGetItemCommand",
    input: { RequestItems: { journal: { Keys: [{ aid }, { aid }] } } },
  },
  {
    commandName: "QueryCommand",
    input: {
      KeyConditionExpression: "#aid = :aid AND seq_nr >= :from",
      ExpressionAttributeNames: { "#aid": "aid" },
      ExpressionAttributeValues: { ":aid": aid, ":from": { N: "1" } },
    },
  },
  {
    commandName: "TransactWriteItemsCommand",
    input: {
      TransactItems: [
        { Put: { Item: { aid, seq_nr: { N: "1" } } } },
        { Update: { Key: { aid } } },
      ],
    },
  },
  {
    commandName: "BatchWriteItemCommand",
    input: {
      RequestItems: {
        journal: [
          { PutRequest: { Item: { aid } } },
          { DeleteRequest: { Key: { aid } } },
        ],
      },
    },
  },
  { commandName: "UpdateItemCommand", input: { Key: { aid } } },
];

describe("checkDynamoDBRequestScope", () => {
  test("accepts the six allowed APIs when every aid is the aggregate's", () => {
    expect(() =>
      checkDynamoDBRequestScope(requestsFor(own), scope, "Order-9"),
    ).not.toThrow();
  });

  test("rejects an operation without any recorded request", () => {
    expect(() => checkDynamoDBRequestScope([], scope, own.S)).toThrow(
      "no requests were recorded",
    );
  });

  test("rejects a Scan request", () => {
    expect(() =>
      checkDynamoDBRequestScope(
        [{ commandName: "ScanCommand", input: { TableName: "journal" } }],
        scope,
        "Order-9",
      ),
    ).toThrow();
  });

  test("rejects a BatchGetItem that reads another aggregate's key", () => {
    expect(() =>
      checkDynamoDBRequestScope(
        [
          {
            commandName: "BatchGetItemCommand",
            input: {
              RequestItems: {
                journal: { Keys: [{ aid: own }, { aid: other }] },
              },
            },
          },
        ],
        scope,
        "Order-9",
      ),
    ).toThrow();
  });

  test("rejects a Query whose partition key condition is another aggregate", () => {
    expect(() =>
      checkDynamoDBRequestScope(
        [
          {
            commandName: "QueryCommand",
            input: {
              KeyConditionExpression: "#aid = :aid",
              ExpressionAttributeNames: { "#aid": "aid" },
              ExpressionAttributeValues: { ":aid": other },
            },
          },
        ],
        scope,
        "Order-9",
      ),
    ).toThrow();
  });

  test("rejects a Query without a key condition", () => {
    expect(() =>
      checkDynamoDBRequestScope(
        [{ commandName: "QueryCommand", input: { TableName: "journal" } }],
        scope,
        "Order-9",
      ),
    ).toThrow();
  });
});
