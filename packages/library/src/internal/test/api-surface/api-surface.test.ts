import * as path from "node:path";
import { checkApiSurface } from "./api-surface-checker";
import { loadApiSurfaceDefinition } from "./api-surface-definition";
import { loadApiSurfaceMapping } from "./api-surface-mapping";

const root = path.resolve(__dirname, "../../../../../../api-surface");
const surface = loadApiSurfaceDefinition(root);
const mapping = loadApiSurfaceMapping(root);
const publicEntry = path.resolve(__dirname, "../../../index.ts");
const fixture = (name: string) =>
  path.resolve(__dirname, "fixtures", name, "index.ts");

describe("公開 API の形", () => {
  it("今の公開 API は共通契約 v5 の形を満たす", () => {
    expect(checkApiSurface(publicEntry, surface, mapping)).toEqual([]);
  });
});

describe("否定の試験（形をずらした定義を報告する）", () => {
  it.each([
    [
      "イベント封筒から occurredAt を消す",
      "missing-occurred-at",
      ["EventEnvelope: 要素 occurred_at（occurredAt）がありません"],
    ],
    [
      "manifest の名前を変える",
      "renamed-manifest",
      ["EventEnvelope: 要素 manifest（manifest）がありません"],
    ],
    [
      "seqNr の型を string にする",
      "seq-nr-string",
      ["EventEnvelope.seqNr: 型が合いません（期待: number、実際: string）"],
    ],
    [
      "EventEnvelopeInput の seqNr を省略できるようにする",
      "optional-input-seq-nr",
      ["EventEnvelopeInput: 要素 seq_nr（seqNr）は必須である必要があります"],
    ],
    [
      "getEventsByIdSinceSeqNr が PE[] を返す",
      "events-return-payloads",
      [
        "EventStore.getEventsByIdSinceSeqNr の戻り値: 型が合いません（期待: Promise<Result<EventEnvelope<PE>[], EventStoreError>> または Promise<Result<readonly EventEnvelope<PE>[], EventStoreError>>、実際: Promise<Result<PE[], EventStoreError>>）",
      ],
    ],
    [
      "エラーの共用体から storage-error を消す",
      "missing-storage-error",
      ['EventStoreError: 分類 storage の値 "storage-error" がありません'],
    ],
    [
      "イベント封筒の型の引数を P extends object に狭める",
      "constrained-type-parameter",
      ["EventEnvelope: 型の引数 P に制約（extends）があってはいけません"],
    ],
  ])("%s", (_title, name, expected) => {
    expect(checkApiSurface(fixture(name), surface, mapping)).toEqual(expected);
  });
});

describe("否定の試験（期待する型を解決できない）", () => {
  it("公開 API が AggregateId を公開しなくなると、黙って通らずに報告する", () => {
    const problems = checkApiSurface(
      fixture("unexported-aggregate-id"),
      surface,
      mapping,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^期待する型を解決できません.*AggregateId/),
      ]),
    );
  });
});
