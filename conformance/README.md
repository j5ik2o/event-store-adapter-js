# 適合テストデータ v1

共通契約と DynamoDB プロファイルの期待値を、言語に依存しない UTF-8 の JSON で配るデータである。データの版は `1.0.0` である。[共通契約](../docs/spec/core-contract.md)と [DynamoDB プロファイル](../docs/spec/storage/dynamodb.md)が規範であり、このデータは規則を追加しない。[ハッシュ仕様](../docs/spec/storage/hash.md)が収録を求める FNV-1a 64 の4件も含める。値30件、操作場面85件（共通42件・DynamoDB固有43件）、配置1件の計116件で、54規則を対象とする。今回の検証はデータと道具だけを対象とし、言語実装や保存先には実行しない。

## ファイルと形式

| 場所 | 内容 | JSON Schema |
|:--|:--|:--|
| `values/` | aid・occurred_at・seq_nr・FNV-1a 64 の入力と期待値 | `schema/values.schema.json` |
| `scenarios/core/` | 共通契約の操作列・保持・エラー | `schema/scenarios.schema.json` |
| `dynamodb/`（layout 以外） | 設定・書き込み・読み取り・保持・項目検査の操作列 | `schema/scenarios.schema.json` |
| `dynamodb/layout.json` | 3 テーブル・GSI と項目の属性の期待値 | `schema/layout.schema.json` |
| `coverage.json` | 網羅対象と対象外の理由 | `schema/coverage.schema.json` |
| `manifest.json` | 版と配布ファイルの SHA-256 | `schema/manifest.schema.json` |

Schema は draft 2020-12 である。共通定義は `schema/common.schema.json` にある。`$id` は識別子であり、検証ツールは同じディレクトリの Schema を登録してオフラインで参照を解決する。この URL へアクセスする必要はない。

各 JSON の最上位は `format` と `version` を持つ。値の表・場面・配置の表は `cases` の配列を持ち、各ケースに配布データ全体で一意な `id`、`rules`、`description` がある。ID は改名せず、ケースと規則の対応を CI の報告に使う。JSON の重複キー、NaN、Infinity は認めない。JSON の文字列値と属性名はデータの一部であり、各言語の慣習で書き換えない。

## 値の表の読み方

`operation` は次の検査を意味する。公開 API に同名の関数を要求するものではなく、実行器が構築・書き込み前の検査に対応付ける。

| 操作 | 入力 | 成功時の期待 |
|:--|:--|:--|
| `buildAid` | `aggregate_id.type_name` と `value` | `expect.value` の aid 文字列 |
| `validateOccurredAt` | `iso8601`、エポックからの `epoch_nanoseconds`、エラー説明用の `event_seq_nr` | 標準時刻型へ変換した入力との同値 |
| `validateSeqNr` | `seq_nr` と `context` | `expect.value` の整数 |
| `fnv1a64` | `utf8` の文字列 | `expect.value` の固定16桁の16進数（`0x` 付き） |

`buildAid` の `user_string` は、利用者の `Display` などが返す別表現である。実行器はこの文字列を使う ID の試験用実装を用意し、ライブラリが型名と値から組み立てることを確かめる。型名・値・区切りを全部合わせた UTF-8 のバイト数で T-12 を判定する。多バイトケースは文字数で判定する実装を検出するためのものである。

`validateSeqNr` の `context = value` は T-9 の一般値域であり、0 も有効である。`context = event` はイベントへの適用であり、0 を W-6 の契約違反にする。上限の値を初回追記として保存することは要求しない。W-8 による連番の検査とは別のケースである。T-9 の範囲外は契約違反として扱う。共通契約4章の一覧への T-9 の明記は、2026-10-05 の合意を受けて指揮役が別途行う。

`validateOccurredAt` は、型名 `ConformanceTime`・値がケースIDの集約で実行する。まず1番から `event_seq_nr - 1` 番までを、時刻 `1970-01-01T00:00:00.123000000Z` で順に確定する。その後、入力時刻を持つ `event_seq_nr` 番のイベントを `persistEvent` で書く。payload は空オブジェクト、manifest は空文字列とする。成功ケースは1番を読み戻して時刻を比較する。範囲外ケースは7番で契約違反を比較するので、飛び番の違反と重ならず、メッセージの7が T-13 の数字で偶然満たされることもない。`validateSeqNr` は封筒の構築やライブラリの値域検査フックを使い、実行器で同じ数式を計算するだけの検査にしてはならない。

`fnv1a64` はハッシュを使うプロファイルの共有ハッシュ実装へ対応付ける。入力4件は hash.md の表そのものであり、aid の構築・検証を挟まない。出力は符号なし64bitとして比較する。固定16桁の表記は比較用であり、保存先のキーの形式を要求しない。DynamoDB はこのハッシュを保存キーに使わない。

### 時刻と番号の表現能力

エポックナノ秒は、符号付き64bitの端やその外側でも JSON の数値パーサーで精度を失わないよう、10進文字列にする。計算は整数で行い、浮動小数点を介さない。操作の封筒では `occurred_at` を9桁の小数秒を持つ UTC の ISO 8601 文字列にする。

`expect.precision_policy = native-time-type` の成功時には、実行器が入力を言語の標準時刻型へ変換し、その値を期待値とする。T-3 は変換した入力と読み取りの同値で検査する。丸めの向きは固定しない。`expect.value` のエポックナノ秒は丸め前の参照値であり、精度の低い型へそのまま一致を要求しない。実行器は変換した値と実際の値を報告する。ストアの現在時刻に置き換えてよいという意味ではない。

操作の場面の event.occurred_at にも同じ方針を適用する。返る封筒の時刻の期待値は、書き込み時に標準時刻型へ変換した fixture の値である。

`representation.time_precision` のあるケースは精度別の境界ケースである。標準時刻型がナノ秒を表せる実装は `nanoseconds`、ミリ秒までの実装は `milliseconds` のケースを実行する。ミリ秒のケースは、範囲内で最も端のミリ秒と、範囲外で最も近いミリ秒を持つ。一方の境界を丸めて他方の期待値を適用してはならない。精度の印がない時刻のケースは、標準時刻型で変換した値を使って全実装が実行する。秒やマイクロ秒だけを表せる標準時刻型を使う実装が追加される場合は、境界データの追加が必要である。

実行器は、`seq_nr` の -1 や 2^53（9007199254740992）も、まず汎用の JSON 値または任意精度の整数として読む。対象 API の符号なし・固定幅の型へデータを直接デコードすると、ライブラリの検査へ届く前に入力を失う。正確な値を保った後で API への変換を試みる。

`representation.signed_seq_nr = true` のケースは負数を引数の型で表せる実装だけが実行する。符号なしの型を使う実装は「表現不能」として報告する。境界や符号の条件を満たさないケースを成功扱いしてはならない。

## 操作の場面の読み方

各場面は独立したストアで実行する。DynamoDB のテーブル名・GSI 名は実行器が割り当て、同じ場面の3テーブルは同じリージョンに置く。ほかのケースの項目を使い回さない。実行器は宣言された方式の保持処理を決定的に実行するためのフックと、内部履歴・失敗通知・SDK 要求の検査フックを用意する。

1. `backends` に実行する保存先があることを確認する。`requires = ["ttl"]` は TTL 方式を要求する。v1 の TTL 場面は DynamoDB だけを対象とする。
2. `store` の設定でストアを生成する。`retention_count = null` は履歴を作らず現在だけを保存する。`delete` は古い履歴を削除し、`ttl` は印を付ける。`ttl_grace_seconds` は DynamoDB の猶予秒である。名前はデータ上の共通名であり、実装の設定 API へ対応付ける。
3. `seed.items` があれば、ストア生成前にテスト用の権限でその項目を入れる。値の型とバイナリの扱いは後述の属性検査と同じである。設定項目が seed にない場合は、通常の生成手順で初期化する。
4. `initialization` があれば生成結果を検査する。生成失敗のケースは操作列を持たない。生成前の障害は先に登録する。
5. `generators` があれば後述の手順で文字列を展開する。`fixtures.events` と `fixtures.snapshots` を読み、各操作の直前に参照された封筒を構築する。キーは場面内だけで有効な参照名である。manifest 省略時の期待値は空文字列である。無効な入力の封筒の構築中に生じた規則違反も、対応する操作の失敗として捕捉する。実行器自身の事前検査でライブラリの検査を代替してはならない。
6. `steps` を配列順に、並行実行せずに実行する。引数の `event`・`snapshot` は fixture の参照、`aggregate_id` と `seq_nr` は値である。書き込みは1操作で1イベントを追記する。
7. 各操作の `expect` と、その操作で指定された `observe` を検査する。保持失敗や遅延のある場面では、宣言された保持・検査フックが完了してから観測する。フックが書き込みの成功・失敗を変更してはならない。

`store.retry_limit` は設定照合の再要求回数の上限であり、初回要求は数えない。実装の上限が回数ではなく待ち時間なら、実行器が同じ未処理応答の列で上限到達を再現する。指数バックオフを待つ試験は、要求列と待ち時間を観測する時計のフックで実時間を短縮してよい。

### 操作結果

| `expect` の種類 | 意味 |
|:--|:--|
| `result = success` | 書き込みまたは生成が成功する。具体的な戻り値は要求しない |
| `result = none` | 集約ヘッドが存在せず、「なし」を返す |
| `result = snapshot` | `head_seq_nr` と、`snapshot` の封筒（null ならなし）の組を返す |
| `result = events` | `events` が参照する全封筒を、その順に返す |
| `error` | 指定した分類とメッセージ条件を満たす失敗になる |

返るイベントは payload だけでなく、aggregate_id・seq_nr・occurred_at・manifest・payload の封筒全体で比較する。最新スナップショットは、封筒とヘッドの番号を別々に比較する。fixture のスナップショットにヘッドの番号を埋め込まない。

### payload と集約状態の比較

payload と `snapshot.aggregate` は任意の JSON 値である。実行器は、既定の JSON シリアライザで直列化・復元した JSON 値を比較する。オブジェクトのキーの順序と JSON の空白は無視し、配列の順序、null、真偽値、文字列、数値の値は保つ。真偽値と数値を同一視しない。文字列には Unicode 正規化を施さない。数値の比較は JSON 上の値で行い、`1` と `1.0` の書式の違いは要求しない。

メタデータを payload へ追加してはならない。payload 内の `seq_nr` や manifest に似た属性も、ドメインの値としてそのまま扱う。文字列のバイト列やキー順が違うという理由だけで失敗にしない。大きな単一文字列は `generators` で指定する。実行器は生成を終えた JSON 値を、通常の payload・manifest・集約状態としてライブラリへ渡す。

`generators` の各要素は、ケースを根とする JSON Pointer の `target`、Unicode の1文字を表す `character`、UTF-8 の総バイト数 `byte_length` を持つ。例として `{"target":"/fixtures/events/e1/payload","character":"x","byte_length":420000}` は、空文字列の payload を420000個の x に置き換える。対象は fixtures のイベント・スナップショット内に既にある空文字列に限り、各ポインタは1回だけ指定する。文字の UTF-8 幅で割り切れないバイト数はデータの誤りである。オブジェクトの属性や配列要素にも指定でき、ポインタの `~0`・`~1` を復号する。展開前の JSON で Schema を検査し、展開後の値で操作を実行する。参照実装は `tools/conformance/data.py` の `materialize` である。

D-7 の400KBと DY-11 の1MBは、DynamoDB の2進単位である。項目上限は409600バイト、読み取りのページ上限は1048576バイトとなる。[AWS の上限の説明](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)。`dynamodb-item-size-head-overhead` は、journal が上限内に収まっても head の type_name の追加で上限を超えるケースである。head は payload・aid・type_name の値だけでも410046バイト以上になる。これは属性名やコンテナの分も数える前の下限であり、厳密な境界の丸めを期待するものではない。[AWS の項目サイズの説明](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html)。

### エラーの対応

| データ上の分類 | 仕様の分類 |
|:--|:--|
| `optimistic-lock` | 楽観ロック |
| `contract-violation` | 契約違反 |
| `serialization` | 直列化 |
| `configuration` | 設定 |
| `storage` | 保存先 |

実装の型・判別可能なコードをこの5分類へ対応付ける。文字列のメッセージだけから分類を推測してはならない。`error.rule` は契約違反の必須規則番号である。`message.must_contain` と `must_not_contain` はメッセージの部分文字列の必要条件であり、E-3 のケースでは違反した規則番号と追記しようとした seq_nr を含める。W-9 では、異なるスナップショット番号も含める。ヘッド番号は契約違反の必須値にしない。

メッセージの検査が規則番号や aid の一部で偶然通らないよう、aid の値は原則 `Order-9`、飛び番は7や42にする。検証器は、規則番号・aid の全文を要求する要素を除き、must_contain の値が同じ場面の aid やエラー規則番号の部分文字列なら拒否する。空文字列も拒否する。

`dynamodb-item-size-*` は分類 `contract-violation` だけを期待する。D-7 はサイズ超過の判断番号であり、必須の規則番号ではないため、`error.rule` やメッセージの必要条件は付けない。`message` がないエラー期待は、分類だけを比較する。

楽観ロックでは、aid と追記しようとした番号をメッセージで検査し、ヘッド番号は必須にしない。生の SDK エラー文・接続文字列・資格情報を模した試験用 sentinel は `must_not_contain` で拒否する。言い回しを固定せずに、メッセージに含まれる全データ値を判別する方法は定義できないため、v1 は `context_only` を持たない。これらのメッセージ条件は E-2 の必要条件を検査するものであり、任意の追加情報が一切ないことまで自動で証明するものではない。

## 障害と時計の差し込み

`faults` は場面内の宣言である。`operation` は整数で、0 はストアの生成、1以上は1始まりの操作番号である。`phase` は次の実行器のフックに対応する。ある操作に複数の障害があれば、異なる段階の障害をすべて登録する。同じ段階の障害は配列順に消費する。登録した障害が発火しなければその場面は失敗であり、差し込み不能は未検証として報告する。

| 段階 | 差し込む場所 |
|:--|:--|
| `serialize-event` / `serialize-snapshot` | payload / 集約状態の直列化 |
| `deserialize-event` / `deserialize-snapshot` | 読み取ったバイナリからの復元 |
| `commit` | 書き込み要求、DynamoDB では TransactWriteItems |
| `read-events` / `read-snapshot` | 各読み取りの保存先応答 |
| `retention-query` | 保持対象を選ぶ履歴読み取り |
| `retention-delete` / `retention-mark` | 超過履歴の削除 / 印付け |
| `configuration-read` / `configuration-create` | 設定項目の照合 / 条件付き作成 |

`kind = serialization-error` はシリアライザの対応段階を失敗させる。既定の JSON シリアライザが正常な JSON で自然に失敗することを期待しない。`storage-error` は保存先・保持フックのその段階の最終失敗を返す。`details.scope = final-retention-failure` のときは、候補選択後、削除が行われる前に保持全体を失敗させる。共通場面の `retention-query` の応答計画は、メモリでは論理履歴のフック、DynamoDB では SDK のフックへ対応付ける。

すべての障害で `injection` を指定し、副作用の有無を区別する。

| 指定 | 要求と副作用 |
|:--|:--|
| `replace-request` | 対象の処理・要求を呼ばず、差し込みの失敗や応答を返す。書き込みは何も確定しない |
| `replace-response` | 対象の処理・要求を送った後、ライブラリへ渡す応答を差し替える。送った要求の副作用は残る |

シリアライザにも同じ区別を適用する。v1 の書き込み失敗と保持失敗は `replace-request` なので、その要求の変更は確定しない。`install_items` がある生成競合だけは、別の実行器が先に書いた項目を確定させる。BatchWriteItem の `unprocessed_first_n` も `replace-request` とし、実行器は未処理と宣言した項目を除く要求だけを実際に処理して応答を組み立てる。

`kind = sdk-error` は、SDK 自体の自動再試行を無効にし、ライブラリへ指定した失敗を返す。`details.code` と `cancellation_reasons` から SDK の例外を組み立てる。送信後の通信失敗など、確定状態が決まらない場面には、参照モデルでの推測を避けるため `replace-response` と書く。`TransactionCanceledException` は要求を確定させず、`replace-request` で差し込む。

`cancellation_reasons` はトランザクションの各項目に1要素を持つ。書き込みの対象名は `journal`、`head`、`current-snapshot`、`history-snapshot` の順で、存在するアクションだけを列挙する。設定作成では `configuration:journal`、`configuration:snapshot`、`configuration:head` を列挙する。失敗していない項目の code は文字列 `None` とする。実行器は対象名を実際の要求内のアクションに照合し、SDK の CancellationReasons を実際のアクション順へ並べ直す。この配列順をライブラリの要求順として強制するものではない。

ヘッドの `ConditionalCheckFailed` 要素は `old_head_seq_nr` を持ち、null は旧項目が返らないことを意味する。D-5 の分類にはこの失敗時点の旧項目を使う。ジャーナルの条件不成立は W-7、いずれの項目の `TransactionConflict` も D-6 の楽観ロックになる。ヘッド以外のスロットリングも保存先エラーとして扱う。

`repeat` は常にオブジェクトで、`{"mode":"count","count":1}` は対象段階への適用回数を指定する。`{"mode":"until-operation-finishes"}` は指定操作内の対象要求を再試行も含めて失敗させる。次の操作には持ち越さない。`times` は使わない。

`kind = sdk-response` は次の応答計画を使う。

| `details` の属性 | 応答計画 |
|:--|:--|
| `responses` と `unprocessed_keys` | BatchGetItem の処理済み項目と未処理キー。`seed-config` / `stored-head` はその場面に保存されている項目である |
| `history_pages` | GSI の応答に載せる履歴の seq_nr のページ列を、そのまま返す。実行器は今書いた履歴を自動追加しない。ページごとに LastEvaluatedKey と次の ExclusiveStartKey を対応付ける |
| `omit_just_written_history` | 既定は false。true なら history_pages に今書いた番号がないことを確かめる。false でも履歴を自動追加しない。候補への追加・重複排除はライブラリが行う |
| `unprocessed_first_n` | BatchWriteItem が受けた削除要求の先頭 n 件を UnprocessedItems として返し、残りは実際に処理する |

応答計画は対象段階への1回の適用で開始し、ページ列を全部返すまで続く。BatchGetItem の部分応答では指定した最初の応答だけを置き換え、以後は未処理キーに対する実際の応答を返す。応答を置き換えるときに、送られていないキーを返してはならない。履歴の `history_pages` はその場面の保存済みの履歴を使う。`omit_just_written_history = true` と、その番号を含むページ列の組み合わせは不正である。応答計画は、GSI の反映待ちを避けるためのものである。削除・TTL 更新・書き込みの物理結果は実際に反映して検査する。

`kind = read-interleave` は、DY-9 の1回の BatchGetItem へ返す非原子的な応答を実行器が組み立てる指定である。`after = capture-head-before-batch` で要求の送信直前に旧ヘッドを検査フックで捕捉し、`interleaved_operation` の追記を確定する。その後に元の BatchGetItem を送って現在のスナップショットを取得し、`then = replace-batch-response-head` で応答内のヘッドを捕捉した旧ヘッドへ差し替える。ライブラリに head と snapshot の別要求を要求しない。返る組は旧ヘッドと新スナップショットであり、物理的なヘッドには差し込みの追記が反映されている。差し込み内の event と snapshot も同じ fixture を参照する。実時間の競争は使わない。

`clock.epoch_seconds` は印を付ける時点の時計である。操作に `clock_epoch_seconds` があれば、その操作の前に時計を進める。期限は印付け時刻と `store.ttl_grace_seconds` の和であり、イベントの occurred_at から計算しない。v1 は2100年の時計を使い、試験中に DynamoDB の非同期 TTL 削除が印付き項目を消さないようにする。サービスによる物理削除を待つ時間や、その時刻の厳密な一致は検査しない。

## 保持・SDK 要求・属性の観測

`observe.history` は、その集約の履歴だけを調べる。`active` は印のない履歴、`marked` は seq_nr とエポック秒の期限の組、`absent` は存在してはならない履歴である。active と marked の集合をそれぞれ完全一致で比較する。現在のスナップショットと設定項目は履歴に数えない。メモリでは内部の論理履歴を検査する。印付き履歴をそのまま残す TTL の試験は DynamoDB だけにある。

`observe.notifications` は指定操作の保持失敗を別経路で知らせたかを検査する。`retention-failure` はコールバック・ログなどの観測を共通化した分類であり、公開の通知 API は固定しない。空配列ならその操作に失敗通知がないことである。同じ最終失敗についてログが複数ある場合は、1つの失敗通知へ正規化してよい。

`observe.requests` は指定 API・段階の要求に対する条件である。式は構造化した属性操作・条件で指定する。実行器は SDK の式と属性名・値の束縛を解析し、属性名へ解決した構造を比較する。空白、節の順序、条件の AND の順序は比較しない。`update.set` は設定する属性と `value_binding`、`update.remove` は取り除く属性、`condition` は属性の存在・不在を表す。`key_condition.all` は AND の条件の集合であり、`operator = eq/gte` と `argument` を操作の aggregate_id・seq_nr へ束縛する。TTL の `#ttl` と `expression_attribute_names` の対応は予約語回避の観測として明示する。`expires` は Unix エポック秒であり、ttl の `value_binding = expires` が参照する値である。条件に含めていない設定値や SDK の自動付与属性は要求しない。`initial_batch_sizes` は未処理項目の再送を除いた削除バッチの件数であり、再送は別に検査する。`no_requests_in_phases` はその操作で送ってはならない要求段階、`request_count` は段階ごとの正確な回数、`minimum_request_count` は最低回数である。`classify-condition-failure-read` は条件不成立の分類のためだけの追加読み取りを指す。

`requests` の要素は、実際の別々の要求に配列順で対応付ける。同じ API・段階の要素を複数置いた場合に、1回の要求で複数の要素を満たしたと判断してはならない。ページ送り・未処理キーの再要求・削除バッチ分割の条件は、その段階の要求列全体に対して検査する。

`observe.items` と `seed.items` は DynamoDB の属性を次の形で書く。

- `table` は journal・snapshot・head の設定済みテーブル名への対応である。
- `attributes` は属性名から DynamoDB の S・N・B・L・M への対応であり、項目の属性集合を完全一致で比較する。定義のない属性、現在の項目の ttl、印付き履歴の active_history_seq_nr、設定項目の GSI 用属性は認めない。
- `values` の N は10進文字列である。実際の N と整数として比較する。L の中の M の属性集合と型は `nested_attributes` で比較する。`events` の要素数は1である。
- `binary_json` は B の復元結果である。`events[0].payload` のようなパスも指定できる。JSON の復元値で比較し、バイナリの見た目は固定しない。
- `bindings` の `generated-store-id` は、最初の実際の store_id を束縛し、3項目で同じ値であることを検査する。ランダムな識別子の具体値は期待しない。

項目を seed するときは、values に binary_json のパスの B と bindings の値を加えて項目を組み立てる。観測時は、binary_json と bindings に指定したパスを別々に比較し、そのパスを除いた値を values と比較する。head の values.events には payload のバイナリを重ねて書かない。属性集合・型・リストの件数の検査は、除外前の実際の項目全体に対して行う。

`dynamodb/layout.json` は配置の参照表である。実行器は実際に用意した3テーブルを DescribeTable と必要な TTL の状態取得で照合する。テーブル名と GSI 名の具体値は設定値へ束縛する。`items` は全種類の項目の参照例であり、初回追記で seq_nr 3 を要求するものではない。値を揃えて書く方法は `dynamodb/item-shapes.json` の操作列にあり、参照例と同じ属性集合・型を実際の項目で検査する。Streams は head だけで有効、NEW_IMAGE とする。snapshot の GSI は KEYS_ONLY であり、現在・印付き履歴・設定項目が載らないことを検査する。

## 版・ハッシュ・配布

manifest の `files[].path` は `conformance/` からの相対 POSIX パスであり、`sha256` はファイルの生バイト列の SHA-256 である。manifest 自身を除き、README・網羅表・Schema を含む全ファイルを列挙する。ファイルの追加・欠落・改変・重複・版違いで照合は失敗する。改行・文字コードもハッシュに含まれる。配布時に改行コードを変換してはならない。シンボリックリンクは配らない。

各言語のリポジトリへは、このディレクトリを同じ内容で写す。CI は manifest の版が期待する版であることを確認し、生バイト列のハッシュとファイル集合を照合する。CI で manifest を作り直して差分を隠してはならない。同等の実装を使う場合も、manifest 自身の除外・全ファイル集合・SHA-256・版の確認を省略しない。検証ツールは別途 `tools/conformance/` を写してよい。

リポジトリのルートからの実行手順は次のとおりである。manifest の照合には Python 3 の標準ライブラリだけを使う。

```sh
python3 tools/conformance/manifest.py verify
# 配布先のパスを明示する場合
python3 tools/conformance/manifest.py verify --root path/to/conformance
```

Schema・規則番号・参照・ID・網羅表・参照モデルも検査するには、Python 3.11 以上と uv を使う。jsonschema と推移依存は `tools/conformance/uv.lock` に固定してある。

```sh
uv run --project tools/conformance --locked python tools/conformance/validate.py
uv run --project tools/conformance --locked python -m unittest discover -s tools/conformance -p 'test_*.py'
```

規則番号はローカルの `docs/spec/core-contract.md`、`docs/spec/storage/dynamodb.md`、`docs/spec/storage/hash.md` の定義から収集する。削除済みの番号や本文で言及しただけの番号を、有効なケースの規則として認めない。コピー先で仕様を別の位置に置く場合は `--root` と `--spec-root` でそれぞれ指定する。後者は core-contract.md、storage/dynamodb.md、storage/hash.md があるディレクトリである。

データを変更したときは、次の順に再生成・照合する。網羅表の生成モードは manifest の照合を行わないので、最後の照合まで実行する必要がある。

```sh
uv run --project tools/conformance --locked python tools/conformance/validate.py --update-coverage
python3 tools/conformance/manifest.py rebuild
uv run --project tools/conformance --locked python tools/conformance/validate.py
```

[網羅表](COVERAGE.md)は `rules` と `coverage.json` から生成する。対象外の規則と理由も同じ表に載せる。規則の列挙は適合を証明するものではなく、実行器が対応する観測をすべて満たす必要がある。

## 参照モデルで期待値の矛盾を検出する

`tools/conformance/reference_model.py` は、集約ごとのヘッド番号、ジャーナル、現在のスナップショット、履歴とTTL期限を状態として操作列を再生する。モデルは期待値を状態の更新に使わない。成功・エラー分類・規則番号・読み取りの全封筒・保持履歴・失敗通知を、独立に計算した結果と比較する。時刻の値域や項目サイズの明らかな超過、確定前の失敗、取り消し理由、履歴ページ、BatchGetItem の応答差し替えも扱う。

送信後の書き込み失敗や保持の更新・削除応答の失敗では確定状態が仕様から決まらないため、その操作と以後の状態依存操作を理由付きで飛ばす。v1 の85場面では、この理由で飛ばす操作はない。SDK要求の実測、物理属性の型、メッセージの実際の文言はモデルの対象外であり、場面ごとに実行器へ委ねる検査として明示する。項目サイズは既存ケースの属性値だけで上限超過を確かめ、厳密な境界のサイズ計算は扱わない。

T-13 の値域は整数のナノ秒で検査する。言語の時刻型へ変換した後の丸め・往復は実行器の検査であり、モデルが丸め方向を決めることはない。FNV-1a 64 の表は仕様の計算で別途照合する。ADR-0008 と Bigtable 仕様は入出力表の収録を求めていないため、固定バイナリ封筒は v1 の対象外とし、coverage.json に理由を記録する。

単体試験では、`core-gap-event` の分類を optimistic-lock へ変える、`dynamodb-retention-ttl-once` の期限を1へ変える、失敗後のヘッドを進める、読み取りの先頭を落とすなどの誤期待が拒否されることを確かめる。モデルの検査に通ったことは、言語実装の適合を意味しない。

## 実行結果の報告

実行器はデータの版、manifest の照合結果、言語・実装版・保存先、ケースID、規則番号ごとの成功・失敗・対象外・未検証、失敗した操作番号と期待値・実際の値を CI に報告する。1ケースが複数の規則を持つ場合は、すべての規則へその結果を対応付ける。操作列の途中で期待と異なれば、成功済み操作だけからそのケース全体を成功と報告してはならない。

表現能力の違いによるケースの選択、任意能力、削除済み規則、呼び出し側の推奨事項はそれぞれ理由を記録する。対象保存先の必須ケースを飛ばした結果や、障害を差し込めなかった結果を成功へ集計してはならない。保存先が対象外のケースを実行する必要はない。同時実行の勝者など非決定的な試験を追加する場合は、決定的な障害または順序の宣言を先に設計する。
