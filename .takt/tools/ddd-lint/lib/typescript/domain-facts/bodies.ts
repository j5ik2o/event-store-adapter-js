/**
 * What a body does to state, read from its syntax alone: which members of `this` and which captured
 * bindings it writes, whether it is nothing but the return of one of them, and which type the
 * nearest binding of a name states.
 *
 * A name is captured when its nearest binding, seen from where the name is written, lies outside the
 * body: a parameter, a local, a nested function or class, or a caught error of the body is its own
 * only where it is visible, so a callback parameter of the same name elsewhere in the body does not
 * hide a captured binding, and a name bound through destructuring is found too. A captured binding
 * an enclosing function declares is closure state; one declared at the top of the file is module
 * state. A write to any captured binding is recorded; a call of an array, `Map` or `Set` changing
 * method on closure state is recorded as a write to it; and only a member of `this` or closure state,
 * or closure state itself, counts as state a getter returns. No name is resolved further than that,
 * so a write through an alias of `this` or through a value handed in is not state the body is
 * recorded to write.
 */

import type ts from "typescript";
import type { CompilerApi } from "../compiler/settings.ts";
import type { WriteFact } from "./contract.ts";

interface BodyEffects {
  readonly writes: readonly WriteFact[];
  readonly returns_state_only: boolean;
}

/** Whether the binding pattern `name` binds `text`, through any destructuring. */
function bindsName(api: CompilerApi, name: ts.BindingName, text: string): boolean {
  if (api.isIdentifier(name)) return name.text === text;
  return name.elements.some((element) => !api.isOmittedExpression(element) && bindsName(api, element.name, text));
}

/** Whether `scope` is `fn` itself or lies inside it: a binding held there belongs to `fn`. */
function within(fn: ts.Node, scope: ts.Node): boolean {
  for (let current: ts.Node | undefined = scope; current; current = current.parent) if (current === fn) return true;
  return false;
}

/**
 * Whether `identifier`, as written inside `fn`, names a binding `fn` itself holds: a parameter, a
 * local, a nested function or class, or a caught error that is visible where the name is written.
 * A binding of the same name in a nested callback that does not enclose the name is not one.
 */
function isOwnBinding(api: CompilerApi, fn: ts.Node, identifier: ts.Identifier): boolean {
  const found = nearestBinding(api, identifier, identifier.text);
  return found !== undefined && within(fn, found.scope);
}

function unwrap(api: CompilerApi, expression: ts.Expression): ts.Expression {
  let current = expression;
  while (api.isParenthesizedExpression(current) || api.isNonNullExpression(current)) current = current.expression;
  return current;
}

/**
 * The state a written expression reaches: `this.x…` writes member `x` of `this`, and `name…` writes
 * the binding `name` when the body captures it.
 */
function writtenState(api: CompilerApi, fn: ts.Node, target: ts.Expression): WriteFact | null {
  let current = unwrap(api, target);
  let member: string | null = null;
  while (api.isPropertyAccessExpression(current) || api.isElementAccessExpression(current)) {
    if (api.isPropertyAccessExpression(current)) member = current.name.text;
    else
      member =
        api.isStringLiteral(current.argumentExpression) || api.isNumericLiteral(current.argumentExpression)
          ? current.argumentExpression.text
          : "[]";
    current = unwrap(api, current.expression);
  }
  if (current.kind === api.SyntaxKind.ThisKeyword) return member === null ? null : { target: "this", name: member };
  if (api.isIdentifier(current) && !isOwnBinding(api, fn, current)) return { target: "captured", name: current.text };
  return null;
}

function isAssignment(api: CompilerApi, kind: ts.SyntaxKind): boolean {
  return kind >= api.SyntaxKind.FirstAssignment && kind <= api.SyntaxKind.LastAssignment;
}

/**
 * The methods an array, a `Map` or a `Set` changes itself through. Called on closure state for their
 * effect, they change that state as an assignment to it would.
 */
export const COLLECTION_MUTATORS: ReadonlySet<string> = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

/**
 * Whether the value of `call` is thrown away: a statement of its own, a `void` operand, or the whole
 * body of an arrow function. A built-in collection is changed this way (`state.seen.add(id);`); a
 * call whose value is kept (`const next = state.lines.add(line)`) is a first-class collection
 * handing back a new instance.
 */
function isCalledForEffect(api: CompilerApi, call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (api.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return (
    api.isExpressionStatement(parent) ||
    api.isVoidExpression(parent) ||
    (api.isArrowFunction(parent) && parent.body === node)
  );
}

/** The identifier an access chain `a.b[c].d` starts from, or undefined when it starts elsewhere. */
function rootIdentifier(api: CompilerApi, expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrap(api, expression);
  while (api.isPropertyAccessExpression(current) || api.isElementAccessExpression(current))
    current = unwrap(api, current.expression);
  return api.isIdentifier(current) ? current : undefined;
}

/**
 * Whether `identifier`, as written inside `fn`, is closure state: bound by an enclosing function
 * rather than by `fn` itself or at the top of the file, where it is module state shared by every
 * instance.
 */
function isClosureState(api: CompilerApi, fn: ts.Node, identifier: ts.Identifier): boolean {
  const found = nearestBinding(api, identifier, identifier.text);
  return found !== undefined && !api.isSourceFile(found.scope) && !within(fn, found.scope);
}

/** Whether `expression` is state read off `this` or off closure state, or closure state itself. */
function isStateRead(api: CompilerApi, fn: ts.Node, expression: ts.Expression): boolean {
  const read = unwrap(api, expression);
  if (api.isIdentifier(read)) return isClosureState(api, fn, read);
  if (!api.isPropertyAccessExpression(read)) return false;
  const owner = unwrap(api, read.expression);
  return owner.kind === api.SyntaxKind.ThisKeyword || (api.isIdentifier(owner) && isClosureState(api, fn, owner));
}

/** What the body of `fn` writes, and whether it only returns state. A function without a body does neither. */
export function bodyEffects(api: CompilerApi, fn: ts.FunctionLikeDeclaration): BodyEffects {
  const body = fn.body;
  if (!body) return { writes: [], returns_state_only: false };
  const writes = new Map<string, WriteFact>();
  const record = (target: ts.Expression) => {
    const written = writtenState(api, fn, target);
    if (written) writes.set(`${written.target}\u0000${written.name}`, written);
  };
  const visit = (node: ts.Node): void => {
    if (api.isBinaryExpression(node) && isAssignment(api, node.operatorToken.kind)) record(node.left);
    else if (
      (api.isPrefixUnaryExpression(node) || api.isPostfixUnaryExpression(node)) &&
      (node.operator === api.SyntaxKind.PlusPlusToken || node.operator === api.SyntaxKind.MinusMinusToken)
    )
      record(node.operand);
    else if (api.isDeleteExpression(node)) record(node.expression);
    else if (
      api.isCallExpression(node) &&
      api.isPropertyAccessExpression(node.expression) &&
      COLLECTION_MUTATORS.has(node.expression.name.text) &&
      isCalledForEffect(api, node)
    ) {
      const root = rootIdentifier(api, node.expression.expression);
      if (root && isClosureState(api, fn, root))
        writes.set(`captured\u0000${root.text}`, { target: "captured", name: root.text });
    }
    api.forEachChild(node, visit);
  };
  visit(body);
  const returned = api.isBlock(body)
    ? body.statements.length === 1 && api.isReturnStatement(body.statements[0])
      ? body.statements[0].expression
      : undefined
    : body;
  return {
    writes: [...writes.values()],
    returns_state_only: returned !== undefined && isStateRead(api, fn, returned),
  };
}

/** Declarations a block-like scope makes visible to the statements it holds. */
function scopeBinding(api: CompilerApi, statements: readonly ts.Statement[], name: string): ts.Node | undefined {
  for (const statement of statements) {
    if (api.isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find((declaration) =>
        bindsName(api, declaration.name, name),
      );
      if (found) return found;
    } else if (
      (api.isFunctionDeclaration(statement) || api.isClassDeclaration(statement)) &&
      statement.name?.text === name
    )
      return statement;
  }
  return undefined;
}

function listBinding(api: CompilerApi, list: ts.ForInitializer | undefined, name: string): ts.Node | undefined {
  if (!list || !api.isVariableDeclarationList(list)) return undefined;
  return list.declarations.find((declaration) => bindsName(api, declaration.name, name));
}

/**
 * A `var` of `name` anywhere in the body of `fn` outside its nested functions: `var` is hoisted to
 * the function, so it binds the name throughout the body even when written in a nested block.
 */
function hoistedVar(api: CompilerApi, fn: ts.SignatureDeclaration, name: string): ts.Node | undefined {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return undefined;
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found || (node !== body && api.isFunctionLike(node))) return;
    if (
      api.isVariableDeclarationList(node) &&
      !(node.flags & (api.NodeFlags.Let | api.NodeFlags.Const)) &&
      node.declarations.some((declaration) => bindsName(api, declaration.name, name))
    ) {
      found = node.declarations.find((declaration) => bindsName(api, declaration.name, name));
      return;
    }
    api.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * The nearest binding of `name` seen from `from`, and the scope that holds it. A name bound through
 * destructuring is found as well; its binding is the parameter or declaration that destructures.
 */
export function nearestBinding(
  api: CompilerApi,
  from: ts.Node,
  name: string,
): { binding: ts.Node; scope: ts.Node } | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    let binding: ts.Node | undefined;
    if (api.isFunctionLike(scope)) {
      binding =
        scope.parameters.find((parameter) => bindsName(api, parameter.name, name)) ??
        ((api.isFunctionExpression(scope) || api.isClassExpression(scope)) && scope.name?.text === name
          ? scope
          : undefined) ??
        hoistedVar(api, scope, name);
    } else if (api.isBlock(scope) || api.isSourceFile(scope) || api.isModuleBlock(scope) || api.isCaseClause(scope))
      binding = scopeBinding(api, scope.statements, name);
    else if (api.isForStatement(scope) || api.isForOfStatement(scope) || api.isForInStatement(scope))
      binding = listBinding(api, scope.initializer, name);
    else if (api.isCatchClause(scope) && scope.variableDeclaration)
      binding = bindsName(api, scope.variableDeclaration.name, name) ? scope.variableDeclaration : undefined;
    if (binding) return { binding, scope };
  }
  return undefined;
}

/**
 * The type the nearest binding of `name`, seen from `from`, states: a parameter or a variable
 * annotation. Undefined when that binding states no type, or no binding of the name is written
 * between `from` and the top of the file.
 */
export function bindingTypeOf(api: CompilerApi, file: ts.SourceFile, from: ts.Node, name: string): string | undefined {
  const found = nearestBinding(api, from, name);
  if (!found) return undefined;
  const binding = found.binding;
  if (!api.isParameter(binding) && !api.isVariableDeclaration(binding)) return undefined;
  // A name bound through destructuring takes one part of the stated type, not the type itself.
  if (!api.isIdentifier(binding.name)) return undefined;
  return binding.type?.getText(file);
}
