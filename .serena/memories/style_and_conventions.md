# Style and conventions
- Language: TypeScript.
- Formatting/linting uses Biome (`biome.json`).
- Formatter: spaces, width 2, line width 80.
- Imports are organized by Biome assist.
- Code style favors simple classes and interfaces over extra abstraction.
- Public surface is exported from `src/index.ts`.
- Tests live beside internal implementation under `src/internal/*.test.ts` and `src/internal/test/*`.
- Domain examples prefer immutable updates (`withVersion`, returning new aggregate instances).
- Project-specific agent rules from AGENTS.md: avoid ambiguous suffixes like `Manager`, `Util`, `Service`; prefer immutable operations; learn from existing code before proposing implementation; one public type per file for new exported types.