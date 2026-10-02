/**
 * Project scan scope — the shared answer to "does this directory entry belong to the inspected
 * project?".
 *
 * Every walk that discovers files beneath an application project root asks the same question, so it
 * is owned here rather than restated per walk: the Rust module layout check and the project settings
 * document search must agree on what is inside the project, or one of them would report on generated
 * and third-party trees the other deliberately skips.
 */

/** Third-party and generated trees. Application-owned source is never placed inside them. */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "target", "vendor", "dist"]);

/** True when a walk must not descend into this entry or count it as project content. */
export function isExcludedFromProjectScan(entryName: string): boolean {
  return entryName.startsWith(".") || EXCLUDED_DIRECTORIES.has(entryName);
}
