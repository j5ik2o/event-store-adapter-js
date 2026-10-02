use super::*;

fn check(source: &str, path: &[&str]) -> Value {
    run(
        json!({"protocol_version":2,"request_identity":format!("sha256:{}", "a".repeat(64)),
        "files":[{"path":"model.rs","source":source}],"settings":{},
        "target":{"file":"model.rs","declarationPath":path,"representation":"rust-struct"}}),
    )
    .unwrap()
}

fn check_settings(source: &str, settings: Value) -> Value {
    run(
        json!({"protocol_version":2,"request_identity":format!("sha256:{}", "a".repeat(64)),
        "files":[{"path":"model.rs","source":source}],"settings":settings,
        "target":{"file":"model.rs","declarationPath":["Model"],"representation":"rust-struct"}}),
    )
    .unwrap()
}

fn rust_settings(module_layout: &str) -> Value {
    json!({"projectSettings":{"version":2,"languages":["rust"],"rust":{"moduleLayout":module_layout}}})
}

fn both_language_settings(module_layout: &str) -> Value {
    json!({"projectSettings":{"version":2,"languages":["rust","typescript"],
        "rust":{"moduleLayout":module_layout},
        "typescript":{"moduleLayout":"named-file","codeRepresentation":"class"}}})
}

#[test]
fn state_evidence_accepts_recognized_project_settings() {
    let result = check_settings("struct Model { pub value: u8 }", rust_settings("file"));
    assert_eq!(result["target_status"], "resolved");
    assert_eq!(result["members"][0]["exposed"], true);
}

#[test]
fn state_evidence_layout_choice_does_not_change_the_evidence() {
    let source = "struct Model { pub value: u8 }";
    let file = check_settings(source, rust_settings("file"));
    let mod_rs = check_settings(source, rust_settings("mod-rs"));
    assert_eq!(file["target_status"], "resolved");
    assert_eq!(file["target_location"], mod_rs["target_location"]);
    assert_eq!(file["members"], mod_rs["members"]);
    assert_eq!(file["completeness"], mod_rs["completeness"]);
}

#[test]
fn state_evidence_accepts_a_payload_that_puts_both_languages_in_use() {
    let result = check_settings("struct Model { pub value: u8 }", both_language_settings("file"));
    assert_eq!(result["target_status"], "resolved");
    assert_eq!(result["members"][0]["exposed"], true);
}

#[test]
fn state_evidence_empty_settings_still_reach_extraction() {
    assert_eq!(
        check_settings("struct Model { pub value: u8 }", json!({}))["target_status"],
        "resolved"
    );
}

#[test]
fn state_evidence_rejects_settings_it_does_not_recognize() {
    for settings in [
        json!({"trace": true}),
        json!({"projectSettings":{"version":2,"languages":["rust"],"rust":{"moduleLayout":"file"},"extra":1}}),
        json!({"projectSettings":{"version":1,"languages":["rust"],"rust":{"moduleLayout":"file"}}}),
        json!({"projectSettings":{"version":2,"languages":["rust"],"rust":{"moduleLayout":"auto"}}}),
        json!({"projectSettings":{"version":2,"languages":["rust"]}}),
        json!({"projectSettings":{"version":2,"languages":["typescript"],
            "typescript":{"moduleLayout":"named-file","codeRepresentation":"class"}}}),
        // A language key that is present while the language is not in use, with a value the
        // contract does not define: neither fact may cancel the other out.
        json!({"projectSettings":{"version":2,"languages":["rust"],"rust":{"moduleLayout":"file"},
            "typescript":{"moduleLayout":"named-file","codeRepresentation":"record"}}}),
        json!({"projectSettings":{"version":2,"languages":["rust"],"rust":{"moduleLayout":"file"},
            "typescript":null}}),
        json!({"projectSettings":{"version":2,"languages":["rust","typescript"],
            "rust":{"moduleLayout":"file"},"typescript":{"moduleLayout":"named-file",
            "codeRepresentation":"record"}}}),
    ] {
        assert_eq!(
            check_settings("struct Model { pub value: u8 }", settings)["reasons"][0],
            "unsupported-syntax"
        );
    }
}

#[test]
fn state_evidence_visibility_and_tuple() {
    for source in [
        "struct Model { a: u8, pub b: u8, pub(crate) c: u8 }",
        "struct Model(u8, pub u8, pub(crate) u8);",
    ] {
        let result = check(source, &["Model"]);
        assert_eq!(result["members"][0]["exposed"], false);
        assert_eq!(result["members"][1]["exposed"], true);
        assert_eq!(result["members"][2]["exposed"], true);
    }
}

#[test]
fn state_evidence_target_paths() {
    assert_eq!(
        check(
            "mod nested { struct Model; } struct Model;",
            &["nested", "Model"]
        )["target_status"],
        "resolved"
    );
    assert_eq!(
        check("struct Other;", &["Model"])["reasons"][0],
        "target-missing"
    );
    assert_eq!(
        check("struct Model; struct Model;", &["Model"])["reasons"][0],
        "target-ambiguous"
    );
}

#[test]
fn state_evidence_conditional_target_and_syntax() {
    for source in [
        "#[cfg(feature=\"x\")] struct Model;",
        "make!(); struct Model;",
        "mod m;",
        "#![cfg(unix)] struct Model;",
    ] {
        let path = if source == "mod m;" {
            vec!["m", "Model"]
        } else {
            vec!["Model"]
        };
        assert_eq!(check(source, &path)["reasons"][0], "unsupported-syntax");
    }
    assert_eq!(
        check("struct Model {", &["Model"])["reasons"][0],
        "syntax-error"
    );
}

#[test]
fn state_evidence_mixed_field_preserves_certainty() {
    let result = check(
        "struct Model { pub a: u8, #[cfg(unix)] pub b: u8 }",
        &["Model"],
    );
    assert_eq!(result["target_status"], "resolved");
    assert_eq!(result["members"][0]["exposed"], true);
    assert_eq!(result["members"][1]["status"], "unresolved");
}

#[test]
fn state_evidence_unicode_bytes_and_digest() {
    let source = "// 日本語\r\nstruct Model { pub 名前: u8 }\n";
    let result = check(source, &["Model"]);
    let field = &result["members"][0]["location"];
    let start = field["byte_start"].as_u64().unwrap() as usize;
    let end = field["byte_end"].as_u64().unwrap() as usize;
    assert_eq!(&source[start..end], "pub 名前: u8");
    assert_eq!(
        result["source_digest"],
        format!("sha256:{:x}", Sha256::digest(source.as_bytes()))
    );
}

#[test]
fn state_evidence_invalid_request() {
    assert!(run(json!({"protocol_version":2,"files":[]})).is_err());
}

#[test]
fn state_evidence_bom_and_shebang_offsets() {
    for prefix in [
        "\u{feff}",
        "#!/usr/bin/env rust-script\n",
        "\u{feff}#!/bin/rust\n",
    ] {
        let source = format!("{prefix}struct Model {{ pub 名前: u8 }}\n");
        let result = check(&source, &["Model"]);
        for (loc, text) in [
            (&result["target_location"], "struct Model { pub 名前: u8 }"),
            (&result["members"][0]["location"], "pub 名前: u8"),
        ] {
            assert_eq!(
                &source[loc["byte_start"].as_u64().unwrap() as usize
                    ..loc["byte_end"].as_u64().unwrap() as usize],
                text
            );
        }
    }
}
