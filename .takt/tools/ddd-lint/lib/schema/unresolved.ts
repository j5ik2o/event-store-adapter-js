/** References of a model its element index cannot resolve. */

import type { ElementIndex } from "./index-builder.ts";
import type { DomainModel } from "./model.ts";

export interface UnresolvedReference {
  id: string;
  reason: string;
  expected?: string;
}

/** Walk every reference attribute and report those the index cannot resolve. */
export function collectUnresolved(model: DomainModel, index: ElementIndex): UnresolvedReference[] {
  const out: UnresolvedReference[] = [];
  const check = (id: string, expected?: string): void => {
    if (!id) return;
    const result = index.resolve(id, expected as never);
    if (!result.ok) out.push({ id, reason: result.reason, ...(expected ? { expected } : {}) });
  };
  for (const bc of model.bounded_contexts) {
    for (const aggregate of bc.aggregates) {
      check(aggregate.bounded_context, "bc");
      check(aggregate.root_element, "entity");
      for (const element of aggregate.elements) {
        check(element.aggregate, "aggregate");
        for (const attribute of element.attributes) {
          const looksLikeId = /^(entity|vo|primitive)\./.test(attribute.type);
          if (looksLikeId) check(attribute.type);
        }
      }
      for (const invariant of aggregate.invariants) {
        check(invariant.aggregate, "aggregate");
        if (invariant.element) check(invariant.element);
      }
      for (const command of aggregate.commands) {
        check(command.aggregate, "aggregate");
        for (const transition of command.transitions) check(transition, "transition");
        check(command.event, "event");
        for (const error of command.domain_errors) check(error.operation, "command");
      }
      for (const event of aggregate.events) {
        check(event.aggregate, "aggregate");
        check(event.produced_by, "command");
      }
      for (const transition of aggregate.transitions) {
        check(transition.aggregate, "aggregate");
        check(transition.command, "command");
      }
      for (const factory of aggregate.factory_rules) {
        check(factory.target_element);
        for (const error of factory.domain_errors) check(error.operation, "factory");
      }
    }
    for (const pm of bc.process_managers) {
      for (const aggregateId of pm.aggregates) check(aggregateId, "aggregate");
      for (const step of [...pm.steps, ...pm.compensations]) check(step.command, "command");
    }
  }
  return out;
}
