/**
 * How each language spells a package name, and which part of that spelling is the package's own.
 *
 * Two artifacts that name the same package have to agree on what a package name is, so the grammar
 * lives here once rather than in each of them. A scope only names the publisher, so the name a
 * business word is read out of is the one with the scope removed.
 */

export const PACKAGE_LANGUAGES = ["rust", "typescript"] as const;
export type PackageLanguage = (typeof PACKAGE_LANGUAGES)[number];

const RUST_PACKAGE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TYPESCRIPT_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_SCOPE = /^@[^/]+\//;

const GRAMMARS: Readonly<Record<PackageLanguage, RegExp>> = { rust: RUST_PACKAGE, typescript: TYPESCRIPT_PACKAGE };

export function isPackageName(language: PackageLanguage, name: string): boolean {
  return GRAMMARS[language].test(name);
}

/** The package's own name, with a scope that names only its publisher set aside. */
export function barePackageName(language: PackageLanguage, name: string): string {
  return language === "typescript" ? name.replace(PACKAGE_SCOPE, "") : name;
}
