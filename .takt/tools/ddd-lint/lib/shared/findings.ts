/** A finding: the one report shape every check returns. */

export interface FindingInput {
  rule_id: string;
  file: string;
  line?: number;
  message: string;
}

/** rule_id, file and message are mandatory; a line is a positive integer. */
export function assertFindingInput(input: FindingInput): void {
  if (!input.rule_id || !input.file || !input.message) {
    throw new Error(`finding is missing a required field: ${JSON.stringify(input)}`);
  }
  if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
    throw new Error(`finding line must be a positive integer: ${input.line}`);
  }
}
