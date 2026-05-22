import { convertJson } from "./json-converter";

describe("convertJson", () => {
  test("wraps converter errors with converter context", () => {
    expect(() =>
      convertJson(
        "eventConverter",
        () => {
          throw new Error("invalid event payload");
        },
        {},
      ),
    ).toThrow("eventConverter failed: invalid event payload");
  });

  test("does not wrap converter errors twice", () => {
    expect(() =>
      convertJson(
        "eventConverter",
        (json) =>
          convertJson(
            "eventConverter",
            () => {
              throw new Error("invalid event payload");
            },
            json,
          ),
        {},
      ),
    ).toThrow("eventConverter failed: invalid event payload");
  });
});
