# After-task checklist
- If code changes are made, run at least the relevant tests with `npm test` or a focused Jest command.
- Run `npm run lint` and, when formatting changes are expected, `npm run fix` or `npm run fmt`.
- Verify public API exports from `src/index.ts` if public types are added.
- For DynamoDB-related changes, re-check `docs/DATABASE_SCHEMA.md` against implementation assumptions.
- If work is design-only, consider whether it should be captured in OpenSpec artifacts because the repo already has `openspec/` configured.