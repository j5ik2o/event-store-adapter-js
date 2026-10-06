export type ConformanceJsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly ConformanceJsonValue[]
  | { readonly [key: string]: ConformanceJsonValue };
