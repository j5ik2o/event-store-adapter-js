/**
 * Stable element IDs — the grammar the whole normalised model
 * shares. An element_id is `<kind-prefix>(.<lower-kebab-segment>)+`, and the
 * number of segments after the prefix is fixed per kind.
 */

export const ELEMENT_KINDS = [
  "bc",
  "aggregate",
  "entity",
  "vo",
  "primitive",
  "invariant",
  "command",
  "event",
  "error",
  "transition",
  "factory",
  "pm",
] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];

const PREFIX_TO_KIND: Readonly<Record<string, ElementKind>> = Object.fromEntries(
  ELEMENT_KINDS.map((kind) => [kind, kind]),
);

/** Segments AFTER the kind prefix. */
const SEGMENT_ARITY: Readonly<Record<ElementKind, number>> = {
  bc: 1,
  aggregate: 1,
  entity: 1,
  vo: 1,
  primitive: 1,
  pm: 1,
  invariant: 2,
  command: 2,
  event: 2,
  transition: 2,
  factory: 2,
  error: 3,
};

export interface ElementId {
  value: string;
  kind: ElementKind;
  /** Name segments with the kind prefix removed. */
  segments: string[];
}

export type ElementIdParse =
  | { ok: true; id: ElementId }
  | { ok: false; rule_id: "schema.id-grammar" | "schema.id-arity"; message: string };

const ID_PATTERN = new RegExp(`^(${ELEMENT_KINDS.join("|")})(\\.[a-z][a-z0-9-]*)+$`);

/** Parse an element_id, rejecting grammar and arity violations. */
export function parseElementId(text: string): ElementIdParse {
  if (!ID_PATTERN.test(text)) {
    return {
      ok: false,
      rule_id: "schema.id-grammar",
      message: `element_id "${text}" must be <kind-prefix>(.<lower-kebab>)+`,
    };
  }
  const parts = text.split(".");
  const kind = PREFIX_TO_KIND[parts[0]];
  const segments = parts.slice(1);
  const arity = SEGMENT_ARITY[kind];
  if (segments.length !== arity) {
    return {
      ok: false,
      rule_id: "schema.id-arity",
      message: `element_id "${text}" must have ${arity} segment(s) after "${kind}", found ${segments.length}`,
    };
  }
  return { ok: true, id: { value: text, kind, segments } };
}

/** The aggregate name segment an ID carries, when its arity includes one. */
export function ownerSegment(id: ElementId): string | undefined {
  if (id.kind === "error") return id.segments[1];
  return id.segments[0];
}

/** The command name segment an error ID carries (error.<agg>.<cmd>.<name>). */
export function commandSegment(id: ElementId): string | undefined {
  return id.kind === "error" ? id.segments[1] : undefined;
}
