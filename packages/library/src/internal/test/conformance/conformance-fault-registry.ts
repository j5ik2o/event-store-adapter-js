import assert from "node:assert/strict";
import { integerOf, recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

/** ケース内の全差し込み口が共有する宣言順の登録簿。 */
export class ConformanceFaultRegistry {
  private operation = 0;
  private entries: {
    declaration: ConformanceJsonValue;
    fired: number;
    applied: number;
  }[];

  constructor(faults: readonly ConformanceJsonValue[]) {
    this.entries = faults.map((declaration) => ({
      declaration,
      fired: 0,
      applied: 0,
    }));
  }

  begin(operation: number): void {
    this.operation = operation;
  }

  take(phase: string) {
    const index = this.entries.findIndex(({ declaration, fired }) => {
      const fault = recordOf(declaration);
      const repeat = recordOf(fault.repeat);
      return (
        Number(integerOf(fault.operation)) === this.operation &&
        fault.phase === phase &&
        (repeat.mode === "until-operation-finishes" ||
          fired < Number(integerOf(repeat.count)))
      );
    });
    if (index < 0) return undefined;
    this.entries = this.entries.map((entry, position) =>
      position === index ? { ...entry, fired: entry.fired + 1 } : entry,
    );
    return { index, declaration: recordOf(this.entries[index].declaration) };
  }

  applied(index: number): void {
    this.entries = this.entries.map((entry, position) =>
      position === index ? { ...entry, applied: entry.applied + 1 } : entry,
    );
  }

  finish(operation: number): void {
    for (const { declaration, fired, applied } of this.entries) {
      const fault = recordOf(declaration);
      if (Number(integerOf(fault.operation)) !== operation) continue;
      const repeat = recordOf(fault.repeat);
      assert.ok(
        fired > 0,
        `unfired fault: operation ${operation}, ${textOf(fault.phase)}`,
      );
      assert.equal(applied, fired, "fired fault was not applied");
      if (repeat.mode === "count")
        assert.equal(
          applied,
          Number(integerOf(repeat.count)),
          "fault repeat count",
        );
    }
  }

  snapshot() {
    return structuredClone(this.entries);
  }
}
