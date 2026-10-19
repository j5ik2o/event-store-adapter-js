import { fnv1a64 } from "./fnv1a64";

test.each([
  ["", BigInt("0xcbf29ce484222325")],
  ["a", BigInt("0xaf63dc4c8601ec8c")],
  ["01H42K4ABWQ5V2XQEP3A48VE0Z", BigInt("0xadb103af5fe2a91a")],
])("computes the FNV-1a 64 of the UTF-8 bytes of %p", (input, expected) => {
  expect(fnv1a64(input)).toBe(expected);
});

test("hashes multibyte text by its UTF-8 bytes, not by UTF-16 code units", () => {
  expect(fnv1a64("あ")).not.toBe(fnv1a64("ああ"));
  expect(fnv1a64("あ")).toBeLessThan(BigInt("0x10000000000000000"));
});
