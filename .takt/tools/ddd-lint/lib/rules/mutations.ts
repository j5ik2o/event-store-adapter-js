/**
 * How a mutating method of a domain type is judged against the model, whatever language it is
 * written in: which model aggregate the type is bound to, whether the mapping declares the method a
 * replay of one of that aggregate's events, and which of the rules (b) and (c) the method falls under.
 *
 * Each language finds its own types and methods and resolves its own parameter types; the binding
 * and the classification those facts are judged by are stated here once, so the Rust and TypeScript
 * domain gates give one mutation one answer.
 */

import type { Aggregate } from "../schema/model.ts";
import { POST_INIT, snakeToKebab, toPascal } from "./lists.ts";
import type { ModelAvailability, MutatorSymbol } from "./types.ts";

/** What a mapping entry states about the aggregate a replay method belongs to. */
export interface ReplayDeclaringMapping {
  readonly aggregate_ref: string;
  readonly persistence_method: string;
  readonly replay_methods: readonly { readonly method: string; readonly event_ref: string }[];
}

/** A domain type as the binding reads it: its name, and the key a note names it by. */
interface BindableType {
  readonly name: string;
  readonly key: string;
}

interface AggregateBinding {
  readonly aggregate?: string;
  readonly ambiguous: boolean;
}

/**
 * The model aggregate `type` is the root of. A mapping entry placed where the type is decides
 * between several candidates; without one, a single candidate binds only when no other domain type
 * has the same name (`sameNameCount` counts the type itself). An undecidable binding is noted.
 */
export function bindAggregate<M extends ReplayDeclaringMapping>(
  type: BindableType,
  sameNameCount: number,
  model: ModelAvailability,
  mappings: readonly M[],
  locatedAt: (mapping: M) => boolean,
  notes: Set<string>,
): AggregateBinding {
  if (!model.index) return { ambiguous: false };
  const matches = model.index.elements("aggregate").filter((entry) => {
    const aggregate = entry.node as Aggregate;
    const root = model.index?.byId(aggregate.root_element);
    return root && (root.name === type.name || toPascal(root.id.segments.join("-")) === type.name);
  });
  if (matches.length === 0) return { ambiguous: false };
  const explicit = matches.filter((entry) =>
    mappings.some((mapping) => mapping.aggregate_ref === entry.id.value && locatedAt(mapping)),
  );
  if (explicit.length === 1) return { aggregate: explicit[0].id.value, ambiguous: false };
  if (matches.length !== 1 || sameNameCount !== 1) {
    notes.add(`model.unresolved: ${type.key} has an ambiguous model/type binding`);
    return { ambiguous: true };
  }
  return { aggregate: matches[0].id.value, ambiguous: false };
}

/**
 * The type names a replay method's one parameter may have when the mapping declares `methodName` a
 * replay method of `aggregate`: the declared event's name and its PascalCase id. Undefined when the
 * mapping declares no such replay, so the method is judged as any other mutation.
 */
export function declaredReplayEventNames<M extends ReplayDeclaringMapping>(
  methodName: string,
  paramCount: number,
  aggregate: string | undefined,
  model: ModelAvailability,
  mappings: readonly M[],
  locatedAt: (mapping: M) => boolean,
): readonly string[] | undefined {
  if (!aggregate || !model.index || paramCount !== 1) return undefined;
  const declarations = mappings.filter((mapping) => mapping.aggregate_ref === aggregate);
  if (declarations.length !== 1) return undefined;
  const mapping = declarations[0];
  if (mapping.persistence_method !== "event-sourcing" || !locatedAt(mapping)) return undefined;
  const methods = mapping.replay_methods.filter((replay) => replay.method === methodName);
  if (methods.length !== 1) return undefined;
  const event = model.index.resolve(methods[0].event_ref, "event");
  if (!event.ok || event.element.owner !== aggregate) return undefined;
  return [event.element.name, toPascal(event.element.id.segments.join("-"))];
}

/** A mutating method as it is written: its name and where it is declared. */
interface MutatingMethod {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

/**
 * Which rule a mutating method falls under: a declared command, an exempt replay, a post-init
 * method (c), an undeclared mutation (b), or unknown when the model cannot decide.
 */
export function classifyMutation(
  method: MutatingMethod,
  aggregate: string | undefined,
  model: ModelAvailability,
  replay: boolean,
  ambiguous: boolean,
): MutatorSymbol {
  const command_slug = snakeToKebab(method.name);
  const base = { method_name: method.name, command_slug, line: method.line, file: method.file };
  if (ambiguous) return { ...base, classification: "unknown" };
  if (replay) return { ...base, classification: "replay-exempt" };
  if (POST_INIT.has(method.name)) return { ...base, classification: "post-init" };
  if (model.status !== "available" || !model.index) return { ...base, classification: "unknown" };
  const declared =
    aggregate !== undefined &&
    model.index
      .commandsOf(aggregate)
      .some(
        (command) =>
          command.element_id.split(".").slice(2).join("-") === command_slug ||
          command.element_id.endsWith(`.${command_slug}`),
      );
  return { ...base, classification: declared ? "declared-command" : "undeclared" };
}
