import { spawn } from "node:child_process";
import type { ExtractionExecution, Issue, ReasonCode } from "../state-exposure/index.ts";

export interface Limits {
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface Observation {
  execution: ExtractionExecution;
  stdout: string;
  diagnostic: string;
}
export const DEFAULT_LIMITS: Limits = { timeoutMs: 30_000, maxOutputBytes: 1_048_576 };
export function issue(code: ReasonCode, subject: string, message: string = code): Issue {
  return { code, subject, message, location: null };
}

/** Resolve only after close: killing a child also reaps it and drains its pipes. */
export function observeProcess(command: readonly string[], input: string, limits: Limits): Promise<Observation> {
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0 ||
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes <= 0
  )
    throw new Error("invalid process limits");
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let started = false;
    let cause: ReasonCode | null = null;
    let outputBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = (code: ReasonCode) => {
      cause ??= code;
      child.kill("SIGKILL");
    };
    const began = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const scheduleTimeout = () => {
      const remaining = limits.timeoutMs - (performance.now() - began);
      if (remaining <= 0) {
        stop("timeout");
        return;
      }
      timer = setTimeout(scheduleTimeout, Math.min(remaining, 2_147_483_647));
    };
    scheduleTimeout();
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", () => {
      cause ??= started ? "execution-failed" : "tool-unavailable";
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) stop("output-limit");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = limits.maxOutputBytes - stderrBytes;
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
      if (stderrBytes > limits.maxOutputBytes) stop("resource-limit");
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // EPIPE is classified by the child's final status, including normal empty output.
      if (error.code !== "EPIPE") stop("execution-failed");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8");
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      if (!started)
        resolve({
          execution: { status: "unavailable", reasons: [issue("tool-unavailable", "extractor")] },
          stdout: "",
          diagnostic,
        });
      else if (cause || code !== 0)
        resolve({
          execution: { status: "failed", reasons: [issue(cause ?? "execution-failed", "extractor")] },
          stdout: "",
          diagnostic,
        });
      else resolve({ execution: { status: "completed", response: parseOutput(text) }, stdout: text, diagnostic });
    });
    child.stdin.end(input);
  });
}

export function parseOutput(stdout: string): unknown {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return "invalid-native-response";
  }
}
