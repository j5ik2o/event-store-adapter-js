import type {
  BatchGetItemCommandInput,
  BatchGetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";

/** 実要求の指定表だけを元SDK応答から除き、同じ要求キーを未処理へ移す。 */
export function deferDynamoDBRequestedKeys(
  input: BatchGetItemCommandInput,
  upstream: BatchGetItemCommandOutput,
  tables: readonly string[],
): BatchGetItemCommandOutput {
  const deferred = Object.entries(input.RequestItems ?? {}).filter(
    ([tableName, request]) =>
      tables.includes(tableName) && (request.Keys?.length ?? 0) > 0,
  );
  if (deferred.length === 0) return upstream;
  return {
    ...upstream,
    Responses: Object.fromEntries(
      Object.entries(upstream.Responses ?? {}).filter(
        ([tableName]) => !deferred.some(([name]) => name === tableName),
      ),
    ),
    UnprocessedKeys: {
      ...upstream.UnprocessedKeys,
      ...Object.fromEntries(
        deferred.map(([tableName, request]) => [
          tableName,
          { Keys: structuredClone(request.Keys) },
        ]),
      ),
    },
  };
}
