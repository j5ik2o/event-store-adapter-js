# DDD 層の依存ポリシー

パッケージがどの層に属するか、ポートをどの層で宣言するか、層の間とコマンド側・クエリ側の間でどの依存を許すか、実装とポートをどこで結線するかを定める。

## 層の決め方

パッケージ（Cargo の crate、または `package.json` を持つ TypeScript のパッケージ）は、接尾辞（`-domain`、`-use-case`、`-interface-adapter`、`-infrastructure`）か配置（`packages/<layer>/`、`modules/<layer>/`）で層が決まる。コマンド側、クエリ側、読み取りモデル更新器のパッケージは `command`、`query`、`rmu` の区切りを持つ。接尾辞が `-composition-root` のパッケージ、バイナリだけのパッケージ、`composition-root/` の下のパッケージは composition root である。

| 基準 | 判定 |
|------|------|
| パッケージの接尾辞と配置が別の層を指している | REJECT |
| パッケージがどの層の規則にも当てはまらない | REJECT |
| パッケージが `command`、`query`、`rmu` のうち 2 つ以上を持つ | REJECT |
| パッケージがバイナリのターゲットと、ある層のライブラリコードを混在させている | REJECT |

## 依存の向き

| 依存元 | 依存してよい先 |
|--------|----------------|
| interface-adapter | use-case、domain、infrastructure |
| use-case | domain、infrastructure |
| domain | infrastructure |
| infrastructure | なし |
| 読み取りモデル更新器 | domain、interface-adapter、infrastructure、コマンド側とクエリ側の両方 |
| composition root | すべての層 |

| 基準 | 判定 |
|------|------|
| 上の表にない依存がある | REJECT |
| コマンド側のパッケージがクエリ側のパッケージに依存している、またはその逆 | REJECT |
| クエリ側のコードがドメイン層の型やリポジトリポートに依存している | REJECT。DAO と DTO を使う |
| ドメイン層やユースケース層のコードが I/O のライブラリ（データベースドライバ、HTTP のクライアントやサーバー、メッセージブローカー）やそのクライアントを使っている | REJECT。ユースケースがポートを通す |
| ポート（リポジトリポートや、層構造が宣言するほかのポート）をドメイン層で宣言している、またはドメイン層のコードがポートを保持したり呼び出したりしている | REJECT。ポートはユースケース層のもの。ユースケースがポートを通して読み込み、ドメインを呼び、ポートを通して保存する |
| データベースや RPC のクライアントを infrastructure 層に置いている | REJECT。インターフェイスアダプタ層に置く |
| infrastructure 層が `Result` などの言語拡張をパッケージのエントリから公開する | OK。infrastructure の関数を公開しないという一般的な指針は、この言語拡張には当てはまらない |
| 実装とポートの結線を composition root の外で行っている | REJECT |
