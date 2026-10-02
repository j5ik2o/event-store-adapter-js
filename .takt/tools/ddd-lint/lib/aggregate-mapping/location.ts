/**
 * Which package owns a code location. Ownership is derived from the locations alone: a package owns
 * the location it is declared at, and its parent is the package one module segment up. No key is
 * invented to link them, so Rust and TypeScript documents state ownership the same way.
 */

import type { CodeLocation, DomainPackageMapping } from "./contract.ts";
import { SPELLINGS } from "./language.ts";

/** Equal for two locations exactly when their language treats them as the same module. */
export function locationKey(location: CodeLocation): string {
  const spelling = SPELLINGS[location.language];
  return JSON.stringify([
    location.language,
    location.package,
    ...location.module.map((segment) => spelling.segmentIdentity(segment)),
  ]);
}

export function rootLocation(location: CodeLocation): CodeLocation {
  return { language: location.language, package: location.package, module: [] };
}

/** The location one module segment up, or undefined for a package root. */
export function parentLocation(location: CodeLocation): CodeLocation | undefined {
  if (location.module.length === 0) return undefined;
  return { language: location.language, package: location.package, module: location.module.slice(0, -1) };
}

/** Every location above this one, up to but not including the package root. */
export function intermediateLocations(location: CodeLocation): CodeLocation[] {
  return location.module
    .slice(1)
    .map((_, index) => ({ ...rootLocation(location), module: location.module.slice(0, index + 1) }));
}

/** The package declared at `location`, if any. */
export function packageAt(
  mapping: { readonly domain_packages: readonly DomainPackageMapping[] },
  location: CodeLocation,
): DomainPackageMapping | undefined {
  const key = locationKey(location);
  return mapping.domain_packages.find((entry) => locationKey(entry.code) === key);
}

/** A location as findings name it, e.g. `rust billing-domain/invoice/number`. */
export function describeLocation(location: CodeLocation): string {
  return `${location.language} ${[location.package, ...location.module].join("/")}`;
}
