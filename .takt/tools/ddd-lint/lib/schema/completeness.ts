/**
 * checkCompleteness — the rules that never fail the load.
 *
 * The model checks call this after a
 * successful `loadDomainModel`, then decide whether a finding blocks the gate
 * based on their own manifest severity.
 */

import type { FindingInput } from "../shared/findings.ts";
import type { DomainModel } from "./model.ts";

export function checkCompleteness(model: DomainModel, file = "docs/ddd/domain-model.yaml"): FindingInput[] {
  const findings: FindingInput[] = [];
  for (const bc of model.bounded_contexts) {
    for (const aggregate of bc.aggregates) {
      // (i) every Aggregate has at least one Invariant
      if (aggregate.invariants.length === 0) {
        findings.push({
          rule_id: "completeness.i",
          file,
          message: `aggregate ${aggregate.element_id} has no invariant`,
        });
      }
      // (p) a domain-primitive declares its value rule, or that it has none
      for (const element of aggregate.elements.filter((entry) => entry.kind === "domain-primitive")) {
        const invariant =
          element.invariants.length > 0 || aggregate.invariants.some((entry) => entry.element === element.element_id);
        const factory = aggregate.factory_rules.some((entry) => entry.target_element === element.element_id);
        const where = `domain-primitive ${element.element_id}`;
        if (element.unconstrained !== undefined && (invariant || factory)) {
          findings.push({
            rule_id: "completeness.primitive-rule",
            file,
            message: `${where} declares unconstrained but also a value rule; keep one`,
          });
        } else if (element.unconstrained === undefined && !(invariant && factory)) {
          findings.push({
            rule_id: "completeness.primitive-rule",
            file,
            message: invariant
              ? `${where} has an invariant but no factory rule that builds it and returns its errors`
              : factory
                ? `${where} has a factory rule but no invariant stating its value rule`
                : `${where} declares no value rule (an invariant on it and a factory rule that builds it) and no "unconstrained" rationale`,
          });
        }
      }
      for (const command of aggregate.commands) {
        // (ii) state_effect agrees with transitions
        if (command.state_effect === "transitions" && command.transitions.length === 0) {
          findings.push({
            rule_id: "completeness.ii",
            file,
            message: `command ${command.element_id} declares state_effect transitions but lists none`,
          });
        }
        if (command.state_effect === "none" && command.transitions.length > 0) {
          findings.push({
            rule_id: "completeness.ii",
            file,
            message: `command ${command.element_id} declares state_effect none but lists transitions`,
          });
        }
        // (j) accumulation requires command-id-memory
        if (command.effect === "accumulation" && command.idempotency.strategy === "none") {
          findings.push({
            rule_id: "idempotency.j",
            file,
            message: `accumulation command ${command.element_id} must use idempotency.strategy command-id-memory`,
          });
        }
        // Keeping only the last command ID holds only when an older command is never resent after a
        // newer one (C1 -> C2 -> retry C1); the rationale states why.
        // A rationale of blanks states nothing, so it counts as missing.
        if (command.idempotency.retention === "last-one" && !command.idempotency.rationale?.trim()) {
          findings.push({
            rule_id: "idempotency.last-one",
            file,
            message: `command ${command.element_id} keeps only the last command ID (retention last-one) but its rationale does not state why an older command is never resent after a newer one`,
          });
        }
      }
    }
  }
  return findings;
}
