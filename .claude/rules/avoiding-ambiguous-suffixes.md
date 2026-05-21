# 曖昧なサフィックスを避ける

型名・trait名・関数名・変数名・フィールド名・variant名・定数名・モジュール名・ファイル名など、Rust コード上の命名全般において曖昧なサフィックスを検出し、明確な命名へ導く。

## 目的

- すべての識別子名から責務・境界・契約が即座に推測できる状態を保つ
- 曖昧な語による責務の吸い込み・肥大化・境界崩壊を防ぐ
- ドメイン語彙を優先する

## 基本原則

- 命名は「何をするか」ではなく「何であるか」を表す
- 名前は責務・境界・依存方向を最小限の語で符号化する
- プロジェクト内で意味が一意に定義できない語はサフィックスとして使わない

## 禁止サフィックスと代替案

新規・既存を問わず、型名・trait名・関数名・変数名・引数名・フィールド名・enum variant名・関連 item 名・generic parameter 名・定数名・static 名・macro 名・モジュール名・ファイル名では以下を使用しない：

| サフィックス | 問題 | 代替案 |
|--------------|------|--------|
| Manager | 「Xxxに関することを全部やる箱」になる | `*Registry`, `*Coordinator`, `*Dispatcher`, `*Controller` |
| Util | 設計されていない再利用コードになる | 具体的な責務名。例: `*Formatter`, `*Parser`, `*Mapper` |
| Facade | 責務の境界が不明確になる | `*Gateway`, `*Adapter`, `*Bridge` |
| Service | 層や責務が未整理になる | `*Executor`, `*Scheduler`, `*Evaluator`, `*Repository`, `*Policy` |
| Runtime | 何が動くのか不明になる | `*Executor`, `*Scheduler`, `*EventLoop`, `*Environment` |
| Engine | 実行体の責務が不明確になる | `*Executor`, `*Evaluator`, `*Processor`, `*Pipeline` |

## 責務別 命名パターン

### データ保持・管理
`*Registry`, `*Catalog`, `*Index`, `*Table`, `*Store`

### 選択・分岐・方針
`*Policy`, `*Selector`, `*Router`

### 仲介・調停・制御
`*Coordinator`, `*Dispatcher`, `*Controller`

### 生成・構築
`*Factory`, `*Builder`

### 変換・適合
`*Adapter`, `*Bridge`, `*Mapper`

### 実行・評価
`*Executor`, `*Scheduler`, `*Evaluator`

## 例外ルール

- 外部API/OSS/フレームワーク由来の名称は無理に改名しない
- 既存コードで責務が明文化されている場合のみ例外的に許容

## 判定フロー

1. 識別子名・モジュール名・ファイル名が禁止サフィックスを含むか確認
2. 含む場合:
   - この名前だけで責務を一文で説明できるか？
   - 依存してよい層・してはいけない層が推測できるか？
3. できない場合は具体名への置換案を提示

## 最終チェック

「この名前だけ見て、何に依存してよいか分かるか？」

分からないなら、その名前はまだ設計途中である。
