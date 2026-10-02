/**
 * The facts every TypeScript rule decides on, as plain records. `index.ts` re-exports them as the
 * public surface of the extraction; `extract.ts` builds them. Neither imports the other for them.
 */

/** Lines are 1-based; columns are 1-based UTF-16 code units, and the end column is one past the node. */
export interface Span {
  readonly start_line: number;
  readonly start_col: number;
  readonly end_line: number;
  readonly end_col: number;
}

export type DeclarationKind = "class" | "interface" | "type-alias" | "enum" | "function" | "variable";
export type VariableBinding = "const" | "let" | "var" | "using" | "await-using";
export type Visibility = "public" | "protected" | "private" | "private-name";

/** One parameter of a method or constructor, with the type it states, if it states one. */
export interface ParamFact {
  /** The parameter name as the source spells it; a destructured parameter keeps its pattern. */
  readonly name: string;
  readonly type_text?: string;
}

/**
 * State a body writes: a member of `this` it assigns, updates or deletes, or a binding the body
 * captures from outside itself rather than declares — assigned, updated or deleted through, or, when
 * it is closure state, changed by an array, `Map` or `Set` changing method.
 */
export interface WriteFact {
  readonly target: "this" | "captured";
  /** The member of `this` written through (a private name keeps its `#`), or the captured binding. */
  readonly name: string;
}

export interface MemberFact {
  /**
   * As the source spells it; a private name keeps its `#`. A computed name spelled by one
   * identifier is `[identifier]`, and carries that identifier as `computed_key`.
   */
  readonly name: string;
  readonly kind: "property" | "method" | "get-accessor" | "set-accessor" | "constructor" | "enum-member";
  readonly visibility: Visibility;
  readonly static: boolean;
  /** Whether the member is declared with the `readonly` modifier. */
  readonly readonly: boolean;
  /** Whether the member is declared with `declare`: it states a type and no run-time member. */
  readonly ambient: boolean;
  readonly abstract: boolean;
  /** The identifier a computed name `[identifier]` is keyed by; which value it holds is the program's. */
  readonly computed_key?: string;
  /** The type the member states: a property's annotation, a parameter property's parameter type. */
  readonly type_text?: string;
  /** The parameters of a method, a method signature or a constructor. */
  readonly params?: readonly ParamFact[];
  /** The return type a method or a method signature states. */
  readonly return_type_text?: string;
  /** What a member with a body writes; present on members with a body only. */
  readonly writes?: readonly WriteFact[];
  /**
   * Whether the body is nothing but `return` of one member of `this`, of one member of closure
   * state, or of closure state itself — the shape a getter has. Closure state is a binding an
   * enclosing function declares, not one at the top of the file. Present on members with a body only.
   */
  readonly returns_state_only?: boolean;
  readonly span: Span;
}

/** A type a class names after `extends` or `implements`, as the source spells it. */
export interface HeritageFact {
  readonly kind: "extends" | "implements";
  readonly type_text: string;
}

/**
 * How a variable is initialized, as far as its syntax tells: a call of a function named by one
 * identifier (with what each argument is), an object literal, or anything else.
 */
export type InitializerFact =
  | {
      readonly kind: "call";
      readonly callee_text: string;
      readonly arguments: readonly ("string-literal" | "other")[];
    }
  | { readonly kind: "object-literal" }
  | { readonly kind: "other" };

/** One declaration at the top of a file. An `export` written on it is recorded here, not as an export. */
export interface DeclarationFact {
  /** `default` for an anonymous default-exported class or function. */
  readonly name: string;
  readonly kind: DeclarationKind;
  /** The keyword a variable is declared with; present on variables only. */
  readonly binding?: VariableBinding;
  readonly exported: boolean;
  readonly default_export: boolean;
  readonly ambient: boolean;
  readonly span: Span;
  readonly members: readonly MemberFact[];
  /** What a class extends and implements, in source order; present on classes only. */
  readonly heritage?: readonly HeritageFact[];
  /** Whether a type alias names a type literal `{ … }`; present on type aliases only. */
  readonly type_literal?: boolean;
  /** The type a variable states; present on variables that state one. */
  readonly type_text?: string;
  /** How a variable is initialized; present on variables that have an initializer. */
  readonly initializer?: InitializerFact;
  /** The parameters of a function declaration; present on function declarations only. */
  readonly params?: readonly ParamFact[];
}

export interface ImportBinding {
  /** The local name. */
  readonly name: string;
  /** The name the module exports it under: `default` for a default import, `*` for a namespace. */
  readonly imported: string;
  readonly type_only: boolean;
}

/** A dependency on a module, whether a statement, an `import("…")` call, or an import type. */
export interface ImportFact {
  readonly specifier: string;
  readonly kind: "named" | "default" | "namespace" | "side-effect" | "dynamic" | "type-query";
  /** Whether the whole dependency is erased: `import type …` and import types are. */
  readonly type_only: boolean;
  readonly bindings: readonly ImportBinding[];
  readonly line: number;
}

export interface ExportName {
  /** The name the module exports. */
  readonly name: string;
  /** The name it has where it comes from: the local binding, the source module's name, or `*`. */
  readonly local: string;
  readonly type_only: boolean;
}

/** An export statement. A declaration written with `export` is carried by the declaration instead. */
export interface ExportFact {
  readonly kind: "named" | "all" | "namespace" | "default-expression";
  /** The module re-exported from; absent when the statement names no module. */
  readonly specifier?: string;
  readonly type_only: boolean;
  readonly names: readonly ExportName[];
  readonly line: number;
}

export interface CallFact {
  readonly kind: "function-call" | "method-call" | "super-call";
  /** The function name, the method name, or `super`. */
  readonly callee_text: string;
  /** The receiver of a method call as the source spells it. */
  readonly receiver_text?: string;
  /**
   * For a method call on one identifier, the type the nearest binding of that identifier states —
   * a parameter or a variable annotation. Absent when that binding states none or is not found.
   */
  readonly receiver_binding_type?: string;
  /**
   * The calls the result of this call is handed to unchanged: as an argument of a call, with only
   * parentheses around it, or through a `const` binding every reference of which is handed on so —
   * a chain of such bindings included. Absent when the result is used any other way, or not at all.
   */
  readonly forwarded_to?: readonly Span[];
  readonly span: Span;
}

/** How an object literal is written against a type: an annotated binding, an assertion, or `satisfies`. */
export type LiteralForm = "annotation" | "assertion" | "satisfies";

export type ConstructionFact =
  | {
      /** `new-expression` is `new T(…)`; `type-assertion` is `x as T` or `<T>x` of a named type. */
      readonly kind: "new-expression" | "type-assertion";
      /** The constructed class or the asserted type, as the source spells it. */
      readonly type_text: string;
      readonly span: Span;
    }
  | {
      readonly kind: "typed-object-literal";
      /** The stated type, as the source spells it. */
      readonly type_text: string;
      readonly form: LiteralForm;
      readonly members: readonly MemberFact[];
      /** Whether a spread or a computed name the syntax cannot spell hides some of its members. */
      readonly opaque: boolean;
      readonly span: Span;
    };

/** An object literal no type is stated for, with a member keyed by a computed `[identifier]`. */
export interface KeyedLiteralFact {
  readonly members: readonly MemberFact[];
  /** Whether a spread or a computed name the syntax cannot spell hides some of its members. */
  readonly opaque: boolean;
  readonly span: Span;
}

export type UnresolvedReason =
  | "decorator"
  | "computed-name"
  | "object-spread"
  | "binding-pattern"
  | "import-equals"
  | "export-assignment"
  | "dynamic-import"
  | "namespace"
  | "dynamic-callee";

/** A construct whose declarations, dependencies or callee cannot be decided from its syntax. */
export interface UnresolvedFact {
  readonly line: number;
  readonly reason: UnresolvedReason;
}

/** What one file declares and uses, each list in source order. A file without a record was not read. */
export interface TypeScriptFileFacts {
  readonly declarations: readonly DeclarationFact[];
  readonly imports: readonly ImportFact[];
  readonly exports: readonly ExportFact[];
  readonly calls: readonly CallFact[];
  readonly constructions: readonly ConstructionFact[];
  readonly keyed_literals: readonly KeyedLiteralFact[];
  readonly unresolved: readonly UnresolvedFact[];
}

export interface TypeScriptFactSet {
  /** Workspace-relative file -> its facts. A file whose syntax was rejected has none. */
  readonly files: ReadonlyMap<string, TypeScriptFileFacts>;
  /** One line per construct that could hide a fact from this answer, sorted, each once. */
  readonly notes: readonly string[];
}

/** One source of the inspected program. */
export interface TypeScriptSourceFile {
  /** Workspace-relative path; the answer is keyed by it. A `.tsx` path is parsed as TSX. */
  readonly file: string;
  readonly source: string;
}
