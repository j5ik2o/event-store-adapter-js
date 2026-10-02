//! Version 2 syntax evidence. Source is never compiled or executed.
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use syn::spanned::Spanned;

#[cfg(test)]
#[path = "state_evidence_tests.rs"]
mod tests;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    file: String,
    #[serde(rename = "declarationPath")]
    declaration_path: Vec<String>,
    representation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    request_identity: String,
    files: Vec<super::Source>,
    target: Target,
    settings: Value,
}

/// The project-settings vocabulary, spelled exactly as the TypeScript owner emits it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsEnvelope {
    #[serde(rename = "projectSettings")]
    project_settings: ProjectSettings,
}

/// serde folds an explicit `null` onto the outer `Option` too, so a key that is present with a null
/// value would read as absent. Forcing the outer `Some` keeps "the key is there" observable.
fn present_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectSettings {
    version: u8,
    languages: Vec<String>,
    // The outer Option keeps "key absent" apart from "key present"; the contract defines the key's
    // presence, so the two must not collapse into the same fact.
    #[serde(default, deserialize_with = "present_field")]
    rust: Option<Option<RustSelection>>,
    #[serde(default, deserialize_with = "present_field")]
    typescript: Option<Option<TypeScriptSelection>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RustSelection {
    #[serde(rename = "moduleLayout")]
    module_layout: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeScriptSelection {
    #[serde(rename = "moduleLayout")]
    module_layout: String,
    #[serde(rename = "codeRepresentation")]
    code_representation: String,
}

/// A language key is present exactly when that language is in use, and a present key names choices
/// the contract defines. Whether the key is there and whether its value is contract-defined stay
/// separate facts: folded into one boolean, an unused language and a contract-external value cancel
/// each other out and an undefined payload is accepted.
fn declared_exactly_when_in_use<T>(
    field: &Option<Option<T>>,
    in_use: bool,
    is_known: impl Fn(&T) -> bool,
) -> bool {
    match field {
        None => !in_use,
        Some(Some(choice)) => in_use && is_known(choice),
        Some(None) => false,
    }
}

/// Empty settings are the baseline every preserved case carries. Anything else must be exactly the
/// project-settings payload and must put Rust in use; the chosen layout never steers extraction.
fn accepts_settings(settings: &Value) -> bool {
    if settings
        .as_object()
        .expect("run rejects a request whose settings are not an object")
        .is_empty()
    {
        return true;
    }
    let Ok(envelope) = serde_json::from_value::<SettingsEnvelope>(settings.clone()) else {
        return false;
    };
    let selection = envelope.project_settings;
    if selection.version != 2 {
        return false;
    }
    let rust_in_use = selection.languages.iter().any(|name| name == "rust");
    let typescript_in_use = selection.languages.iter().any(|name| name == "typescript");
    if selection.languages.len() != usize::from(rust_in_use) + usize::from(typescript_in_use) {
        return false;
    }
    rust_in_use
        && declared_exactly_when_in_use(&selection.rust, rust_in_use, |choice| {
            ["file", "mod-rs"].contains(&choice.module_layout.as_str())
        })
        && declared_exactly_when_in_use(&selection.typescript, typescript_in_use, |choice| {
            ["named-file", "index-file"].contains(&choice.module_layout.as_str())
                && ["class", "companion"].contains(&choice.code_representation.as_str())
        })
}

fn location(span: proc_macro2::Span) -> Value {
    let range = span.byte_range();
    json!({"byte_start": range.start, "byte_end": range.end})
}

fn uncertain(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| !attr.path().is_ident("doc"))
}

fn unresolved(code: &str) -> Value {
    json!({"target_status": "unresolved", "reasons": [code]})
}

fn identify(items: &[syn::Item], path: &[String]) -> Value {
    let candidates: Vec<_> = items
        .iter()
        .filter(|item| match item {
            syn::Item::Struct(item) => {
                path.len() == 1 && item.ident.to_string().trim_start_matches("r#") == path[0]
            }
            syn::Item::Mod(item) => item.ident.to_string().trim_start_matches("r#") == path[0],
            syn::Item::Enum(item) => item.ident.to_string().trim_start_matches("r#") == path[0],
            syn::Item::Union(item) => item.ident.to_string().trim_start_matches("r#") == path[0],
            syn::Item::Type(item) => item.ident.to_string().trim_start_matches("r#") == path[0],
            syn::Item::Trait(item) => item.ident.to_string().trim_start_matches("r#") == path[0],
            _ => false,
        })
        .collect();
    if candidates.len() > 1 {
        return unresolved("target-ambiguous");
    }
    // Macros in this namespace may create or duplicate the requested declaration.
    if items.iter().any(|item| matches!(item, syn::Item::Macro(_))) {
        return unresolved("unsupported-syntax");
    }
    match candidates.first() {
        None => unresolved("target-missing"),
        Some(syn::Item::Mod(item)) if path.len() > 1 => {
            if uncertain(&item.attrs) {
                return unresolved("unsupported-syntax");
            }
            match &item.content {
                Some((_, items)) => identify(items, &path[1..]),
                None => unresolved("unsupported-syntax"),
            }
        }
        Some(syn::Item::Struct(item)) => extract(item, path),
        _ => unresolved("unsupported-syntax"),
    }
}

fn extract(item: &syn::ItemStruct, _path: &[String]) -> Value {
    if uncertain(&item.attrs) {
        return unresolved("unsupported-syntax");
    }
    let members: Vec<_> = item.fields.iter().enumerate().map(|(index, field)| {
        let name = field.ident.as_ref().map(|id| format!("field:{}", id.to_string().trim_start_matches("r#")))
            .unwrap_or_else(|| format!("tuple:{index}"));
        if uncertain(&field.attrs) {
            json!({"name": name, "status": "unresolved", "reason": "unsupported-syntax", "location": location(field.span())})
        } else {
            json!({"name": name, "status": "resolved", "exposed": !matches!(field.vis, syn::Visibility::Inherited), "location": location(field.span())})
        }
    }).collect();
    json!({"target_status": "resolved", "target_location": location(item.span()),
        "members": members, "completeness": "complete", "reasons": []})
}

pub fn run(value: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let target = value.get("target").cloned().ok_or("missing target")?;
    let request: Request = serde_json::from_value(value)?;
    if request.protocol_version != 2
        || request.files.is_empty()
        || request.target.declaration_path.is_empty()
        || request.target.declaration_path.iter().any(String::is_empty)
        || request.target.representation != "rust-struct"
        || !request.settings.is_object()
        || !request.request_identity.starts_with("sha256:")
        || request.request_identity.len() != 71
    {
        return Err("invalid version 2 request".into());
    }
    let files: Vec<_> = request
        .files
        .iter()
        .filter(|file| file.path == request.target.file)
        .collect();
    if files.len() != 1 {
        return Err("target file must occur exactly once".into());
    }
    let source = &files[0].source;
    let evidence = match syn::parse_file(source) {
        Ok(_) if !accepts_settings(&request.settings) => unresolved("unsupported-syntax"),
        Ok(file) if uncertain(&file.attrs) => unresolved("unsupported-syntax"),
        Ok(file) => {
            let offset = usize::from(source.starts_with('\u{feff}')) * 3
                + file.shebang.as_ref().map_or(0, String::len);
            let mut evidence = identify(&file.items, &request.target.declaration_path);
            shift_locations(&mut evidence, offset);
            evidence
        }
        Err(_) => unresolved("syntax-error"),
    };
    let mut result = evidence.as_object().unwrap().clone();
    result.insert("protocol_version".into(), json!(2));
    result.insert("request_identity".into(), json!(request.request_identity));
    result.insert(
        "source_digest".into(),
        json!(format!("sha256:{:x}", Sha256::digest(source.as_bytes()))),
    );
    result.insert("target".into(), target);
    Ok(Value::Object(result))
}

// syn::parse_file removes the BOM and shebang before assigning token spans.
fn shift_locations(value: &mut Value, offset: usize) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key == "byte_start" || key == "byte_end" {
                    *value = json!(value.as_u64().unwrap() + offset as u64);
                } else {
                    shift_locations(value, offset);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                shift_locations(value, offset);
            }
        }
        _ => {}
    }
}
