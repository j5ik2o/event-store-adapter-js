type Token = Readonly<{
  kind: "word" | "quoted" | "string" | "punct";
  text: string;
}>;

const isWordChar = (ch: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(ch);

/** コメントと空白を飛ばし、文字列・引用符付き識別子・語・記号に分ける。 */
function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readQuoted = (close: string, doubled: boolean): string => {
    let text = "";
    i += 1;
    while (i < sql.length) {
      const ch = sql[i];
      if (ch === close) {
        if (doubled && sql[i + 1] === close) {
          text += close;
          i += 2;
          continue;
        }
        i += 1;
        return text;
      }
      text += ch;
      i += 1;
    }
    return text;
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'") {
      tokens.push({ kind: "string", text: readQuoted("'", true) });
    } else if (ch === '"') {
      tokens.push({ kind: "quoted", text: readQuoted('"', true) });
    } else if (ch === "`") {
      tokens.push({ kind: "quoted", text: readQuoted("`", true) });
    } else if (ch === "[") {
      tokens.push({ kind: "quoted", text: readQuoted("]", false) });
    } else if (isWordChar(ch)) {
      const start = i;
      while (i < sql.length && isWordChar(sql[i])) i += 1;
      tokens.push({ kind: "word", text: sql.slice(start, i) });
    } else {
      tokens.push({ kind: "punct", text: ch });
      i += 1;
    }
  }
  return tokens;
}

const TABLE_CONSTRAINT_KEYWORDS = [
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
];

/** CREATE TABLE の最初の括弧の中を、深さ 1 のカンマで定義ごとに分ける。 */
function definitionsOf(
  tokens: readonly Token[],
): readonly (readonly Token[])[] {
  const start = tokens.findIndex((t) => t.kind === "punct" && t.text === "(");
  if (start === -1) return [];
  const definitions: Token[][] = [];
  let current: Token[] = [];
  let depth = 1;
  for (const token of tokens.slice(start + 1)) {
    if (token.kind === "punct" && token.text === "(") depth += 1;
    if (token.kind === "punct" && token.text === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1 && token.kind === "punct" && token.text === ",") {
      definitions.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  definitions.push(current);
  return definitions;
}

/**
 * CREATE TABLE 文から、列の宣言に書かれた照合順序を読む（SQ-2）。
 * 列の定義の深さ 0 にある `COLLATE 名前` のうち最後のものを返し、なければ BINARY とする。
 * CHECK・DEFAULT・コメント・文字列の中の COLLATE と、表の制約の中の COLLATE は数えない。
 * 列が見つからなければ undefined を返す。
 */
export function declaredColumnCollation(
  sql: string,
  column: string,
): string | undefined {
  for (const definition of definitionsOf(tokenize(sql))) {
    const [first, ...rest] = definition;
    if (first === undefined) continue;
    if (
      first.kind === "word" &&
      TABLE_CONSTRAINT_KEYWORDS.includes(first.text.toUpperCase())
    )
      continue;
    if (first.text.toLowerCase() !== column.toLowerCase()) continue;
    let collation = "BINARY";
    let depth = 0;
    for (const [index, token] of rest.entries()) {
      if (token.kind === "punct" && token.text === "(") depth += 1;
      else if (token.kind === "punct" && token.text === ")") depth -= 1;
      else if (
        depth === 0 &&
        token.kind === "word" &&
        token.text.toUpperCase() === "COLLATE"
      ) {
        const name = rest[index + 1];
        if (
          name !== undefined &&
          (name.kind === "word" || name.kind === "quoted")
        )
          collation = name.text;
      }
    }
    return collation;
  }
  return undefined;
}
