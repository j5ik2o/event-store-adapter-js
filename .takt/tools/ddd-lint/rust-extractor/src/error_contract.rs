//! Version 3 business-error contract resolution. Source is never compiled or executed.
//!
//! The Cargo condition and the project settings are resolved at the caller's
//! boundary and arrive here already decided; this module only reads them.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use syn::spanned::Spanned;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    request_identity: String,
    files: Vec<super::Source>,
    target: Target,
    cargo_condition: CargoCondition,
    settings: Value,
}

/// The contract records are spelled by their TypeScript owner, so they stay camelCase.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Target {
    package_id: String,
    target_name: String,
    file: String,
    declaration_path: Vec<String>,
    operation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CargoCondition {
    target_triple: String,
    packages: Vec<CargoPackage>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CargoPackage {
    package_id: String,
    name: String,
    edition: String,
    targets: Vec<CargoTarget>,
    features: Vec<String>,
    dependency_renames: Vec<DependencyRename>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CargoTarget {
    kind: String,
    name: String,
    src_path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DependencyRename {
    alias: String,
    package_id: String,
}

struct Reason {
    code: &'static str,
    subject: String,
}

fn blocked(code: &'static str, subject: &str) -> Reason {
    Reason {
        code,
        subject: subject.to_owned(),
    }
}

fn reason_json(reason: &Reason) -> Value {
    json!({"code": reason.code, "subject": reason.subject, "message": reason.code, "location": Value::Null})
}

/// `Unknown` carries why the declaration stopped being readable evidence, so an
/// undecidable `cfg` predicate is never reported as an unmodelled attribute.
#[derive(PartialEq, Clone, Copy)]
enum Condition {
    Active,
    Inactive,
    Unknown(&'static str),
}

fn name_of(ident: &syn::Ident) -> String {
    ident.to_string().trim_start_matches("r#").to_owned()
}

fn both(left: Condition, right: Condition) -> Condition {
    match (left, right) {
        (Condition::Inactive, _) | (_, Condition::Inactive) => Condition::Inactive,
        (Condition::Unknown(code), _) | (Condition::Active, Condition::Unknown(code)) => {
            Condition::Unknown(code)
        }
        _ => Condition::Active,
    }
}

fn either(left: Condition, right: Condition) -> Condition {
    match (left, right) {
        (Condition::Active, _) | (_, Condition::Active) => Condition::Active,
        (Condition::Unknown(code), _) | (Condition::Inactive, Condition::Unknown(code)) => {
            Condition::Unknown(code)
        }
        _ => Condition::Inactive,
    }
}

/// Only the selected feature set decides a predicate here; every other predicate
/// is a condition this build condition does not settle, so it stays `unknown-cfg`.
fn evaluate_cfg(meta: &syn::Meta, features: &[String]) -> Condition {
    let undecided = Condition::Unknown("unknown-cfg");
    match meta {
        syn::Meta::NameValue(pair) if pair.path.is_ident("feature") => match &pair.value {
            syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(text),
                ..
            }) => {
                if features.contains(&text.value()) {
                    Condition::Active
                } else {
                    Condition::Inactive
                }
            }
            _ => undecided,
        },
        syn::Meta::List(list) => {
            let Ok(inner) = list.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            ) else {
                return undecided;
            };
            let states: Vec<_> = inner
                .iter()
                .map(|meta| evaluate_cfg(meta, features))
                .collect();
            if list.path.is_ident("not") {
                return match states.as_slice() {
                    [Condition::Active] => Condition::Inactive,
                    [Condition::Inactive] => Condition::Active,
                    _ => undecided,
                };
            }
            if list.path.is_ident("all") {
                return states.into_iter().fold(Condition::Active, both);
            }
            if list.path.is_ident("any") {
                return states.into_iter().fold(Condition::Inactive, either);
            }
            undecided
        }
        _ => undecided,
    }
}

/// The contract interprets exactly `doc`, `non_exhaustive` and `cfg`. Any other
/// attribute can change what a declaration is, so the declaration stops being
/// readable evidence — but it stops for its own reason: a `derive` always expands
/// a macro that may declare further names, while any other unmodelled attribute
/// is simply a written form this contract does not resolve.
fn attribute_state(attrs: &[syn::Attribute], features: &[String]) -> Condition {
    let mut state = Condition::Active;
    for attr in attrs {
        let path = attr.path();
        if path.is_ident("doc") || path.is_ident("non_exhaustive") {
            continue;
        }
        if path.is_ident("derive") {
            return Condition::Unknown("macro-generated");
        }
        if !path.is_ident("cfg") {
            return Condition::Unknown("unsupported-syntax");
        }
        // A `cfg` whose predicate syn cannot read as a meta item is an unresolvable
        // written form, not a condition left open by the selected features.
        let Ok(meta) = attr.parse_args::<syn::Meta>() else {
            return Condition::Unknown("unsupported-syntax");
        };
        state = both(state, evaluate_cfg(&meta, features));
    }
    state
}

struct UseBinding {
    name: String,
    path: Vec<String>,
    renamed: bool,
    exported: bool,
}

fn flatten_use(
    tree: &syn::UseTree,
    prefix: &mut Vec<String>,
    exported: bool,
    bindings: &mut Vec<UseBinding>,
    globs: &mut Vec<Vec<String>>,
) {
    match tree {
        syn::UseTree::Path(item) => {
            prefix.push(name_of(&item.ident));
            flatten_use(&item.tree, prefix, exported, bindings, globs);
            prefix.pop();
        }
        syn::UseTree::Name(item) => {
            let mut path = prefix.clone();
            path.push(name_of(&item.ident));
            bindings.push(UseBinding {
                name: name_of(&item.ident),
                path,
                renamed: false,
                exported,
            });
        }
        syn::UseTree::Rename(item) => {
            let mut path = prefix.clone();
            path.push(name_of(&item.ident));
            bindings.push(UseBinding {
                name: name_of(&item.rename),
                path,
                renamed: true,
                exported,
            });
        }
        syn::UseTree::Glob(_) => globs.push(prefix.clone()),
        syn::UseTree::Group(group) => {
            for item in &group.items {
                flatten_use(item, prefix, exported, bindings, globs);
            }
        }
    }
}

fn declared_name(item: &syn::Item) -> Option<String> {
    match item {
        syn::Item::Struct(item) => Some(name_of(&item.ident)),
        syn::Item::Enum(item) => Some(name_of(&item.ident)),
        syn::Item::Union(item) => Some(name_of(&item.ident)),
        syn::Item::Type(item) => Some(name_of(&item.ident)),
        syn::Item::Trait(item) => Some(name_of(&item.ident)),
        syn::Item::Mod(item) => Some(name_of(&item.ident)),
        _ => None,
    }
}

fn item_attrs(item: &syn::Item) -> &[syn::Attribute] {
    match item {
        syn::Item::Struct(item) => &item.attrs,
        syn::Item::Enum(item) => &item.attrs,
        syn::Item::Union(item) => &item.attrs,
        syn::Item::Type(item) => &item.attrs,
        syn::Item::Trait(item) => &item.attrs,
        syn::Item::Mod(item) => &item.attrs,
        syn::Item::Use(item) => &item.attrs,
        syn::Item::Impl(item) => &item.attrs,
        _ => &[],
    }
}

fn generic_names(generics: &syn::Generics) -> Vec<String> {
    generics
        .params
        .iter()
        .filter_map(|param| match param {
            syn::GenericParam::Type(param) => Some(name_of(&param.ident)),
            _ => None,
        })
        .collect()
}

fn impl_owner(ty: &syn::Type) -> Option<String> {
    match ty {
        syn::Type::Path(path) if path.qself.is_none() => path
            .path
            .segments
            .last()
            .map(|segment| name_of(&segment.ident)),
        _ => None,
    }
}

/// `None` marks a generic argument this contract cannot substitute structurally.
fn type_arguments(path: &syn::Path) -> Option<Vec<&syn::Type>> {
    match path.segments.last().map(|segment| &segment.arguments) {
        None | Some(syn::PathArguments::None) => Some(Vec::new()),
        Some(syn::PathArguments::AngleBracketed(args)) => args
            .args
            .iter()
            .map(|argument| match argument {
                syn::GenericArgument::Type(ty) => Some(ty),
                _ => None,
            })
            .collect(),
        Some(syn::PathArguments::Parenthesized(_)) => None,
    }
}

fn written_path(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|segment| name_of(&segment.ident))
        .collect::<Vec<_>>()
        .join("::")
}

/// syn::parse_file removes the BOM and shebang before assigning token spans.
fn span_offset(source: &str, parsed: &syn::File) -> usize {
    usize::from(source.starts_with('\u{feff}')) * 3 + parsed.shebang.as_ref().map_or(0, String::len)
}

struct SourceFile {
    path: String,
    offset: usize,
}

struct ModuleNode<'a> {
    file: usize,
    items: &'a [syn::Item],
    /// A module whose item set can still grow is not a readable scope.
    opaque: Option<&'static str>,
}

struct CrateTree<'a> {
    package_id: String,
    features: Vec<String>,
    renames: HashMap<String, String>,
    modules: HashMap<Vec<String>, ModuleNode<'a>>,
    unreadable: HashMap<Vec<String>, &'static str>,
    blocked: Option<&'static str>,
}

#[derive(Clone)]
struct DeclId {
    krate: usize,
    module: Vec<String>,
    index: usize,
}

enum Resolved {
    Module(usize, Vec<String>),
    Std(Vec<String>),
    Declaration(DeclId),
    StandardResult,
    SelfType(String),
}

/// One mechanism crossed while resolving a single written reference.
struct Crossing {
    kind: &'static str,
    resolved: Option<String>,
}

#[derive(Clone)]
enum TypeRef {
    Unit,
    Nominal(String),
}

fn type_ref_json(value: &TypeRef) -> Value {
    match value {
        TypeRef::Unit => json!({"kind": "unit"}),
        TypeRef::Nominal(symbol) => json!({"kind": "nominal", "symbolId": symbol}),
    }
}

struct Step {
    kind: &'static str,
    reference: String,
    resolved: String,
    file: usize,
    span: proc_macro2::Span,
}

struct Scope {
    krate: usize,
    module: Vec<String>,
    file: usize,
    self_type: Option<String>,
    generics: Vec<String>,
}

struct Located<'a> {
    krate: usize,
    module: Vec<String>,
    type_symbol: String,
    file: usize,
    signature: &'a syn::Signature,
    generics: Vec<String>,
}

enum Contract {
    Absent,
    Standard {
        success: TypeRef,
        error: TypeRef,
        error_decl: Option<DeclId>,
        file: usize,
        span: proc_macro2::Span,
    },
    NonStandard {
        result: TypeRef,
        named_result: bool,
        file: usize,
        span: proc_macro2::Span,
    },
    Blocked(Reason),
}

type Binding = (TypeRef, Option<DeclId>);

struct Resolver<'a> {
    files: Vec<SourceFile>,
    crates: Vec<CrateTree<'a>>,
    by_name: HashMap<String, Vec<usize>>,
}

fn child_candidates(owner: &str, name: &str) -> [String; 2] {
    let directory = match owner.rsplit_once('/') {
        Some((head, tail)) if tail == "mod.rs" || tail == "lib.rs" || tail == "main.rs" => {
            head.to_owned()
        }
        Some((head, tail)) => format!("{head}/{}", tail.trim_end_matches(".rs")),
        None => String::new(),
    };
    let base = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    [format!("{base}{name}.rs"), format!("{base}{name}/mod.rs")]
}

fn collect_module<'a>(
    tree: &mut CrateTree<'a>,
    path: Vec<String>,
    file: usize,
    owner: &str,
    items: &'a [syn::Item],
    index: &HashMap<&str, usize>,
    parsed: &'a [Option<syn::File>],
) {
    let opaque = items
        .iter()
        .any(|item| matches!(item, syn::Item::Macro(_)))
        .then_some("macro-generated");
    tree.modules.insert(
        path.clone(),
        ModuleNode {
            file,
            items,
            opaque,
        },
    );
    for item in items {
        let syn::Item::Mod(entry) = item else { continue };
        let mut child = path.clone();
        child.push(name_of(&entry.ident));
        match attribute_state(&entry.attrs, &tree.features) {
            Condition::Active => (),
            Condition::Inactive => continue,
            Condition::Unknown(code) => {
                tree.unreadable.insert(child, code);
                continue;
            }
        }
        if let Some((_, inner)) = &entry.content {
            collect_module(tree, child, file, owner, inner, index, parsed);
            continue;
        }
        // Both project layouts are accepted, but exactly one file may declare the module.
        let candidates = child_candidates(owner, &name_of(&entry.ident));
        let found: Vec<(&String, usize)> = candidates
            .iter()
            .filter_map(|candidate| {
                index
                    .get(candidate.as_str())
                    .map(|position| (candidate, *position))
            })
            .collect();
        // No file declaring the module and two files declaring it are different
        // facts: the first is an absent referent, the second a competing candidate.
        let (candidate, child_file) = match found.as_slice() {
            [single] => *single,
            [] => {
                tree.unreadable.insert(child, "missing-referent");
                continue;
            }
            _ => {
                tree.unreadable.insert(child, "ambiguous-candidate");
                continue;
            }
        };
        match parsed.get(child_file) {
            Some(Some(source)) => collect_module(
                tree,
                child,
                child_file,
                candidate,
                &source.items,
                index,
                parsed,
            ),
            _ => {
                tree.unreadable.insert(child, "syntax-error");
            }
        }
    }
}

fn build_crate<'a>(
    package: &CargoPackage,
    index: &HashMap<&str, usize>,
    parsed: &'a [Option<syn::File>],
) -> CrateTree<'a> {
    let mut tree = CrateTree {
        package_id: package.package_id.clone(),
        features: package.features.clone(),
        renames: package
            .dependency_renames
            .iter()
            .map(|rename| (rename.alias.clone(), rename.package_id.clone()))
            .collect(),
        modules: HashMap::new(),
        unreadable: HashMap::new(),
        blocked: None,
    };
    // Rust 2015 resolves `use` paths from the crate root; this contract does not model it.
    if package.edition == "2015" {
        tree.blocked = Some("unsupported-syntax");
        return tree;
    }
    // The condition records library targets only, and resolution enters a package
    // through that one crate root; a package without one cannot be walked.
    let Some(root) = package.targets.iter().find(|target| target.kind == "lib") else {
        tree.blocked = Some("target-missing");
        return tree;
    };
    let Some(&file) = index.get(root.src_path.as_str()) else {
        tree.blocked = Some("target-missing");
        return tree;
    };
    let Some(Some(source)) = parsed.get(file) else {
        tree.blocked = Some("syntax-error");
        return tree;
    };
    collect_module(
        &mut tree,
        Vec::new(),
        file,
        &root.src_path,
        &source.items,
        index,
        parsed,
    );
    tree
}

impl<'a> Resolver<'a> {
    fn build(request: &Request, parsed: &'a [Option<syn::File>]) -> Resolver<'a> {
        let files: Vec<SourceFile> = request
            .files
            .iter()
            .zip(parsed)
            .map(|(source, file)| SourceFile {
                path: source.path.clone(),
                offset: file.as_ref().map_or(0, |file| {
                    span_offset(&source.source, file)
                }),
            })
            .collect();
        let index: HashMap<&str, usize> = files
            .iter()
            .enumerate()
            .map(|(position, file)| (file.path.as_str(), position))
            .collect();
        let mut crates = Vec::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for package in &request.cargo_condition.packages {
            let position = crates.len();
            by_name
                .entry(package.name.clone())
                .or_default()
                .push(position);
            // Rust names a dependency that was not renamed by its lib target.
            if let Some(lib) = package.targets.iter().find(|target| target.kind == "lib") {
                if lib.name != package.name {
                    by_name.entry(lib.name.clone()).or_default().push(position);
                }
            }
            crates.push(build_crate(package, &index, parsed));
        }
        Resolver {
            files,
            crates,
            by_name,
        }
    }

    fn location(&self, file: usize, span: proc_macro2::Span) -> Value {
        let range = span.byte_range();
        let offset = self.files[file].offset;
        json!({
            "file": self.files[file].path,
            "byte_start": range.start + offset,
            "byte_end": range.end + offset,
        })
    }

    fn item(&self, id: &DeclId) -> &'a syn::Item {
        &self.crates[id.krate].modules[&id.module].items[id.index]
    }

    fn symbol(&self, id: &DeclId) -> String {
        let mut path = id.module.clone();
        path.push(declared_name(self.item(id)).unwrap_or_default());
        format!("{}::{}", self.crates[id.krate].package_id, path.join("::"))
    }

    fn module(&self, krate: usize, path: &[String], subject: &str) -> Result<&ModuleNode<'a>, Reason> {
        if let Some(code) = self.crates[krate].blocked {
            return Err(blocked(code, subject));
        }
        if let Some(code) = self.crates[krate].unreadable.get(path) {
            return Err(blocked(code, subject));
        }
        self.crates[krate]
            .modules
            .get(path)
            .ok_or_else(|| blocked("missing-referent", subject))
    }

    /// Candidates are collected in full: the first matching name is never taken.
    fn declaration(
        &self,
        krate: usize,
        path: &[String],
        wanted: &str,
        subject: &str,
    ) -> Result<Option<DeclId>, Reason> {
        let node = self.module(krate, path, subject)?;
        if let Some(code) = node.opaque {
            return Err(blocked(code, subject));
        }
        let features = &self.crates[krate].features;
        let mut active = Vec::new();
        let mut unknown: Option<&'static str> = None;
        for (index, item) in node.items.iter().enumerate() {
            if declared_name(item).as_deref() != Some(wanted) {
                continue;
            }
            match attribute_state(item_attrs(item), features) {
                Condition::Active => active.push(index),
                Condition::Unknown(code) => unknown = unknown.or(Some(code)),
                Condition::Inactive => (),
            }
        }
        if active.len() > 1 {
            return Err(blocked("ambiguous-candidate", subject));
        }
        if let Some(code) = unknown {
            return Err(blocked(code, subject));
        }
        Ok(active.pop().map(|index| DeclId {
            krate,
            module: path.to_vec(),
            index,
        }))
    }

    fn bindings(
        &self,
        krate: usize,
        path: &[String],
        subject: &str,
    ) -> Result<(Vec<UseBinding>, Vec<Vec<String>>), Reason> {
        let node = self.module(krate, path, subject)?;
        let features = &self.crates[krate].features;
        let mut bindings = Vec::new();
        let mut globs = Vec::new();
        for item in node.items {
            let syn::Item::Use(entry) = item else { continue };
            match attribute_state(&entry.attrs, features) {
                Condition::Active => (),
                Condition::Unknown(code) => return Err(blocked(code, subject)),
                Condition::Inactive => continue,
            }
            let exported = matches!(entry.vis, syn::Visibility::Public(_));
            flatten_use(
                &entry.tree,
                &mut Vec::new(),
                exported,
                &mut bindings,
                &mut globs,
            );
        }
        Ok((bindings, globs))
    }

    /// Resolution never takes the first matching name, and every mechanism it
    /// crosses becomes its own step of the recorded path.
    fn resolve_path(
        &self,
        path: &'a syn::Path,
        scope: &Scope,
        subject: &str,
        steps: &mut Vec<Step>,
    ) -> Result<Resolved, Reason> {
        let segments: Vec<String> = path
            .segments
            .iter()
            .map(|segment| name_of(&segment.ident))
            .collect();
        if segments.is_empty() {
            return Err(blocked("unsupported-syntax", subject));
        }
        let written = written_path(path);
        let span = path.span();
        let qualified = segments.len() > 1;
        if segments[0] == "Self" {
            if qualified {
                return Err(blocked("associated-type-required", subject));
            }
            let Some(symbol) = scope.self_type.clone() else {
                return Err(blocked("unsupported-syntax", subject));
            };
            steps.push(Step {
                kind: "self-type",
                reference: written,
                resolved: symbol.clone(),
                file: scope.file,
                span,
            });
            return Ok(Resolved::SelfType(symbol));
        }
        if scope.generics.contains(&segments[0]) {
            let code = if qualified {
                "trait-selection-required"
            } else {
                "unsupported-type-argument"
            };
            return Err(blocked(code, subject));
        }
        let mut crossings = Vec::new();
        let current = self.walk(
            scope.krate,
            &scope.module,
            &segments,
            path.leading_colon.is_some(),
            subject,
            &mut crossings,
            &mut Vec::new(),
        )?;
        let symbol = match &current {
            Resolved::Declaration(id) => self.symbol(id),
            Resolved::StandardResult => "core::result::Result".to_owned(),
            _ => return Err(blocked("unsupported-syntax", subject)),
        };
        let crossed = !crossings.is_empty();
        for crossing in crossings {
            steps.push(Step {
                kind: crossing.kind,
                reference: written.clone(),
                resolved: crossing.resolved.unwrap_or_else(|| symbol.clone()),
                file: scope.file,
                span,
            });
        }
        if !crossed || qualified {
            steps.push(Step {
                kind: if qualified { "qualified" } else { "direct" },
                reference: written,
                resolved: symbol,
                file: scope.file,
                span,
            });
        }
        Ok(current)
    }

    fn walk(
        &self,
        krate: usize,
        module: &[String],
        segments: &[String],
        absolute: bool,
        subject: &str,
        crossings: &mut Vec<Crossing>,
        seen: &mut Vec<String>,
    ) -> Result<Resolved, Reason> {
        let mut consumed = 1usize;
        let mut current = if absolute {
            self.outside(krate, &segments[0], subject, crossings)?
        } else {
            match segments[0].as_str() {
                "crate" => Resolved::Module(krate, Vec::new()),
                "self" => Resolved::Module(krate, module.to_vec()),
                "super" => {
                    let mut owner = module.to_vec();
                    consumed = 0;
                    while consumed < segments.len() && segments[consumed] == "super" {
                        if owner.pop().is_none() {
                            return Err(blocked("missing-referent", subject));
                        }
                        consumed += 1;
                    }
                    Resolved::Module(krate, owner)
                }
                _ => self.name_in(krate, module, &segments[0], subject, crossings, true, seen)?,
            }
        };
        while consumed < segments.len() {
            current = match current {
                Resolved::Module(owner, path) => self.name_in(
                    owner,
                    &path,
                    &segments[consumed],
                    subject,
                    crossings,
                    false,
                    seen,
                )?,
                Resolved::Std(mut path) => {
                    path.push(segments[consumed].clone());
                    if path == ["result", "Result"] {
                        Resolved::StandardResult
                    } else {
                        Resolved::Std(path)
                    }
                }
                _ => return Err(blocked("unsupported-syntax", subject)),
            };
            consumed += 1;
        }
        Ok(current)
    }

    fn name_in(
        &self,
        krate: usize,
        module: &[String],
        name: &str,
        subject: &str,
        crossings: &mut Vec<Crossing>,
        root: bool,
        seen: &mut Vec<String>,
    ) -> Result<Resolved, Reason> {
        let visiting = format!("{krate}:{}:{name}", module.join("::"));
        if seen.contains(&visiting) {
            return Err(blocked("alias-cycle", subject));
        }
        seen.push(visiting);
        if let Some(declaration) = self.declaration(krate, module, name, subject)? {
            if matches!(self.item(&declaration), syn::Item::Mod(_)) {
                let mut child = module.to_vec();
                child.push(name.to_owned());
                return Ok(Resolved::Module(krate, child));
            }
            return Ok(Resolved::Declaration(declaration));
        }
        let (bindings, globs) = self.bindings(krate, module, subject)?;
        let matched: Vec<&UseBinding> = bindings
            .iter()
            .filter(|binding| binding.name == name)
            .collect();
        if matched.len() > 1 {
            return Err(blocked("ambiguous-candidate", subject));
        }
        if let Some(binding) = matched.first() {
            if binding.exported {
                crossings.push(Crossing {
                    kind: "re-export",
                    resolved: None,
                });
            } else if binding.renamed {
                crossings.push(Crossing {
                    kind: "use-rename",
                    resolved: None,
                });
            }
            return self.walk(krate, module, &binding.path, false, subject, crossings, seen);
        }
        // A glob import can offer a competing binding, so every prefix is searched.
        let mut candidates = Vec::new();
        for prefix in &globs {
            let target = self.walk(
                krate,
                module,
                prefix,
                false,
                subject,
                &mut Vec::new(),
                &mut Vec::new(),
            )?;
            let Resolved::Module(owner, path) = target else {
                continue;
            };
            if let Some(declaration) = self.declaration(owner, &path, name, subject)? {
                candidates.push(declaration);
            }
        }
        if candidates.len() > 1 {
            return Err(blocked("ambiguous-candidate", subject));
        }
        if let Some(declaration) = candidates.pop() {
            if matches!(self.item(&declaration), syn::Item::Mod(_)) {
                let mut child = declaration.module.clone();
                child.push(name.to_owned());
                return Ok(Resolved::Module(declaration.krate, child));
            }
            return Ok(Resolved::Declaration(declaration));
        }
        if !root {
            return Err(blocked("missing-referent", subject));
        }
        self.outside(krate, name, subject, crossings)
    }

    /// The standard library, the renamed dependencies of this package, the other
    /// packages of the condition, and finally the prelude.
    fn outside(
        &self,
        krate: usize,
        name: &str,
        subject: &str,
        crossings: &mut Vec<Crossing>,
    ) -> Result<Resolved, Reason> {
        if matches!(name, "core" | "std" | "alloc") {
            return Ok(Resolved::Std(Vec::new()));
        }
        if let Some(package_id) = self.crates[krate].renames.get(name) {
            let target = self
                .crates
                .iter()
                .position(|entry| &entry.package_id == package_id)
                .ok_or_else(|| blocked("missing-referent", subject))?;
            crossings.push(Crossing {
                kind: "dependency-rename",
                resolved: Some(package_id.clone()),
            });
            return Ok(Resolved::Module(target, Vec::new()));
        }
        if let Some(found) = self.by_name.get(name) {
            // A shared name is not a shared identity; candidates are never merged.
            if found.len() > 1 {
                return Err(blocked("multiple-package-versions", subject));
            }
            return Ok(Resolved::Module(found[0], Vec::new()));
        }
        if name == "Result" {
            return Ok(Resolved::StandardResult);
        }
        Err(blocked("missing-referent", subject))
    }

    fn locate(&self, request: &'a Request, subject: &str) -> Result<Located<'a>, Reason> {
        let target = &request.target;
        let package = request
            .cargo_condition
            .packages
            .iter()
            .find(|package| package.package_id == target.package_id)
            .ok_or_else(|| blocked("target-missing", subject))?;
        if !package
            .targets
            .iter()
            .any(|entry| entry.name == target.target_name)
        {
            return Err(blocked("target-missing", subject));
        }
        let krate = self
            .crates
            .iter()
            .position(|entry| entry.package_id == target.package_id)
            .ok_or_else(|| blocked("target-missing", subject))?;
        let (module, owner_name) = target
            .declaration_path
            .split_at(target.declaration_path.len() - 1);
        let owner = self
            .declaration(krate, module, &owner_name[0], subject)?
            .ok_or_else(|| blocked("target-missing", subject))?;
        match self.item(&owner) {
            syn::Item::Struct(_) | syn::Item::Enum(_) | syn::Item::Union(_) => (),
            _ => return Err(blocked("unsupported-syntax", subject)),
        }
        let node = self.module(krate, module, subject)?;
        if self.files[node.file].path != target.file {
            return Err(blocked("target-missing", subject));
        }
        let features = &self.crates[krate].features;
        let mut found: Vec<(Vec<String>, &syn::Signature)> = Vec::new();
        for item in node.items {
            let syn::Item::Impl(block) = item else { continue };
            match attribute_state(&block.attrs, features) {
                Condition::Active => (),
                Condition::Unknown(code) => return Err(blocked(code, subject)),
                Condition::Inactive => continue,
            }
            if impl_owner(&block.self_ty).as_deref() != Some(owner_name[0].as_str()) {
                continue;
            }
            for member in &block.items {
                let syn::ImplItem::Fn(function) = member else {
                    continue;
                };
                if name_of(&function.sig.ident) != target.operation {
                    continue;
                }
                match attribute_state(&function.attrs, features) {
                    Condition::Active => (),
                    Condition::Unknown(code) => return Err(blocked(code, subject)),
                    Condition::Inactive => continue,
                }
                found.push((generic_names(&block.generics), &function.sig));
            }
        }
        if found.len() > 1 {
            return Err(blocked("target-ambiguous", subject));
        }
        let Some((mut generics, signature)) = found.pop() else {
            return Err(blocked("target-missing", subject));
        };
        generics.extend(generic_names(&signature.generics));
        Ok(Located {
            krate,
            module: module.to_vec(),
            type_symbol: self.symbol(&owner),
            file: node.file,
            signature,
            generics,
        })
    }

    fn evidence(&self, request: &'a Request) -> Value {
        let target = &request.target;
        let subject = format!(
            "{}::{}",
            target.declaration_path.join("::"),
            target.operation
        );
        let found = match self.locate(request, &subject) {
            Ok(found) => found,
            Err(reason) => {
                return json!({"operation_status": "unresolved", "reasons": [reason_json(&reason)]})
            }
        };
        self.contract(request, &found, &subject)
    }

    fn contract(&self, request: &Request, found: &Located<'a>, subject: &str) -> Value {
        let mut path = request.target.declaration_path.clone();
        path.push(request.target.operation.clone());
        let operation = json!({
            "symbolId": format!("{}::{}", self.crates[found.krate].package_id, path.join("::")),
            "packageId": request.target.package_id,
            "declarationPath": request.target.declaration_path,
            "operation": request.target.operation,
        });
        let here = self.location(found.file, found.signature.ident.span());
        let scope = Scope {
            krate: found.krate,
            module: found.module.clone(),
            file: found.file,
            self_type: Some(found.type_symbol.clone()),
            generics: found.generics.clone(),
        };
        let mut steps = Vec::new();
        let outcome = match &found.signature.output {
            syn::ReturnType::Default => Contract::Absent,
            syn::ReturnType::Type(_, ty) => self.result_of(
                ty,
                &scope,
                &HashMap::new(),
                subject,
                &mut steps,
                &mut Vec::new(),
            ),
        };
        let (result_contract, error_cases) = match outcome {
            Contract::Absent => (
                json!({"status": "absent", "evidence": [here.clone()]}),
                json!({"status": "absent", "evidence": [here.clone()]}),
            ),
            Contract::Blocked(reason) => (
                json!({"status": "unresolved", "reasons": [reason_json(&reason)]}),
                json!({"status": "unresolved", "reasons": [reason_json(&reason)]}),
            ),
            Contract::Standard {
                success,
                error,
                error_decl,
                file,
                span,
            } => (
                json!({
                    "status": "resolved",
                    "value": {
                        "standardResult": true,
                        "successType": type_ref_json(&success),
                        "errorType": type_ref_json(&error),
                    },
                    "evidence": [self.location(file, span)],
                }),
                self.case_set(error_decl.as_ref(), subject),
            ),
            Contract::NonStandard {
                result,
                named_result,
                file,
                span,
            } => (
                json!({
                    "status": "resolved",
                    "value": {"standardResult": false, "resultType": type_ref_json(&result)},
                    "evidence": [self.location(file, span)],
                }),
                if named_result {
                    json!({"status": "unresolved",
                        "reasons": [reason_json(&blocked("shadowed-result-identity", subject))]})
                } else {
                    json!({"status": "absent", "evidence": [self.location(file, span)]})
                },
            ),
        };
        json!({
            "operation_status": "resolved",
            "operation": operation,
            "operation_evidence": [here],
            "result_contract": result_contract,
            "error_cases": error_cases,
            "resolution_path": steps
                .iter()
                .map(|step| json!({
                    "kind": step.kind,
                    "reference": step.reference,
                    "resolved": step.resolved,
                    "location": self.location(step.file, step.span),
                }))
                .collect::<Vec<_>>(),
        })
    }

    /// An open or condition-dependent list keeps its known cases and its reason.
    fn case_set(&self, decl: Option<&DeclId>, subject: &str) -> Value {
        let unsupported = json!({"status": "unresolved",
            "reasons": [reason_json(&blocked("unsupported-syntax", subject))]});
        let Some(decl) = decl else {
            return unsupported;
        };
        let syn::Item::Enum(declared) = self.item(decl) else {
            return unsupported;
        };
        let file = self.crates[decl.krate].modules[&decl.module].file;
        let features = &self.crates[decl.krate].features;
        let mut reasons = Vec::new();
        if declared
            .attrs
            .iter()
            .any(|attr| attr.path().is_ident("non_exhaustive"))
        {
            reasons.push(blocked("incomplete-case-set", subject));
        }
        let mut items = Vec::new();
        for variant in &declared.variants {
            match attribute_state(&variant.attrs, features) {
                Condition::Active => items.push(json!({
                    "name": name_of(&variant.ident),
                    "location": self.location(file, variant.ident.span()),
                })),
                Condition::Inactive => (),
                Condition::Unknown(code) => {
                    if !reasons.iter().any(|reason| reason.code == code) {
                        reasons.push(blocked(code, subject));
                    }
                }
            }
        }
        json!({
            "status": "resolved",
            "value": {
                "completeness": if reasons.is_empty() { "complete" } else { "partial" },
                "items": items,
                "reasons": reasons.iter().map(reason_json).collect::<Vec<_>>(),
            },
            "evidence": [self.location(file, declared.ident.span())],
        })
    }

    fn result_of(
        &self,
        ty: &'a syn::Type,
        scope: &Scope,
        bound: &HashMap<String, Binding>,
        subject: &str,
        steps: &mut Vec<Step>,
        aliases: &mut Vec<String>,
    ) -> Contract {
        let path = match ty {
            syn::Type::ImplTrait(_) => {
                return Contract::Blocked(blocked("expression-inference-required", subject))
            }
            syn::Type::Tuple(tuple) if tuple.elems.is_empty() => return Contract::Absent,
            syn::Type::Path(path) if path.qself.is_none() => &path.path,
            _ => return Contract::Blocked(blocked("unsupported-syntax", subject)),
        };
        if path.segments.len() == 1 && bound.contains_key(&name_of(&path.segments[0].ident)) {
            return Contract::Blocked(blocked("unsupported-type-argument", subject));
        }
        let head = match self.resolve_path(path, scope, subject, steps) {
            Ok(head) => head,
            Err(reason) => return Contract::Blocked(reason),
        };
        let Some(arguments) = type_arguments(path) else {
            return Contract::Blocked(blocked("unsupported-type-argument", subject));
        };
        let span = path.span();
        match head {
            Resolved::StandardResult => {
                // Generic arguments are substituted structurally, never stripped.
                if arguments.len() != 2 {
                    return Contract::Blocked(blocked("unsupported-type-argument", subject));
                }
                let success = match self.type_of(arguments[0], scope, bound, subject, steps) {
                    Ok(value) => value,
                    Err(reason) => return Contract::Blocked(reason),
                };
                let error = match self.type_of(arguments[1], scope, bound, subject, steps) {
                    Ok(value) => value,
                    Err(reason) => return Contract::Blocked(reason),
                };
                Contract::Standard {
                    success: success.0,
                    error: error.0,
                    error_decl: error.1,
                    file: scope.file,
                    span,
                }
            }
            Resolved::SelfType(symbol) => Contract::NonStandard {
                result: TypeRef::Nominal(symbol),
                named_result: false,
                file: scope.file,
                span,
            },
            Resolved::Declaration(id) => {
                let symbol = self.symbol(&id);
                let syn::Item::Type(alias) = self.item(&id) else {
                    return Contract::NonStandard {
                        named_result: declared_name(self.item(&id)).as_deref() == Some("Result"),
                        result: TypeRef::Nominal(symbol),
                        file: scope.file,
                        span,
                    };
                };
                if aliases.contains(&symbol) {
                    return Contract::Blocked(blocked("alias-cycle", subject));
                }
                let parameters = generic_names(&alias.generics);
                if arguments.len() != parameters.len() {
                    return Contract::Blocked(blocked("unsupported-type-argument", subject));
                }
                let mut inner_bound = HashMap::new();
                for (parameter, argument) in parameters.into_iter().zip(arguments) {
                    match self.type_of(argument, scope, bound, subject, steps) {
                        Ok(value) => {
                            inner_bound.insert(parameter, value);
                        }
                        Err(reason) => return Contract::Blocked(reason),
                    }
                }
                aliases.push(symbol.clone());
                steps.push(Step {
                    kind: "type-alias",
                    reference: written_path(path),
                    resolved: symbol,
                    file: scope.file,
                    span,
                });
                let inner = Scope {
                    krate: id.krate,
                    module: id.module.clone(),
                    file: self.crates[id.krate].modules[&id.module].file,
                    self_type: None,
                    generics: Vec::new(),
                };
                self.result_of(&alias.ty, &inner, &inner_bound, subject, steps, aliases)
            }
            Resolved::Module(_, _) | Resolved::Std(_) => {
                Contract::Blocked(blocked("unsupported-syntax", subject))
            }
        }
    }

    fn type_of(
        &self,
        ty: &'a syn::Type,
        scope: &Scope,
        bound: &HashMap<String, Binding>,
        subject: &str,
        steps: &mut Vec<Step>,
    ) -> Result<Binding, Reason> {
        match ty {
            syn::Type::Tuple(tuple) if tuple.elems.is_empty() => Ok((TypeRef::Unit, None)),
            syn::Type::Path(path) if path.qself.is_none() => {
                if path.path.segments.len() == 1 {
                    if let Some(value) = bound.get(&name_of(&path.path.segments[0].ident)) {
                        return Ok(value.clone());
                    }
                }
                match self.resolve_path(&path.path, scope, subject, steps)? {
                    Resolved::Declaration(id) => Ok((TypeRef::Nominal(self.symbol(&id)), Some(id))),
                    Resolved::SelfType(symbol) => Ok((TypeRef::Nominal(symbol), None)),
                    _ => Err(blocked("unsupported-type-argument", subject)),
                }
            }
            _ => Err(blocked("unsupported-type-argument", subject)),
        }
    }
}

pub fn run(value: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let echo = value.get("target").cloned().ok_or("missing target")?;
    let request: Request = serde_json::from_value(value)?;
    if request.protocol_version != 3
        || request.files.is_empty()
        || request.target.declaration_path.is_empty()
        || request.target.declaration_path.iter().any(String::is_empty)
        || request.target.package_id.is_empty()
        || request.target.target_name.is_empty()
        || request.target.file.is_empty()
        || request.target.operation.is_empty()
        || request.cargo_condition.target_triple.is_empty()
        || request.cargo_condition.packages.is_empty()
        || !request.settings.is_object()
        || !request.request_identity.starts_with("sha256:")
        || request.request_identity.len() != 71
    {
        return Err("invalid version 3 request".into());
    }
    for package in &request.cargo_condition.packages {
        let targets_named = package.targets.iter().all(|target| {
            !target.kind.is_empty() && !target.name.is_empty() && !target.src_path.is_empty()
        });
        if package.package_id.is_empty()
            || package.name.is_empty()
            || package.edition.is_empty()
            || package.targets.is_empty()
            || !targets_named
        {
            return Err("invalid version 3 request".into());
        }
    }
    let parsed: Vec<Option<syn::File>> = request
        .files
        .iter()
        .map(|source| syn::parse_file(&source.source).ok())
        .collect();
    let resolver = Resolver::build(&request, &parsed);
    let evidence = resolver.evidence(&request);
    Ok(json!({
        "protocol_version": 3,
        "request_identity": request.request_identity,
        "target": echo,
        "evidence": evidence,
    }))
}
