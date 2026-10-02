import type { Dirent } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_NAME } from "../project-settings/contract.ts";
import { isExcludedFromProjectScan } from "../shared/project-scope.ts";

/**
 * Where a layout check's walk records a finding: `module-layout.<rule>` at `path`.
 *
 * Every language's layout check walks the project with the two functions below, so what the walk
 * reports — nested settings, symbolic links, unreadable directories — carries the same rule and the
 * same words whichever language the project uses. What each check collects from the entries it keeps
 * stays with that check.
 */
export type LayoutReport = (rule: string, path: string, message: string) => void;

/**
 * The entries of `directory`, or `undefined` when it cannot be listed.
 *
 * The project settings search refuses a tree it cannot list; the layout checks report the same fact in
 * their own vocabulary, beside the symbolic links they already decline to inspect, so an unreadable
 * directory yields a finding the caller can act on instead of an exception from the walk.
 */
export function readLayoutDirectory(directory: string, report: LayoutReport): Dirent[] | undefined {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    report(
      "unresolved",
      directory,
      `cannot inspect this directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Whether the walk goes on to `entry` of `directory`, reporting what it declines on the way.
 *
 * A settings document below the project root is reported before the scan exclusion is asked, because
 * its own dotted name is one the scan excludes; only the root document is read. Any other entry the
 * project scan excludes is skipped silently, and a symbolic link is reported and not followed.
 */
export function admitLayoutEntry(root: string, directory: string, entry: Dirent, report: LayoutReport): boolean {
  if (entry.name === DOCUMENT_NAME && directory !== root)
    report(
      "configuration",
      join(directory, entry.name),
      "nested layout configuration is not allowed; use the project-root .ddd.toml",
    );
  if (isExcludedFromProjectScan(entry.name)) return false;
  if (entry.isSymbolicLink()) {
    report("unresolved", join(directory, entry.name), "symbolic links in the inspected project are not supported");
    return false;
  }
  return true;
}
