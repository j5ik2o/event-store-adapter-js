/**
 * loadDomainModel — the hand-written structural validator (Q4 A) and index
 * builder for `docs/ddd/domain-model.yaml`.
 *
 * The reader fails closed: any load-time violation returns
 * `{ ok: false, findings }` and no partial index. Rules that the design marks
 * "completeness" never fail the load; they are reported
 * separately by completeness.ts after a successful load.
 *
 * Unknown keys are rejected outright: the normalised model owns only
 * domain concepts, not modules, crates, deployment units or use-case steps.
 */

import { existsSync, readFileSync } from "node:fs";
import { assertFindingInput, type FindingInput } from "../shared/findings.ts";
import { type ElementId, parseElementId } from "./element-id.ts";
import { createElementIndex, type ElementIndex, type ResolveReason } from "./index-builder.ts";
import type {
  Aggregate,
  BoundedContext,
  Command,
  CommandEffect,
  DomainElement,
  DomainElementKind,
  DomainError,
  DomainEvent,
  DomainModel,
  ElementAttribute,
  ElementLineage,
  FactoryRule,
  IdempotencyPolicy,
  IdempotencyRetention,
  IdempotencyStrategy,
  IndexedElement,
  Invariant,
  ProcessManager,
  ProcessStep,
  StateEffect,
  StateTransition,
} from "./model.ts";

export type LoadResult =
  | { ok: true; model: DomainModel; index: ElementIndex }
  | { ok: false; findings: FindingInput[] };

const SCALAR_TYPES = new Set(["string", "integer", "decimal", "boolean", "date", "datetime"]);

const ALLOWED: Record<string, readonly string[]> = {
  domainModel: ["bounded_contexts", "lineage"],
  bc: ["element_id", "name", "aggregates", "process_managers"],
  aggregate: [
    "element_id",
    "name",
    "bounded_context",
    "root_element",
    "states",
    "elements",
    "invariants",
    "commands",
    "events",
    "transitions",
    "factory_rules",
    "process_managers",
  ],
  element: ["element_id", "kind", "name", "aggregate", "attributes", "invariants", "unconstrained"],
  attribute: ["name", "type", "required", "collection"],
  invariant: ["element_id", "name", "aggregate", "element", "statement"],
  command: [
    "element_id",
    "name",
    "aggregate",
    "effect",
    "state_effect",
    "transitions",
    "domain_errors",
    "event",
    "idempotency",
  ],
  idempotency: ["strategy", "retention", "retention_count", "retention_window", "rationale"],
  event: ["element_id", "name", "aggregate", "produced_by"],
  transition: ["element_id", "name", "aggregate", "from_state", "to_state", "command"],
  pm: ["element_id", "name", "aggregates", "steps", "compensations"],
  step: ["name", "command", "on_failure"],
  lineage: ["lineage_id", "element_id", "relation", "previous_name", "successors", "replaced_by", "deprecated_at"],
};

/** Each operation — Command or FactoryRule — owns its own DomainErrors, naming itself in `operation`. */
const ERROR_KEYS: readonly string[] = ["element_id", "name", "operation", "condition"];
const FACTORY_KEYS: readonly string[] = ["element_id", "name", "target_element", "preconditions", "domain_errors"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Report {
  readonly findings: FindingInput[] = [];

  constructor(private readonly file: string) {}

  add(ruleId: string, message: string, line?: number): void {
    const finding: FindingInput = {
      rule_id: ruleId,
      file: this.file,
      message,
      ...(line === undefined ? {} : { line }),
    };
    assertFindingInput(finding);
    this.findings.push(finding);
  }

  checkKeys(node: Record<string, unknown>, allowed: readonly string[], where: string): void {
    const allow = new Set(allowed);
    for (const key of Object.keys(node)) {
      if (!allow.has(key)) {
        this.add("schema.unknown-key", `${where}: unknown key "${key}"`);
      }
    }
  }

  requiredString(node: Record<string, unknown>, key: string, where: string): string | undefined {
    const value = node[key];
    if (typeof value !== "string" || value.length === 0) {
      this.add("schema.structure", `${where}: "${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  optionalString(node: Record<string, unknown>, key: string, where: string): string | undefined {
    const value = node[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      this.add("schema.structure", `${where}: "${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  private idCache = new Map<string, ElementId | undefined>();

  parseId(text: string, where: string): ElementId | undefined {
    if (this.idCache.has(text)) return this.idCache.get(text);
    const parsed = parseElementId(text);
    if (!parsed.ok) {
      this.add(parsed.rule_id, `${where}: ${parsed.message}`);
      this.idCache.set(text, undefined);
      return undefined;
    }
    this.idCache.set(text, parsed.id);
    return parsed.id;
  }

  idField(node: Record<string, unknown>, key: string, where: string): string | undefined {
    const value = this.requiredString(node, key, where);
    if (value === undefined) return undefined;
    return this.parseId(value, where)?.value;
  }
}

function readStringArray(
  report: Report,
  node: Record<string, unknown>,
  key: string,
  where: string,
  required: boolean,
): string[] {
  const value = node[key];
  if (value === undefined) {
    if (required) report.add("schema.structure", `${where}: "${key}" is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    report.add("schema.structure", `${where}: "${key}" must be a list`);
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      report.add("schema.structure", `${where}: "${key}[${index}]" must be a non-empty string`);
      return;
    }
    out.push(entry);
  });
  return out;
}

function readObjectArray(
  report: Report,
  node: Record<string, unknown>,
  key: string,
  where: string,
  required: boolean,
): Record<string, unknown>[] {
  const value = node[key];
  if (value === undefined) {
    if (required) report.add("schema.structure", `${where}: "${key}" is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    report.add("schema.structure", `${where}: "${key}" must be a list`);
    return [];
  }
  const out: Record<string, unknown>[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      report.add("schema.structure", `${where}: "${key}[${index}]" must be an object`);
      return;
    }
    out.push(entry);
  });
  return out;
}

function readAttribute(report: Report, node: Record<string, unknown>, where: string): ElementAttribute | undefined {
  report.checkKeys(node, ALLOWED.attribute, where);
  const name = report.requiredString(node, "name", where);
  const type = report.requiredString(node, "type", where);
  if (name === undefined || type === undefined) return undefined;
  const required = node.required === undefined ? true : node.required;
  const collection = node.collection === undefined ? false : node.collection;
  if (typeof required !== "boolean") {
    report.add("schema.structure", `${where}: "required" must be a boolean`);
    return undefined;
  }
  if (typeof collection !== "boolean") {
    report.add("schema.structure", `${where}: "collection" must be a boolean`);
    return undefined;
  }
  return { name, type, required, collection };
}

function readIdempotency(
  report: Report,
  node: Record<string, unknown> | undefined,
  where: string,
): IdempotencyPolicy | undefined {
  if (node === undefined) {
    report.add("schema.idempotency-missing", `${where}: "idempotency" is required`);
    return undefined;
  }
  report.checkKeys(node, ALLOWED.idempotency, where);
  const strategy = node.strategy;
  if (strategy !== "none" && strategy !== "command-id-memory") {
    report.add("schema.idempotency-missing", `${where}: strategy must be none | command-id-memory`);
    return undefined;
  }
  if (strategy === "none") {
    const rationale = report.optionalString(node, "rationale", where);
    return { strategy: strategy as IdempotencyStrategy, ...(rationale ? { rationale } : {}) };
  }
  const retention = node.retention;
  if (retention !== "last-one" && retention !== "multiple" && retention !== "time-window") {
    report.add("schema.retention", `${where}: retention is required and must be last-one | multiple | time-window`);
    return undefined;
  }
  const policy: IdempotencyPolicy = {
    strategy: strategy as IdempotencyStrategy,
    retention: retention as IdempotencyRetention,
  };
  if (retention === "multiple") {
    const count = node.retention_count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      report.add("schema.retention", `${where}: retention_count must be an integer >= 1`);
    } else {
      policy.retention_count = count;
    }
  }
  if (retention === "time-window") {
    const window = report.optionalString(node, "retention_window", where);
    if (window === undefined) {
      report.add("schema.retention", `${where}: retention_window is required for time-window`);
    } else {
      policy.retention_window = window;
    }
  }
  const rationale = report.optionalString(node, "rationale", where);
  if (rationale) policy.rationale = rationale;
  return policy;
}

// ---------------------------------------------------------------------------
// Structural readers
// ---------------------------------------------------------------------------

function readDomainError(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): DomainError | undefined {
  report.checkKeys(node, ERROR_KEYS, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  // Read as a plain string, not as an element_id: an owner that is not well-formed is reported as
  // an unresolvable reference by the cross-element pass, where the expected kind is also known.
  const operation = report.requiredString(node, "operation", where);
  const condition = report.requiredString(node, "condition", where);
  if (element_id === undefined || name === undefined || operation === undefined || condition === undefined) {
    return undefined;
  }
  return { element_id, name, operation, condition };
}

function readDomainErrors(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): (DomainError | undefined)[] {
  return readObjectArray(report, node, "domain_errors", where, true).map((raw, index) =>
    readDomainError(report, raw, `${where}/domain_errors[${index}]`),
  );
}

function readCommand(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): Command | undefined {
  report.checkKeys(node, ALLOWED.command, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregate = report.requiredString(node, "aggregate", where);
  // A command produces exactly one event.
  const event = report.requiredString(node, "event", where);
  const effect = node.effect;
  const state_effect = node.state_effect;
  if (effect !== "transition" && effect !== "accumulation") {
    report.add("schema.structure", `${where}: effect must be transition | accumulation`);
  }
  if (state_effect !== "transitions" && state_effect !== "none") {
    report.add("schema.structure", `${where}: state_effect must be transitions | none`);
  }
  const domainErrors = readDomainErrors(report, node, where);
  if (domainErrors.length === 0) {
    report.add("schema.command-no-error", `${where}: every Command needs at least one DomainError`);
  }
  const idempotencyRaw = node.idempotency;
  const idempotency = isRecord(idempotencyRaw)
    ? readIdempotency(report, idempotencyRaw, `${where}/idempotency`)
    : readIdempotency(report, undefined, `${where}/idempotency`);
  if (
    element_id === undefined ||
    name === undefined ||
    aggregate === undefined ||
    event === undefined ||
    idempotency === undefined ||
    domainErrors.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  return {
    element_id,
    name,
    aggregate,
    effect: effect as CommandEffect,
    state_effect: state_effect as StateEffect,
    transitions: readStringArray(report, node, "transitions", where, false),
    domain_errors: domainErrors as DomainError[],
    event,
    idempotency,
  };
}

function readInvariant(report: Report, node: Record<string, unknown>, where: string): Invariant | undefined {
  report.checkKeys(node, ALLOWED.invariant, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregate = report.requiredString(node, "aggregate", where);
  const statement = report.requiredString(node, "statement", where);
  const element = report.optionalString(node, "element", where);
  if (element_id === undefined || name === undefined || aggregate === undefined || statement === undefined) {
    return undefined;
  }
  return { element_id, name, aggregate, statement, ...(element ? { element } : {}) };
}

function readElement(report: Report, node: Record<string, unknown>, where: string): DomainElement | undefined {
  report.checkKeys(node, ALLOWED.element, where);
  const element_id = report.idField(node, "element_id", where);
  const kind = node.kind;
  const name = report.requiredString(node, "name", where);
  const aggregate = report.requiredString(node, "aggregate", where);
  if (kind !== "entity" && kind !== "value-object" && kind !== "domain-primitive") {
    report.add("schema.structure", `${where}: kind must be entity | value-object | domain-primitive`);
  }
  const attributes = readObjectArray(report, node, "attributes", where, false).map((raw, index) =>
    readAttribute(report, raw, `${where}/attributes[${index}]`),
  );
  if (
    element_id === undefined ||
    name === undefined ||
    aggregate === undefined ||
    attributes.some((a) => a === undefined)
  ) {
    return undefined;
  }
  const parsed = parseElementId(element_id);
  const expectedPrefix = kind === "entity" ? "entity" : kind === "value-object" ? "vo" : "primitive";
  if (parsed.ok && parsed.id.kind !== expectedPrefix) {
    report.add(
      "schema.kind-prefix",
      `${where}: kind ${kind} needs prefix "${expectedPrefix}", got "${parsed.id.kind}"`,
    );
  }
  if (kind === "domain-primitive" && attributes.length !== 1) {
    report.add("schema.primitive-shape", `${where}: domain-primitive must wrap exactly one attribute`);
  }
  const unconstrained = report.optionalString(node, "unconstrained", where);
  if (unconstrained !== undefined && kind !== "domain-primitive") {
    report.add("schema.structure", `${where}: only a domain-primitive declares "unconstrained"`);
  }
  return {
    element_id,
    kind: kind as DomainElementKind,
    name,
    aggregate,
    attributes: attributes as ElementAttribute[],
    invariants: readStringArray(report, node, "invariants", where, false),
    ...(unconstrained === undefined ? {} : { unconstrained }),
  };
}

function readEvent(report: Report, node: Record<string, unknown>, where: string): DomainEvent | undefined {
  report.checkKeys(node, ALLOWED.event, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregate = report.requiredString(node, "aggregate", where);
  const produced_by = report.requiredString(node, "produced_by", where);
  if (element_id === undefined || name === undefined || aggregate === undefined || produced_by === undefined) {
    return undefined;
  }
  return { element_id, name, aggregate, produced_by };
}

function readTransition(report: Report, node: Record<string, unknown>, where: string): StateTransition | undefined {
  report.checkKeys(node, ALLOWED.transition, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregate = report.requiredString(node, "aggregate", where);
  const from_state = report.requiredString(node, "from_state", where);
  const to_state = report.requiredString(node, "to_state", where);
  const command = report.requiredString(node, "command", where);
  if (
    element_id === undefined ||
    name === undefined ||
    aggregate === undefined ||
    from_state === undefined ||
    to_state === undefined ||
    command === undefined
  ) {
    return undefined;
  }
  return { element_id, name, aggregate, from_state, to_state, command };
}

function readFactory(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): FactoryRule | undefined {
  report.checkKeys(node, FACTORY_KEYS, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const target_element = report.requiredString(node, "target_element", where);
  const preconditions = readStringArray(report, node, "preconditions", where, true);
  const domainErrors = readDomainErrors(report, node, where);
  if (domainErrors.length === 0) {
    report.add("schema.factory-no-error", `${where}: every FactoryRule needs at least one DomainError`);
  }
  if (
    element_id === undefined ||
    name === undefined ||
    target_element === undefined ||
    domainErrors.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  if (preconditions.length === 0) {
    report.add("schema.structure", `${where}: preconditions needs at least one entry`);
  }
  return { element_id, name, target_element, preconditions, domain_errors: domainErrors as DomainError[] };
}

function readProcessStep(report: Report, node: Record<string, unknown>, where: string): ProcessStep | undefined {
  report.checkKeys(node, ALLOWED.step, where);
  const name = report.requiredString(node, "name", where);
  const command = report.requiredString(node, "command", where);
  const on_failure = report.optionalString(node, "on_failure", where);
  if (name === undefined || command === undefined) return undefined;
  return { name, command, ...(on_failure ? { on_failure } : {}) };
}

function readProcessManager(report: Report, node: Record<string, unknown>, where: string): ProcessManager | undefined {
  report.checkKeys(node, ALLOWED.pm, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregates = readStringArray(report, node, "aggregates", where, true);
  const steps = readObjectArray(report, node, "steps", where, true).map((raw, index) =>
    readProcessStep(report, raw, `${where}/steps[${index}]`),
  );
  const compensations = readObjectArray(report, node, "compensations", where, false).map((raw, index) =>
    readProcessStep(report, raw, `${where}/compensations[${index}]`),
  );
  if (element_id === undefined || name === undefined || steps.some((entry) => entry === undefined)) {
    return undefined;
  }
  return {
    element_id,
    name,
    aggregates,
    steps: steps as ProcessStep[],
    compensations: compensations as ProcessStep[],
  };
}

function readAggregate(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): Aggregate | undefined {
  report.checkKeys(node, ALLOWED.aggregate, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const bounded_context = report.requiredString(node, "bounded_context", where);
  const root_element = report.requiredString(node, "root_element", where);
  const states = readStringArray(report, node, "states", where, false);
  const elements = readObjectArray(report, node, "elements", where, true).map((raw, index) =>
    readElement(report, raw, `${where}/elements[${index}]`),
  );
  const invariants = readObjectArray(report, node, "invariants", where, false).map((raw, index) =>
    readInvariant(report, raw, `${where}/invariants[${index}]`),
  );
  const commands = readObjectArray(report, node, "commands", where, false).map((raw, index) =>
    readCommand(report, raw, `${where}/commands[${index}]`),
  );
  const events = readObjectArray(report, node, "events", where, false).map((raw, index) =>
    readEvent(report, raw, `${where}/events[${index}]`),
  );
  const transitions = readObjectArray(report, node, "transitions", where, false).map((raw, index) =>
    readTransition(report, raw, `${where}/transitions[${index}]`),
  );
  const factoryRules = readObjectArray(report, node, "factory_rules", where, false).map((raw, index) =>
    readFactory(report, raw, `${where}/factory_rules[${index}]`),
  );
  if (elements.length === 0) {
    report.add("schema.structure", `${where}: elements needs at least one entry`);
  }
  const nested = [...elements, ...invariants, ...commands, ...events, ...transitions, ...factoryRules];
  if (
    element_id === undefined ||
    name === undefined ||
    bounded_context === undefined ||
    root_element === undefined ||
    nested.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  return {
    element_id,
    name,
    bounded_context,
    root_element,
    states,
    elements: elements as DomainElement[],
    invariants: invariants as Invariant[],
    commands: commands as Command[],
    events: events as DomainEvent[],
    transitions: transitions as StateTransition[],
    factory_rules: factoryRules as FactoryRule[],
    process_managers: [],
  };
}

function readBoundedContext(
  report: Report,
  node: Record<string, unknown>,
  where: string,
): BoundedContext | undefined {
  report.checkKeys(node, ALLOWED.bc, where);
  const element_id = report.idField(node, "element_id", where);
  const name = report.requiredString(node, "name", where);
  const aggregates = readObjectArray(report, node, "aggregates", where, true).map((raw, index) =>
    readAggregate(report, raw, `${where}/aggregates[${index}]`),
  );
  const processManagers = readObjectArray(report, node, "process_managers", where, false).map((raw, index) =>
    readProcessManager(report, raw, `${where}/process_managers[${index}]`),
  );
  if (aggregates.length === 0) {
    report.add("schema.structure", `${where}: aggregates needs at least one entry`);
  }
  if (
    element_id === undefined ||
    name === undefined ||
    aggregates.some((entry) => entry === undefined) ||
    processManagers.some((entry) => entry === undefined)
  ) {
    return undefined;
  }
  return {
    element_id,
    name,
    aggregates: aggregates as Aggregate[],
    process_managers: processManagers as ProcessManager[],
  };
}

function readLineage(report: Report, node: Record<string, unknown>, where: string): ElementLineage | undefined {
  report.checkKeys(node, ALLOWED.lineage, where);
  const lineage_id = report.requiredString(node, "lineage_id", where);
  const elementIdRaw = report.requiredString(node, "element_id", where);
  const relation = node.relation;
  if (relation !== "renamed" && relation !== "split" && relation !== "merged" && relation !== "deprecated") {
    report.add("lineage.shape", `${where}: relation must be renamed | split | merged | deprecated`);
    return undefined;
  }
  if (lineage_id === undefined || elementIdRaw === undefined || !/^lineage-\d{4}$/.test(lineage_id)) {
    if (lineage_id !== undefined) {
      report.add("lineage.shape", `${where}: lineage_id must match lineage-<4 digits>`);
    }
    return undefined;
  }
  if (!parseElementId(elementIdRaw).ok) {
    report.add("lineage.shape", `${where}: element_id must be a well-formed element_id`);
    return undefined;
  }
  const previous_name = report.optionalString(node, "previous_name", where);
  const successors = readStringArray(report, node, "successors", where, false);
  const replaced_by = report.optionalString(node, "replaced_by", where);
  const deprecated_at = report.optionalString(node, "deprecated_at", where);

  if (relation === "renamed" && previous_name === undefined) {
    report.add("lineage.shape", `${where}: renamed needs previous_name`);
  }
  if (relation === "split" && successors.length < 2) {
    report.add("lineage.shape", `${where}: split needs at least two successors`);
  }
  if (relation === "merged" && replaced_by === undefined) {
    report.add("lineage.shape", `${where}: merged needs replaced_by`);
  }
  if ((relation === "split" || relation === "merged" || relation === "deprecated") && deprecated_at === undefined) {
    report.add("lineage.shape", `${where}: ${relation} needs deprecated_at`);
  }

  return {
    lineage_id,
    element_id: elementIdRaw,
    relation,
    ...(previous_name ? { previous_name } : {}),
    successors,
    ...(replaced_by ? { replaced_by } : {}),
    ...(deprecated_at ? { deprecated_at } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reference helpers
// ---------------------------------------------------------------------------

function expectedKindRule(reason: ResolveReason): string {
  return reason === "kind-mismatch"
    ? "schema.ref-kind"
    : reason === "deprecated"
      ? "schema.ref-deprecated"
      : "schema.ref-undefined";
}

function messageFor(reason: ResolveReason, id: string, expected?: string): string {
  switch (reason) {
    case "undefined":
      return `reference "${id}" does not resolve to a current element`;
    case "deprecated":
      return `reference "${id}" points at a retired ID`;
    case "kind-mismatch":
      return `reference "${id}" is not a ${expected ?? "expected element"}`;
    default:
      return `reference "${id}" is malformed`;
  }
}

function requireRef(
  report: Report,
  resolver: ElementIndex,
  where: string,
  id: string,
  expectedKind?: ElementId["kind"],
): boolean {
  const result = resolver.resolve(id, expectedKind);
  if (!result.ok) {
    report.add(expectedKindRule(result.reason), `${where}: ${messageFor(result.reason, id, expectedKind)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cross-element validation
// ---------------------------------------------------------------------------

function validateModel(report: Report, model: DomainModel, index: ElementIndex): void {
  for (const bc of model.bounded_contexts) {
    for (const aggregate of bc.aggregates) {
      validateAggregate(report, index, bc, aggregate);
    }
    for (const pm of bc.process_managers) {
      validateProcessManager(report, index, bc, pm);
    }
  }

  validateLineage(report, index, model.lineage);

  // Derived: Aggregate.process_managers from ProcessManager.aggregates.
  const pmByAggregate = new Map<string, string[]>();
  for (const bc of model.bounded_contexts) {
    for (const pm of bc.process_managers) {
      for (const aggregateId of pm.aggregates) {
        const list = pmByAggregate.get(aggregateId) ?? [];
        list.push(pm.element_id);
        pmByAggregate.set(aggregateId, list);
      }
    }
  }
  for (const bc of model.bounded_contexts) {
    for (const aggregate of bc.aggregates) {
      aggregate.process_managers = [...(pmByAggregate.get(aggregate.element_id) ?? [])].sort();
    }
  }
}

type OperationKind = Extract<ElementId["kind"], "command" | "factory">;

/** The aggregate key each kind of operation is declared under. */
const OPERATION_SECTION: Readonly<Record<OperationKind, string>> = { command: "commands", factory: "factory_rules" };

/** The operation a DomainError is declared under, as the ownership checks need to see it. */
interface OwningOperation {
  readonly element_id: string;
  readonly kind: OperationKind;
  /** The operation-name segment of its element_id, absent when that ID is malformed. */
  readonly nameSegment: string | undefined;
}

/**
 * A DomainError belongs to the operation that declares it. Resolving its owner reference is a
 * separate question from that ownership: a reference naming a different operation that exists
 * resolves cleanly, so the declared owner is also compared against the containing operation.
 */
function validateErrorOwnership(
  report: Report,
  index: ElementIndex,
  where: string,
  operation: OwningOperation,
  aggregateSegment: string | undefined,
  domainError: DomainError,
): void {
  requireRef(
    report,
    index,
    `${where}.${OPERATION_SECTION[operation.kind]}.${operation.element_id}.domain_errors`,
    domainError.operation,
    operation.kind,
  );
  if (domainError.operation !== operation.element_id) {
    report.add(
      "schema.id-owner-mismatch",
      `${where}: ${domainError.element_id} declares ${domainError.operation} but is contained by ${operation.element_id}`,
    );
  }
  const errorParsed = parseElementId(domainError.element_id);
  if (!errorParsed.ok) return;
  const segments = errorParsed.id.segments;
  if (
    (aggregateSegment !== undefined && segments[0] !== aggregateSegment) ||
    (operation.nameSegment !== undefined && segments[1] !== operation.nameSegment)
  ) {
    report.add(
      "schema.id-owner-mismatch",
      `${where}: ${domainError.element_id} does not match its owning operation ${operation.element_id}`,
    );
  }
}

function validateAggregate(report: Report, index: ElementIndex, bc: BoundedContext, aggregate: Aggregate): void {
  const where = `aggregate ${aggregate.element_id}`;
  requireRef(report, index, `${where}.bounded_context`, aggregate.bounded_context, "bc");
  if (aggregate.bounded_context !== bc.element_id) {
    report.add(
      "schema.id-owner-mismatch",
      `${where}.bounded_context must match the containing BoundedContext ${bc.element_id}`,
    );
  }

  const root = index.resolve(aggregate.root_element, "entity");
  if (!root.ok) {
    report.add(
      expectedKindRule(root.reason),
      `${where}.root_element: ${messageFor(root.reason, aggregate.root_element, "entity")}`,
    );
  }

  const states = new Set(aggregate.states);
  if (aggregate.transitions.length > 0 && aggregate.states.length === 0) {
    report.add("schema.states-missing", `${where}: transitions require a non-empty states list`);
  }

  const aggregateSegment = parseElementId(aggregate.element_id).ok
    ? (parseElementId(aggregate.element_id) as { ok: true; id: ElementId }).id.segments[0]
    : undefined;

  const commandBySegment = new Map<string, Command>();
  for (const command of aggregate.commands) {
    requireRef(report, index, `${where}.commands`, command.aggregate, "aggregate");
    if (command.aggregate !== aggregate.element_id) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.commands: ${command.element_id}.aggregate must be ${aggregate.element_id}`,
      );
    }
    const parsed = parseElementId(command.element_id);
    if (parsed.ok) {
      if (aggregateSegment !== undefined && parsed.id.segments[0] !== aggregateSegment) {
        report.add(
          "schema.id-owner-mismatch",
          `${where}.commands: ${command.element_id} carries a different aggregate name`,
        );
      }
      commandBySegment.set(parsed.id.segments[1], command);
    }
    const owner: OwningOperation = {
      element_id: command.element_id,
      kind: "command",
      nameSegment: parsed.ok ? parsed.id.segments[1] : undefined,
    };
    for (const domainError of command.domain_errors) {
      validateErrorOwnership(report, index, where, owner, aggregateSegment, domainError);
    }
  }

  for (const event of aggregate.events) {
    requireRef(report, index, `${where}.events`, event.aggregate, "aggregate");
    if (event.aggregate !== aggregate.element_id) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.events: ${event.element_id}.aggregate must be ${aggregate.element_id}`,
      );
    }
    requireRef(report, index, `${where}.events.${event.element_id}.produced_by`, event.produced_by, "command");
  }

  for (const transition of aggregate.transitions) {
    requireRef(report, index, `${where}.transitions`, transition.aggregate, "aggregate");
    if (transition.aggregate !== aggregate.element_id) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.transitions: ${transition.element_id}.aggregate must be ${aggregate.element_id}`,
      );
    }
    requireRef(report, index, `${where}.transitions.${transition.element_id}.command`, transition.command, "command");
    if (aggregate.states.length > 0) {
      if (transition.from_state !== "initial" && !states.has(transition.from_state)) {
        report.add(
          "schema.state-unknown",
          `${where}.transitions.${transition.element_id}: from_state "${transition.from_state}" not in states`,
        );
      }
      if (!states.has(transition.to_state)) {
        report.add(
          "schema.state-unknown",
          `${where}.transitions.${transition.element_id}: to_state "${transition.to_state}" not in states`,
        );
      }
    }
  }

  for (const command of aggregate.commands) {
    const transitionIds = new Set(aggregate.transitions.map((t) => t.element_id));
    for (const transitionId of command.transitions) {
      if (!transitionIds.has(transitionId)) {
        report.add(
          "schema.transition-owner",
          `${where}.commands.${command.element_id}: transition "${transitionId}" is not on this aggregate`,
        );
      }
    }
    const produced = aggregate.events.find((e) => e.element_id === command.event);
    if (produced === undefined) {
      report.add(
        "schema.event-link",
        `${where}.commands.${command.element_id}: event "${command.event}" is not on this aggregate`,
      );
    } else if (produced.produced_by !== command.element_id) {
      report.add(
        "schema.event-link",
        `${where}.commands.${command.element_id}: event "${command.event}" is produced by ${produced.produced_by}`,
      );
    }
  }

  for (const factory of aggregate.factory_rules) {
    // A factory builds an element of its own aggregate: the root, another Entity, a value object, or
    // a Domain Primitive whose value rule it checks.
    const targetWhere = `${where}.factory_rules.${factory.element_id}.target_element`;
    if (requireRef(report, index, targetWhere, factory.target_element)) {
      const target = aggregate.elements.find((element) => element.element_id === factory.target_element);
      if (target === undefined) {
        report.add("schema.ref-kind", `${targetWhere}: "${factory.target_element}" is not an element of ${aggregate.element_id}`);
      }
    }
    const parsed = parseElementId(factory.element_id);
    if (parsed.ok && aggregateSegment !== undefined && parsed.id.segments[0] !== aggregateSegment) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.factory_rules: ${factory.element_id} carries a different aggregate name`,
      );
    }
    const owner: OwningOperation = {
      element_id: factory.element_id,
      kind: "factory",
      nameSegment: parsed.ok ? parsed.id.segments[1] : undefined,
    };
    for (const domainError of factory.domain_errors) {
      validateErrorOwnership(report, index, where, owner, aggregateSegment, domainError);
    }
  }

  for (const invariant of aggregate.invariants) {
    requireRef(report, index, `${where}.invariants`, invariant.aggregate, "aggregate");
    if (invariant.aggregate !== aggregate.element_id) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.invariants: ${invariant.element_id}.aggregate must be ${aggregate.element_id}`,
      );
    }
    if (invariant.element !== undefined) {
      requireRef(report, index, `${where}.invariants.${invariant.element_id}.element`, invariant.element);
    }
  }

  for (const element of aggregate.elements) {
    requireRef(report, index, `${where}.elements`, element.aggregate, "aggregate");
    if (element.aggregate !== aggregate.element_id) {
      report.add(
        "schema.id-owner-mismatch",
        `${where}.elements: ${element.element_id}.aggregate must be ${aggregate.element_id}`,
      );
    }
    for (const attribute of element.attributes) {
      if (SCALAR_TYPES.has(attribute.type)) continue;
      const result = index.resolve(attribute.type);
      if (!result.ok) {
        report.add(
          "schema.ref-undefined",
          `${where}.elements.${element.element_id}.attributes.${attribute.name}: type "${attribute.type}" is neither a scalar nor a resolvable element`,
        );
      }
    }
  }

  void commandBySegment;
}

function validateProcessManager(report: Report, index: ElementIndex, bc: BoundedContext, pm: ProcessManager): void {
  const where = `process manager ${pm.element_id}`;
  if (pm.aggregates.length < 2) {
    report.add("schema.pm-aggregates", `${where}: needs at least two aggregates`);
  }
  const aggregateIds = new Set(pm.aggregates);
  for (const aggregateId of pm.aggregates) {
    const result = index.resolve(aggregateId, "aggregate");
    if (!result.ok) {
      report.add(expectedKindRule(result.reason), `${where}: ${messageFor(result.reason, aggregateId, "aggregate")}`);
      continue;
    }
    if (!bc.aggregates.some((aggregate) => aggregate.element_id === aggregateId)) {
      report.add(
        "schema.pm-step-owner",
        `${where}: aggregate "${aggregateId}" is not in BoundedContext ${bc.element_id}`,
      );
    }
  }
  const compensationNames = new Set(pm.compensations.map((step) => step.name));
  for (const [kind, steps] of [
    ["steps", pm.steps],
    ["compensations", pm.compensations],
  ] as const) {
    for (const step of steps) {
      const result = index.resolve(step.command, "command");
      if (!result.ok) {
        report.add(
          expectedKindRule(result.reason),
          `${where}.${kind}.${step.name}: ${messageFor(result.reason, step.command, "command")}`,
        );
        continue;
      }
      const command = result.element.node as Command;
      if (!aggregateIds.has(command.aggregate)) {
        report.add(
          "schema.pm-step-owner",
          `${where}.${kind}.${step.name}: command belongs to an aggregate outside this Process Manager`,
        );
      }
      if (step.on_failure !== undefined && !compensationNames.has(step.on_failure)) {
        report.add(
          "schema.pm-compensation",
          `${where}.${kind}.${step.name}: on_failure "${step.on_failure}" is not a declared compensation`,
        );
      }
    }
  }
}

function validateLineage(report: Report, index: ElementIndex, lineage: ElementLineage[]): void {
  const lineageIds = new Set(lineage.map((entry) => entry.element_id));
  const successorIds = new Set<string>();
  for (const entry of lineage) {
    for (const successor of entry.successors) successorIds.add(successor);
    if (entry.replaced_by) successorIds.add(entry.replaced_by);
  }

  for (const entry of lineage) {
    const where = `lineage ${entry.lineage_id}`;
    const live = index.byId(entry.element_id) !== undefined;
    if (entry.relation === "renamed" && !live) {
      report.add("lineage.renamed-missing", `${where}: renamed target ${entry.element_id} is not a current element`);
    }
    if (entry.relation !== "renamed" && live) {
      report.add("lineage.still-live", `${where}: retired ID ${entry.element_id} still appears in the model`);
    }
    for (const successor of [...entry.successors, ...(entry.replaced_by ? [entry.replaced_by] : [])]) {
      if (index.byId(successor) === undefined && !lineageIds.has(successor) && !successorIds.has(successor)) {
        report.add(
          "lineage.successor-unknown",
          `${where}: successor "${successor}" is neither live nor declared in lineage`,
        );
      }
    }
  }

  // Cycle detection over element_id -> replaced_by / successors.
  const edges = new Map<string, string[]>();
  for (const entry of lineage) {
    const targets = [...entry.successors, ...(entry.replaced_by ? [entry.replaced_by] : [])];
    edges.set(entry.element_id, targets);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of edges.keys()) {
    if (visit(id)) {
      report.add("lineage.cycle", `lineage replacement graph contains a cycle through "${id}"`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Reads `docs/ddd/domain-model.yaml`: the model, its element index, or every finding that stops it. */
export function loadDomainModel(path: string): LoadResult {
  if (!existsSync(path)) {
    const report = new Report(path);
    report.add("schema.yaml-parse", `domain model not found: ${path}`);
    return { ok: false, findings: report.findings };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const report = new Report(path);
    report.add("schema.yaml-parse", `failed to parse ${path}: ${errorMessage(error)}`);
    return { ok: false, findings: report.findings };
  }
  return loadDomainModelSource(text, path);
}

/** The same read against a document held in memory; `path` names the document the findings report against. */
export function loadDomainModelSource(text: string, path: string): LoadResult {
  const report = new Report(path);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (error) {
    report.add("schema.yaml-parse", `failed to parse ${path}: ${errorMessage(error)}`);
    return { ok: false, findings: report.findings };
  }
  if (!isRecord(raw)) {
    report.add("schema.structure", `${path}: the document root must be a mapping`);
    return { ok: false, findings: report.findings };
  }
  report.checkKeys(raw, ALLOWED.domainModel, "domain-model");

  const boundedContexts = readObjectArray(report, raw, "bounded_contexts", "domain-model", true).map((node, index) =>
    readBoundedContext(report, node, `bounded_contexts[${index}]`),
  );
  if (boundedContexts.length === 0) {
    report.add("schema.structure", "bounded_contexts needs at least one entry");
  }
  const lineage = readObjectArray(report, raw, "lineage", "domain-model", false).map((node, index) =>
    readLineage(report, node, `lineage[${index}]`),
  );

  if (
    boundedContexts.some((entry) => entry === undefined) ||
    lineage.some((entry) => entry === undefined)
  ) {
    return { ok: false, findings: report.findings };
  }

  const model: DomainModel = {
    bounded_contexts: boundedContexts as BoundedContext[],
    lineage: lineage as ElementLineage[],
  };

  // Build the registry and detect duplicates / retired-ID reuse.
  const registry = new Map<string, IndexedElement>();
  const duplicates = new Set<string>();
  const retired = new Set(
    model.lineage.filter((entry) => entry.relation !== "renamed").map((entry) => entry.element_id),
  );
  const register = (element: IndexedElement): void => {
    const id = element.id.value;
    if (registry.has(id)) {
      duplicates.add(id);
      return;
    }
    if (retired.has(id)) {
      report.add("schema.id-reused", `retired ID "${id}" may not be reused by a current element`);
    }
    registry.set(id, element);
  };
  /** Commands and factory rules share one error namespace, so both index their errors alike. */
  const registerDomainErrors = (domainErrors: readonly DomainError[], owner: string): void => {
    for (const domainError of domainErrors) {
      const id = parseElementId(domainError.element_id);
      if (id.ok) register({ id: id.id, kind: "error", name: domainError.name, owner, node: domainError });
    }
  };

  const commandsByAggregate = new Map<string, Command[]>();
  for (const bc of model.bounded_contexts) {
    const bcId = parseElementId(bc.element_id);
    if (bcId.ok) {
      register({ id: bcId.id, kind: "bc", name: bc.name, node: bc });
    }
    for (const aggregate of bc.aggregates) {
      const aggregateId = parseElementId(aggregate.element_id);
      if (aggregateId.ok) {
        register({ id: aggregateId.id, kind: "aggregate", name: aggregate.name, node: aggregate });
      }
      commandsByAggregate.set(aggregate.element_id, aggregate.commands);
      for (const element of aggregate.elements) {
        const id = parseElementId(element.element_id);
        if (id.ok)
          register({ id: id.id, kind: id.id.kind, name: element.name, owner: aggregate.element_id, node: element });
      }
      for (const invariant of aggregate.invariants) {
        const id = parseElementId(invariant.element_id);
        if (id.ok)
          register({
            id: id.id,
            kind: "invariant",
            name: invariant.name,
            owner: aggregate.element_id,
            statement: invariant.statement,
            node: invariant,
          });
      }
      for (const command of aggregate.commands) {
        const id = parseElementId(command.element_id);
        if (id.ok)
          register({ id: id.id, kind: "command", name: command.name, owner: aggregate.element_id, node: command });
        registerDomainErrors(command.domain_errors, aggregate.element_id);
      }
      for (const event of aggregate.events) {
        const id = parseElementId(event.element_id);
        if (id.ok) register({ id: id.id, kind: "event", name: event.name, owner: aggregate.element_id, node: event });
      }
      for (const transition of aggregate.transitions) {
        const id = parseElementId(transition.element_id);
        if (id.ok)
          register({
            id: id.id,
            kind: "transition",
            name: transition.name,
            owner: aggregate.element_id,
            node: transition,
          });
      }
      for (const factory of aggregate.factory_rules) {
        const id = parseElementId(factory.element_id);
        if (id.ok)
          register({ id: id.id, kind: "factory", name: factory.name, owner: aggregate.element_id, node: factory });
        registerDomainErrors(factory.domain_errors, aggregate.element_id);
      }
    }
    for (const pm of bc.process_managers) {
      const id = parseElementId(pm.element_id);
      if (id.ok) register({ id: id.id, kind: "pm", name: pm.name, node: pm });
    }
  }

  for (const id of duplicates) {
    report.add("schema.id-duplicate", `element_id "${id}" appears more than once`);
  }

  const index = createElementIndex(model, registry, commandsByAggregate);
  validateModel(report, model, index);

  if (report.findings.length > 0) {
    return { ok: false, findings: report.findings };
  }
  return { ok: true, model, index };
}
