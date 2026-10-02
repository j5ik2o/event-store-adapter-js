//! Version 7 domain facts: the decision base of every rule the domain gate reports. Source is
//! never compiled or executed.
//!
//! One batch carries every source of the inspected program, and the answer carries one record per
//! requested file. A record names what the file *declares* — its non-private struct members, its
//! types, traits, impls and their methods, the functions it declares outside an impl block, its
//! `use` paths, type aliases, module declarations, constructions and calls — and never a resolved
//! type. Resolution across files stays with the rule layer, which joins these declarations into
//! one program.
//!
//! Text facts are reported as the slice of source they cover, not as re-printed tokens: the rule
//! layer matches them against patterns a reader wrote (`Box<Invoice>`, `crate::billing::Invoice`),
//! and re-printing would insert token separators that those patterns do not allow.
//!
//! Two kinds of "cannot be read" are kept apart, because they are answered differently. `unresolved`
//! notes name a construct that could hide a declaration from this answer (`cfg`, macro expansion,
//! an attribute that may be an attribute macro, outside `#[cfg(test)]` and the attribute macro
//! allow list); a record without `parsed: true` names a file that yielded no declarations at all. Neither is ever
//! flattened into an empty declaration list, because "this file declares nothing" is the one answer
//! an uninspected file must not give.
use proc_macro2::TokenTree;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use syn::{
    spanned::Spanned,
    visit::{self, Visit},
};

#[cfg(test)]
#[path = "domain_facts_tests.rs"]
mod tests;

const PROTOCOL_VERSION: u8 = 7;

/// The single-segment attributes the compiler itself defines, which expand to nothing and so cannot
/// replace what they annotate. `cfg` and `cfg_attr` are left out: they are recorded under their own
/// reason. A path-qualified attribute (`tokio::test`, `core::prelude::v1::test`) is never read as
/// one of these: telling a crate's macro from a built-in re-exported under a path takes the name
/// resolution this protocol does not perform, so it is recorded rather than trusted.
const BUILT_IN_ATTRIBUTES: &[&str] = &[
    "test",
    "ignore",
    "should_panic",
    "derive",
    "automatically_derived",
    "macro_export",
    "macro_use",
    "proc_macro",
    "proc_macro_derive",
    "proc_macro_attribute",
    "allow",
    "expect",
    "warn",
    "deny",
    "forbid",
    "deprecated",
    "must_use",
    "link",
    "link_name",
    "link_ordinal",
    "no_link",
    "repr",
    "crate_type",
    "crate_name",
    "no_main",
    "export_name",
    "link_section",
    "no_mangle",
    "used",
    "inline",
    "cold",
    "naked",
    "no_builtins",
    "target_feature",
    "track_caller",
    "instruction_set",
    "doc",
    "no_std",
    "no_implicit_prelude",
    "path",
    "recursion_limit",
    "type_length_limit",
    "panic_handler",
    "global_allocator",
    "windows_subsystem",
    "feature",
    "non_exhaustive",
    "debugger_visualizer",
    "collapse_debuginfo",
    "unsafe",
];

/// The tool namespaces the compiler reserves (`#[rustfmt::skip]`, `#[clippy::msrv]`,
/// `#[diagnostic::on_unimplemented]`): an attribute under one of them is read by a tool, never
/// expanded.
const TOOL_ATTRIBUTE_NAMESPACES: &[&str] = &["rustfmt", "clippy", "diagnostic"];

/// Derive helper attributes that are not read as possible attribute macros, each with the derives
/// (by their last path segment) that declare it. A helper is only inert on the item a derive naming
/// it is written on, and syntax alone cannot tell it from an attribute macro of the same name, so a
/// helper stays allowed only when that derive stands on the same item.
const DERIVE_HELPER_ALLOW_LIST: &[(&str, &[&str])] = &[
    ("serde", &["Serialize", "Deserialize"]),
    ("default", &["Default"]),
    // thiserror's `#[derive(Error)]`: the helpers that shape a domain error type's message and its
    // source chain.
    ("error", &["Error"]),
    ("from", &["Error"]),
    ("source", &["Error"]),
    ("backtrace", &["Error"]),
];

/// Attribute macros whose expansion is known not to change a declaration rules (a) and (d) read,
/// matched by their last path segment so `#[async_trait]` and `#[async_trait::async_trait]` are
/// both allowed. Any other attribute macro is still recorded.
const ATTRIBUTE_MACRO_ALLOW_LIST: &[&str] = &[
    // async-trait rewrites the signatures of an `async fn` in a trait or impl; it adds no public
    // member rule (a) reads and no getter rule (d) reads.
    "async_trait",
];

fn is_built_in_attribute(path: &syn::Path) -> bool {
    if path.leading_colon.is_some() {
        return false;
    }
    let mut segments = path.segments.iter();
    match (segments.next(), segments.next()) {
        (Some(only), None) => BUILT_IN_ATTRIBUTES.contains(&only.ident.to_string().as_str()),
        (Some(namespace), Some(_)) => {
            TOOL_ATTRIBUTE_NAMESPACES.contains(&namespace.ident.to_string().as_str())
        }
        _ => false,
    }
}

/// The helpers of the allow-listed derives an item carries. A `derive` whose arguments do not parse
/// as paths allows nothing, so its item's helpers are recorded rather than trusted.
fn allowed_derive_helpers(attrs: &[syn::Attribute]) -> Vec<&'static str> {
    let derived: Vec<String> = attrs
        .iter()
        .filter(|attr| attr.path().is_ident("derive"))
        .filter_map(|attr| {
            attr.parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            )
            .ok()
        })
        .flatten()
        .filter_map(|path| {
            path.segments
                .last()
                .map(|segment| segment.ident.to_string())
        })
        .collect();
    DERIVE_HELPER_ALLOW_LIST
        .iter()
        .filter(|(_, derives)| derives.iter().any(|name| derived.iter().any(|d| d == name)))
        .map(|(helper, _)| *helper)
        .collect()
}

fn is_allowed_attribute_macro(path: &syn::Path) -> bool {
    path.segments.last().is_some_and(|segment| {
        ATTRIBUTE_MACRO_ALLOW_LIST.contains(&segment.ident.to_string().as_str())
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    files: Vec<super::Source>,
}

/// Identifiers keep the spelling the source uses, raw prefix included: the rule layer joins these
/// names against the same spellings its own declarations carry, and reports them to the reader.
fn spelling(value: &syn::Ident) -> String {
    value.to_string()
}

/// Syntax evidence that the body hands back one of `self`'s own members. It is not a proof that
/// the method has no other effect.
fn field_return(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Field(field) => {
            matches!(&*field.base, syn::Expr::Path(path) if path.path.is_ident("self"))
        }
        syn::Expr::Paren(expr) => field_return(&expr.expr),
        syn::Expr::Reference(expr) => expr.mutability.is_none() && field_return(&expr.expr),
        syn::Expr::Return(expr) => expr.expr.as_deref().is_some_and(field_return),
        syn::Expr::MethodCall(call) => {
            call.args.is_empty()
                && ["clone", "as_ref", "as_deref", "to_owned", "to_string"]
                    .contains(&call.method.to_string().as_str())
                && field_return(&call.receiver)
        }
        _ => false,
    }
}

fn returns_field_only(block: &syn::Block) -> bool {
    matches!(block.stmts.as_slice(), [syn::Stmt::Expr(expr, _)] if field_return(expr))
}

/// Lines are the original file's. `parse_file` drops a BOM without dropping a line, and cuts a
/// shebang at its newline rather than past it, so the line it parses from keeps standing in for the
/// line the reader opens. The rejected-file answer reads its line from the parse error the same
/// way, which is why both answers put a reader on the same line of the same file.
fn line(span: proc_macro2::Span) -> usize {
    span.start().line
}

/// Columns are 1-based, as the rule layer's containment test reads them. `proc_macro2` counts the
/// first column as 0, so every reported column is one past its own.
fn span_json(start: proc_macro2::Span, end: proc_macro2::Span) -> Value {
    let (start, end) = (start.start(), end.end());
    json!({
        "start_line": start.line, "start_col": start.column + 1,
        "end_line": end.line, "end_col": end.column + 1,
    })
}

fn visibility(vis: &syn::Visibility) -> &'static str {
    match vis {
        syn::Visibility::Inherited => "private",
        syn::Visibility::Public(_) => "pub",
        syn::Visibility::Restricted(restricted) => {
            if restricted.in_token.is_some() {
                "pub-in"
            } else if restricted.path.is_ident("crate") {
                "pub-crate"
            } else if restricted.path.is_ident("super") {
                "pub-super"
            } else {
                "pub"
            }
        }
    }
}

/// The span an item occupies without the attributes written above it. A reader sent to an item is
/// sent to its first keyword, and the rule layer's containment test compares item spans against
/// expressions inside them, so an attribute must not widen either.
fn declared_start(vis: &syn::Visibility, fallback: proc_macro2::Span) -> proc_macro2::Span {
    match vis {
        syn::Visibility::Inherited => fallback,
        syn::Visibility::Public(token) => token.span,
        syn::Visibility::Restricted(restricted) => restricted.pub_token.span,
    }
}

/// Where a function declaration opens, for the three places one can stand: an impl method, an item
/// of its own, and a trait method that writes a body. `default` precedes the visibility it is
/// written with, and a trait item declares no visibility at all.
fn declared_fn_start(
    vis: &syn::Visibility,
    modifiers: &syn::FnModifiers,
    signature: &syn::Signature,
) -> proc_macro2::Span {
    modifiers
        .defaultness
        .as_ref()
        .map(|token| token.span)
        .unwrap_or_else(|| declared_start(vis, signature.span()))
}

// --- notes and public members -----------------------------------------------

/// The pass that reports what could hide a declaration from the answer, and the non-private struct
/// members rule (a) decides on. It visits every node syn defines, so an attribute this protocol
/// cannot resolve is reported wherever it is written rather than only where the other pass looks.
struct Notes {
    members: Vec<Value>,
    unresolved: Vec<Value>,
    /// The derive helpers allowed on the item being visited, innermost item last. Every item opens
    /// its own entry, so a helper allowed on a struct is not allowed on an item nested inside it.
    derive_helpers: Vec<Vec<&'static str>>,
    /// How many enclosing items carry `#[cfg(test)]`, counting a file that opens with
    /// `#![cfg(test)]` as one: the same distinction `Walk::conditional_tests` and
    /// `Walk::file_auxiliary` draw.
    test_only: usize,
}

impl Notes {
    /// Only the constructs that can add or remove a declaration these rules read are recorded. An
    /// attribute macro replaces the item it annotates, so it can add public members or methods, or
    /// rewrite an inline module, and the item a reader sees is not necessarily the one the program
    /// declares. A derive macro cannot change the item it annotates (it can only add items beside
    /// it), so a derive and the allow-listed helpers it reads are not recorded. Nor is an attribute
    /// macro under `#[cfg(test)]`, which the normal build never compiles, or one on the attribute
    /// macro allow list, whose expansion is known not to add what these rules read.
    fn unresolved(&mut self, reason: &str, span: proc_macro2::Span) {
        self.unresolved
            .push(json!({"reason": reason, "line": line(span)}));
    }

    fn is_allowed_derive_helper(&self, path: &syn::Path) -> bool {
        self.derive_helpers
            .last()
            .is_some_and(|allowed| allowed.iter().any(|helper| path.is_ident(helper)))
    }

    fn within_derived_item(&mut self, attrs: &[syn::Attribute], visit: impl FnOnce(&mut Self)) {
        self.derive_helpers.push(allowed_derive_helpers(attrs));
        visit(self);
        self.derive_helpers.pop();
    }
}

impl<'ast> Visit<'ast> for Notes {
    fn visit_item(&mut self, node: &'ast syn::Item) {
        let test_only = attrs_of(node).is_some_and(has_cfg_test);
        if test_only {
            self.test_only += 1;
        }
        self.derive_helpers.push(Vec::new());
        visit::visit_item(self, node);
        self.derive_helpers.pop();
        if test_only {
            self.test_only -= 1;
        }
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        self.within_derived_item(&node.attrs, |notes| visit::visit_item_enum(notes, node));
    }

    fn visit_item_union(&mut self, node: &'ast syn::ItemUnion) {
        self.within_derived_item(&node.attrs, |notes| visit::visit_item_union(notes, node));
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        for (index, field) in node.fields.iter().enumerate() {
            if matches!(field.vis, syn::Visibility::Inherited) {
                continue;
            }
            // A tuple member has no identifier, so its ordinal names it.
            let member = field
                .ident
                .as_ref()
                .map(spelling)
                .unwrap_or_else(|| index.to_string());
            // The visibility is what makes the member reportable, and it opens the declaration on
            // the line a reader is sent to; the field's own span would start at its attributes.
            let line = line(field.vis.span());
            self.members
                .push(json!({"type": spelling(&node.ident), "member": member, "line": line}));
        }
        self.within_derived_item(&node.attrs, |notes| visit::visit_item_struct(notes, node));
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        for item in &node.items {
            if let syn::ImplItem::Macro(item) = item {
                self.unresolved("macro-expansion", item.span());
            }
        }
        visit::visit_item_impl(self, node);
    }

    fn visit_item_macro(&mut self, node: &'ast syn::ItemMacro) {
        // A named item macro is a `macro_rules!` definition: it declares nothing by itself.
        if node.ident.is_none() {
            self.unresolved("macro-expansion", node.span());
        }
        visit::visit_item_macro(self, node);
    }

    fn visit_attribute(&mut self, node: &'ast syn::Attribute) {
        let path = node.path();
        if path.is_ident("cfg") || path.is_ident("cfg_attr") {
            self.unresolved("conditional-compilation", node.span());
        } else if self.test_only == 0
            && !is_built_in_attribute(path)
            && !self.is_allowed_derive_helper(path)
            && !is_allowed_attribute_macro(path)
        {
            self.unresolved("attribute-macro", node.span());
        }
        visit::visit_attribute(self, node);
    }
}

// --- lexical bindings -------------------------------------------------------

/// One `let` of a block, as the lookup that follows a name back to its declaration reads it.
struct LetBinding {
    id: usize,
    /// The pattern as written, without the `mut` that stands beside it.
    pattern: String,
    declared_type: Option<String>,
}

struct Param {
    pattern: String,
    declared_type: Option<String>,
}

/// The lexical constructs a name lookup walks out through, innermost last.
enum Scope {
    /// A block, carrying the `let` declarations already passed in source order.
    Block(Vec<LetBinding>),
    /// A function body: its parameters answer, and the lookup stops here either way.
    Function(Vec<Param>),
    Closure(Vec<Param>),
    /// A pattern that binds names for the region it encloses — `for`, a match arm, `if let`.
    Binder(String),
}

/// What a name resolves to, or that no declaration in scope can be named for it.
enum Resolved {
    Let(usize, Option<String>),
    Param(Option<String>),
    Unbound,
}

/// Where the value an expression produces goes. It is what decides whether a call's result is
/// handed on unchanged, which is the only forwarding this protocol proves.
#[derive(Clone)]
enum Consumption {
    /// An argument of the call at this span.
    Argument(Value),
    /// The initializer of a plain `let` binding with this id.
    LetInit(usize),
    /// Anything else: read, compared, stored in a field, passed through an operator.
    Other,
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

/// Whether `text` writes `name` as a whole word, which is how a pattern is read for the names it
/// could bind without taking the pattern grammar apart.
///
/// Rust accepts non-ASCII identifiers, so a pattern and the name looked up in it are both arbitrary
/// UTF-8. Every step here is therefore taken in characters: a byte-wise neighbour test reads a
/// continuation byte as a non-word character and would call `合計` a whole word inside `合計額`, and
/// a byte-wise advance would cut a multi-byte character in half and panic on the next slice.
fn mentions(text: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(offset) = text[from..].find(name) {
        // `find` reports a character boundary, and the match ends on one, so both slices are valid.
        let start = from + offset;
        let end = start + name.len();
        let opens = !text[..start].chars().next_back().is_some_and(is_word_char);
        let closes = !text[end..].chars().next().is_some_and(is_word_char);
        if opens && closes {
            return true;
        }
        // Resume after the match's first character: its second character index, or nothing left.
        match text[start..].char_indices().nth(1) {
            Some((step, _)) => from = start + step,
            None => break,
        }
    }
    false
}

/// A pattern that binds exactly one name, which is the only shape a value can be followed through.
fn binds_one_name(pattern: &str) -> bool {
    let rest = match pattern.strip_prefix("mut") {
        Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
        _ => pattern,
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {
            chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

// --- the declaration walk ---------------------------------------------------

struct Walk<'a> {
    /// The source `parse_file` assigned spans from: the request's text without its BOM and shebang.
    source: &'a str,
    module: Vec<String>,
    /// How many function bodies enclose the node being walked, which is what makes a declaration
    /// inside one local to it.
    function_depth: usize,
    /// How many enclosing items carry `#[cfg(test)]`, which is what makes a module auxiliary.
    conditional_tests: usize,
    file_auxiliary: bool,
    scopes: Vec<Scope>,
    lets: usize,
    /// Every use of a `let`-bound name, and where the value it names went.
    uses_of_let: HashMap<usize, Vec<Consumption>>,
    /// One entry per reported call, in report order, naming where that call's result went.
    call_consumption: Vec<Consumption>,
    types: Vec<Value>,
    traits: Vec<Value>,
    impls: Vec<Value>,
    functions: Vec<Value>,
    imports: Vec<Value>,
    aliases: Vec<Value>,
    constructions: Vec<Value>,
    calls: Vec<Value>,
    modules: Vec<Value>,
    item_macros: Vec<Value>,
}

impl<'a> Walk<'a> {
    fn new(source: &'a str, file_auxiliary: bool) -> Self {
        Self {
            source,
            module: Vec::new(),
            function_depth: 0,
            conditional_tests: 0,
            file_auxiliary,
            scopes: Vec::new(),
            lets: 0,
            uses_of_let: HashMap::new(),
            call_consumption: Vec::new(),
            types: Vec::new(),
            traits: Vec::new(),
            impls: Vec::new(),
            functions: Vec::new(),
            imports: Vec::new(),
            aliases: Vec::new(),
            constructions: Vec::new(),
            calls: Vec::new(),
            modules: Vec::new(),
            item_macros: Vec::new(),
        }
    }

    /// The source a span covers. Every span reaching here was assigned by parsing `source`, so the
    /// range always lies inside it.
    fn text(&self, span: proc_macro2::Span) -> String {
        self.source[span.byte_range()].to_string()
    }

    fn in_function(&self) -> bool {
        self.function_depth > 0
    }

    fn auxiliary(&self) -> bool {
        self.file_auxiliary || self.conditional_tests > 0
    }

    fn resolve(&self, name: &str) -> Resolved {
        for scope in self.scopes.iter().rev() {
            match scope {
                Scope::Block(bindings) => {
                    if let Some(binding) = bindings
                        .iter()
                        .rev()
                        .find(|binding| mentions(&binding.pattern, name))
                    {
                        return if binds_one_name(&binding.pattern) {
                            Resolved::Let(binding.id, binding.declared_type.clone())
                        } else {
                            Resolved::Unbound
                        };
                    }
                }
                Scope::Closure(params) => {
                    if let Some(param) =
                        params.iter().find(|param| mentions(&param.pattern, name))
                    {
                        return Resolved::Param(param.declared_type.clone());
                    }
                }
                Scope::Function(params) => {
                    return match params.iter().find(|param| mentions(&param.pattern, name)) {
                        Some(param) => Resolved::Param(param.declared_type.clone()),
                        None => Resolved::Unbound,
                    };
                }
                Scope::Binder(pattern) => {
                    if mentions(pattern, name) {
                        return Resolved::Unbound;
                    }
                }
            }
        }
        Resolved::Unbound
    }

    /// The declared type of the name a receiver starts with, which is the only type this protocol
    /// reports: an explicit `let` annotation or parameter type, never one inferred from a value.
    fn binding_type(&self, receiver: &str) -> Option<String> {
        let head = receiver.trim().split('.').next().unwrap_or("").trim();
        let mut chars = head.chars();
        match chars.next() {
            Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
            _ => return None,
        }
        if !chars.all(|c| c == '_' || c.is_ascii_alphanumeric()) {
            return None;
        }
        match self.resolve(head) {
            Resolved::Let(_, declared) => declared,
            Resolved::Param(declared) => declared,
            Resolved::Unbound => None,
        }
    }

    fn record_use(&mut self, name: &str, consumption: Consumption) {
        if let Resolved::Let(id, _) = self.resolve(name) {
            self.uses_of_let.entry(id).or_default().push(consumption);
        }
    }

    fn push_let(&mut self, binding: LetBinding) {
        for scope in self.scopes.iter_mut().rev() {
            if let Scope::Block(bindings) = scope {
                bindings.push(binding);
                return;
            }
        }
    }

    // --- items ------------------------------------------------------------

    fn items(&mut self, items: &[syn::Item]) {
        for item in items {
            self.item(item);
        }
    }

    fn item(&mut self, item: &syn::Item) {
        let conditional = attrs_of(item).is_some_and(has_cfg_test);
        if conditional {
            self.conditional_tests += 1;
        }
        self.item_body(item);
        if conditional {
            self.conditional_tests -= 1;
        }
    }

    fn item_body(&mut self, item: &syn::Item) {
        match item {
            syn::Item::Struct(node) => self.declared_type(
                &node.ident,
                "struct",
                &node.fields,
                &node.attrs,
                declared_start(&node.vis, node.struct_token.span),
            ),
            // An enum's members are reached through a variant, so it declares no field a rule
            // resolves a type through; only its name and derives are facts here.
            syn::Item::Enum(node) => self.declared_type(
                &node.ident,
                "enum",
                &syn::Fields::Unit,
                &node.attrs,
                declared_start(&node.vis, node.enum_token.span),
            ),
            syn::Item::Trait(node) => {
                let methods: Vec<Value> = node
                    .items
                    .iter()
                    .filter_map(|item| match item {
                        syn::TraitItem::Fn(method) => Some(json!(spelling(&method.sig.ident))),
                        _ => None,
                    })
                    .collect();
                // `unsafe` stands between the visibility and the keyword, and opens the declaration
                // when no visibility is written.
                let start = declared_start(
                    &node.vis,
                    node.unsafety
                        .as_ref()
                        .map(|token| token.span)
                        .unwrap_or(node.trait_token.span),
                );
                self.traits.push(json!({
                    "name": spelling(&node.ident), "module": self.module, "methods": methods,
                    "line": line(start),
                }));
                for item in &node.items {
                    match item {
                        syn::TraitItem::Fn(method) => {
                            if let Some(block) = &method.default {
                                // A trait item declares no visibility of its own, which is what
                                // `Inherited` names.
                                self.function_declaration(
                                    &syn::Visibility::Inherited,
                                    &method.modifiers,
                                    &method.sig,
                                );
                                self.function(&method.sig, block);
                            }
                        }
                        syn::TraitItem::Macro(node) => self.item_macro(node.span()),
                        _ => {}
                    }
                }
            }
            syn::Item::Impl(node) => self.impl_block(node),
            syn::Item::Mod(node) => self.module_item(node),
            syn::Item::Use(node) => {
                // The path as written, from its leading `::` to the end of its tree — the same
                // characters a reader sees, which is what the allow list is matched against.
                let tree = node.tree.span().byte_range();
                let start = node
                    .leading_colon
                    .as_ref()
                    .map(|colon| colon.span().byte_range().start)
                    .unwrap_or(tree.start);
                self.imports.push(json!({
                    "module": self.module,
                    "path_text": self.source[start..tree.end].to_string(),
                    "local": self.in_function(),
                    "line": line(declared_start(&node.vis, node.use_token.span)),
                }));
            }
            syn::Item::Type(node) => {
                self.aliases.push(json!({
                    "module": self.module, "name": spelling(&node.ident),
                    "type_text": self.text(node.ty.span()),
                    "generic": !node.generics.params.is_empty(),
                    "local": self.in_function(),
                }));
            }
            syn::Item::Fn(node) => {
                self.function_declaration(&node.vis, &node.modifiers, &node.sig);
                self.function(&node.sig, &node.block);
            }
            syn::Item::Macro(node) => {
                // A named item macro is a `macro_rules!` definition: it declares nothing by itself.
                if node.ident.is_none() {
                    self.item_macro(node.span());
                }
                self.macro_tokens(&node.mac.tokens);
            }
            syn::Item::Const(node) => self.expr(&node.expr, Consumption::Other),
            syn::Item::Static(node) => self.expr(&node.expr, Consumption::Other),
            _ => {}
        }
    }

    /// A function declared outside an impl block. The walk reaches a function through the item that
    /// holds it, so one written in the default value of a trait associated constant is not recorded
    /// here. A method of an impl block is carried by that block, and a trait method without a body
    /// binds no parameter a rule has an argument to decide on.
    fn function_declaration(
        &mut self,
        vis: &syn::Visibility,
        modifiers: &syn::FnModifiers,
        signature: &syn::Signature,
    ) {
        self.functions.push(json!({
            "module": self.module,
            "name": spelling(&signature.ident),
            "params": self.params(signature),
            "line": line(declared_fn_start(vis, modifiers, signature)),
        }));
    }

    fn declared_type(
        &mut self,
        ident: &syn::Ident,
        kind: &str,
        fields: &syn::Fields,
        attrs: &[syn::Attribute],
        start: proc_macro2::Span,
    ) {
        // Only named fields are members a rule can name; a tuple element is reached by position
        // and carries no declaration the rule layer resolves a type through.
        let named: Vec<Value> = match fields {
            syn::Fields::Named(named) => named
                .named
                .iter()
                .filter_map(|field| {
                    let name = field.ident.as_ref()?;
                    Some(json!({
                        "name": spelling(name), "visibility": visibility(&field.vis),
                        "type_text": self.text(field.ty.span()),
                        "line": line(declared_start(&field.vis, name.span())),
                    }))
                })
                .collect(),
            _ => Vec::new(),
        };
        self.types.push(json!({
            "name": spelling(ident), "kind": kind, "module": self.module,
            "fields": named, "derives": self.derives(attrs), "line": line(start),
        }));
    }

    /// The derive names as the source writes them, so a path-qualified derive keeps its path.
    fn derives(&self, attrs: &[syn::Attribute]) -> Vec<Value> {
        let mut out = Vec::new();
        for attr in attrs {
            let syn::Meta::List(list) = &attr.meta else {
                continue;
            };
            if !list.path.is_ident("derive") || list.tokens.is_empty() {
                continue;
            }
            let delimiter = list.delimiter.span();
            let inner = delimiter.open().byte_range().end..delimiter.close().byte_range().start;
            for name in self.source[inner].split(',') {
                let name = name.trim();
                if !name.is_empty() {
                    out.push(json!(name));
                }
            }
        }
        out
    }

    fn impl_block(&mut self, node: &syn::ItemImpl) {
        let start = node
            .modifiers
            .defaultness
            .as_ref()
            .map(|token| token.span)
            .or_else(|| node.unsafety.as_ref().map(|token| token.span))
            .unwrap_or(node.impl_token.span);
        let mut methods = Vec::new();
        for item in &node.items {
            match item {
                syn::ImplItem::Fn(method) => {
                    let start = declared_fn_start(&method.vis, &method.modifiers, &method.sig);
                    methods.push(json!({
                        "name": spelling(&method.sig.ident),
                        "receiver": receiver_kind(&method.sig),
                        "params": self.params(&method.sig),
                        "return_type_text": match &method.sig.output {
                            syn::ReturnType::Type(_, ty) => Value::from(self.text(ty.span())),
                            syn::ReturnType::Default => Value::Null,
                        },
                        "returns_field_only": returns_field_only(&method.block),
                        "line": line(start),
                    }));
                }
                syn::ImplItem::Macro(node) => self.item_macro(node.span()),
                _ => {}
            }
        }
        self.impls.push(json!({
            "module": self.module,
            "target_type_text": self.text(node.self_ty.span()),
            "trait_text": match &node.trait_ {
                Some((path, _)) => Value::from(self.text(path.span())),
                None => Value::Null,
            },
            "methods": methods,
            "span": span_json(start, node.span()),
        }));
        for item in &node.items {
            match item {
                syn::ImplItem::Fn(method) => self.function(&method.sig, &method.block),
                syn::ImplItem::Const(node) => self.expr(&node.expr, Consumption::Other),
                _ => {}
            }
        }
    }

    fn params(&self, signature: &syn::Signature) -> Vec<Value> {
        signature
            .inputs
            .iter()
            .filter_map(|input| match input {
                // `self: Box<Self>` is written like any other parameter, and is read like one.
                syn::FnArg::Receiver(receiver) => match &receiver.kind {
                    syn::ReceiverKind::Typed(_, ty) => Some(json!({
                        "name": "self", "type_text": self.text(ty.span()),
                    })),
                    _ => None,
                },
                syn::FnArg::Typed(typed) => Some(json!({
                    "name": self.text(typed.pat.span()), "type_text": self.text(typed.ty.span()),
                })),
            })
            .collect()
    }

    fn module_item(&mut self, node: &syn::ItemMod) {
        let paths: Vec<&syn::Attribute> = node
            .attrs
            .iter()
            .filter(|attr| attr.path().is_ident("path"))
            .collect();
        // More than one `path` names more than one file, and a `cfg_attr` names one only for a
        // configuration this protocol does not resolve. Both leave the module without a source.
        let mut unresolved = paths.len() > 1
            || node.attrs.iter().any(|attr| {
                attr.path().is_ident("cfg_attr") && mentions(&self.text(attr.span()), "path")
            });
        let mut path = Value::Null;
        if let [attr] = paths.as_slice() {
            match &attr.meta {
                syn::Meta::NameValue(pair) => match &pair.value {
                    syn::Expr::Lit(literal) => match &literal.lit {
                        syn::Lit::Str(text) if !text.value().is_empty() => {
                            path = Value::from(text.value());
                        }
                        _ => unresolved = true,
                    },
                    _ => unresolved = true,
                },
                _ => unresolved = true,
            }
        }
        let start = node
            .unsafety
            .as_ref()
            .map(|token| token.span)
            .unwrap_or_else(|| declared_start(&node.vis, node.mod_token.span));
        let name = spelling(&node.ident);
        self.modules.push(json!({
            "name": name.trim_start_matches("r#"),
            "module": self.module.iter().map(|part| part.trim_start_matches("r#")).collect::<Vec<_>>(),
            "inline": node.content.is_some(),
            "path": path,
            "unresolved_path": unresolved,
            "auxiliary": self.auxiliary(),
            "local": self.in_function(),
            "line": line(start),
        }));
        if let Some((_, items)) = &node.content {
            self.module.push(name);
            self.items(items);
            self.module.pop();
        }
    }

    fn item_macro(&mut self, span: proc_macro2::Span) {
        self.item_macros
            .push(json!({"line": line(span), "auxiliary": self.auxiliary()}));
    }

    // --- bodies -----------------------------------------------------------

    fn function(&mut self, signature: &syn::Signature, block: &syn::Block) {
        let params = signature
            .inputs
            .iter()
            .map(|input| match input {
                syn::FnArg::Receiver(receiver) => match &receiver.kind {
                    syn::ReceiverKind::Typed(_, ty) => Param {
                        pattern: "self".to_string(),
                        declared_type: Some(self.text(ty.span())),
                    },
                    _ => Param {
                        pattern: self.text(receiver.span()),
                        declared_type: None,
                    },
                },
                syn::FnArg::Typed(typed) => Param {
                    pattern: self.text(typed.pat.span()),
                    declared_type: Some(self.text(typed.ty.span())),
                },
            })
            .collect();
        self.function_depth += 1;
        self.scopes.push(Scope::Function(params));
        self.block(block);
        self.scopes.pop();
        self.function_depth -= 1;
    }

    fn block(&mut self, block: &syn::Block) {
        self.scopes.push(Scope::Block(Vec::new()));
        for statement in &block.stmts {
            self.statement(statement);
        }
        self.scopes.pop();
    }

    fn statement(&mut self, statement: &syn::Stmt) {
        match statement {
            syn::Stmt::Local(local) => {
                let (pattern, declared_type, mutable) = binding_parts(self, &local.pat);
                self.lets += 1;
                let id = self.lets;
                if let Some(init) = &local.init {
                    // A value is followed through a binding only when the binding names it alone
                    // and cannot be written to afterwards.
                    let consumption = if binds_one_name(&pattern) && !mutable {
                        Consumption::LetInit(id)
                    } else {
                        Consumption::Other
                    };
                    self.expr(&init.expr, consumption);
                    if let Some((_, diverge)) = &init.diverge {
                        self.expr(diverge, Consumption::Other);
                    }
                }
                self.push_let(LetBinding {
                    id,
                    pattern,
                    declared_type,
                });
            }
            syn::Stmt::Item(item) => self.item(item),
            syn::Stmt::Expr(expr, _) => self.expr(expr, Consumption::Other),
            syn::Stmt::Macro(node) => self.macro_tokens(&node.mac.tokens),
        }
    }

    /// A macro's tokens are not expanded, so a name written inside one is a use this protocol
    /// cannot follow: it is recorded as a use that does not hand the value on.
    fn macro_tokens(&mut self, tokens: &proc_macro2::TokenStream) {
        for token in tokens.clone() {
            match token {
                TokenTree::Ident(ident) => {
                    let name = ident.to_string();
                    self.record_use(&name, Consumption::Other);
                }
                TokenTree::Group(group) => self.macro_tokens(&group.stream()),
                _ => {}
            }
        }
    }

    fn exprs<'e>(&mut self, exprs: impl IntoIterator<Item = &'e syn::Expr>) {
        for expr in exprs {
            self.expr(expr, Consumption::Other);
        }
    }

    fn expr(&mut self, expr: &syn::Expr, consumption: Consumption) {
        match expr {
            // Parentheses and a shared borrow hand the value on unchanged; `&mut` does not.
            syn::Expr::Paren(node) => self.expr(&node.expr, consumption),
            syn::Expr::Group(node) => self.expr(&node.expr, consumption),
            syn::Expr::Reference(node) => {
                let inner = if node.mutability.is_some() {
                    Consumption::Other
                } else {
                    consumption
                };
                self.expr(&node.expr, inner);
            }
            syn::Expr::Path(node) => {
                if node.qself.is_none() {
                    if let Some(name) = node.path.get_ident() {
                        let name = name.to_string();
                        self.record_use(&name, consumption);
                    }
                }
            }
            syn::Expr::Call(node) => self.call(node, consumption),
            syn::Expr::MethodCall(node) => self.method_call(node, consumption),
            syn::Expr::Struct(node) => {
                self.constructions.push(json!({
                    "kind": if node.rest.is_some() { "update-syntax" } else { "struct-literal" },
                    "type_text": self.text(node.path.span()),
                    "callee_text": Value::Null,
                    "span": span_json(node.path.span(), expr.span()),
                }));
                self.exprs(node.fields.iter().map(|field| &field.expr));
                if let Some(rest) = &node.rest {
                    self.expr(rest, Consumption::Other);
                }
            }
            syn::Expr::Block(node) => self.block(&node.block),
            syn::Expr::Async(node) => self.block(&node.block),
            syn::Expr::Unsafe(node) => self.block(&node.block),
            syn::Expr::Const(node) => self.block(&node.block),
            syn::Expr::TryBlock(node) => self.block(&node.block),
            syn::Expr::Loop(node) => self.block(&node.body),
            syn::Expr::Closure(node) => {
                let params = node
                    .inputs
                    .iter()
                    .map(|pat| {
                        let (pattern, declared_type, _) = binding_parts(self, pat);
                        Param {
                            pattern,
                            declared_type,
                        }
                    })
                    .collect();
                self.scopes.push(Scope::Closure(params));
                self.expr(&node.body, Consumption::Other);
                self.scopes.pop();
            }
            syn::Expr::ForLoop(node) => {
                // The pattern binds for the whole loop, its iterator expression included, which is
                // where a name written outside is shadowed before it can be followed.
                let (pattern, _, _) = binding_parts(self, &node.pat);
                self.scopes.push(Scope::Binder(pattern));
                self.expr(&node.expr, Consumption::Other);
                self.block(&node.body);
                self.scopes.pop();
            }
            syn::Expr::If(node) => {
                self.expr(&node.cond, Consumption::Other);
                let bound = let_patterns(self, &node.cond);
                self.scopes.push(Scope::Binder(bound));
                self.block(&node.then_branch);
                self.scopes.pop();
                if let Some((_, branch)) = &node.else_branch {
                    self.expr(branch, Consumption::Other);
                }
            }
            syn::Expr::While(node) => {
                self.expr(&node.cond, Consumption::Other);
                let bound = let_patterns(self, &node.cond);
                self.scopes.push(Scope::Binder(bound));
                self.block(&node.body);
                self.scopes.pop();
            }
            syn::Expr::Match(node) => {
                self.expr(&node.expr, Consumption::Other);
                for arm in &node.arms {
                    // A guard is part of the arm's pattern in this grammar, and it is read inside
                    // the names that pattern binds, exactly like the arm's body.
                    let (pattern, _, _) = binding_parts(self, &arm.pat);
                    self.scopes.push(Scope::Binder(pattern));
                    if let syn::Pat::Guard(guard) = &arm.pat {
                        self.expr(&guard.guard, Consumption::Other);
                    }
                    self.expr(&arm.body, Consumption::Other);
                    self.scopes.pop();
                }
            }
            syn::Expr::Let(node) => self.expr(&node.expr, Consumption::Other),
            syn::Expr::Macro(node) => self.macro_tokens(&node.mac.tokens),
            syn::Expr::Array(node) => self.exprs(&node.elems),
            syn::Expr::Tuple(node) => self.exprs(&node.elems),
            syn::Expr::Assign(node) => {
                self.expr(&node.left, Consumption::Other);
                self.expr(&node.right, Consumption::Other);
            }
            syn::Expr::Binary(node) => {
                self.expr(&node.left, Consumption::Other);
                self.expr(&node.right, Consumption::Other);
            }
            syn::Expr::Await(node) => self.expr(&node.base, Consumption::Other),
            syn::Expr::Break(node) => self.exprs(node.expr.as_deref()),
            syn::Expr::Cast(node) => self.expr(&node.expr, Consumption::Other),
            syn::Expr::Field(node) => self.expr(&node.base, Consumption::Other),
            syn::Expr::Index(node) => {
                self.expr(&node.expr, Consumption::Other);
                self.expr(&node.index, Consumption::Other);
            }
            syn::Expr::Range(node) => {
                self.exprs(node.start.as_deref());
                self.exprs(node.end.as_deref());
            }
            syn::Expr::RawAddr(node) => self.expr(&node.expr, Consumption::Other),
            syn::Expr::Repeat(node) => {
                self.expr(&node.expr, Consumption::Other);
                self.expr(&node.len, Consumption::Other);
            }
            syn::Expr::Return(node) => self.exprs(node.expr.as_deref()),
            syn::Expr::Try(node) => self.expr(&node.expr, Consumption::Other),
            syn::Expr::Unary(node) => self.expr(&node.expr, Consumption::Other),
            syn::Expr::Yield(node) => self.exprs(node.expr.as_deref()),
            _ => {}
        }
    }

    fn call(&mut self, node: &syn::ExprCall, consumption: Consumption) {
        let span = span_json(node.func.span(), node.span());
        if let syn::Expr::Path(path) = &*node.func {
            // A qualified call is how a type is asked to build one of itself. A turbofish or a
            // qualified self type is a different construct, and is reported as a call alone.
            let plain = path.qself.is_none()
                && path
                    .path
                    .segments
                    .iter()
                    .all(|segment| segment.arguments.is_none());
            if plain && path.path.segments.len() > 1 {
                let callee = spelling(&path.path.segments.last().expect("a non-empty path").ident);
                self.constructions.push(json!({
                    "kind": if callee == "default" { "default-call" } else { "associated-call" },
                    "type_text": self.path_prefix(&path.path),
                    "callee_text": callee,
                    "span": span.clone(),
                }));
            }
        }
        self.calls.push(json!({
            "module": self.module, "kind": "path-call",
            "callee_text": self.text(node.func.span()),
            "receiver_text": Value::Null, "receiver_binding_type": Value::Null,
            "span": span.clone(),
        }));
        self.call_consumption.push(consumption);
        self.expr(&node.func, Consumption::Other);
        for argument in &node.args {
            self.expr(argument, Consumption::Argument(span.clone()));
        }
    }

    fn method_call(&mut self, node: &syn::ExprMethodCall, consumption: Consumption) {
        let span = span_json(node.receiver.span(), node.span());
        let receiver = self.text(node.receiver.span());
        let binding = self.binding_type(&receiver);
        self.calls.push(json!({
            "module": self.module, "kind": "method-call",
            "callee_text": spelling(&node.method),
            "receiver_text": receiver,
            "receiver_binding_type": match binding {
                Some(text) => Value::from(text),
                None => Value::Null,
            },
            "span": span.clone(),
        }));
        self.call_consumption.push(consumption);
        self.expr(&node.receiver, Consumption::Other);
        for argument in &node.args {
            self.expr(argument, Consumption::Argument(span.clone()));
        }
    }

    /// The path without its last segment, cut from the source so it keeps the spelling a rule
    /// matches a declaration against.
    fn path_prefix(&self, path: &syn::Path) -> String {
        let last = path.segments.last().expect("a non-empty path");
        let start = path.span().byte_range().start;
        let end = last.ident.span().byte_range().start;
        self.source[start..end]
            .trim_end()
            .trim_end_matches("::")
            .trim_end()
            .to_string()
    }

    /// Resolves each reported call's forwarding: the calls that consume its result unchanged, or
    /// nothing when any use of that result is not a forwarding one.
    fn forwarded(&self) -> Vec<Value> {
        self.call_consumption
            .iter()
            .map(|consumption| match self.follow(consumption, 0) {
                Some(spans) => Value::from(spans),
                None => Value::Array(Vec::new()),
            })
            .collect()
    }

    fn follow(&self, consumption: &Consumption, depth: usize) -> Option<Vec<Value>> {
        // A binding cannot name itself, so a chain is finite; the bound keeps a malformed answer
        // from becoming an unbounded walk rather than a refusal.
        if depth > 64 {
            return None;
        }
        match consumption {
            Consumption::Argument(span) => Some(vec![span.clone()]),
            Consumption::Other => None,
            Consumption::LetInit(id) => {
                let uses = self.uses_of_let.get(id)?;
                let mut spans = Vec::new();
                for use_of in uses {
                    spans.extend(self.follow(use_of, depth + 1)?);
                }
                if spans.is_empty() {
                    None
                } else {
                    Some(spans)
                }
            }
        }
    }
}

/// The pattern as the binding lookup reads it, with the `mut` that stands beside a name and the
/// type annotation written after it taken out.
fn binding_parts(walk: &Walk, pat: &syn::Pat) -> (String, Option<String>, bool) {
    match pat {
        syn::Pat::Type(typed) => {
            let (pattern, _, mutable) = binding_parts(walk, &typed.pat);
            (pattern, Some(walk.text(typed.ty.span())), mutable)
        }
        syn::Pat::Ident(ident) if ident.by_ref.is_none() && ident.subpat.is_none() => (
            spelling(&ident.ident),
            None,
            ident.mutability.is_some(),
        ),
        _ => (walk.text(pat.span()), None, false),
    }
}

/// Every pattern the condition of an `if let` or `while let` binds for its body, as one text the
/// binding lookup reads for the names it shadows.
fn let_patterns(walk: &Walk, cond: &syn::Expr) -> String {
    match cond {
        syn::Expr::Let(node) => walk.text(node.pat.span()),
        syn::Expr::Binary(node) if matches!(node.op, syn::BinOp::And(_)) => {
            let left = let_patterns(walk, &node.left);
            let right = let_patterns(walk, &node.right);
            format!("{left} {right}")
        }
        syn::Expr::Paren(node) => let_patterns(walk, &node.expr),
        _ => String::new(),
    }
}

fn receiver_kind(signature: &syn::Signature) -> &'static str {
    match signature.inputs.first() {
        Some(syn::FnArg::Receiver(receiver)) => match &receiver.kind {
            syn::ReceiverKind::Reference(_, _, mutability) => {
                if mutability.is_some() {
                    "mut-self"
                } else {
                    "ref-self"
                }
            }
            // `mut self` takes the value and may write to it, which is neither of the two shapes a
            // rule reads as "borrows itself"; a typed receiver is written as a parameter instead.
            syn::ReceiverKind::Value => {
                if receiver.mutability.is_some() {
                    "other"
                } else {
                    "self"
                }
            }
            // A typed receiver is written like any other parameter, and is read like one.
            syn::ReceiverKind::Typed(_, _) => "none",
            // A receiver shape this version of the grammar does not name is not one of the two
            // shapes a rule reads as "borrows itself".
            _ => "other",
        },
        _ => "none",
    }
}

fn attrs_of(item: &syn::Item) -> Option<&[syn::Attribute]> {
    match item {
        syn::Item::Const(node) => Some(&node.attrs),
        syn::Item::Enum(node) => Some(&node.attrs),
        syn::Item::ExternCrate(node) => Some(&node.attrs),
        syn::Item::Fn(node) => Some(&node.attrs),
        syn::Item::ForeignMod(node) => Some(&node.attrs),
        syn::Item::Impl(node) => Some(&node.attrs),
        syn::Item::Macro(node) => Some(&node.attrs),
        syn::Item::Mod(node) => Some(&node.attrs),
        syn::Item::Static(node) => Some(&node.attrs),
        syn::Item::Struct(node) => Some(&node.attrs),
        syn::Item::Trait(node) => Some(&node.attrs),
        syn::Item::TraitAlias(node) => Some(&node.attrs),
        syn::Item::Type(node) => Some(&node.attrs),
        syn::Item::Union(node) => Some(&node.attrs),
        syn::Item::Use(node) => Some(&node.attrs),
        _ => None,
    }
}

fn has_cfg_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(is_cfg_test)
}

/// `#[cfg(test)]` exactly: any other configuration predicate names a build this protocol does not
/// resolve, and is reported as an unresolved construct rather than as a test-only declaration.
fn is_cfg_test(attr: &syn::Attribute) -> bool {
    let syn::Meta::List(list) = &attr.meta else {
        return false;
    };
    if !list.path.is_ident("cfg") {
        return false;
    }
    let mut tokens = list.tokens.clone().into_iter();
    matches!(
        (tokens.next(), tokens.next()),
        (Some(TokenTree::Ident(ident)), None) if ident == "test"
    )
}

/// A file the parser rejected carries no declaration key at all: an empty declaration list would
/// read as "this file declares nothing", which is the one answer an uninspected file must not give.
fn analyze(path: &str, source: &str) -> Value {
    let parsed = match syn::parse_file(source) {
        Ok(file) => file,
        Err(error) => {
            return json!({"path": path, "parsed": false,
                "unresolved": [{"reason": "syntax-error", "line": error.span().start().line}]});
        }
    };
    let file_auxiliary = parsed.attrs.iter().any(is_cfg_test);
    let mut notes = Notes {
        members: Vec::new(),
        unresolved: Vec::new(),
        derive_helpers: Vec::new(),
        test_only: usize::from(file_auxiliary),
    };
    notes.visit_file(&parsed);
    // `parse_file` assigns spans from the text left after it drops a BOM and cuts a shebang, so a
    // span is read against that same text.
    let offset = usize::from(source.starts_with('\u{feff}')) * "\u{feff}".len()
        + parsed.shebang.as_ref().map_or(0, String::len);
    let mut walk = Walk::new(&source[offset..], file_auxiliary);
    walk.items(&parsed.items);
    let forwarded = walk.forwarded();
    let calls: Vec<Value> = walk
        .calls
        .into_iter()
        .zip(forwarded)
        .map(|(mut call, spans)| {
            call["forwarded_argument_calls"] = spans;
            call
        })
        .collect();
    json!({
        "path": path, "parsed": true, "auxiliary": walk.file_auxiliary,
        "members": notes.members, "unresolved": notes.unresolved,
        "types": walk.types, "traits": walk.traits, "impls": walk.impls,
        "functions": walk.functions,
        "uses": walk.imports, "aliases": walk.aliases,
        "constructions": walk.constructions, "calls": calls,
        "modules": walk.modules, "item_macros": walk.item_macros,
    })
}

pub fn run(value: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let request: Request = serde_json::from_value(value)?;
    if request.protocol_version != PROTOCOL_VERSION || request.files.is_empty() {
        return Err(format!("expected protocol_version {PROTOCOL_VERSION} and at least one file").into());
    }
    let files: Vec<_> = request
        .files
        .iter()
        .map(|file| analyze(&file.path, &file.source))
        .collect();
    Ok(json!({"protocol_version": PROTOCOL_VERSION, "files": files}))
}
