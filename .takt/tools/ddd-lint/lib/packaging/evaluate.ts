/**
 * Domain packaging for the code gates: every module the inspected domain package reaches has a
 * business package declared for it, and no name below it is a technical classification.
 *
 * Whether the mapping itself is sound is the mapping reader's decision, not this one's. A mapping
 * the reader refuses yields no packages at all, and its findings are reported here under the rule
 * ids the gates already declare, so the same defect is never judged twice by two checks.
 *
 * `packagingFindings` decides for one package of any language; each gate hands it the modules its
 * language's layout gives.
 */

import { finding } from "../project/context.ts";
import type { FindingInput } from "../shared/findings.ts";
import { packageKey } from "./declarations.ts";

/** One module of the inspected package: its path below the package root and where it is written. */
export interface PackagingModule {
  readonly parts: readonly string[];
  readonly file: string;
  readonly line?: number;
  /** The technical classification a segment of its path stands on, if any. */
  readonly technical?: string;
}

/** A module whose place in the package the inspection could not decide. */
export interface PackagingProblem {
  readonly file: string;
  readonly reason: string;
  readonly line?: number;
}

/** The domain package one gate decides packaging for, as its language lays it out. */
interface PackagingSubject {
  /** The package name as the mapping spells it. */
  readonly name: string;
  /** Where a finding about the package name itself is reported. */
  readonly manifestFile: string;
  /** What the language calls the package in a message, and how it joins module segments. */
  readonly unit: "crate" | "package";
  readonly separator: string;
  /** The technical classification the package name stands on, if any. */
  readonly technicalName?: string;
  readonly modules: readonly PackagingModule[];
  readonly problems: readonly PackagingProblem[];
}

/** The packages the mapping declares in the subject's language, or why it declares none. */
export type DeclaredPackages =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly findings: readonly FindingInput[] }
  | {
      readonly kind: "loaded";
      /** Each module path spelled the way the subject's modules are, so equal paths name one package. */
      readonly packages: readonly { readonly package: string; readonly module: readonly string[] }[];
    };

/** Which rule of this gate reports a refusal the mapping reader made. */
function transcribedRule(ruleId: string): string {
  if (ruleId === "aggregate-mapping.model") return "domain-packaging.reference";
  if (ruleId === "aggregate-mapping.technical-name") return "domain-packaging.technical-name";
  return "domain-packaging.declaration";
}

/** The packaging findings for one domain package; `mappingFile` is where the mapping's findings go. */
export function packagingFindings(
  subject: PackagingSubject,
  declared: DeclaredPackages,
  mappingFile: string,
): FindingInput[] {
  const findings: FindingInput[] = [];
  if (subject.technicalName)
    findings.push(
      finding(
        "domain-packaging.technical-name",
        subject.manifestFile,
        `${subject.unit} name uses technical classification ${subject.technicalName}`,
      ),
    );
  const validModules: PackagingModule[] = [];
  for (const module of subject.modules) {
    if (module.technical)
      findings.push(
        finding(
          "domain-packaging.technical-name",
          module.file,
          `domain package ${module.parts.join(subject.separator) || subject.unit} uses technical classification ${module.technical}`,
          module.line,
        ),
      );
    else validModules.push(module);
  }
  for (const issue of subject.problems)
    findings.push(finding("domain-packaging.unresolved", issue.file, issue.reason, issue.line));
  if (declared.kind === "absent")
    return [
      ...findings,
      finding(
        "domain-packaging.declaration",
        mappingFile,
        "a readable aggregate mapping with domain_packages is required",
      ),
    ];
  if (declared.kind === "invalid")
    return [
      ...findings,
      ...declared.findings.map((entry) =>
        finding(transcribedRule(entry.rule_id), mappingFile, `${entry.rule_id}: ${entry.message}`),
      ),
    ];
  const keys = new Set(declared.packages.map((entry) => packageKey(entry.package, entry.module)));
  if (!keys.has(packageKey(subject.name, [])))
    findings.push(
      finding(
        "domain-packaging.coverage",
        mappingFile,
        `${subject.unit} ${subject.name} needs a root package declaration`,
      ),
    );
  for (const module of validModules) {
    if (module.parts.length === 0) continue;
    if (!keys.has(packageKey(subject.name, module.parts)))
      findings.push(
        finding(
          "domain-packaging.coverage",
          module.file,
          `domain package ${subject.name}/${module.parts.join(subject.separator)} has no term/model declaration`,
          module.line,
        ),
      );
  }
  return findings;
}
