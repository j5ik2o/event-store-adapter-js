import {CreateTableCommand, CreateTableCommandInput, DynamoDBClient} from "@aws-sdk/client-dynamodb";

async function createJournalTable(
    dynamodbClient: DynamoDBClient,
    tableName: string,
    indexName: string,
) {
    const request: CreateTableCommandInput = {
        TableName: tableName,
        AttributeDefinitions: [
            {
                AttributeName: "pkey",
                AttributeType: "S",
            },
            {
                AttributeName: "skey",
                AttributeType: "S",
            },
            {
                AttributeName: "aid",
                AttributeType: "S",
            },
            {
                AttributeName: "seq_nr",
                AttributeType: "N",
            },
        ],
        KeySchema: [
            {
                AttributeName: "pkey",
                KeyType: "HASH",
            },
            {
                AttributeName: "skey",
                KeyType: "RANGE",
            },
        ],
        GlobalSecondaryIndexes: [
            {
                IndexName: indexName,
                KeySchema: [
                    {
                        AttributeName: "aid",
                        KeyType: "HASH",
                    },
                    {
                        AttributeName: "seq_nr",
                        KeyType: "RANGE",
                    },
                ],
                Projection: {
                    ProjectionType: "ALL",
                },
                ProvisionedThroughput: {
                    ReadCapacityUnits: 10,
                    WriteCapacityUnits: 5,
                },
            },
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 10,
            WriteCapacityUnits: 5,
        },
    };

    await dynamodbClient.send(new CreateTableCommand(request));
}

async function createSnapshotTable(
    dynamodbClient: DynamoDBClient,
    tableName: string,
    indexName: string,
) {
    const request: CreateTableCommandInput = {
        TableName: tableName,
        AttributeDefinitions: [
            {
                AttributeName: "pkey",
                AttributeType: "S",
            },
            {
                AttributeName: "skey",
                AttributeType: "S",
            },
            {
                AttributeName: "aid",
                AttributeType: "S",
            },
            {
                AttributeName: "seq_nr",
                AttributeType: "N",
            },
        ],
        KeySchema: [
            {
                AttributeName: "pkey",
                KeyType: "HASH",
            },
            {
                AttributeName: "skey",
                KeyType: "RANGE",
            },
        ],
        GlobalSecondaryIndexes: [
            {
                IndexName: indexName,
                KeySchema: [
                    {
                        AttributeName: "aid",
                        KeyType: "HASH",
                    },
                    {
                        AttributeName: "seq_nr",
                        KeyType: "RANGE",
                    },
                ],
                Projection: {
                    ProjectionType: "ALL",
                },
                ProvisionedThroughput: {
                    ReadCapacityUnits: 10,
                    WriteCapacityUnits: 5,
                },
            },
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 10,
            WriteCapacityUnits: 5,
        },
    };

    await dynamodbClient.send(new CreateTableCommand(request));
}

export {createJournalTable, createSnapshotTable};
