import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCase } from "./conformance-case";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceStatus } from "./conformance-status";

export type CaseClassification = {
  status: ConformanceStatus;
  reason: string;
};

type JsonRecord = { readonly [key: string]: ConformanceJsonValue };

const isRecord = (v: ConformanceJsonValue | undefined): v is JsonRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asList = (
  v: ConformanceJsonValue | undefined,
): readonly ConformanceJsonValue[] => (Array.isArray(v) ? v : []);

const recordValues = (
  v: ConformanceJsonValue | undefined,
): readonly ConformanceJsonValue[] => (isRecord(v) ? Object.values(v) : []);

const seqNrsOf = (body: JsonRecord): readonly ConformanceJsonValue[] => {
  const input = isRecord(body.input) ? body.input : {};
  const fixtures = isRecord(body.fixtures) ? body.fixtures : {};
  const fixtureSeqNrs = [fixtures.events, fixtures.snapshots]
    .flatMap(recordValues)
    .map((f) => (isRecord(f) ? f.seq_nr : undefined));
  const stepSeqNrs = asList(body.steps).map((s) =>
    isRecord(s) && isRecord(s.arguments) ? s.arguments.seq_nr : undefined,
  );
  return [
    input.seq_nr,
    input.event_seq_nr,
    ...fixtureSeqNrs,
    ...stepSeqNrs,
  ].filter((v): v is ConformanceJsonValue => v !== undefined);
};

const isExactNumber = (v: ConformanceJsonValue): boolean => {
  if (typeof v !== "bigint") {
    return true;
  }
  const n = Number(v);
  return Number.isFinite(n) && BigInt(n) === v;
};

export function classifyCase(
  c: ConformanceCase,
  backend: ConformanceBackend,
): CaseClassification {
  const body = isRecord(c.body) ? c.body : {};
  const representation = isRecord(body.representation)
    ? body.representation
    : {};
  if (body.operation === "fnv1a64") {
    return {
      status: "not-applicable",
      reason: "最初のメジャーにハッシュを使う保存先がない（段階5で実行する）",
    };
  }
  if (representation.time_precision === "nanoseconds") {
    return { status: "not-applicable", reason: "Date はミリ秒精度である" };
  }
  if (backend === "memory" && asList(body.requires).includes("ttl")) {
    return { status: "not-applicable", reason: "MEM-12" };
  }
  if (!seqNrsOf(body).every(isExactNumber)) {
    return {
      status: "not-representable",
      reason: "seq_nr が number で正確に表せない",
    };
  }
  return {
    status: "unverified",
    reason: "保存先の境界の実装がまだない",
  };
}
