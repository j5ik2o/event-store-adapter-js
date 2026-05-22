/** @type {import("ts-jest/dist/types").InitialOptionsTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/internal/test/**",
    "!dist/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
};
