/**
 * What the TypeScript rules of every gate read off the facts of one source file: the facts
 * themselves, the class a call is written in, and the type a call's receiver is stated to have.
 *
 * Nothing here infers a type. A receiver type is what an annotation or a class property spells.
 */

import type { CallFact, TypeScriptFileFacts } from "../../typescript/domain-facts/index.ts";
import { within } from "./symbols.ts";
import type { TsInspection } from "./types.ts";

export function factsOf(inspection: TsInspection, file: string): TypeScriptFileFacts {
  const facts = inspection.facts.files.get(file);
  if (!facts) throw new Error(`the TypeScript facts carry no record for ${file}`);
  return facts;
}

/** The class of `facts` whose body `call` is written in. */
export function enclosingClass(facts: TypeScriptFileFacts, call: CallFact) {
  return facts.declarations.find((declaration) => declaration.kind === "class" && within(call.span, declaration.span));
}

/**
 * The type a receiver is stated to have: an annotated binding, or a property of the class whose
 * body the call is written in.
 */
export function receiverType(facts: TypeScriptFileFacts, call: CallFact): string | undefined {
  const receiver = (call.receiver_text ?? "").replace(/\s+/g, "");
  if (/^[A-Za-z_$][\w$]*$/.test(receiver)) return call.receiver_binding_type;
  const field = /^this\.(#?[A-Za-z_$][\w$]*)$/.exec(receiver)?.[1];
  if (field === undefined) return undefined;
  return enclosingClass(facts, call)?.members.find((member) => member.name === field && member.kind === "property")
    ?.type_text;
}
