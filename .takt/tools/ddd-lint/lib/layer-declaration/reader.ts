/**
 * Reads the shape of a layer declaration, before any model is consulted.
 *
 * The key set is closed at every level, so a crate list, a crate beside a package or a module path
 * inside a package identity is refused rather than ignored. Package names are checked against the
 * grammar of the language the identity declares. Nothing is coerced, defaulted or dropped: a verb
 * list is empty only when the document says so, and a flag the crate format used to supply on its
 * own reads as absent, which `completeDeclaration` reports rather than fills in.
 */

import type { FindingInput } from "../shared/findings.ts";
import { isPackageName } from "../shared/package-name.ts";
import {
  allDefined,
  isRecord,
  own,
  readChoice,
  readNodes,
  readOptionalBoolean,
  readOptionalChoice,
  readOptionalText,
  readOptionalTextList,
  readText,
} from "../shared/yaml-read.ts";
import {
  IO_UNITS,
  LAYER_LANGUAGES,
  type LayerDeclaration,
  type LayerDeclarationDraft,
  type LayerPackage,
  LayerReport,
  type LayerStructure,
  type LayerStructureDraft,
  PACKAGE_ROLES,
  type PackageDependency,
  type PackageIdentity,
  PORT_KINDS,
  type PortDeclaration,
  type PortDraft,
  RESTORATION_ROUTES,
  type RepositoryDeclaration,
  type RepositoryDraft,
  type RestorationPath,
  type RestorationPathDraft,
  STORE_SEMANTICS,
  structureWhere,
} from "./contract.ts";

const KEYS = {
  root: ["model_ref", "layer_structures"],
  structure: [
    "context_ref",
    "cqrs",
    "packages",
    "dependencies",
    "ports",
    "repositories",
    "restoration_paths",
    "persistence_backend",
  ],
  package: ["role", "code"],
  identity: ["language", "package"],
  dependency: ["code", "depends_on"],
  port: ["name", "kind", "verbs"],
  repository: ["name", "aggregate_ref", "io_unit", "verbs", "store_semantics"],
  restoration: ["aggregate_ref", "via", "note"],
} as const;

function structure(report: LayerReport, message: string): undefined {
  report.structure(message);
  return undefined;
}

// ---------------------------------------------------------------------------
// Package identity
// ---------------------------------------------------------------------------

/** A package identity: the language that spells the name, and the name in that spelling. */
function readIdentity(report: LayerReport, node: unknown, where: string): PackageIdentity | undefined {
  if (!isRecord(node))
    return structure(report, `${where}: a package is named by its language and its name, not by a bare value`);
  report.unknownKeys(node, KEYS.identity, where);
  const language = readChoice(report, node, "language", LAYER_LANGUAGES, where);
  const name = readText(report, node, "package", where);
  if (language === undefined || name === undefined) return undefined;
  if (!isPackageName(language, name))
    return structure(report, `${where}: "package" ${JSON.stringify(name)} is not a package name ${language} spells`);
  return { language, package: name };
}

function readPackage(
  report: LayerReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): LayerPackage | undefined {
  report.unknownKeys(node, KEYS.package, where);
  const role = readChoice(report, node, "role", PACKAGE_ROLES, where);
  const code = readIdentity(report, own(node, "code"), `${where}.code`);
  if (role === undefined || code === undefined) return undefined;
  return { role, code };
}

function readDependency(
  report: LayerReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): PackageDependency | undefined {
  report.unknownKeys(node, KEYS.dependency, where);
  const code = readIdentity(report, own(node, "code"), `${where}.code`);
  const targets = own(node, "depends_on");
  if (!Array.isArray(targets)) return structure(report, `${where}: "depends_on" must be a list`);
  const dependsOn = targets.map((target, index) => readIdentity(report, target, `${where}.depends_on[${index}]`));
  if (code === undefined || !allDefined(dependsOn)) return undefined;
  return { code, depends_on: dependsOn };
}

// ---------------------------------------------------------------------------
// The items a context declares
// ---------------------------------------------------------------------------

function readPort(report: LayerReport, node: Readonly<Record<string, unknown>>, where: string): PortDraft | undefined {
  report.unknownKeys(node, KEYS.port, where);
  const name = readText(report, node, "name", where);
  const kind = readOptionalChoice(report, node, "kind", PORT_KINDS, where);
  const verbs = readOptionalTextList(report, node, "verbs", where, { minimum: 0 });
  if (name === undefined || kind === undefined || verbs === undefined) return undefined;
  return { name, ...(kind.present ? { kind: kind.value } : {}), ...(verbs.present ? { verbs: verbs.value } : {}) };
}

function readRepository(
  report: LayerReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): RepositoryDraft | undefined {
  report.unknownKeys(node, KEYS.repository, where);
  const name = readText(report, node, "name", where);
  const aggregateRef = readText(report, node, "aggregate_ref", where);
  const ioUnit = readOptionalChoice(report, node, "io_unit", IO_UNITS, where);
  const verbs = readOptionalTextList(report, node, "verbs", where, { minimum: 0 });
  const storeSemantics = readOptionalChoice(report, node, "store_semantics", STORE_SEMANTICS, where);
  if (
    name === undefined ||
    aggregateRef === undefined ||
    ioUnit === undefined ||
    verbs === undefined ||
    storeSemantics === undefined
  )
    return undefined;
  return {
    name,
    aggregate_ref: aggregateRef,
    ...(ioUnit.present ? { io_unit: ioUnit.value } : {}),
    ...(verbs.present ? { verbs: verbs.value } : {}),
    ...(storeSemantics.present ? { store_semantics: storeSemantics.value } : {}),
  };
}

function readRestorationPath(
  report: LayerReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): RestorationPathDraft | undefined {
  report.unknownKeys(node, KEYS.restoration, where);
  const aggregateRef = readText(report, node, "aggregate_ref", where);
  const via = readOptionalChoice(report, node, "via", RESTORATION_ROUTES, where);
  const note = readOptionalText(report, node, "note", where);
  if (aggregateRef === undefined || via === undefined || note === undefined) return undefined;
  return {
    aggregate_ref: aggregateRef,
    ...(via.present ? { via: via.value } : {}),
    ...(note.present ? { note: note.value } : {}),
  };
}

function readStructure(
  report: LayerReport,
  node: Readonly<Record<string, unknown>>,
  where: string,
): LayerStructureDraft | undefined {
  report.unknownKeys(node, KEYS.structure, where);
  const contextRef = readText(report, node, "context_ref", where);
  const cqrs = readOptionalBoolean(report, node, "cqrs", where);
  const packages = readNodes(report, node, "packages", where, true)?.map((entry, index) =>
    readPackage(report, entry, `${where}.packages[${index}]`),
  );
  const dependencies = readNodes(report, node, "dependencies", where, true)?.map((entry, index) =>
    readDependency(report, entry, `${where}.dependencies[${index}]`),
  );
  const ports = readNodes(report, node, "ports", where, true)?.map((entry, index) =>
    readPort(report, entry, `${where}.ports[${index}]`),
  );
  const repositories = readNodes(report, node, "repositories", where, true)?.map((entry, index) =>
    readRepository(report, entry, `${where}.repositories[${index}]`),
  );
  const restorationPaths = readNodes(report, node, "restoration_paths", where, true)?.map((entry, index) =>
    readRestorationPath(report, entry, `${where}.restoration_paths[${index}]`),
  );
  const backend = readText(report, node, "persistence_backend", where);
  if (
    contextRef === undefined ||
    cqrs === undefined ||
    backend === undefined ||
    packages === undefined ||
    !allDefined(packages) ||
    dependencies === undefined ||
    !allDefined(dependencies) ||
    ports === undefined ||
    !allDefined(ports) ||
    repositories === undefined ||
    !allDefined(repositories) ||
    restorationPaths === undefined ||
    !allDefined(restorationPaths)
  )
    return undefined;
  return {
    context_ref: contextRef,
    ...(cqrs.present ? { cqrs: cqrs.value } : {}),
    packages,
    dependencies,
    ports,
    repositories,
    restoration_paths: restorationPaths,
    persistence_backend: backend,
  };
}

type DraftRead =
  | { readonly kind: "read"; readonly draft: LayerDeclarationDraft }
  | { readonly kind: "rejected"; readonly findings: readonly FindingInput[] };

/**
 * A root read into a draft declaration. Every finding
 * names `file`, the document the root was read from.
 */
export function readLayerDraft(root: Readonly<Record<string, unknown>>, file: string): DraftRead {
  const report = new LayerReport(file);
  report.unknownKeys(root, KEYS.root, "layer declaration");
  const modelRef = readText(report, root, "model_ref", "layer declaration");
  const structures = readNodes(report, root, "layer_structures", "layer declaration", true)?.map((entry, index) =>
    readStructure(report, entry, `layer_structures[${index}]`),
  );
  if (report.findings.length > 0 || modelRef === undefined || structures === undefined || !allDefined(structures))
    return { kind: "rejected", findings: report.findings };
  return {
    kind: "read",
    draft: { model_ref: modelRef, layer_structures: structures },
  };
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

type Completion =
  | { readonly complete: true; readonly declaration: LayerDeclaration }
  | { readonly complete: false; readonly missing: readonly string[] };

function present<T>(value: T | undefined, where: string, missing: string[]): value is T {
  if (value !== undefined) return true;
  missing.push(where);
  return false;
}

function completePort(port: PortDraft, where: string, missing: string[]): PortDeclaration | undefined {
  const kind = present(port.kind, `${where}.kind`, missing) ? port.kind : undefined;
  const verbs = present(port.verbs, `${where}.verbs`, missing) ? port.verbs : undefined;
  if (kind === undefined || verbs === undefined) return undefined;
  return { name: port.name, kind, verbs };
}

function completeRepository(
  repository: RepositoryDraft,
  where: string,
  missing: string[],
): RepositoryDeclaration | undefined {
  const ioUnit = present(repository.io_unit, `${where}.io_unit`, missing) ? repository.io_unit : undefined;
  const verbs = present(repository.verbs, `${where}.verbs`, missing) ? repository.verbs : undefined;
  const semantics = present(repository.store_semantics, `${where}.store_semantics`, missing)
    ? repository.store_semantics
    : undefined;
  if (ioUnit === undefined || verbs === undefined || semantics === undefined) return undefined;
  return {
    name: repository.name,
    aggregate_ref: repository.aggregate_ref,
    io_unit: ioUnit,
    verbs,
    store_semantics: semantics,
  };
}

function completeRestorationPath(
  path: RestorationPathDraft,
  where: string,
  missing: string[],
): RestorationPath | undefined {
  if (!present(path.via, `${where}.via`, missing)) return undefined;
  return {
    aggregate_ref: path.aggregate_ref,
    via: path.via,
    ...(path.note === undefined ? {} : { note: path.note }),
  };
}

/**
 * The draft as a declaration, or the positions it still says nothing about. The order is the order
 * of the document: each structure in turn, and inside one the flag before the ports, the ports
 * before the repositories and the repositories before the restoration paths.
 */
export function completeDeclaration(draft: LayerDeclarationDraft): Completion {
  const missing: string[] = [];
  const structures: LayerStructure[] = [];
  for (const draftStructure of draft.layer_structures) {
    const where = structureWhere(draftStructure.context_ref);
    const cqrs = present(draftStructure.cqrs, `${where}.cqrs`, missing) ? draftStructure.cqrs : undefined;
    const ports = draftStructure.ports.map((port) => completePort(port, `${where}.ports[${port.name}]`, missing));
    const repositories = draftStructure.repositories.map((repository) =>
      completeRepository(repository, `${where}.repositories[${repository.name}]`, missing),
    );
    const restorationPaths = draftStructure.restoration_paths.map((path) =>
      completeRestorationPath(path, `${where}.restoration_paths[${path.aggregate_ref}]`, missing),
    );
    if (cqrs === undefined || !allDefined(ports) || !allDefined(repositories) || !allDefined(restorationPaths))
      continue;
    structures.push({ ...draftStructure, cqrs, ports, repositories, restoration_paths: restorationPaths });
  }
  if (missing.length > 0) return { complete: false, missing };
  return { complete: true, declaration: { ...draft, layer_structures: structures } };
}
