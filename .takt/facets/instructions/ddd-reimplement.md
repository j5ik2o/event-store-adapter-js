{extends:development-reimplement-with-reports}

## DDD モデルを先に

- コードを変える前に、計画の `## DDD Model Changes` を計画どおりに `.ddd.toml` と `docs/ddd/` のファイルへ反映する。
- 名前は集約写像のとおりに実装する。パッケージ、モジュールのパス、型、メソッド、エラー型、エラーの case、replay メソッドが対象である。モジュールは `.ddd.toml` で選んだ配置に従って置く。
- コードが必要とする宣言（操作、エラーの case、パッケージ、モジュールの階層）が計画にないときは、コードで作り出さない。欠けている宣言を計画の不備として報告する。
- `.takt/` の中は、失敗したゲートが示す出力ログのほかは読まない。DDD の規則はこのステップに渡された policy と knowledge にある。コードの検査は、ソースを読まず `bun .takt/tools/ddd-lint/ddd-lint.ts --project .` を実行して確かめる。
