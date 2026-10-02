# DDD ドメインのパッケージ名ポリシー

ドメイン層のパッケージとモジュールの名前を定める。名前はユビキタス言語から付け、技術分類では付けない。名前に対応する業務用語の宣言（集約写像の `domain_packages`）はドメインモデルポリシーが持つ。

| 基準 | 判定 |
|------|------|
| パッケージやモジュールの名前が `aggregate(s)`、`impl(s)`、`implementation(s)`、`vo(s)`、`entity`、`entities`、`value_object(s)`、`valueobject(s)`、または単独の `domain` | REJECT |
| 同じ業務概念の集約、Entity、値オブジェクトを、型の種類だけでモジュールに分けている | REJECT |
| 共有する値を、責務の名前（`money`、`address`）のモジュールではなく `common/vo` のような入れ物に置いている | REJECT |
| `common`、`shared`、`utils` がドメインの概念を持っている | 警告。業務用語としての根拠を示すか、名前を変える |
| `-domain` の接尾辞や `packages/domain` の配置のような層の標識 | OK。技術分類ではなく層の標識である |

`aggregate/`、`model/`、`services/`、`repositories/` のようにコードを種類でまとめるディレクトリの例は、ドメイン層のコードには当てはまらない。
