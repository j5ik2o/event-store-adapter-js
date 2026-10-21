/** 利用者の復元関数が返す、v5 の封筒に必要な値。 */
export type SpannerMigrationRestoredEvent<PE> = Readonly<{
  typeName: string;
  value: string;
  manifest: string;
  payload: PE;
}>;
