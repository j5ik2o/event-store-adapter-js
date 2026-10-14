import * as path from "node:path";
import ts from "typescript";
import type { ApiSurfaceDefinition } from "./api-surface-definition";
import type { ApiSurfaceElement } from "./api-surface-element";
import type { ApiSurfaceMapping } from "./api-surface-mapping";

const PROBE_FILE = "__api_surface_probe.ts";
const BUILTIN_TYPES = new Set(["number", "string", "Date"]);

// 公開 API の入口ファイルを型検査し、surface.json と js.json から導いた期待する形と
// 照合する。ずれは 1 件ずつ文字列で返す（ずれがなければ空配列）。
//
// 型の比較は、型の引数を目印の型に置き換えて実体化した公開 API の型と、
// 期待する形を書いた型（探査用ファイルで宣言）を、相互に代入できるかで判定する。
export function checkApiSurface(
  entryFile: string,
  surface: ApiSurfaceDefinition,
  mapping: ApiSurfaceMapping,
): string[] {
  const entry = path.resolve(entryFile);
  const probePath = path.join(path.dirname(entry), PROBE_FILE);
  const probeLines: string[] = [];
  const problems: string[] = [];

  // 探査用ファイルに型を 1 つ宣言し、後で取り出すための番号を返す。
  const probeTexts: string[] = [];
  const probe = (typeText: string): number => {
    probeTexts.push(typeText);
    probeLines.push(`type Probe${probeLines.length} = ${typeText};`);
    return probeLines.length - 1;
  };
  const readable = (text: string): string =>
    text
      .replace(/\{ readonly __marker: "(\w+)";? \}/g, "$1")
      .replace(/\bM\./g, "");
  const qualify = (name: string): string =>
    BUILTIN_TYPES.has(name) ? name : `M.${name}`;
  const marker = (jsParam: string): string =>
    `{ readonly __marker: "${jsParam}" }`;
  const fill = (template: string, value: string): string =>
    template.replace(/\bT\b/, value);

  // 共通の型式（optional<X>、list<X>、event_envelope<P> など）を、js で許される型の表記へ変換する。
  const candidates = (
    expr: string,
    params: Readonly<Record<string, string>>,
  ): string[] => {
    if (expr === "none") return [mapping.containers.none];
    const generic = /^(\w+)<(.+)>$/.exec(expr);
    if (generic === null) {
      return [
        params[expr] === undefined
          ? qualify(mapping.value_types[expr])
          : marker(params[expr]),
      ];
    }
    const [, head, arg] = generic;
    if (head === "optional") {
      return candidates(arg, params).map((c) =>
        fill(mapping.containers.optional, c),
      );
    }
    if (head === "list") {
      return candidates(arg, params).flatMap((c) =>
        mapping.containers.list.map((t) => fill(t, c)),
      );
    }
    return [`${qualify(mapping.types[head].name)}<${marker(params[arg])}>`];
  };
  const probeCandidates = (
    expr: string,
    params: Readonly<Record<string, string>>,
    wrap: (c: string) => string = (c) => c,
  ): number[] => candidates(expr, params).map((c) => probe(wrap(c)));
  const markers = (
    params: Readonly<Record<string, string>>,
    names: readonly string[],
  ) => names.map((n) => marker(params[n])).join(", ");

  type Check = (
    checker: ts.TypeChecker,
    probeType: (index: number) => ts.Type,
    exported: ReadonlyMap<string, ts.Symbol>,
  ) => void;
  const checks: Check[] = [];

  const sameType = (checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean =>
    checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
  const show = (checker: ts.TypeChecker, type: ts.Type): string =>
    readable(
      checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
    );

  const checkTypeParameters = (
    where: string,
    symbol: ts.Symbol,
    surfaceParams: readonly string[],
    params: Readonly<Record<string, string>>,
  ): void => {
    const declaration = symbol.declarations?.find(
      (
        d,
      ): d is
        | ts.TypeAliasDeclaration
        | ts.InterfaceDeclaration
        | ts.ClassDeclaration =>
        ts.isTypeAliasDeclaration(d) ||
        ts.isInterfaceDeclaration(d) ||
        ts.isClassDeclaration(d),
    );
    const actual = declaration?.typeParameters ?? [];
    surfaceParams.forEach((name, i) => {
      const parameter = actual[i];
      if (parameter?.name.text !== params[name]) {
        problems.push(
          `${where}: 型の引数 ${name} は ${params[name]} である必要があります（実際: ${parameter?.name.text ?? "なし"}）`,
        );
      } else if (parameter.constraint !== undefined) {
        problems.push(
          `${where}: 型の引数 ${params[name]} に制約（extends）があってはいけません`,
        );
      }
    });
  };

  const planElements = (
    where: string,
    ownerIndex: number,
    elements: readonly ApiSurfaceElement[],
    names: Readonly<Record<string, string>>,
    params: Readonly<Record<string, string>>,
    checkRequired: boolean,
  ): void => {
    const expected = elements.map((e) => probeCandidates(e.type, params));
    checks.push((checker, probeType) => {
      const owner = probeType(ownerIndex);
      elements.forEach((element, i) => {
        const jsName = names[element.name];
        const prop = checker.getPropertyOfType(owner, jsName);
        if (prop === undefined) {
          problems.push(
            `${where}: 要素 ${element.name}（${jsName}）がありません`,
          );
          return;
        }
        const actual = checker.getTypeOfSymbol(prop);
        // 省略できるかは ? の印で決まる。値の型に undefined を含むかは別に見る
        const optionalProperty = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        const acceptsUndefined =
          actual.isUnion() &&
          actual.types.some((t) => (t.flags & ts.TypeFlags.Undefined) !== 0);
        const mustBeRequired = checkRequired
          ? element.required === true
          : !element.type.startsWith("optional<");
        const mustBeOptional = checkRequired
          ? element.required === false
          : element.type.startsWith("optional<");
        if (mustBeRequired && (optionalProperty || acceptsUndefined)) {
          problems.push(
            `${where}: 要素 ${element.name}（${jsName}）は必須である必要があります`,
          );
        }
        if (
          mustBeOptional &&
          !optionalProperty &&
          !(acceptsUndefined && !checkRequired)
        ) {
          problems.push(
            `${where}: 要素 ${element.name}（${jsName}）は省略できる必要があります`,
          );
        }
        const actualValue = checker.getNonNullableType(actual);
        const wanted = expected[i].map((n) =>
          checker.getNonNullableType(probeType(n)),
        );
        if (!wanted.some((w) => sameType(checker, actualValue, w))) {
          problems.push(
            `${where}.${jsName}: 型が合いません（期待: ${expected[i].map((n) => readable(probeTexts[n])).join(" または ")}、実際: ${show(checker, actualValue)}）`,
          );
        }
      });
    });
  };

  for (const type of surface.types) {
    const map = mapping.types[type.name];
    const owner = probe(
      `${qualify(map.name)}<${markers(map.type_parameters, type.type_parameters)}>`,
    );
    checks.push((_checker, _probeType, exported) => {
      const symbol = exported.get(map.name);
      if (symbol === undefined) {
        problems.push(`${type.name}: 型 ${map.name} が公開されていません`);
        return;
      }
      checkTypeParameters(
        map.name,
        symbol,
        type.type_parameters,
        map.type_parameters,
      );
    });
    planElements(
      map.name,
      owner,
      type.elements,
      map.elements,
      map.type_parameters,
      false,
    );
    if (map.construction === undefined) continue;
    const { function: functionName, input } = map.construction;
    const args = markers(map.type_parameters, type.type_parameters);
    planElements(
      input,
      probe(`${qualify(input)}<${args}>`),
      type.elements,
      map.elements,
      map.type_parameters,
      true,
    );
    checks.push((_checker, _probeType, exported) => {
      const inputSymbol = exported.get(input);
      if (inputSymbol !== undefined) {
        checkTypeParameters(
          input,
          inputSymbol,
          type.type_parameters,
          map.type_parameters,
        );
      }
    });
    const genericCreation = probe(
      `typeof ${qualify(map.name)}.${functionName}`,
    );
    checks.push((_checker, probeType) => {
      const signature = probeType(genericCreation).getCallSignatures()[0];
      for (const parameter of signature?.typeParameters ?? []) {
        if (parameter.getConstraint() !== undefined) {
          problems.push(
            `${map.name}.${functionName}: 型の引数 ${parameter.symbol.name} に制約（extends）があってはいけません`,
          );
        }
      }
    });
    const creation = probe(
      `typeof ${qualify(map.name)}.${functionName}<${args}>`,
    );
    const creationInput = probe(`${qualify(input)}<${args}>`);
    checks.push((checker, probeType) => {
      const where = `${map.name}.${functionName}`;
      const parameter =
        probeType(creation).getCallSignatures()[0]?.parameters[0];
      if (parameter === undefined) {
        problems.push(`${where} がありません`);
      } else if (
        !sameType(
          checker,
          checker.getTypeOfSymbol(parameter),
          probeType(creationInput),
        )
      ) {
        problems.push(
          `${where}: 引数の型が ${input} と合いません（実際: ${show(checker, checker.getTypeOfSymbol(parameter))}）`,
        );
      }
    });
  }

  const storeName = mapping.store.name;
  const storeParams = mapping.store.type_parameters;
  const store = probe(
    `${qualify(storeName)}<${markers(storeParams, surface.store.type_parameters)}>`,
  );
  checks.push((_checker, _probeType, exported) => {
    const symbol = exported.get(storeName);
    if (symbol === undefined) {
      problems.push(`${storeName} が公開されていません`);
      return;
    }
    checkTypeParameters(
      storeName,
      symbol,
      surface.store.type_parameters,
      storeParams,
    );
  });
  for (const operation of surface.store.operations) {
    const where = `${storeName}.${mapping.store.operations[operation.name]}`;
    const jsName = mapping.store.operations[operation.name];
    const inputs = operation.inputs.map((i) =>
      probeCandidates(i.type, storeParams),
    );
    const outputs = probeCandidates(operation.output, storeParams, (c) =>
      fill(
        mapping.store.result.replace(/\b(Result|EventStoreError)\b/g, "M.$1"),
        c,
      ),
    );
    checks.push((checker, probeType) => {
      const prop = checker.getPropertyOfType(probeType(store), jsName);
      const signature =
        prop && checker.getTypeOfSymbol(prop).getCallSignatures()[0];
      if (signature === undefined) {
        problems.push(`${where}: 操作 ${operation.name} がありません`);
        return;
      }
      if (signature.parameters.length !== operation.inputs.length) {
        problems.push(
          `${where}: 引数は ${operation.inputs.length} 個である必要があります（実際: ${signature.parameters.length}）`,
        );
      }
      const compare = (label: string, actual: ts.Type, wanted: number[]) => {
        if (!wanted.some((n) => sameType(checker, actual, probeType(n)))) {
          problems.push(
            `${where} の${label}: 型が合いません（期待: ${wanted.map((n) => readable(probeTexts[n])).join(" または ")}、実際: ${show(checker, actual)}）`,
          );
        }
      };
      operation.inputs.forEach((input, i) => {
        const parameter = signature.parameters[i];
        if (parameter === undefined) return;
        compare(
          `引数 ${input.name}`,
          checker.getTypeOfSymbol(parameter),
          inputs[i],
        );
      });
      compare("戻り値", signature.getReturnType(), outputs);
    });
  }

  checks.push((checker, _probeType, exported) => {
    const errorSymbol = exported.get(mapping.error_categories.type);
    if (errorSymbol === undefined) {
      problems.push(`${mapping.error_categories.type} が公開されていません`);
      return;
    }
    const declared = checker.getDeclaredTypeOfSymbol(errorSymbol);
    const members = declared.isUnion() ? declared.types : [declared];
    const actual = new Set(
      members.flatMap((member) => {
        const prop = checker.getPropertyOfType(
          member,
          mapping.error_categories.discriminant,
        );
        const t = prop && checker.getTypeOfSymbol(prop);
        return t?.isStringLiteral() ? [t.value] : [];
      }),
    );
    for (const name of surface.error_categories.names) {
      const value = mapping.error_categories.names[name];
      if (!actual.has(value)) {
        problems.push(
          `${mapping.error_categories.type}: 分類 ${name} の値 "${value}" がありません`,
        );
      }
    }
  });

  const probeSource = [
    `import type * as M from ${JSON.stringify(entry.replace(/\.ts$/, ""))};`,
    ...probeLines,
    "export {};",
  ].join("\n");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2015,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    ignoreDeprecations: "6.0",
    lib: ["lib.esnext.d.ts"],
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    path.resolve(fileName) === probePath
      ? ts.createSourceFile(fileName, probeSource, languageVersion)
      : original(fileName, languageVersion, ...rest);
  const program = ts.createProgram([entry, probePath], options, host);
  const checker = program.getTypeChecker();
  const entrySource = program.getSourceFile(entry);
  const moduleSymbol = entrySource && checker.getSymbolAtLocation(entrySource);
  const probeSourceFile = program.getSourceFile(probePath);
  if (moduleSymbol === undefined || probeSourceFile === undefined) {
    throw new Error(`${entryFile} をモジュールとして読み込めません`);
  }
  const exported = new Map(
    checker.getExportsOfModule(moduleSymbol).map((s) => [s.name, s]),
  );
  // 期待する型を解決できないと、その型はエラー型（any と同じ扱い）になり、照合が黙って通る。
  // そこで、探査用のファイルの型の検査のエラーを、そのままずれとして報告する。
  for (const diagnostic of ts.getPreEmitDiagnostics(program, probeSourceFile)) {
    const line =
      diagnostic.file !== undefined && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
        : -1;
    const index = line - 1; // 1 行目は import
    const typeText =
      index >= 0 && index < probeTexts.length
        ? `（${readable(probeTexts[index])}）`
        : "";
    problems.push(
      `期待する型を解決できません${typeText}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
  const aliases = probeSourceFile.statements.filter(ts.isTypeAliasDeclaration);
  const probeType = (index: number): ts.Type =>
    checker.getTypeFromTypeNode(aliases[index].type);
  for (const check of checks) check(checker, probeType, exported);
  return problems;
}
