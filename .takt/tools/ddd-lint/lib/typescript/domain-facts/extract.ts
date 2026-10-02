/**
 * The walk from one parsed TypeScript file to the facts rules read. Every fact comes from a syntax
 * node, so a spelling inside a comment, a string or a regular expression is never a fact, and no
 * fact depends on what a name resolves to: the extraction runs without a type checker.
 *
 * Declarations, members, static imports and exports are read from the statements at the top of the
 * file. Calls, constructions, keyed literals, dynamic imports and import types are read wherever
 * they are written. A construct that could hide one of these facts is returned as unresolved
 * instead of being read as if it declared nothing; inside a literal written in code, it marks that
 * literal opaque instead, because the literal is the fact it hides members of.
 */

import type ts from "typescript";
import type { CompilerApi } from "../compiler/settings.ts";
import { bindingTypeOf, bodyEffects } from "./bodies.ts";
import type {
  CallFact,
  ConstructionFact,
  DeclarationFact,
  DeclarationKind,
  ExportFact,
  HeritageFact,
  ImportBinding,
  ImportFact,
  InitializerFact,
  KeyedLiteralFact,
  LiteralForm,
  MemberFact,
  ParamFact,
  Span,
  TypeScriptFileFacts,
  UnresolvedFact,
  UnresolvedReason,
  VariableBinding,
  Visibility,
} from "./contract.ts";
import { forwardedTo } from "./forwarding.ts";

/** Members a literal spells, and whether a spread or an unspellable computed name hides others. */
interface LiteralMembers {
  readonly members: MemberFact[];
  readonly opaque: boolean;
}

export function extractFileFacts(api: CompilerApi, file: ts.SourceFile): TypeScriptFileFacts {
  const declarations: DeclarationFact[] = [];
  const imports: ImportFact[] = [];
  const exports: ExportFact[] = [];
  const calls: CallFact[] = [];
  const constructions: ConstructionFact[] = [];
  const keyedLiterals: KeyedLiteralFact[] = [];
  const unresolved: UnresolvedFact[] = [];

  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const spanOf = (node: ts.Node): Span => {
    const start = file.getLineAndCharacterOfPosition(node.getStart(file));
    const end = file.getLineAndCharacterOfPosition(node.getEnd());
    return {
      start_line: start.line + 1,
      start_col: start.character + 1,
      end_line: end.line + 1,
      end_col: end.character + 1,
    };
  };
  const leaveUnresolved = (node: ts.Node, reason: UnresolvedReason): void => {
    unresolved.push({ line: lineOf(node), reason });
  };
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    api.canHaveModifiers(node) && (api.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

  /**
   * What happens to a construct that hides a member. Members read for a declaration at the top of
   * the file leave it unresolved; members read for a literal written inside code mark that literal
   * opaque instead, so the literal carries the answer rather than the file.
   */
  type Hidden = (node: ts.Node, reason: UnresolvedReason) => void;
  const unresolvedAt: Hidden = leaveUnresolved;

  /**
   * A member name as the source spells it. A computed name spelled by one identifier is kept with
   * that identifier; what value the identifier holds is left to the rule that asks. Any other
   * computed name is decided only when the program runs.
   */
  function memberName(name: ts.PropertyName, hidden: Hidden): { name: string; computed_key?: string } | null {
    if (api.isComputedPropertyName(name)) {
      if (api.isIdentifier(name.expression))
        return { name: `[${name.expression.text}]`, computed_key: name.expression.text };
      hidden(name, "computed-name");
      return null;
    }
    return { name: name.text };
  }

  function paramsOf(parameters: readonly ts.ParameterDeclaration[]): ParamFact[] {
    return parameters.map((parameter) => ({
      name: parameter.name.getText(file),
      ...(parameter.type ? { type_text: parameter.type.getText(file) } : {}),
    }));
  }

  function member(
    node: ts.Node,
    name: ts.PropertyName,
    kind: MemberFact["kind"],
    visibility: Visibility | null,
    hidden: Hidden,
  ): MemberFact[] {
    const spelled = memberName(name, hidden);
    if (spelled === null) return [];
    const typed = api.isPropertyDeclaration(node) || api.isPropertySignature(node) || api.isParameter(node);
    const signature =
      api.isMethodDeclaration(node) || api.isMethodSignature(node) || api.isConstructorDeclaration(node);
    const body = api.isMethodDeclaration(node) && node.body ? bodyEffects(api, node) : null;
    return [
      {
        ...spelled,
        kind,
        visibility:
          visibility ??
          (api.isPrivateIdentifier(name)
            ? "private-name"
            : hasModifier(node, api.SyntaxKind.PrivateKeyword)
              ? "private"
              : hasModifier(node, api.SyntaxKind.ProtectedKeyword)
                ? "protected"
                : "public"),
        static: hasModifier(node, api.SyntaxKind.StaticKeyword),
        readonly: hasModifier(node, api.SyntaxKind.ReadonlyKeyword),
        ambient: hasModifier(node, api.SyntaxKind.DeclareKeyword),
        abstract: hasModifier(node, api.SyntaxKind.AbstractKeyword),
        ...(typed && node.type ? { type_text: node.type.getText(file) } : {}),
        ...(signature ? { params: paramsOf(node.parameters) } : {}),
        ...((api.isMethodDeclaration(node) || api.isMethodSignature(node)) && node.type
          ? { return_type_text: node.type.getText(file) }
          : {}),
        ...(body ? { writes: body.writes, returns_state_only: body.returns_state_only } : {}),
        span: spanOf(node),
      },
    ];
  }

  function classMembers(node: ts.ClassDeclaration): MemberFact[] {
    return node.members.flatMap((element): MemberFact[] => {
      if (api.isPropertyDeclaration(element)) return member(element, element.name, "property", null, unresolvedAt);
      if (api.isMethodDeclaration(element)) return member(element, element.name, "method", null, unresolvedAt);
      if (api.isGetAccessorDeclaration(element))
        return member(element, element.name, "get-accessor", null, unresolvedAt);
      if (api.isSetAccessorDeclaration(element))
        return member(element, element.name, "set-accessor", null, unresolvedAt);
      if (api.isConstructorDeclaration(element)) {
        const constructorMember: MemberFact = {
          name: "constructor",
          kind: "constructor",
          visibility: hasModifier(element, api.SyntaxKind.PrivateKeyword)
            ? "private"
            : hasModifier(element, api.SyntaxKind.ProtectedKeyword)
              ? "protected"
              : "public",
          static: false,
          readonly: false,
          ambient: false,
          abstract: false,
          params: paramsOf(element.parameters),
          span: spanOf(element),
        };
        const parameterProperties = element.parameters
          .filter((parameter) => api.isParameterPropertyDeclaration(parameter, element))
          .flatMap((parameter) =>
            api.isIdentifier(parameter.name) ? member(parameter, parameter.name, "property", null, unresolvedAt) : [],
          );
        return [constructorMember, ...parameterProperties];
      }
      return [];
    });
  }

  function typeMembers(elements: readonly ts.TypeElement[]): MemberFact[] {
    return elements.flatMap((element): MemberFact[] => {
      if (!element.name) return [];
      if (api.isPropertySignature(element)) return member(element, element.name, "property", "public", unresolvedAt);
      if (api.isMethodSignature(element)) return member(element, element.name, "method", "public", unresolvedAt);
      if (api.isGetAccessorDeclaration(element))
        return member(element, element.name, "get-accessor", "public", unresolvedAt);
      if (api.isSetAccessorDeclaration(element))
        return member(element, element.name, "set-accessor", "public", unresolvedAt);
      return [];
    });
  }

  /** The members a literal spells; a spread brings in members only the running program knows. */
  function objectMembers(literal: ts.ObjectLiteralExpression, hidden: Hidden): MemberFact[] {
    return literal.properties.flatMap((element): MemberFact[] => {
      if (api.isPropertyAssignment(element) || api.isShorthandPropertyAssignment(element))
        return member(element, element.name, "property", "public", hidden);
      if (api.isMethodDeclaration(element)) return member(element, element.name, "method", "public", hidden);
      if (api.isGetAccessorDeclaration(element)) return member(element, element.name, "get-accessor", "public", hidden);
      if (api.isSetAccessorDeclaration(element)) return member(element, element.name, "set-accessor", "public", hidden);
      const spread: ts.SpreadAssignment = element;
      hidden(spread, "object-spread");
      return [];
    });
  }

  /** The members of a literal written inside code; what hides a member marks the literal opaque. */
  function literalMembers(literal: ts.ObjectLiteralExpression): LiteralMembers {
    let opaque = false;
    const members = objectMembers(literal, () => {
      opaque = true;
    });
    return { members, opaque };
  }

  /** The object literal an expression is, looking through parentheses and type assertions. */
  function objectLiteralOf(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
    let current = expression;
    while (
      current &&
      (api.isParenthesizedExpression(current) ||
        api.isAsExpression(current) ||
        api.isSatisfiesExpression(current) ||
        api.isTypeAssertionExpression(current))
    )
      current = current.expression;
    return current && api.isObjectLiteralExpression(current) ? current : null;
  }

  /** What only some kinds of declaration record: heritage, a type literal, a stated type, an initializer. */
  type DeclarationDetail = Pick<
    DeclarationFact,
    "binding" | "heritage" | "type_literal" | "type_text" | "initializer" | "params"
  >;

  function recordDeclaration(
    statement: ts.Statement,
    node: ts.Node,
    name: ts.Identifier | undefined,
    kind: DeclarationKind,
    members: readonly MemberFact[],
    detail: DeclarationDetail = {},
  ): void {
    const exported = hasModifier(statement, api.SyntaxKind.ExportKeyword);
    declarations.push({
      name: name ? name.text : "default",
      kind,
      ...detail,
      exported,
      default_export: exported && hasModifier(statement, api.SyntaxKind.DefaultKeyword),
      ambient: hasModifier(statement, api.SyntaxKind.DeclareKeyword),
      span: spanOf(node),
      members,
    });
  }

  function heritageOf(node: ts.ClassDeclaration): HeritageFact[] {
    return (node.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => ({
        kind: clause.token === api.SyntaxKind.ExtendsKeyword ? ("extends" as const) : ("implements" as const),
        type_text: type.getText(file),
      })),
    );
  }

  function initializerOf(expression: ts.Expression): InitializerFact {
    let current = expression;
    while (api.isParenthesizedExpression(current)) current = current.expression;
    if (api.isObjectLiteralExpression(current)) return { kind: "object-literal" };
    if (api.isCallExpression(current) && api.isIdentifier(current.expression))
      return {
        kind: "call",
        callee_text: current.expression.text,
        arguments: current.arguments.map((argument) =>
          api.isStringLiteral(argument) ? ("string-literal" as const) : ("other" as const),
        ),
      };
    return { kind: "other" };
  }

  function variableBinding(list: ts.VariableDeclarationList): VariableBinding {
    const flags = list.flags & api.NodeFlags.BlockScoped;
    if (flags === api.NodeFlags.Const) return "const";
    if (flags === api.NodeFlags.Let) return "let";
    if (flags === api.NodeFlags.Using) return "using";
    if (flags === api.NodeFlags.AwaitUsing) return "await-using";
    return "var";
  }

  function specifierOf(expression: ts.Expression): string {
    if (!api.isStringLiteral(expression))
      throw new Error(`a module specifier at line ${lineOf(expression)} is not a string`);
    return expression.text;
  }

  function staticImport(node: ts.ImportDeclaration): void {
    const specifier = specifierOf(node.moduleSpecifier);
    const clause = node.importClause;
    const line = lineOf(node);
    if (!clause) {
      imports.push({ specifier, kind: "side-effect", type_only: false, bindings: [], line });
      return;
    }
    const typeOnly = clause.phaseModifier === api.SyntaxKind.TypeKeyword;
    const bindings: ImportBinding[] = [];
    if (clause.name) bindings.push({ name: clause.name.text, imported: "default", type_only: typeOnly });
    const named = clause.namedBindings;
    if (named && api.isNamespaceImport(named))
      bindings.push({ name: named.name.text, imported: "*", type_only: typeOnly });
    if (named && api.isNamedImports(named))
      for (const element of named.elements)
        bindings.push({
          name: element.name.text,
          imported: (element.propertyName ?? element.name).text,
          type_only: typeOnly || element.isTypeOnly,
        });
    const kind =
      named && api.isNamespaceImport(named) ? "namespace" : named && api.isNamedImports(named) ? "named" : "default";
    imports.push({ specifier, kind, type_only: typeOnly, bindings, line });
  }

  function exportStatement(node: ts.ExportDeclaration): void {
    const specifier = node.moduleSpecifier ? { specifier: specifierOf(node.moduleSpecifier) } : {};
    const line = lineOf(node);
    const clause = node.exportClause;
    if (!clause) {
      exports.push({ kind: "all", ...specifier, type_only: node.isTypeOnly, names: [], line });
      return;
    }
    if (api.isNamespaceExport(clause)) {
      exports.push({
        kind: "namespace",
        ...specifier,
        type_only: node.isTypeOnly,
        names: [{ name: clause.name.text, local: "*", type_only: node.isTypeOnly }],
        line,
      });
      return;
    }
    exports.push({
      kind: "named",
      ...specifier,
      type_only: node.isTypeOnly,
      names: clause.elements.map((element) => ({
        name: element.name.text,
        local: (element.propertyName ?? element.name).text,
        type_only: node.isTypeOnly || element.isTypeOnly,
      })),
      line,
    });
  }

  function variables(statement: ts.VariableStatement): void {
    const binding = variableBinding(statement.declarationList);
    for (const declaration of statement.declarationList.declarations) {
      if (!api.isIdentifier(declaration.name)) {
        leaveUnresolved(declaration.name, "binding-pattern");
        continue;
      }
      const literal = objectLiteralOf(declaration.initializer);
      const members = literal ? objectMembers(literal, unresolvedAt) : [];
      recordDeclaration(statement, declaration, declaration.name, "variable", members, {
        binding,
        ...(declaration.type ? { type_text: declaration.type.getText(file) } : {}),
        ...(declaration.initializer ? { initializer: initializerOf(declaration.initializer) } : {}),
      });
    }
  }

  function topLevel(statement: ts.Statement): void {
    if (api.isImportDeclaration(statement)) {
      staticImport(statement);
    } else if (api.isExportDeclaration(statement)) {
      exportStatement(statement);
    } else if (api.isExportAssignment(statement)) {
      if (statement.isExportEquals) leaveUnresolved(statement, "export-assignment");
      else exports.push({ kind: "default-expression", type_only: false, names: [], line: lineOf(statement) });
    } else if (api.isImportEqualsDeclaration(statement)) {
      leaveUnresolved(statement, "import-equals");
    } else if (api.isModuleDeclaration(statement) || api.isNamespaceExportDeclaration(statement)) {
      leaveUnresolved(statement, "namespace");
    } else if (api.isClassDeclaration(statement)) {
      recordDeclaration(statement, statement, statement.name, "class", classMembers(statement), {
        heritage: heritageOf(statement),
      });
    } else if (api.isInterfaceDeclaration(statement)) {
      recordDeclaration(statement, statement, statement.name, "interface", typeMembers(statement.members));
    } else if (api.isTypeAliasDeclaration(statement)) {
      const aliased = statement.type;
      const literal = api.isTypeLiteralNode(aliased);
      const members = literal ? typeMembers(aliased.members) : [];
      recordDeclaration(statement, statement, statement.name, "type-alias", members, { type_literal: literal });
    } else if (api.isEnumDeclaration(statement)) {
      const members = statement.members.flatMap((element) =>
        member(element, element.name, "enum-member", "public", unresolvedAt),
      );
      recordDeclaration(statement, statement, statement.name, "enum", members);
    } else if (api.isFunctionDeclaration(statement)) {
      recordDeclaration(statement, statement, statement.name, "function", [], {
        params: paramsOf(statement.parameters),
      });
    } else if (api.isVariableStatement(statement)) {
      variables(statement);
    }
  }

  function callee(node: ts.CallExpression | ts.TaggedTemplateExpression, target: ts.Expression): void {
    const reached = api.isCallExpression(node) ? forwardedTo(api, node) : undefined;
    const forwarded = reached ? { forwarded_to: reached.map(spanOf) } : {};
    if (target.kind === api.SyntaxKind.SuperKeyword)
      calls.push({ kind: "super-call", callee_text: "super", ...forwarded, span: spanOf(node) });
    else if (api.isIdentifier(target))
      calls.push({ kind: "function-call", callee_text: target.text, ...forwarded, span: spanOf(node) });
    else if (api.isPropertyAccessExpression(target)) {
      const receiver = target.expression;
      const bound = api.isIdentifier(receiver) ? bindingTypeOf(api, file, node, receiver.text) : undefined;
      calls.push({
        kind: "method-call",
        callee_text: target.name.text,
        receiver_text: receiver.getText(file),
        ...(bound === undefined ? {} : { receiver_binding_type: bound }),
        ...forwarded,
        span: spanOf(node),
      });
    } else leaveUnresolved(node, "dynamic-callee");
  }

  /** The type an object literal is written against, when an assertion or an annotation states one. */
  function statedType(literal: ts.ObjectLiteralExpression): { type: ts.TypeNode; form: LiteralForm } | null {
    let outer: ts.Node = literal;
    while (api.isParenthesizedExpression(outer.parent)) outer = outer.parent;
    const parent = outer.parent;
    if (api.isAsExpression(parent) || api.isSatisfiesExpression(parent) || api.isTypeAssertionExpression(parent))
      return api.isConstTypeReference(parent.type)
        ? null
        : { type: parent.type, form: api.isSatisfiesExpression(parent) ? "satisfies" : "assertion" };
    if (api.isVariableDeclaration(parent) && parent.initializer === outer && parent.type)
      return { type: parent.type, form: "annotation" };
    return null;
  }

  /**
   * An assertion to a named type of anything but an object literal, which is recorded as a typed
   * literal instead. An assertion to `const` or to a keyword type names no type to construct.
   */
  function typeAssertion(node: ts.AsExpression | ts.TypeAssertion): void {
    let asserted = node.expression;
    while (api.isParenthesizedExpression(asserted)) asserted = asserted.expression;
    if (api.isObjectLiteralExpression(asserted)) return;
    if (!api.isTypeReferenceNode(node.type) || api.isConstTypeReference(node.type)) return;
    constructions.push({ kind: "type-assertion", type_text: node.type.getText(file), span: spanOf(node) });
  }

  function objectLiteral(node: ts.ObjectLiteralExpression): void {
    const stated = statedType(node);
    if (stated) {
      constructions.push({
        kind: "typed-object-literal",
        type_text: stated.type.getText(file),
        form: stated.form,
        ...literalMembers(node),
        span: spanOf(node),
      });
      return;
    }
    const keyed = node.properties.some(
      (element) =>
        element.name && api.isComputedPropertyName(element.name) && api.isIdentifier(element.name.expression),
    );
    if (keyed) keyedLiterals.push({ ...literalMembers(node), span: spanOf(node) });
  }

  function visit(node: ts.Node): void {
    if (node.parent === file && api.isStatement(node)) topLevel(node);
    if (api.isDecorator(node)) leaveUnresolved(node, "decorator");
    else if (api.isCallExpression(node)) {
      if (node.expression.kind === api.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument && (api.isStringLiteral(argument) || api.isNoSubstitutionTemplateLiteral(argument)))
          imports.push({
            specifier: argument.text,
            kind: "dynamic",
            type_only: false,
            bindings: [],
            line: lineOf(node),
          });
        else leaveUnresolved(node, "dynamic-import");
      } else callee(node, node.expression);
    } else if (api.isTaggedTemplateExpression(node)) callee(node, node.tag);
    else if (api.isNewExpression(node)) {
      if (api.isIdentifier(node.expression) || api.isPropertyAccessExpression(node.expression))
        constructions.push({ kind: "new-expression", type_text: node.expression.getText(file), span: spanOf(node) });
      else leaveUnresolved(node, "dynamic-callee");
    } else if (api.isObjectLiteralExpression(node)) objectLiteral(node);
    else if (api.isAsExpression(node) || api.isTypeAssertionExpression(node)) typeAssertion(node);
    else if (api.isImportTypeNode(node)) {
      const argument = node.argument;
      if (api.isLiteralTypeNode(argument) && api.isStringLiteral(argument.literal))
        imports.push({
          specifier: argument.literal.text,
          kind: "type-query",
          type_only: true,
          bindings: [],
          line: lineOf(node),
        });
      else leaveUnresolved(node, "dynamic-import");
    }
    api.forEachChild(node, visit);
  }

  visit(file);
  return { declarations, imports, exports, calls, constructions, keyed_literals: keyedLiterals, unresolved };
}
