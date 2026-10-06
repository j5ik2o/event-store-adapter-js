import { implementationCommitOf } from "./conformance-implementation-commit";

describe("implementationCommitOf", () => {
  test("returns GITHUB_SHA when set", () => {
    expect(implementationCommitOf({ GITHUB_SHA: "abc" })).toBe("abc");
  });

  test.each([{}, { GITHUB_SHA: "" }])("returns null for %j", (env) => {
    expect(implementationCommitOf(env)).toBeNull();
  });
});
