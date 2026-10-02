use super::*;

fn check(source: &str) -> Value {
    let answer =
        run(json!({"protocol_version":7,"files":[{"path":"lib.rs","source":source}]})).unwrap();
    assert_eq!(answer["protocol_version"], 7);
    answer["files"][0].clone()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("a parsed file reports its {key}"))
}

fn path_of(value: &Value) -> String {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part.as_str().unwrap())
        .collect::<Vec<_>>()
        .join("::")
}

/// `type.member@line` for every reported member, in the order the answer lists them.
fn members(source: &str) -> Vec<String> {
    list(&check(source), "members")
        .iter()
        .map(|member| {
            format!(
                "{}.{}@{}",
                member["type"].as_str().unwrap(),
                member["member"].as_str().unwrap(),
                member["line"].as_u64().unwrap()
            )
        })
        .collect()
}

/// `module::owner/trait/name=returns_field_only` for every method of every reported impl.
fn methods(source: &str) -> Vec<String> {
    list(&check(source), "impls")
        .iter()
        .flat_map(|block| {
            let owner = format!(
                "{}::{}/{}",
                path_of(&block["module"]),
                block["target_type_text"].as_str().unwrap(),
                block["trait_text"].as_str().unwrap_or("-")
            );
            list(block, "methods")
                .iter()
                .map(|method| {
                    format!(
                        "{owner}/{}={}",
                        method["name"].as_str().unwrap(),
                        method["returns_field_only"].as_bool().unwrap()
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `module::name@line(params)` for every entry the answer's `functions` list carries, in the order
/// it lists them.
fn functions(source: &str) -> Vec<String> {
    list(&check(source), "functions")
        .iter()
        .map(|entry| {
            let params = list(entry, "params")
                .iter()
                .map(|param| {
                    format!(
                        "{}: {}",
                        param["name"].as_str().unwrap(),
                        param["type_text"].as_str().unwrap()
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "{}::{}@{}({params})",
                path_of(&entry["module"]),
                entry["name"].as_str().unwrap(),
                entry["line"].as_u64().unwrap(),
            )
        })
        .collect()
}

/// `name@line` for every type declaration and then every trait declaration the answer lists.
fn declarations(source: &str) -> Vec<String> {
    let answer = check(source);
    ["types", "traits"]
        .into_iter()
        .flat_map(|key| {
            list(&answer, key)
                .iter()
                .map(|entry| {
                    format!(
                        "{}@{}",
                        entry["name"].as_str().unwrap(),
                        entry["line"].as_u64().unwrap()
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `name@line` and the resolution of every module declaration, in the order the answer lists them.
fn modules(source: &str) -> Vec<String> {
    list(&check(source), "modules")
        .iter()
        .map(|entry| {
            format!(
                "{}::{}@{} inline={} path={} unresolved={} auxiliary={} local={}",
                path_of(&entry["module"]),
                entry["name"].as_str().unwrap(),
                entry["line"].as_u64().unwrap(),
                entry["inline"].as_bool().unwrap(),
                entry["path"].as_str().unwrap_or("-"),
                entry["unresolved_path"].as_bool().unwrap(),
                entry["auxiliary"].as_bool().unwrap(),
                entry["local"].as_bool().unwrap(),
            )
        })
        .collect()
}

fn reasons(source: &str) -> Vec<String> {
    list(&check(source), "unresolved")
        .iter()
        .map(|entry| entry["reason"].as_str().unwrap().to_owned())
        .collect()
}

/// `reason@line` for every unresolved record, in the order the answer lists them.
fn reasons_at(source: &str) -> Vec<String> {
    list(&check(source), "unresolved")
        .iter()
        .map(|entry| {
            format!(
                "{}@{}",
                entry["reason"].as_str().unwrap(),
                entry["line"].as_u64().unwrap()
            )
        })
        .collect()
}

/// Each prefix a Rust file may carry ahead of its first item, paired with the line the item then
/// occupies in the file a reader opens. `parse_file` consumes both prefixes before it assigns
/// spans, which is the one place a reported line could drift off the file on disk. These cases pin
/// that it does not: a BOM costs no line, and a shebang is cut at its newline rather than past it,
/// so the line the parser counts from is still the line the reader opens.
const PREFIXES: [(&str, u64); 4] = [
    ("", 1),
    ("\u{feff}", 1),
    ("#!/usr/bin/env rust-script\n", 2),
    ("\u{feff}#!/bin/rust\n", 2),
];

#[test]
fn domain_facts_reports_a_public_tuple_member_under_its_ordinal() {
    assert_eq!(members("pub struct Invoice(pub u64);"), ["Invoice.0@1"]);
}

#[test]
fn domain_facts_reports_each_tuple_member_on_its_own_declaration_line() {
    assert_eq!(
        members("pub struct Pair(\n    pub u64,\n    pub(crate) u32,\n    u8,\n);"),
        ["Pair.0@2", "Pair.1@3"]
    );
}

#[test]
fn domain_facts_keeps_a_private_tuple_member_out_of_the_answer() {
    assert_eq!(members("pub struct Amount(u64);"), Vec::<String>::new());
}

#[test]
fn domain_facts_reports_restricted_raw_and_non_ascii_members_as_written() {
    assert_eq!(
        members(
            "mod m { pub struct A { pub(super) x: u64 } }\npub struct B { pub(in crate::m) y: u64 }\npub struct C { pub r#type: u64 }\npub struct D { pub 合計: u64 }"
        ),
        ["A.x@1", "B.y@2", "C.r#type@3", "D.合計@4"]
    );
}

#[test]
fn domain_facts_reads_the_member_line_from_its_visibility_not_its_attributes() {
    assert_eq!(
        members("pub struct Invoice {\n    /// documented\n    #[allow(dead_code)]\n    pub amount: u64,\n}"),
        ["Invoice.amount@4"]
    );
}

#[test]
fn domain_facts_reports_a_member_on_the_line_it_occupies_in_the_original_file() {
    for (prefix, line) in PREFIXES {
        let source = format!("{prefix}pub struct Invoice {{ pub amount: u64 }}\n");
        assert_eq!(
            members(&source),
            [format!("Invoice.amount@{line}")],
            "prefix {prefix:?}"
        );
    }
}

#[test]
fn domain_facts_reports_an_unresolved_construct_on_the_line_it_occupies_in_the_original_file() {
    for (prefix, line) in PREFIXES {
        let source =
            format!("{prefix}pub struct Invoice {{ #[cfg(feature = \"x\")] pub amount: u64 }}\n");
        assert_eq!(
            reasons_at(&source),
            [format!("conditional-compilation@{line}")],
            "prefix {prefix:?}"
        );
    }
}

/// The rejected-file answer reads its line straight from the parse error, so this pins that both
/// answers place a reader on the same line basis whether or not the file could be parsed.
#[test]
fn domain_facts_reports_a_syntax_error_on_the_line_it_occupies_in_the_original_file() {
    for (prefix, line) in PREFIXES {
        let answer = check(&format!("{prefix}pub struct {{"));
        assert_eq!(answer["parsed"], false, "prefix {prefix:?}");
        assert_eq!(
            answer["unresolved"][0],
            json!({"reason": "syntax-error", "line": line}),
            "prefix {prefix:?}"
        );
    }
}

#[test]
fn domain_facts_leaves_enum_and_union_members_out_of_the_answer() {
    assert_eq!(
        members("pub enum Kind { Draft, Paid(u64), Issued { amount: u64 } }\npub union U { pub amount: u64 }"),
        Vec::<String>::new()
    );
}

#[test]
fn domain_facts_does_not_read_a_declaration_out_of_a_macro_body_a_string_or_a_comment() {
    let source = "macro_rules! declare {\n    () => { pub struct Generated { pub amount: u64 } };\n}\nconst DOC: &str = \"pub amount: u64\";\n// pub amount: u64\n";
    assert_eq!(members(source), Vec::<String>::new());
    assert_eq!(reasons(source), Vec::<String>::new());
}

/// Every region that carries the characters of a declaration without declaring one. The module
/// walk, the dependency edges, the execute-argument rule and the construction rule all read these
/// same regions.
#[test]
fn domain_facts_reads_no_module_use_impl_or_function_out_of_a_lookalike_region() {
    let source = "macro_rules! declare {\n    () => { mod generated; use billing::Adapter; fn execute(invoice: Invoice) {} impl Invoice { pub fn rename(&mut self) {} } };\n}\nconst DOC: &str = \"mod generated; fn execute(invoice: Invoice) {}\";\nconst RAW: &str = r##\"mod generated; fn execute(invoice: Invoice) {}\"##;\n// mod generated; fn execute(invoice: Invoice) {}\n/* /* mod generated; use billing::Adapter; */ */\n";
    let answer = check(source);
    assert_eq!(list(&answer, "modules").len(), 0);
    assert_eq!(list(&answer, "uses").len(), 0);
    assert_eq!(list(&answer, "impls").len(), 0);
    assert_eq!(list(&answer, "functions").len(), 0);
    assert_eq!(list(&answer, "item_macros").len(), 0);
}

#[test]
fn domain_facts_accepts_both_body_forms_of_a_getter() {
    assert_eq!(
        methods(
            "pub struct Invoice { amount: u64 }\nimpl Invoice {\n    pub fn tail(&self) -> u64 { self.amount }\n    pub fn returned(&self) -> u64 { return self.amount; }\n    pub fn borrowed(&self) -> &u64 { &self.amount }\n    pub fn cloned(&self) -> u64 { self.amount.clone() }\n}"
        ),
        [
            "::Invoice/-/tail=true",
            "::Invoice/-/returned=true",
            "::Invoice/-/borrowed=true",
            "::Invoice/-/cloned=true"
        ]
    );
}

#[test]
fn domain_facts_refuses_bodies_that_do_more_than_hand_back_a_member() {
    assert_eq!(
        methods(
            "pub struct Invoice { amount: u64, inner: Invoice }\nimpl Invoice {\n    pub fn derived(&self) -> u64 { self.amount + 1 }\n    pub fn bound(&self) -> u64 { let x = self.amount; x }\n    pub fn deep(&self) -> u64 { self.inner.amount }\n    pub fn other(&self, peer: &Invoice) -> u64 { peer.amount }\n    pub fn counted(&self) -> usize { self.amount.count_ones() as usize }\n}"
        ),
        [
            "::Invoice/-/derived=false",
            "::Invoice/-/bound=false",
            "::Invoice/-/deep=false",
            "::Invoice/-/other=false",
            "::Invoice/-/counted=false"
        ]
    );
}

#[test]
fn domain_facts_separates_a_trait_implementation_from_an_inherent_one() {
    assert_eq!(
        methods(
            "pub struct Invoice { amount: u64 }\npub trait Shown { fn shown(&self) -> u64; }\nimpl Shown for Invoice { fn shown(&self) -> u64 { self.amount } }\nimpl Invoice { pub fn total(&self) -> u64 { self.amount } }"
        ),
        ["::Invoice/Shown/shown=true", "::Invoice/-/total=true"]
    );
}

#[test]
fn domain_facts_keeps_same_named_methods_of_different_modules_apart() {
    assert_eq!(
        methods(
            "mod a { pub struct Invoice { amount: u64 } impl Invoice { pub fn total(&self) -> u64 { self.amount } } }\nmod b { pub struct Invoice { amount: u64 } impl Invoice { pub fn total(&self) -> u64 { self.amount + 1 } } }"
        ),
        ["a::Invoice/-/total=true", "b::Invoice/-/total=false"]
    );
}

#[test]
fn domain_facts_keeps_a_raw_identifier_method_name_as_written() {
    assert_eq!(
        methods("pub struct Invoice { amount: u64 }\nimpl Invoice { pub fn r#total(&self) -> u64 { self.amount } }"),
        ["::Invoice/-/r#total=true"]
    );
}

/// A function declared outside an impl block carries the same decision the rule layer reads off an
/// impl method. Four positions are exercised here: at the top level, inside an inline module, inside
/// another function's body, and as a trait method that writes a body. A method of an impl block is
/// already carried by that block and is not repeated here, and a trait method that declares no body
/// declares no parameter binding to decide on.
#[test]
fn domain_facts_reports_a_function_declared_outside_an_impl_block_at_four_positions() {
    assert_eq!(
        functions(
            "pub fn top(invoice: Invoice) {}\nmod inner { pub fn nested(invoice: Invoice) {} }\nfn outer() { fn local(invoice: Invoice) {} }\ntrait Runner { fn defaulted(&self, invoice: Invoice) {} fn declared(&self, invoice: Invoice); }\nstruct Issue;\nimpl Issue { pub fn method(&self, invoice: Invoice) {} }\n"
        ),
        [
            "::top@1(invoice: Invoice)",
            "inner::nested@2(invoice: Invoice)",
            "::outer@3()",
            "::local@3(invoice: Invoice)",
            "::defaulted@4(invoice: Invoice)",
        ]
    );
}

/// A reader sent to a function is sent to its first keyword, as they are for a member, a module and
/// an impl method; the attributes written above it must not move that line.
#[test]
fn domain_facts_reads_a_function_line_from_its_visibility_not_its_attributes() {
    assert_eq!(
        functions("/// documented\n#[inline]\npub fn execute(invoice: Invoice) {}\n"),
        ["::execute@3(invoice: Invoice)"]
    );
}

/// A type and a trait are each reported where a reader would be sent to read the declaration, on
/// the same basis as every other declaration this protocol carries.
#[test]
fn domain_facts_reads_a_type_and_a_trait_line_from_its_visibility_not_its_attributes() {
    assert_eq!(
        declarations(
            "/// documented\n#[derive(Clone)]\npub struct Invoice;\nenum Kind { Draft }\n#[allow(dead_code)]\npub trait Shown { fn shown(&self); }\ntrait Hidden {}\n"
        ),
        ["Invoice@3", "Kind@4", "Shown@6", "Hidden@7"]
    );
}

/// How a method takes the value it is declared on decides whether it mutates it, so each notation
/// is reported as itself. A typed receiver is written like any other parameter and read like one.
#[test]
fn domain_facts_reports_each_receiver_notation_as_itself() {
    let answer = check(
        "pub struct Invoice;\nimpl Invoice {\n    pub fn free() {}\n    pub fn taken(self) {}\n    pub fn written(mut self) {}\n    pub fn read(&self) {}\n    pub fn changed(&mut self) {}\n    pub fn boxed(self: Box<Self>) {}\n}",
    );
    let methods = list(&answer["impls"][0], "methods");
    assert_eq!(
        methods
            .iter()
            .map(|method| format!(
                "{}={}",
                method["name"].as_str().unwrap(),
                method["receiver"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            "free=none",
            "taken=self",
            "written=other",
            "read=ref-self",
            "changed=mut-self",
            "boxed=none"
        ]
    );
    assert_eq!(methods[5]["params"][0]["type_text"], "Box<Self>");
}

/// The rule layer matches these texts against the shapes a reader writes, so each one is the slice
/// of source it covers rather than a re-print of its tokens.
#[test]
fn domain_facts_reports_text_as_the_source_writes_it() {
    let answer = check(
        "use crate::billing::{Invoice, Ledger as Book};\n#[derive(Clone, serde::Serialize)]\npub struct Batch { entries: Box<Vec<Invoice>> }\ntype Alias = Option<Invoice>;\nimpl core::fmt::Debug for Box<Batch> {}\nfn build() -> Batch { Batch { entries: crate::billing::Invoice::all() } }\n",
    );
    assert_eq!(answer["uses"][0]["path_text"], "crate::billing::{Invoice, Ledger as Book}");
    assert_eq!(answer["types"][0]["derives"][1], "serde::Serialize");
    assert_eq!(answer["types"][0]["fields"][0]["type_text"], "Box<Vec<Invoice>>");
    assert_eq!(answer["aliases"][0]["type_text"], "Option<Invoice>");
    assert_eq!(answer["impls"][0]["target_type_text"], "Box<Batch>");
    assert_eq!(answer["impls"][0]["trait_text"], "core::fmt::Debug");
    assert_eq!(answer["constructions"][1]["type_text"], "crate::billing::Invoice");
}

/// The module walk follows these declarations to the next file, so a declaration it cannot resolve
/// to exactly one file has to say so rather than be left out.
#[test]
fn domain_facts_reports_how_each_module_declaration_resolves() {
    assert_eq!(
        modules(
            "mod plain;\n#[path = \"billing/invoice.rs\"] mod attributed;\n#[path = r#\"raw.rs\"#] mod raw;\n#[cfg_attr(feature = \"alternate\", path = \"other.rs\")] mod conditional;\n#[path = \"a.rs\"] #[path = \"b.rs\"] mod twice;\n#[cfg(test)] mod tests { mod nested; }\nmod inline { mod child; }\nfn run() { mod local; }\n"
        ),
        [
            "::plain@1 inline=false path=- unresolved=false auxiliary=false local=false",
            "::attributed@2 inline=false path=billing/invoice.rs unresolved=false auxiliary=false local=false",
            "::raw@3 inline=false path=raw.rs unresolved=false auxiliary=false local=false",
            "::conditional@4 inline=false path=- unresolved=true auxiliary=false local=false",
            "::twice@5 inline=false path=- unresolved=true auxiliary=false local=false",
            "::tests@6 inline=true path=- unresolved=false auxiliary=true local=false",
            "tests::nested@6 inline=false path=- unresolved=false auxiliary=true local=false",
            "::inline@7 inline=true path=- unresolved=false auxiliary=false local=false",
            "inline::child@7 inline=false path=- unresolved=false auxiliary=false local=false",
            "::local@8 inline=false path=- unresolved=false auxiliary=false local=true",
        ]
    );
}

/// A whole file can be excluded from the program it sits in, which is a different fact from a
/// module inside it being test-only.
#[test]
fn domain_facts_reports_a_test_only_file_as_auxiliary() {
    assert_eq!(check("#![cfg(test)]\nmod helpers;\n")["auxiliary"], true);
    assert_eq!(check("mod helpers;\n")["auxiliary"], false);
}

/// A macro in item position may expand to module declarations the walk would then never see, so it
/// is reported where it stands; a named definition expands nowhere by itself.
#[test]
fn domain_facts_reports_item_position_macro_calls_and_not_their_definitions() {
    let answer = check(
        "macro_rules! declare { () => { mod generated; }; }\ndeclare_modules!();\n#[cfg(test)]\nmod tests { declare_helpers!(); }\nimpl Invoice { declare_getters!(); }\nfn run() { declare_locals!(); }\n",
    );
    assert_eq!(
        list(&answer, "item_macros")
            .iter()
            .map(|entry| format!(
                "{}@{}",
                entry["line"].as_u64().unwrap(),
                entry["auxiliary"].as_bool().unwrap()
            ))
            .collect::<Vec<_>>(),
        ["2@false", "4@true", "5@false"]
    );
}

/// Rule (d) resolves a receiver through the type its name was declared with, and only an explicit
/// annotation is such a declaration.
#[test]
fn domain_facts_reports_only_an_explicitly_declared_receiver_type() {
    let answer = check(
        "fn run(repo: &Repo) {\n    let typed: Ledger = make();\n    let inferred = make();\n    repo.remove(1);\n    typed.total();\n    inferred.total();\n    self.total();\n}\n",
    );
    assert_eq!(
        list(&answer, "calls")
            .iter()
            .filter(|call| call["kind"] == "method-call")
            .map(|call| format!(
                "{}.{}:{}",
                call["receiver_text"].as_str().unwrap(),
                call["callee_text"].as_str().unwrap(),
                call["receiver_binding_type"].as_str().unwrap_or("-")
            ))
            .collect::<Vec<_>>(),
        [
            "repo.remove:&Repo",
            "typed.total:Ledger",
            "inferred.total:-",
            "self.total:-"
        ]
    );
}

/// The whole-word test the binding lookup runs a pattern through, read in characters. A byte-wise
/// neighbour test reads a UTF-8 continuation byte as a non-word character, and a byte-wise advance
/// lands inside a multi-byte character and panics on the next slice.
#[test]
fn domain_facts_reads_a_whole_word_in_characters_not_bytes() {
    assert!(mentions("合計", "合計"));
    assert!(mentions("(合計, rest)", "合計"));
    assert!(mentions("mut total", "total"));
    assert!(!mentions("合計2", "合計"));
    assert!(!mentions("x合計", "合計"));
    assert!(!mentions("合計額", "合計"));
    assert!(!mentions("合計id", "id"));
    assert!(!mentions("subtotal", "total"));
}

/// Rust accepts non-ASCII identifiers, so the binding lookup meets them. A name that another
/// binding in the same block only prefixes must resolve to its own binding and must not end the
/// run: an extractor that panics produces no answer at all, which stops every gate that needs it
/// at the tool-unavailable terminal instead of reporting a verdict.
#[test]
fn domain_facts_answers_when_one_non_ascii_binding_prefixes_another() {
    let answer = check(
        "pub struct D { pub 合計: u64 }\nfn run() {\n    let 合計 = make();\n    let 合計2 = make();\n    let total = 合計;\n}\n",
    );
    assert_eq!(
        list(&answer, "members")
            .iter()
            .map(|member| member["member"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        ["合計"]
    );
}

/// Whether a construction goes through the type's own constructor is what rule (c) reads, and the
/// span is what tells a construction inside an inherent impl from one outside it.
#[test]
fn domain_facts_reports_each_construction_form_with_the_span_it_occupies() {
    let answer = check(
        "impl Invoice {\n    pub fn new() -> Self { Invoice { id: 0 } }\n}\nfn build(base: Invoice) -> Invoice {\n    let updated = Invoice { ..base };\n    let made = Invoice::create(1);\n    let empty = Invoice::default();\n    Default::default()\n}\n",
    );
    assert_eq!(
        list(&answer, "constructions")
            .iter()
            .map(|entry| format!(
                "{}:{}:{}@{}",
                entry["kind"].as_str().unwrap(),
                entry["type_text"].as_str().unwrap(),
                entry["callee_text"].as_str().unwrap_or("-"),
                entry["span"]["start_line"].as_u64().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            "struct-literal:Invoice:-@2",
            "update-syntax:Invoice:-@5",
            "associated-call:Invoice:create@6",
            "default-call:Invoice:default@7",
            "default-call:Default:default@8",
        ]
    );
    let block = &answer["impls"][0]["span"];
    assert_eq!(block["start_line"], 1);
    assert_eq!(block["end_line"], 3);
}

#[test]
fn domain_facts_records_the_constructs_that_can_hide_a_declaration() {
    assert_eq!(reasons("declare_invoice!();"), ["macro-expansion"]);
    assert_eq!(
        reasons("pub struct Invoice { #[cfg(feature = \"x\")] pub amount: u64 }"),
        ["conditional-compilation"]
    );
    assert_eq!(
        reasons("pub struct Invoice;\nimpl Invoice { declare_getters!(); }"),
        ["macro-expansion"]
    );
}

/// `reason@line` for every unresolved record, sorted, so a case states the set it expects rather than
/// the order the visit happens to take.
fn sorted_reasons_at(source: &str) -> Vec<String> {
    let mut reasons = reasons_at(source);
    reasons.sort();
    reasons
}

/// An attribute macro replaces the item it annotates, so the item a reader sees is not necessarily the
/// one the program declares. It is recorded on the line its `#` stands on.
#[test]
fn domain_facts_records_an_attribute_that_is_not_built_in_as_a_possible_attribute_macro() {
    assert_eq!(
        reasons_at("#[add_public_field]\npub struct Invoice { id: String }"),
        ["attribute-macro@1"]
    );
}

/// Outside `#[cfg(test)]` code, whether an attribute may be a macro is read off the attribute, not off
/// where in the syntax it is written.
#[test]
fn domain_facts_records_a_possible_attribute_macro_wherever_it_is_written_outside_test_only_code() {
    assert_eq!(
        sorted_reasons_at(
            "pub struct A {\n    #[field_macro]\n    id: String,\n}\n#[fn_macro]\nfn run() {}\n#[impl_macro]\nimpl A {\n    #[method_macro]\n    fn get(&self) {}\n}\n#[trait_macro]\ntrait T {}\n#[mod_macro]\nmod inner {}\n"
        ),
        [
            "attribute-macro@12",
            "attribute-macro@14",
            "attribute-macro@2",
            "attribute-macro@5",
            "attribute-macro@7",
            "attribute-macro@9",
        ]
    );
}

/// A `#[cfg(test)]` item is not part of the build rules (a) and (d) decide on, so an attribute macro
/// inside it cannot change a declaration they read. The `cfg` itself stays the conditional-compilation
/// record it always was.
#[test]
fn domain_facts_does_not_record_an_attribute_macro_inside_a_test_only_module() {
    assert_eq!(
        sorted_reasons_at(
            "#[cfg(test)]\nmod tests {\n    #[tokio::test]\n    async fn one() {}\n}"
        ),
        ["conditional-compilation@1"]
    );
}

/// The item that carries `#[cfg(test)]` is test-only as a whole, attributes written above the `cfg`
/// included.
#[test]
fn domain_facts_does_not_record_an_attribute_macro_on_the_test_only_item_itself() {
    assert_eq!(
        sorted_reasons_at("#[my_attr]\n#[cfg(test)]\nfn helper() {}"),
        ["conditional-compilation@2"]
    );
}

/// A file whose inner attribute is `#![cfg(test)]` is test-only as a whole.
#[test]
fn domain_facts_does_not_record_an_attribute_macro_in_a_test_only_file() {
    assert_eq!(
        sorted_reasons_at("#![cfg(test)]\n#[tokio::test]\nasync fn one() {}"),
        ["conditional-compilation@1"]
    );
}

/// Leaving a test-only module ends what it excludes: the item after it is part of the build again.
#[test]
fn domain_facts_records_an_attribute_macro_on_an_item_after_a_test_only_module() {
    assert_eq!(
        sorted_reasons_at("#[cfg(test)]\nmod tests {}\n#[my_attr]\npub struct A;"),
        ["attribute-macro@3", "conditional-compilation@1"]
    );
}

/// The test-only distinction is the one the declaration walk draws, over `syn::Item`s and the file.
/// A `#[cfg(test)]` method inside an impl is outside it, so an attribute macro there is recorded.
#[test]
fn domain_facts_records_an_attribute_macro_on_a_test_only_method_inside_an_impl() {
    assert_eq!(
        sorted_reasons_at(
            "pub struct A;\nimpl A {\n    #[cfg(test)]\n    #[my_attr]\n    fn h(&self) {}\n}"
        ),
        ["attribute-macro@4", "conditional-compilation@3"]
    );
}

/// Only `#[cfg(test)]` exactly is read as test-only. Any other predicate, one that merely mentions
/// `test` included, names a build this protocol does not evaluate, so an attribute macro under it is
/// recorded as before, and what `cfg_attr(test, ..)` would apply stays a conditional-compilation record.
#[test]
fn domain_facts_records_an_attribute_macro_under_any_other_configuration_predicate() {
    assert_eq!(
        sorted_reasons_at(
            "#[cfg(feature = \"x\")]\nmod a { #[tokio::test] async fn one() {} }\n#[cfg(not(test))]\nmod b { #[my_attr] fn two() {} }\n#[cfg(any(test, feature = \"x\"))]\nmod c { #[my_attr] fn three() {} }\n#[cfg_attr(test, my_macro)]\npub struct D;"
        ),
        [
            "attribute-macro@2",
            "attribute-macro@4",
            "attribute-macro@6",
            "conditional-compilation@1",
            "conditional-compilation@3",
            "conditional-compilation@5",
            "conditional-compilation@7",
        ]
    );
}

/// `async_trait` only rewrites the signatures of the async methods it annotates: it adds no public
/// member for rule (a) and no getter for rule (d), so it is allow-listed, with or without arguments,
/// on a trait or on an impl.
#[test]
fn domain_facts_does_not_record_an_allow_listed_attribute_macro() {
    assert_eq!(
        reasons_at(
            "#[async_trait]\npub trait Clock { async fn now(&self) -> i64; }\n#[async_trait(?Send)]\npub trait Tick { async fn tick(&self); }\npub struct System;\n#[async_trait]\nimpl Clock for System { async fn now(&self) -> i64 { 0 } }\n"
        ),
        Vec::<String>::new()
    );
}

/// The allow list is matched on the last path segment, so the path-qualified spelling is allowed too.
#[test]
fn domain_facts_does_not_record_a_path_qualified_allow_listed_attribute_macro() {
    assert_eq!(
        reasons_at(
            "pub trait Clock { fn now(&self) -> i64; }\npub struct System;\n#[async_trait::async_trait]\nimpl Clock for System { fn now(&self) -> i64 { 0 } }\n"
        ),
        Vec::<String>::new()
    );
}

/// A path that merely starts with an allow-listed name names another macro.
#[test]
fn domain_facts_records_an_attribute_macro_whose_last_segment_is_not_allow_listed() {
    assert_eq!(
        reasons_at("#[async_trait::other]\npub trait Clock {}"),
        ["attribute-macro@1"]
    );
}

/// An attribute macro the allow list does not name is recorded in the build as before, path-qualified
/// or not.
#[test]
fn domain_facts_records_an_attribute_macro_the_allow_list_does_not_name() {
    assert_eq!(
        sorted_reasons_at("#[tokio::main]\nasync fn main() {}\n#[tokio::test]\nasync fn one() {}"),
        ["attribute-macro@1", "attribute-macro@3"]
    );
}

/// The same characters in a region that declares nothing, a doc comment included, record nothing.
#[test]
fn domain_facts_does_not_record_an_attribute_spelled_where_nothing_is_declared() {
    let source = "macro_rules! declare {\n    () => { #[add_public_field] pub struct X; };\n}\nconst DOC: &str = \"#[add_public_field] pub struct X;\";\nconst RAW: &str = r##\"#[add_public_field] pub struct X;\"##;\n// #[add_public_field] pub struct X;\n/* /* #[add_public_field] pub struct X; */ */\n/// #[add_public_field] pub struct X;\npub struct Y;\n";
    assert_eq!(reasons_at(source), Vec::<String>::new());
}

/// A built-in attribute expands to nothing, and what `cfg_attr` would apply is a configuration this
/// protocol does not evaluate: it stays the one conditional-compilation record it always was.
#[test]
fn domain_facts_does_not_record_a_built_in_attribute_or_what_cfg_attr_would_apply() {
    assert_eq!(
        reasons_at(
            "#[derive(Clone)]\n#[allow(dead_code)]\n#[non_exhaustive]\n#[rustfmt::skip]\n#[cfg_attr(test, my_macro)]\npub struct Builtin;"
        ),
        ["conditional-compilation@5"]
    );
}

/// The built-in and tool attributes a domain crate commonly carries. `#[unsafe(...)]` is read by syn
/// 3.0.5 as an attribute whose path is `unsafe`, so it is one of them.
#[test]
fn domain_facts_does_not_record_built_in_or_tool_attributes() {
    let source = "#![allow(dead_code)]\n#[doc = \"documented\"]\n#[doc(hidden)]\n#[must_use]\n#[inline]\n#[deprecated(note = \"x\")]\npub fn a() -> u64 { 0 }\n#[repr(C)]\n#[derive(Debug)]\npub struct B;\n#[clippy::msrv = \"1.70\"]\n#[diagnostic::on_unimplemented(message = \"x\")]\npub trait C {}\n#[expect(unused)]\n#[track_caller]\n#[cold]\npub fn d() {}\n#[unsafe(no_mangle)]\npub extern \"C\" fn e() {}\n#[test]\n#[ignore]\n#[should_panic]\nfn f() {}\n#[macro_export]\nmacro_rules! g { () => {} }\n#[automatically_derived]\nimpl Clone for B { fn clone(&self) -> Self { B } }\n";
    assert_eq!(reasons_at(source), Vec::<String>::new());
}

/// A helper attribute of a derive the same item carries is read by that derive, which cannot change
/// the item's members, so it is not a possible attribute macro. The derive is matched by its last
/// path segment, and the helper may stand on the item or on one of its fields.
#[test]
fn domain_facts_does_not_record_the_serde_helpers_of_a_serde_derive_on_the_same_struct() {
    assert_eq!(
        reasons_at(
            "#[derive(serde::Serialize)]\n#[serde(rename_all = \"camelCase\")]\npub struct Invoice { #[serde(rename = \"x\")] id: String }"
        ),
        Vec::<String>::new()
    );
}

#[test]
fn domain_facts_does_not_record_the_serde_helpers_on_the_variants_of_a_serde_enum() {
    assert_eq!(
        reasons_at(
            "#[derive(Deserialize)]\n#[serde(tag = \"kind\")]\npub enum Event {\n    #[serde(rename = \"issued\")]\n    Issued { #[serde(default)] amount: u64 },\n    Paid(#[serde(default)] u64),\n}\n"
        ),
        Vec::<String>::new()
    );
}

#[test]
fn domain_facts_records_a_serde_helper_on_an_item_without_a_serde_derive() {
    assert_eq!(
        reasons_at(
            "#[derive(Clone)]\n#[serde(rename_all = \"camelCase\")]\npub struct Invoice { id: String }"
        ),
        ["attribute-macro@2"]
    );
}

/// The derive allows its helpers on the item it is written on alone: not on another item of the same
/// file, and not on an impl block of the same type, which is an item of its own.
#[test]
fn domain_facts_allows_a_serde_helper_on_the_derived_item_only() {
    assert_eq!(
        sorted_reasons_at(
            "#[derive(Serialize)]\npub struct A { id: String }\n#[serde(rename_all = \"camelCase\")]\npub struct B { id: String }\n#[derive(Serialize)]\npub struct C;\nimpl C {\n    #[serde(skip)]\n    fn hidden(&self) {}\n}\n"
        ),
        ["attribute-macro@3", "attribute-macro@8"]
    );
}

/// `Default` declares the `#[default]` helper that picks the default variant of an enum it derives.
#[test]
fn domain_facts_does_not_record_the_default_helper_on_a_variant_of_a_default_enum() {
    assert_eq!(
        reasons_at(
            "#[derive(Clone, Default)]\npub enum InvoiceStatus {\n    #[default]\n    Draft,\n    Issued,\n}\n"
        ),
        Vec::<String>::new()
    );
}

#[test]
fn domain_facts_records_the_default_helper_on_an_enum_without_a_default_derive() {
    assert_eq!(
        reasons_at(
            "#[derive(Clone)]\npub enum InvoiceStatus {\n    #[default]\n    Draft,\n    Issued,\n}\n"
        ),
        ["attribute-macro@3"]
    );
}

/// Only the helpers of an allow-listed derive are allowed; the helper of any other derive is recorded.
#[test]
fn domain_facts_records_the_helper_of_a_derive_the_allow_list_does_not_name() {
    assert_eq!(
        reasons_at(
            "#[derive(strum::Display)]\n#[strum(serialize_all = \"snake_case\")]\npub enum Status { Draft }"
        ),
        ["attribute-macro@2"]
    );
}

/// thiserror's helpers are allowed on the item that derives `Error`, on the item and its variants
/// and fields alike.
#[test]
fn domain_facts_does_not_record_the_thiserror_helpers_of_an_error_derive() {
    assert_eq!(
        reasons_at(
            "#[derive(Debug, thiserror::Error)]\npub enum InvoiceError {\n    #[error(\"not found\")]\n    NotFound,\n    #[error(transparent)]\n    Io(#[from] Cause),\n    #[error(\"wrapped\")]\n    Wrapped { #[source] cause: Cause, #[backtrace] trace: Trace },\n}\n"
        ),
        Vec::<String>::new()
    );
}

/// The same `#[error]` on an item that does not derive `Error` is recorded.
#[test]
fn domain_facts_records_the_error_helper_on_an_item_without_an_error_derive() {
    assert_eq!(
        reasons_at("#[derive(Debug)]\n#[error(\"failed\")]\npub struct Failure;"),
        ["attribute-macro@2"]
    );
}

#[test]
fn domain_facts_marks_an_unparsed_file_instead_of_reporting_it_as_declaring_nothing() {
    let answer = check("pub struct {");
    assert_eq!(answer["parsed"], false);
    for key in ["members", "types", "traits", "impls", "functions", "uses", "modules", "calls"] {
        assert!(answer.get(key).is_none(), "{key} is reported for an unparsed file");
    }
    assert_eq!(answer["unresolved"][0]["reason"], "syntax-error");
}

#[test]
fn domain_facts_answers_one_record_per_requested_file_in_order() {
    let answer = run(json!({"protocol_version":7,"files":[
        {"path":"b.rs","source":"pub struct B(pub u64);"},
        {"path":"a.rs","source":"pub struct A(pub u64);"}]}))
    .unwrap();
    let files = answer["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["path"], "b.rs");
    assert_eq!(files[1]["path"], "a.rs");
}

#[test]
fn domain_facts_refuses_a_request_that_is_not_this_protocol() {
    for request in [
        json!({"protocol_version":6,"files":[{"path":"lib.rs","source":""}]}),
        json!({"protocol_version":7,"files":[]}),
        json!({"protocol_version":7,"files":[{"path":"lib.rs"}]}),
        json!({"protocol_version":7,"files":[{"path":"lib.rs","source":"","extra":true}]}),
    ] {
        assert!(run(request).is_err());
    }
}
