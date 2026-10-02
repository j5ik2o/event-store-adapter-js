import { readFileSync } from "node:fs";
import { DOCUMENT_NAME, type ProjectSelection } from "../project-settings/contract.ts";
import { validateProjectSettings } from "../project-settings/settings.ts";

/**
 * The project settings of the document at `configPath`, or the configuration finding's message saying
 * why they cannot be read. Only the root document is validated here: each layout check's walk already
 * reports every nested one, and reading them a second time would report the same defect under two rules.
 *
 * Every language's layout check reads its layout through this one function and reports the message as
 * given, so a document refused by one check is refused by all of them in the same words and for the
 * same reason.
 */
export function readLayoutSelection(configPath: string): ProjectSelection | { readonly message: string } {
  const refused = (detail: string) => ({ message: `Choose one project-wide layout in ${DOCUMENT_NAME}: ${detail}` });
  let table: unknown;
  try {
    table = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  const outcome = validateProjectSettings(table as Record<string, unknown>, configPath);
  if (outcome.kind === "validated") return outcome.selection;
  const { rejection } = outcome;
  return refused(`${rejection.reason}: ${rejection.detail}`);
}
