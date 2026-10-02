```markdown
# DDD レビュー

## 結果: APPROVE / IMPROVE / REJECT

{{include:output-contracts/base-review-summary}}

## 確認した観点
- [x] ドメインモデル宣言（不変条件、操作、エラー、ID、lineage）
- [x] 集約写像と層構造
- [x] ドメイン層（組み立て、状態変更、getter、Result エラー、所有）
- [x] ユースケース層（調整、再実行、回復）
- [x] インターフェイスアダプタ層（ポート、リポジトリ、復元、CQRS の両側）
- [x] 構造（依存方向、パッケージ名、モジュール配置）

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | DDD-NEW-src-file-L42 | ddd-violation | スコープ内 | `src/file.ts:42` | 問題の説明 | `src/file.ts:42` | 修正方法 |

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | DDD-PERSIST-src-file-L77 | ddd-violation | `src/file.ts:77` | `src/file.ts:77` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| DDD-RESOLVED-src-file-L10 | `src/file.ts:10` は規約を満たす |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | DDD-REOPENED-src-file-L55 | ddd-violation | 直前の裁定: 解消済み | 修正で再発 | `src/file.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-non-finding-concerns}}

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

{{include:output-contracts/base-review-rescan-evidence}}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
{{include:output-contracts/base-review-rejection-gate-in-scope}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリー + 検証証跡 + 影響経路の確認証跡。それ以外は省略。非finding化した懸念（計画の留意点の持ち越しを含む）は内容がある場合は省略しない
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
