/**
 * Domain packaging for the Rust gates: the modules of a domain crate, as its module walk gives them,
 * handed to the language-independent packaging decision.
 */

import { join } from "node:path";
import { mappingPathOf } from "../../aggregate-mapping/index.ts";
import { packageWord, technicalName } from "../../packaging/declarations.ts";
import { type DeclaredPackages, packagingFindings } from "../../packaging/evaluate.ts";
import { relPath } from "../../project/context.ts";
import type { FindingInput } from "../../shared/findings.ts";
import type { InspectionContext, InspectionTarget } from "../types.ts";

export function evaluateDomainPackaging(target: InspectionTarget, context: InspectionContext): FindingInput[] {
  const crate = context.assignments.find((entry) => entry.crate_name === target.crate_name);
  if (crate?.layer !== "domain") return [];
  // The program is built from every crate a layer is assigned to, this one included, so its module
  // walk is the one this check reads rather than a second walk over the same declarations.
  const inventory = context.program.moduleInventories.get(crate.crate_name);
  if (!inventory) throw new Error(`the program carries no module walk for ${crate.crate_name}`);
  const crateName = technicalName([packageWord(crate.crate_name)]);
  const unreachable = context.targets
    .filter((entry) => entry.crate_name === crate.crate_name)
    .filter((target) => !inventory.files.has(target.sourceFile.path))
    .map((target) => ({
      file: target.sourceFile.path,
      reason: "Rust file is not reachable from this crate's module roots",
    }));
  const mapping = context.rustMapping;
  // The raw prefix only lets a keyword be spelled, so it never distinguishes two modules here.
  const declared: DeclaredPackages =
    mapping.kind === "loaded"
      ? {
          kind: "loaded",
          packages: mapping.view.packages.map((entry) => ({
            package: entry.crate,
            module: entry.module.map((segment) => segment.replace(/^r#/, "")),
          })),
        }
      : mapping;
  return packagingFindings(
    {
      name: crate.crate_name,
      manifestFile: join(crate.path, "Cargo.toml"),
      unit: "crate",
      separator: "::",
      ...(crateName || crate.crate_name === "domain" ? { technicalName: crateName ?? "domain" } : {}),
      modules: inventory.modules.map((module) => {
        const banned = technicalName([...module.parts, ...module.physical]);
        return { parts: module.parts, file: module.file, line: module.line, ...(banned ? { technical: banned } : {}) };
      }),
      problems: [...inventory.problems, ...unreachable],
    },
    declared,
    relPath(context.run, mappingPathOf(context.run.modelDir)),
  );
}
