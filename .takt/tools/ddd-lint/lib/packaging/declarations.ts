/**
 * How a package name is compared: which spellings name the same package, and which of them name a
 * technical classification rather than a business word. Shared by the language-neutral mapping,
 * the layer inspection and the Rust code gate, so one answer decides for all of them.
 */

const TECHNICAL_PACKAGE_NAMES = new Set([
  "aggregate",
  "aggregates",
  "impl",
  "impls",
  "implementation",
  "implementations",
  "vo",
  "vos",
  "entity",
  "entities",
  "value_object",
  "value_objects",
  "valueobject",
  "valueobjects",
]);

export function moduleParts(module: string): string[] | undefined {
  const parts = module.split("::").map((part) => part.replace(/^r#/, ""));
  if (!parts.every((part) => /^[A-Za-z_]\w*$/.test(part))) return undefined;
  if (parts[0] === "crate") parts.shift();
  return parts;
}

export function technicalName(parts: readonly string[]): string | undefined {
  return parts.find((part) => TECHNICAL_PACKAGE_NAMES.has(part.replace(/^r#/, "").toLowerCase()));
}

/**
 * The one name a crate or package is compared against: lowercased, with the `-domain` layer marker
 * removed and its word separators normalized. A reserved name has to be the whole name, the way a
 * module segment is compared: `value-objects` is the classification, while `invoice-entities` names
 * invoices and only ends in the word.
 */
export function packageWord(crate: string): string {
  return crate
    .toLowerCase()
    .replace(/(?:-|_)domain$/, "")
    .replace(/-/g, "_");
}

export function packageKey(crate: string, parts: readonly string[]): string {
  return `${crate}:${parts.join("::")}`;
}
