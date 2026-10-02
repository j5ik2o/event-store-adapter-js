/**
 * Where the result of a call is handed on unchanged, read from its syntax alone: as an argument of
 * another call, with nothing but parentheses around it, or through a `const` binding whose every
 * reference is handed on the same way. A chain of such bindings is followed, at most
 * `MAX_BINDING_DEPTH` deep. Any other use — an operand, a receiver, an assertion, a condition, a
 * `let`, an unused binding, one reference used otherwise — hands the result on nowhere. So does a
 * `const` declared directly in a `case` or `default` clause: its scope is the whole case block, so a
 * later clause may read it where this clause's references do not reach.
 *
 * A reference of a binding is an identifier whose nearest binding is that binding. A property name,
 * a member name, the name a declaration introduces and an identifier written in a type are not
 * references: they name no value the program reads.
 */

import type ts from "typescript";
import type { CompilerApi } from "../compiler/settings.ts";
import { nearestBinding } from "./bodies.ts";

const MAX_BINDING_DEPTH = 64;

/** The `const` binding `node` initializes as a whole, or undefined when it is written anywhere else. */
function initializedConst(api: CompilerApi, node: ts.Expression): ts.VariableDeclaration | undefined {
  const parent = node.parent;
  if (!api.isVariableDeclaration(parent) || parent.initializer !== node || !api.isIdentifier(parent.name))
    return undefined;
  const list = parent.parent;
  if (!api.isVariableDeclarationList(list)) return undefined;
  // A `const` written directly in a `case` or `default` clause is in scope for the whole case
  // block, while `referencesOf` reads only its own clause: its references cannot be proven.
  if (api.isVariableStatement(list.parent) && api.isCaseOrDefaultClause(list.parent.parent)) return undefined;
  return (list.flags & api.NodeFlags.BlockScoped) === api.NodeFlags.Const ? parent : undefined;
}

/** Whether `identifier` is written where it reads a value, rather than naming a property or a declaration. */
function isValueReference(api: CompilerApi, identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (api.isShorthandPropertyAssignment(parent)) return parent.name === identifier;
  // `export { name }` and `export { name as other }` read the local binding.
  if (api.isExportSpecifier(parent)) return (parent.propertyName ?? parent.name) === identifier;
  if ("name" in parent && (parent as { name?: ts.Node }).name === identifier) return false;
  if ("propertyName" in parent && (parent as { propertyName?: ts.Node }).propertyName === identifier) return false;
  if ("label" in parent && (parent as { label?: ts.Node }).label === identifier) return false;
  return true;
}

/** The value references of `declaration`, in source order, within the scope that holds it. */
function referencesOf(api: CompilerApi, declaration: ts.VariableDeclaration): ts.Identifier[] {
  const name = (declaration.name as ts.Identifier).text;
  const list = declaration.parent;
  const scope = api.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (api.isTypeNode(node)) return;
    if (
      api.isIdentifier(node) &&
      node.text === name &&
      isValueReference(api, node) &&
      nearestBinding(api, node, name)?.binding === declaration
    )
      found.push(node);
    api.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** The calls `expression` is handed to unchanged, or undefined when any use of it is another one. */
function forwardedCalls(api: CompilerApi, expression: ts.Expression, depth: number): ts.CallExpression[] | undefined {
  let outer: ts.Expression = expression;
  while (api.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if (api.isCallExpression(parent) && parent.arguments.some((argument) => argument === outer)) return [parent];
  const binding = depth < MAX_BINDING_DEPTH ? initializedConst(api, outer) : undefined;
  if (!binding) return undefined;
  const references = referencesOf(api, binding);
  if (references.length === 0) return undefined;
  const calls: ts.CallExpression[] = [];
  for (const reference of references) {
    const reached = forwardedCalls(api, reference, depth + 1);
    if (!reached) return undefined;
    calls.push(...reached);
  }
  return calls;
}

/**
 * The calls the result of `call` is handed to unchanged, in source order, each once; undefined when
 * the result is used any other way or not at all.
 */
export function forwardedTo(api: CompilerApi, call: ts.CallExpression): ts.CallExpression[] | undefined {
  const reached = forwardedCalls(api, call, 0);
  if (!reached) return undefined;
  return [...new Set(reached)].sort((a, b) => a.getStart() - b.getStart());
}
