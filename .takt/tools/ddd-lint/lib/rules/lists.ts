/**
 * Fixed lists shared by the Rust rule evaluators. The storage-medium
 * list is the same value the layer-structure check uses, so the design and code checks agree.
 */

export const POST_INIT = new Set(["init", "setup", "initialize", "reset", "configure"]);

export const MEDIA_WORDS = [
  "dynamodb",
  "dynamo",
  "postgres",
  "mysql",
  "sqlite",
  "redis",
  "mongo",
  "s3",
  "jdbc",
  "sql",
  "http",
  "grpc",
  "kafka",
  "inmemory",
];

export interface ExternalCrateRule {
  pattern: string;
  category: "database" | "cache" | "message-broker" | "http-client" | "rpc" | "web-framework" | "cloud-sdk";
}

/** Q6 initial denylist. A trailing `*` is a prefix match. */
export const IO_CRATES: readonly ExternalCrateRule[] = [
  { pattern: "sqlx", category: "database" },
  { pattern: "diesel", category: "database" },
  { pattern: "rusqlite", category: "database" },
  { pattern: "mongodb", category: "database" },
  { pattern: "redis", category: "cache" },
  { pattern: "aws-sdk-*", category: "cloud-sdk" },
  { pattern: "aws-config", category: "cloud-sdk" },
  { pattern: "reqwest", category: "http-client" },
  { pattern: "hyper", category: "http-client" },
  { pattern: "axum", category: "web-framework" },
  { pattern: "actix-web", category: "web-framework" },
  { pattern: "tonic", category: "rpc" },
  { pattern: "rdkafka", category: "message-broker" },
  { pattern: "lapin", category: "message-broker" },
];

/**
 * The npm packages that are external I/O, in the same categories as `IO_CRATES`. Node's built-in
 * modules are left out, as the Rust list leaves out `std`. A trailing `*` is a prefix match.
 */
export const IO_PACKAGES: readonly ExternalCrateRule[] = [
  { pattern: "pg", category: "database" },
  { pattern: "mysql", category: "database" },
  { pattern: "mysql2", category: "database" },
  { pattern: "sqlite3", category: "database" },
  { pattern: "better-sqlite3", category: "database" },
  { pattern: "mongodb", category: "database" },
  { pattern: "mongoose", category: "database" },
  { pattern: "@prisma/client", category: "database" },
  { pattern: "typeorm", category: "database" },
  { pattern: "sequelize", category: "database" },
  { pattern: "knex", category: "database" },
  { pattern: "drizzle-orm", category: "database" },
  { pattern: "redis", category: "cache" },
  { pattern: "ioredis", category: "cache" },
  { pattern: "@aws-sdk/*", category: "cloud-sdk" },
  { pattern: "aws-sdk", category: "cloud-sdk" },
  { pattern: "axios", category: "http-client" },
  { pattern: "node-fetch", category: "http-client" },
  { pattern: "got", category: "http-client" },
  { pattern: "undici", category: "http-client" },
  { pattern: "express", category: "web-framework" },
  { pattern: "fastify", category: "web-framework" },
  { pattern: "koa", category: "web-framework" },
  { pattern: "hono", category: "web-framework" },
  { pattern: "@nestjs/*", category: "web-framework" },
  { pattern: "@grpc/grpc-js", category: "rpc" },
  { pattern: "kafkajs", category: "message-broker" },
  { pattern: "amqplib", category: "message-broker" },
];

export function matchesIoRule(
  crateName: string,
  rules: readonly ExternalCrateRule[] = IO_CRATES,
): ExternalCrateRule | undefined {
  return rules.find((rule) =>
    rule.pattern.endsWith("*") ? crateName.startsWith(rule.pattern.slice(0, -1)) : crateName === rule.pattern,
  );
}

export function containsMediaWord(name: string): boolean {
  const lower = name.toLowerCase();
  return MEDIA_WORDS.some((word) => lower.includes(word));
}

/** PascalCase / camelCase -> lower kebab (InvoiceLine -> invoice-line, HTTPClient -> http-client). */
export function toKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/** snake_case -> kebab (add_item -> add-item). */
export function snakeToKebab(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function toPascal(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
