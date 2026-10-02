//! Experimental syntax facts only. No Cargo discovery or compiler semantics.
use proc_macro2::Span;
use quote::ToTokens;
use serde_json::{json, Value};
use syn::{
    spanned::Spanned,
    visit::{self, Visit},
};

#[derive(Default)]
struct Facts {
    module: Vec<String>,
    owner: Option<String>,
    types: Vec<Value>,
    methods: Vec<Value>,
    imports: Vec<Value>,
    aliases: Vec<Value>,
    modules: Vec<Value>,
    calls: Vec<Value>,
    findings: Vec<Value>,
    unresolved: Vec<Value>,
}

fn text(value: &impl ToTokens) -> String {
    value.to_token_stream().to_string()
}

fn name(value: &syn::Ident) -> String {
    value.to_string().trim_start_matches("r#").to_owned()
}

fn visibility(value: &syn::Visibility) -> &'static str {
    match value {
        syn::Visibility::Inherited => "private",
        syn::Visibility::Public(_) => "pub",
        syn::Visibility::Restricted(value) if value.path.is_ident("crate") => "pub-crate",
        syn::Visibility::Restricted(value) if value.path.is_ident("super") => "pub-super",
        syn::Visibility::Restricted(_) => "pub-in",
    }
}

fn receiver(sig: &syn::Signature) -> &'static str {
    match sig.receiver().map(|receiver| &receiver.kind) {
        None => "none",
        Some(syn::ReceiverKind::Value) => "self",
        Some(syn::ReceiverKind::Reference(_, _, Some(_))) => "mut-self",
        Some(syn::ReceiverKind::Reference(_, _, None)) => "ref-self",
        Some(_) => "other",
    }
}

// This is syntax evidence, not a proof that the method has no other effects.
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

impl Facts {
    fn unresolved(&mut self, reason: &str, span: Span) {
        self.unresolved
            .push(json!({"reason": reason, "line": span.start().line}));
    }

    fn signature(&mut self, sig: &syn::Signature, body: Option<&syn::Block>) {
        let return_type = match &sig.output {
            syn::ReturnType::Default => None,
            syn::ReturnType::Type(_, ty) => Some(text(ty)),
        };
        let returns_field_only = body.is_some_and(|body| {
            matches!(body.stmts.as_slice(),
            [syn::Stmt::Expr(expr, _)] if field_return(expr))
        });
        self.methods.push(json!({
            "owner": self.owner, "module": self.module, "name": name(&sig.ident),
            "receiver": receiver(sig), "return_type_text": return_type,
            "returns_field_only": returns_field_only, "line": sig.span().start().line,
            "type_resolution": "unsupported"
        }));
    }
}

impl<'ast> Visit<'ast> for Facts {
    fn visit_item(&mut self, node: &'ast syn::Item) {
        match node {
            syn::Item::Verbatim(_)
            | syn::Item::Union(_)
            | syn::Item::ForeignMod(_)
            | syn::Item::TraitAlias(_) => self.unresolved("unsupported-item", node.span()),
            syn::Item::Const(_)
            | syn::Item::Enum(_)
            | syn::Item::ExternCrate(_)
            | syn::Item::Fn(_)
            | syn::Item::Impl(_)
            | syn::Item::Macro(_)
            | syn::Item::Mod(_)
            | syn::Item::Static(_)
            | syn::Item::Struct(_)
            | syn::Item::Trait(_)
            | syn::Item::Type(_)
            | syn::Item::Use(_) => (),
            _ => self.unresolved("unsupported-item", node.span()),
        }
        visit::visit_item(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        let mut fields = Vec::new();
        for (index, field) in node.fields.iter().enumerate() {
            let field_name = field
                .ident
                .as_ref()
                .map(name)
                .unwrap_or_else(|| index.to_string());
            fields.push(
                json!({"name": field_name, "visibility": visibility(&field.vis),
                "type_text": text(&field.ty), "line": field.span().start().line}),
            );
            if !matches!(field.vis, syn::Visibility::Inherited) {
                self.findings
                    .push(json!({"rule_id": "a", "type": name(&node.ident),
                    "field": field_name, "line": field.span().start().line}));
            }
            if let Err(error) = field.modifiers.require_empty() {
                self.unresolved("unsupported-modifier", error.span());
            }
        }
        self.types.push(json!({"name": name(&node.ident), "kind": "struct", "module": self.module, "fields": fields}));
        visit::visit_item_struct(self, node);
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        self.types.push(json!({"name": name(&node.ident), "kind": "enum", "module": self.module,
            "variants": node.variants.iter().map(|variant| name(&variant.ident)).collect::<Vec<_>>()}));
        visit::visit_item_enum(self, node);
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let owner = self.owner.replace(text(&node.self_ty));
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_item_impl(self, node);
        self.owner = owner;
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        let owner = self.owner.take();
        self.signature(&node.sig, Some(&node.block));
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_item_fn(self, node);
        self.owner = owner;
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        self.signature(&node.sig, Some(&node.block));
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_impl_item_fn(self, node);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        let owner = self.owner.replace(name(&node.ident));
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_item_trait(self, node);
        self.owner = owner;
    }

    fn visit_trait_item_fn(&mut self, node: &'ast syn::TraitItemFn) {
        self.signature(&node.sig, node.default.as_ref());
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_trait_item_fn(self, node);
    }

    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        self.imports.push(
            json!({"module": self.module, "path_text": text(node), "resolution": "unsupported"}),
        );
        visit::visit_item_use(self, node);
    }

    fn visit_item_type(&mut self, node: &'ast syn::ItemType) {
        self.aliases.push(
            json!({"module": self.module, "name": name(&node.ident), "type_text": text(&node.ty),
            "resolution": "unsupported"}),
        );
        if let Err(error) = node.modifiers.require_empty() {
            self.unresolved("unsupported-modifier", error.span());
        }
        visit::visit_item_type(self, node);
    }

    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.modules.push(json!({"module": self.module, "name": name(&node.ident), "inline": node.content.is_some()}));
        if node.content.is_none() {
            self.unresolved("external-module-not-loaded", node.span());
        }
        self.module.push(name(&node.ident));
        visit::visit_item_mod(self, node);
        self.module.pop();
    }

    fn visit_attribute(&mut self, node: &'ast syn::Attribute) {
        let path = node.path();
        if path.is_ident("cfg") || path.is_ident("cfg_attr") {
            self.unresolved("conditional-compilation", node.span());
        } else if ![
            "doc", "allow", "warn", "deny", "forbid", "inline", "test", "repr", "path", "must_use",
        ]
        .iter()
        .any(|name| path.is_ident(name))
        {
            self.unresolved("attribute-or-derive-expansion", node.span());
        }
        visit::visit_attribute(self, node);
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        self.unresolved("macro-expansion", node.span());
    }

    fn visit_expr(&mut self, node: &'ast syn::Expr) {
        if let syn::Expr::Verbatim(_) = node {
            self.unresolved("verbatim-expression", node.span());
        }
        visit::visit_expr(self, node);
    }

    fn visit_type(&mut self, node: &'ast syn::Type) {
        if let syn::Type::Verbatim(_) = node {
            self.unresolved("verbatim-type", node.span());
        }
        visit::visit_type(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        self.calls.push(
            json!({"method": name(&node.method), "receiver_text": text(&node.receiver),
            "receiver_resolution": "unsupported", "line": node.span().start().line}),
        );
        visit::visit_expr_method_call(self, node);
    }
}

pub fn analyze(file: &str, source: &str) -> Value {
    let mut facts = Facts::default();
    let parsed = match syn::parse_file(source) {
        Ok(ast) => {
            facts.visit_file(&ast);
            true
        }
        Err(error) => {
            facts.unresolved("parse-error", error.span());
            false
        }
    };
    // An opaque declaration can change whether a field exists. Preserve syntax
    // candidates but never label a partially inspected file as passing.
    let state = if !facts.unresolved.is_empty() {
        "unresolved"
    } else if facts.findings.is_empty() {
        "pass"
    } else {
        "violation"
    };
    json!({
        "file": file, "parsed": parsed, "field_inspection": {"state": state, "candidates": facts.findings},
        "facts": {"types": facts.types, "methods": facts.methods, "imports": facts.imports,
            "aliases": facts.aliases, "modules": facts.modules, "calls": facts.calls},
        "unresolved": facts.unresolved, "semantic_analysis": "unsupported"
    })
}
