import { readFileSync } from "node:fs";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function readConformanceText(file: string): string {
  const bytes = readFileSync(file);
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${file}: invalid UTF-8`);
  }
}
