use std::collections::HashSet;
use std::io;
use std::path::Path;

use jsonc_parser::ast::{Array as AstArray, Object as AstObject, Value as AstValue};
use jsonc_parser::common::Ranged;
use jsonc_parser::cst::{CstInputValue, CstNode, CstObject, CstRootNode};
use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions};
use serde_json::{json as serde_json_value, Map, Value};

use super::command::hook_command;
use super::config_edit::{
    ensure_hooks_object, hook_command_variants, hooks_object_if_present, is_matching_command_hook,
};

// Claude's documented SessionStart sources. Grok imports Claude hooks but uses
// `new`/`load`; filter before it starts an unnecessary hook process.
const SESSION_START_MATCHER: &str = "^(startup|resume|clear|compact|fork)$";
const HOOK_TIMEOUT_SECONDS: u64 = 10;
/// The permission hook waits up to 24 hours for an answer; Claude Code must not
/// kill it before that wait ends on its own.
const PERMISSION_HOOK_TIMEOUT_SECONDS: u64 = 24 * 60 * 60 + 60;

/// A hook group that install writes and keeps in one canonical form.
struct HookInstall {
    event: &'static str,
    action: &'static str,
    matcher: Option<&'static str>,
    timeout: u64,
    /// Claude Code runs the hook without waiting for it (`"async": true`).
    background: bool,
}

const HOOK_INSTALLS: &[HookInstall] = &[
    HookInstall {
        event: "SessionStart",
        action: "session",
        matcher: Some(SESSION_START_MATCHER),
        timeout: HOOK_TIMEOUT_SECONDS,
        background: false,
    },
    // `Stop`/`idle` is a removed legacy hook, so the reply report uses its own action.
    HookInstall {
        event: "Stop",
        action: "reply",
        matcher: None,
        timeout: HOOK_TIMEOUT_SECONDS,
        background: false,
    },
    // `PermissionRequest`/`blocked` is a removed legacy hook as well.
    HookInstall {
        event: "PermissionRequest",
        action: "permission",
        matcher: None,
        timeout: PERMISSION_HOOK_TIMEOUT_SECONDS,
        background: false,
    },
    // The tool events report every tool call's start and end. They report no
    // agent state, unlike the removed `working` hooks on the same events, and
    // run in the background so that reporting never delays a tool.
    HookInstall {
        event: "PreToolUse",
        action: "tool",
        matcher: None,
        timeout: HOOK_TIMEOUT_SECONDS,
        background: true,
    },
    HookInstall {
        event: "PostToolUse",
        action: "tool",
        matcher: None,
        timeout: HOOK_TIMEOUT_SECONDS,
        background: true,
    },
    HookInstall {
        event: "PostToolUseFailure",
        action: "tool",
        matcher: None,
        timeout: HOOK_TIMEOUT_SECONDS,
        background: true,
    },
];

impl HookInstall {
    fn for_event(event: &str) -> Option<&'static HookInstall> {
        HOOK_INSTALLS.iter().find(|hook| hook.event == event)
    }

    fn command(&self, hook_path: &Path) -> String {
        hook_command(hook_path, Some(self.action))
    }

    fn canonical_value(&self, hook_path: &Path) -> Value {
        let mut handler = serde_json_value!({
            "type": "command",
            "command": self.command(hook_path),
            "timeout": self.timeout,
        });
        if self.background {
            handler["async"] = Value::Bool(true);
        }
        let mut entry = Map::new();
        if let Some(matcher) = self.matcher {
            entry.insert("matcher".to_string(), Value::String(matcher.to_string()));
        }
        entry.insert("hooks".to_string(), Value::Array(vec![handler]));
        Value::Object(entry)
    }

    fn canonical_input(&self, hook_path: &Path) -> CstInputValue {
        let mut handler = vec![
            (
                "type".to_string(),
                CstInputValue::String("command".to_string()),
            ),
            (
                "command".to_string(),
                CstInputValue::String(self.command(hook_path)),
            ),
            (
                "timeout".to_string(),
                CstInputValue::Number(self.timeout.to_string()),
            ),
        ];
        if self.background {
            handler.push(("async".to_string(), CstInputValue::Bool(true)));
        }
        let mut properties = Vec::new();
        if let Some(matcher) = self.matcher {
            properties.push((
                "matcher".to_string(),
                CstInputValue::String(matcher.to_string()),
            ));
        }
        properties.push((
            "hooks".to_string(),
            CstInputValue::Array(vec![CstInputValue::Object(handler)]),
        ));
        CstInputValue::Object(properties)
    }

    fn canonical_json(&self, hook_path: &Path) -> io::Result<String> {
        let command = serde_json::to_string(&self.command(hook_path))?;
        let background = if self.background {
            ",\"async\":true"
        } else {
            ""
        };
        let hooks = format!(
            "[{{\"type\":\"command\",\"command\":{command},\"timeout\":{}{background}}}]",
            self.timeout
        );
        Ok(match self.matcher {
            Some(matcher) => format!(
                "{{\"matcher\":{},\"hooks\":{hooks}}}",
                serde_json::to_string(matcher)?
            ),
            None => format!("{{\"hooks\":{hooks}}}"),
        })
    }
}

struct HookRemoval {
    event: &'static str,
    actions: &'static [&'static str],
}

const HOOK_REMOVALS: &[HookRemoval] = &[
    HookRemoval {
        event: "PostToolUse",
        actions: &["working", "tool"],
    },
    HookRemoval {
        event: "PostToolUseFailure",
        actions: &["working", "tool"],
    },
    HookRemoval {
        event: "SubagentStop",
        actions: &["working"],
    },
    HookRemoval {
        event: "PermissionRequest",
        actions: &["blocked", "permission"],
    },
    HookRemoval {
        event: "SessionStart",
        actions: &["idle", "session"],
    },
    HookRemoval {
        event: "UserPromptSubmit",
        actions: &["working"],
    },
    HookRemoval {
        event: "PreToolUse",
        actions: &["working", "tool"],
    },
    HookRemoval {
        event: "Stop",
        actions: &["idle", "reply"],
    },
    HookRemoval {
        event: "SessionEnd",
        actions: &["release"],
    },
];

pub(crate) fn install(content: &str, settings_path: &Path, hook_path: &Path) -> io::Result<String> {
    let original = parse_value(content, settings_path)?;
    let mut desired = original.clone();
    let hooks = ensure_hooks_object(
        &mut desired,
        settings_path,
        "claude settings",
        "claude settings hooks",
    )?;
    apply_value_removals(hooks, hook_path, EditKind::Install)?;
    for hook in HOOK_INSTALLS {
        ensure_canonical_hook(hooks, hook, hook_path)?;
    }

    if desired == original {
        return Ok(content.to_string());
    }

    rewrite(
        content,
        settings_path,
        hook_path,
        EditKind::Install,
        &desired,
    )
}

pub(crate) fn uninstall(
    content: &str,
    settings_path: &Path,
    hook_path: &Path,
) -> io::Result<String> {
    let original = parse_value(content, settings_path)?;
    let mut desired = original.clone();
    let mut removed = false;

    if let Some(hooks) = hooks_object_if_present(
        &mut desired,
        settings_path,
        "claude settings",
        "claude settings hooks",
    )? {
        removed = apply_value_removals(hooks, hook_path, EditKind::Uninstall)?;
    }

    if !removed {
        return Ok(content.to_string());
    }

    rewrite(
        content,
        settings_path,
        hook_path,
        EditKind::Uninstall,
        &desired,
    )
}

/// Appends the canonical entry of `hook` unless the removals preserved it.
fn ensure_canonical_hook(
    hooks: &mut Map<String, Value>,
    hook: &HookInstall,
    hook_path: &Path,
) -> io::Result<()> {
    let canonical = hook.canonical_value(hook_path);
    let entries = hooks
        .entry(hook.event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            io::Error::other(format!("hook entries for {} must be an array", hook.event))
        })?;
    if !entries.contains(&canonical) {
        entries.push(canonical);
    }
    Ok(())
}

fn apply_value_removals(
    hooks: &mut Map<String, Value>,
    hook_path: &Path,
    kind: EditKind,
) -> io::Result<bool> {
    let mut removed = false;
    for policy in HOOK_REMOVALS {
        let commands = removal_commands(policy, hook_path);
        let canonical = preserved_canonical(kind, policy.event, hook_path);
        removed |= remove_value_event_commands(hooks, policy.event, &commands, canonical.as_ref())?;
    }
    Ok(removed)
}

/// Install keeps the first canonical entry of each installed event in place.
fn preserved_canonical(kind: EditKind, event: &str, hook_path: &Path) -> Option<Value> {
    if kind != EditKind::Install {
        return None;
    }
    HookInstall::for_event(event).map(|hook| hook.canonical_value(hook_path))
}

fn remove_value_event_commands(
    hooks: &mut Map<String, Value>,
    event: &str,
    commands: &[String],
    canonical: Option<&Value>,
) -> io::Result<bool> {
    let Some(entries_value) = hooks.get_mut(event) else {
        return Ok(false);
    };
    let entries = entries_value
        .as_array_mut()
        .ok_or_else(|| io::Error::other(format!("hook entries for {event} must be an array")))?;
    let mut removed = false;
    let mut canonical_preserved = false;

    entries.retain_mut(|entry| {
        if !canonical_preserved && canonical.is_some_and(|canonical| entry == canonical) {
            canonical_preserved = true;
            return true;
        }
        let Some(command_entries) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            return true;
        };
        let before = command_entries.len();
        command_entries.retain(|entry| {
            !commands
                .iter()
                .any(|command| is_matching_command_hook(entry, command))
        });
        removed |= command_entries.len() != before;
        !command_entries.is_empty()
    });

    if entries.is_empty() && canonical.is_none() {
        hooks.remove(event);
    }
    Ok(removed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Install,
    Uninstall,
}

fn rewrite(
    content: &str,
    settings_path: &Path,
    hook_path: &Path,
    kind: EditKind,
    desired: &Value,
) -> io::Result<String> {
    let root = parse_cst_root(content, settings_path)?;
    let root_value = root.value().ok_or_else(|| not_an_object(settings_path))?;
    reject_duplicate_keys(&root_value, settings_path)?;
    let root_object = root_value
        .as_object()
        .ok_or_else(|| not_an_object(settings_path))?;

    let mut preserved_events = HashSet::new();
    if let Some(property) = root_object.get("hooks") {
        let hooks = property
            .object_value()
            .ok_or_else(|| hooks_not_an_object(settings_path))?;
        for policy in HOOK_REMOVALS {
            let commands = removal_commands(policy, hook_path);
            let canonical = preserved_canonical(kind, policy.event, hook_path);
            if remove_event_commands(&hooks, policy.event, &commands, canonical.as_ref())? {
                preserved_events.insert(policy.event);
            }
        }
    }

    let mut updated = root.to_string();
    if kind == EditKind::Install {
        for hook in HOOK_INSTALLS {
            if !preserved_events.contains(hook.event) {
                updated = append_canonical_hook(&updated, settings_path, hook_path, hook)?;
            }
        }
    }

    verify_updated(updated, settings_path, desired)
}

/// Removes owned commands from `event` and reports whether its canonical entry survived.
fn remove_event_commands(
    hooks: &CstObject,
    event: &str,
    commands: &[String],
    canonical: Option<&Value>,
) -> io::Result<bool> {
    let Some(event_property) = hooks.get(event) else {
        return Ok(false);
    };
    let entries = event_property
        .array_value()
        .ok_or_else(|| io::Error::other(format!("hook entries for {event} must be an array")))?;
    let mut canonical_preserved = false;

    for entry in entries.elements() {
        if !canonical_preserved
            && canonical.is_some_and(|canonical| entry.to_serde_value().as_ref() == Some(canonical))
        {
            canonical_preserved = true;
            continue;
        }

        let Some(entry_object) = entry.as_object() else {
            continue;
        };
        let Some(command_entries) = entry_object
            .get("hooks")
            .and_then(|property| property.array_value())
        else {
            continue;
        };

        for command_entry in command_entries.elements() {
            let matches = command_entry.to_serde_value().is_some_and(|value| {
                commands
                    .iter()
                    .any(|command| is_matching_command_hook(&value, command))
            });
            if matches {
                command_entry.remove();
            }
        }

        if command_entries.elements().is_empty() {
            entry.remove();
        }
    }

    if entries.elements().is_empty() && canonical.is_none() {
        event_property.remove();
    }

    Ok(canonical_preserved)
}

fn removal_commands(policy: &HookRemoval, hook_path: &Path) -> Vec<String> {
    policy
        .actions
        .iter()
        .flat_map(|action| hook_command_variants(hook_path, Some(action)))
        .collect()
}

/// Appends the canonical entry for `hook`, writing compact containers as compact text.
fn append_canonical_hook(
    content: &str,
    settings_path: &Path,
    hook_path: &Path,
    hook: &HookInstall,
) -> io::Result<String> {
    let root = parse_cst_root(content, settings_path)?;
    let root_object = root
        .object_value()
        .ok_or_else(|| not_an_object(settings_path))?;

    let Some(hooks_property) = root_object.get("hooks") else {
        if direct_children_are_compact(&root_object.children()) {
            let ast_root = parse_ast_root_object(content, settings_path)?;
            let value = format!(
                "{{{}:[{}]}}",
                serde_json::to_string(hook.event)?,
                hook.canonical_json(hook_path)?
            );
            return Ok(append_object_property(content, &ast_root, "hooks", &value));
        }
        root_object.append("hooks", CstInputValue::Object(Vec::new()));
        return append_canonical_hook(&root.to_string(), settings_path, hook_path, hook);
    };
    let hooks = hooks_property
        .object_value()
        .ok_or_else(|| hooks_not_an_object(settings_path))?;

    match hooks.get(hook.event) {
        Some(event_property) => {
            let entries = event_property.array_value().ok_or_else(|| {
                io::Error::other(format!("hook entries for {} must be an array", hook.event))
            })?;
            if direct_children_are_compact(&entries.children()) {
                let ast_root = parse_ast_root_object(content, settings_path)?;
                let array = ast_root
                    .get_object("hooks")
                    .and_then(|hooks| hooks.get_array(hook.event))
                    .ok_or_else(|| {
                        io::Error::other(format!(
                            "hook entries for {} must be an array",
                            hook.event
                        ))
                    })?;
                return Ok(append_array_element(
                    content,
                    array,
                    &hook.canonical_json(hook_path)?,
                ));
            }
            entries.append(hook.canonical_input(hook_path));
        }
        None if direct_children_are_compact(&hooks.children()) => {
            let ast_root = parse_ast_root_object(content, settings_path)?;
            let ast_hooks = ast_root
                .get_object("hooks")
                .ok_or_else(|| hooks_not_an_object(settings_path))?;
            let value = format!("[{}]", hook.canonical_json(hook_path)?);
            return Ok(append_object_property(
                content, ast_hooks, hook.event, &value,
            ));
        }
        None => {
            hooks
                .append(hook.event, CstInputValue::Array(Vec::new()))
                .array_value()
                .ok_or_else(|| {
                    io::Error::other(format!("failed to create {} hook array", hook.event))
                })?
                .append(hook.canonical_input(hook_path));
        }
    }
    Ok(root.to_string())
}

fn parse_cst_root(content: &str, settings_path: &Path) -> io::Result<CstRootNode> {
    CstRootNode::parse(content, &strict_parse_options()).map_err(|err| {
        io::Error::other(format!(
            "failed to parse {}: {err}",
            settings_path.display()
        ))
    })
}

fn not_an_object(settings_path: &Path) -> io::Error {
    io::Error::other(format!(
        "claude settings at {} must be a JSON object",
        settings_path.display()
    ))
}

fn hooks_not_an_object(settings_path: &Path) -> io::Error {
    io::Error::other(format!(
        "claude settings hooks at {} must be a JSON object",
        settings_path.display()
    ))
}

fn parse_ast_root_object<'a>(content: &'a str, settings_path: &Path) -> io::Result<AstObject<'a>> {
    let parsed = parse_to_ast(content, &CollectOptions::default(), &strict_parse_options())
        .map_err(|err| {
            io::Error::other(format!(
                "failed to parse {}: {err}",
                settings_path.display()
            ))
        })?;
    match parsed.value {
        Some(AstValue::Object(object)) => Ok(object),
        _ => Err(io::Error::other(format!(
            "claude settings at {} must be a JSON object",
            settings_path.display()
        ))),
    }
}

fn append_object_property(
    content: &str,
    object: &AstObject<'_>,
    name: &str,
    value: &str,
) -> String {
    let key = serde_json::to_string(name).expect("JSON object keys are serializable");
    let key_value_separator = object
        .properties
        .first()
        .map(|property| &content[property.name.range().end..property.value.range().start])
        .unwrap_or(":");
    let insertion = format!("{key}{key_value_separator}{value}");
    let delimiter = object_delimiter(content, object);
    append_to_container(
        content,
        object.range,
        !object.properties.is_empty(),
        delimiter,
        &insertion,
    )
}

fn append_array_element(content: &str, array: &AstArray<'_>, value: &str) -> String {
    let delimiter = array_delimiter(content, array);
    append_to_container(
        content,
        array.range,
        !array.elements.is_empty(),
        delimiter,
        value,
    )
}

fn object_delimiter<'a>(content: &'a str, object: &AstObject<'_>) -> &'a str {
    match object.properties.as_slice() {
        [first, second, ..] => delimiter_suffix(&content[first.range.end..second.range.start]),
        [first] => &content[object.range.start + 1..first.range.start],
        [] => "",
    }
}

fn array_delimiter<'a>(content: &'a str, array: &AstArray<'_>) -> &'a str {
    match array.elements.as_slice() {
        [first, second, ..] => delimiter_suffix(&content[first.range().end..second.range().start]),
        [first] => &content[array.range.start + 1..first.range().start],
        [] => "",
    }
}

fn delimiter_suffix(delimiter: &str) -> &str {
    delimiter
        .split_once(',')
        .map(|(_, suffix)| suffix)
        .unwrap_or(delimiter)
}

fn append_to_container(
    content: &str,
    range: jsonc_parser::common::Range,
    has_elements: bool,
    delimiter: &str,
    value: &str,
) -> String {
    let closing = range.end - 1;
    let insertion_index = if has_elements {
        content[..closing].trim_end_matches([' ', '\t']).len()
    } else {
        closing
    };
    let mut updated = String::with_capacity(content.len() + delimiter.len() + value.len() + 1);
    updated.push_str(&content[..insertion_index]);
    if has_elements {
        updated.push(',');
        updated.push_str(delimiter);
    }
    updated.push_str(value);
    updated.push_str(&content[insertion_index..]);
    updated
}

fn verify_updated(updated: String, settings_path: &Path, desired: &Value) -> io::Result<String> {
    let actual = parse_value(&updated, settings_path)?;
    if &actual != desired {
        return Err(io::Error::other(format!(
            "failed to safely update claude settings at {}",
            settings_path.display()
        )));
    }
    Ok(updated)
}

fn direct_children_are_compact(children: &[CstNode]) -> bool {
    !children.iter().any(CstNode::is_newline)
}

fn parse_value(content: &str, settings_path: &Path) -> io::Result<Value> {
    serde_json::from_str(content).map_err(|err| {
        io::Error::other(format!(
            "failed to parse {}: {err}",
            settings_path.display()
        ))
    })
}

fn reject_duplicate_keys(node: &CstNode, settings_path: &Path) -> io::Result<()> {
    if let Some(object) = node.as_object() {
        let mut names = HashSet::new();
        for property in object.properties() {
            let name = property
                .name()
                .ok_or_else(|| io::Error::other("JSON object property is missing a name"))?
                .decoded_value()
                .map_err(|err| io::Error::other(format!("failed to decode JSON key: {err}")))?;
            if !names.insert(name.clone()) {
                return Err(io::Error::other(format!(
                    "claude settings at {} contains duplicate key {name:?}",
                    settings_path.display()
                )));
            }
            if let Some(value) = property.value() {
                reject_duplicate_keys(&value, settings_path)?;
            }
        }
    } else if let Some(array) = node.as_array() {
        for element in array.elements() {
            reject_duplicate_keys(&element, settings_path)?;
        }
    }
    Ok(())
}

fn strict_parse_options() -> ParseOptions {
    ParseOptions {
        allow_comments: false,
        allow_loose_object_property_names: false,
        allow_trailing_commas: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (&'static Path, &'static Path) {
        (
            Path::new("/home/test/.claude/settings.json"),
            Path::new("/home/test/.claude/hooks/herdr-agent-state.sh"),
        )
    }

    fn command_json(hook_path: &Path, action: &str) -> String {
        serde_json::to_string(&hook_command(hook_path, Some(action))).unwrap()
    }

    fn session_start_json(hook_path: &Path) -> String {
        format!(
            "{{\"matcher\":\"{SESSION_START_MATCHER}\",\"hooks\":[{{\"type\":\"command\",\"command\":{},\"timeout\":10}}]}}",
            command_json(hook_path, "session")
        )
    }

    fn stop_json(hook_path: &Path) -> String {
        format!(
            "{{\"hooks\":[{{\"type\":\"command\",\"command\":{},\"timeout\":10}}]}}",
            command_json(hook_path, "reply")
        )
    }

    fn permission_json(hook_path: &Path) -> String {
        format!(
            "{{\"hooks\":[{{\"type\":\"command\",\"command\":{},\"timeout\":86460}}]}}",
            command_json(hook_path, "permission")
        )
    }

    fn tool_json(hook_path: &Path) -> String {
        format!(
            "{{\"hooks\":[{{\"type\":\"command\",\"command\":{},\"timeout\":10,\"async\":true}}]}}",
            command_json(hook_path, "tool")
        )
    }

    /// The compact tool hook events that install appends after the others.
    fn tool_events_json(hook_path: &Path) -> String {
        let tool = tool_json(hook_path);
        format!(",\"PreToolUse\":[{tool}],\"PostToolUse\":[{tool}],\"PostToolUseFailure\":[{tool}]")
    }

    #[test]
    fn install_preserves_untouched_formatting_and_complete_trailing_suffix() {
        let (settings_path, hook_path) = paths();
        let input = concat!(
            "{\r\n",
            "    \"zeta\" : {\"escaped\":\"\\u0061\", \"number\":1e+02},\r\n",
            "    \"hooks\" : {\r\n",
            "        \"Notification\" : [{\"matcher\":\"keep\",\"hooks\":[]}]\r\n",
            "    },\r\n",
            "    \"alpha\" : 1\r\n",
            "}\r\n\r\n",
        );

        let updated = install(input, settings_path, hook_path).unwrap();

        assert!(updated.starts_with(concat!(
            "{\r\n",
            "    \"zeta\" : {\"escaped\":\"\\u0061\", \"number\":1e+02},\r\n",
            "    \"hooks\" : {\r\n",
            "        \"Notification\" : [{\"matcher\":\"keep\",\"hooks\":[]}],\r\n",
        )));
        assert!(updated.ends_with(concat!(
            "\r\n    },\r\n",
            "    \"alpha\" : 1\r\n",
            "}\r\n\r\n",
        )));
        assert!(!updated.replace("\r\n", "").contains('\n'));
        assert!(updated.contains("\"SessionStart\""));
        assert!(updated.contains("\"Stop\""));
        assert_eq!(
            install(&updated, settings_path, hook_path).unwrap(),
            updated
        );
        assert_eq!(
            serde_json::from_str::<Value>(&updated).unwrap()["zeta"]["number"],
            100.0
        );
    }

    #[test]
    fn install_keeps_compact_containers_compact() {
        let (settings_path, hook_path) = paths();
        let canonical = session_start_json(hook_path);
        let stop = stop_json(hook_path);
        let permission = permission_json(hook_path);
        let tools = tool_events_json(hook_path);
        let cases = [
            (
                "{\"zeta\":{\"escaped\":\"\\u0061\",\"n\":1e+02},\"alpha\":1}\r\n".to_string(),
                format!(
                    "{{\"zeta\":{{\"escaped\":\"\\u0061\",\"n\":1e+02}},\"alpha\":1,\"hooks\":{{\"SessionStart\":[{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}}}}\r\n"
                ),
            ),
            (
                "{\"hooks\":{\"Notification\":[{\"matcher\":\"keep\",\"hooks\":[]}]}, \"alpha\":1}".to_string(),
                format!(
                    "{{\"hooks\":{{\"Notification\":[{{\"matcher\":\"keep\",\"hooks\":[]}}],\"SessionStart\":[{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}}, \"alpha\":1}}"
                ),
            ),
            (
                "{\"hooks\":{\"SessionStart\":[{\"matcher\":\"keep\",\"hooks\":[{\"type\":\"command\",\"command\":\"echo keep\"}]}]}}".to_string(),
                format!(
                    "{{\"hooks\":{{\"SessionStart\":[{{\"matcher\":\"keep\",\"hooks\":[{{\"type\":\"command\",\"command\":\"echo keep\"}}]}},{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}}}}"
                ),
            ),
            (
                "{\"zeta\":{\n  \"x\":1\n},\"alpha\":1}".to_string(),
                format!(
                    "{{\"zeta\":{{\n  \"x\":1\n}},\"alpha\":1,\"hooks\":{{\"SessionStart\":[{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}}}}"
                ),
            ),
            (
                "{\"hooks\":{\"Notification\":[\n  {\"matcher\":\"keep\",\"hooks\":[]}\n]},\"alpha\":1}".to_string(),
                format!(
                    "{{\"hooks\":{{\"Notification\":[\n  {{\"matcher\":\"keep\",\"hooks\":[]}}\n],\"SessionStart\":[{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}},\"alpha\":1}}"
                ),
            ),
            (
                "{\"hooks\":{\"SessionStart\":[{\n  \"matcher\":\"keep\",\n  \"hooks\":[{\"type\":\"command\",\"command\":\"echo keep\"}]\n}]}}".to_string(),
                format!(
                    "{{\"hooks\":{{\"SessionStart\":[{{\n  \"matcher\":\"keep\",\n  \"hooks\":[{{\"type\":\"command\",\"command\":\"echo keep\"}}]\n}},{canonical}],\"Stop\":[{stop}],\"PermissionRequest\":[{permission}]{tools}}}}}"
                ),
            ),
            (
                format!(
                    "{{\"hooks\":{{\"SessionStart\":[{canonical}],\"Stop\":[{{\"hooks\":[{{\"type\":\"command\",\"command\":\"echo keep\"}}]}}]}}}}"
                ),
                format!(
                    "{{\"hooks\":{{\"SessionStart\":[{canonical}],\"Stop\":[{{\"hooks\":[{{\"type\":\"command\",\"command\":\"echo keep\"}}]}},{stop}],\"PermissionRequest\":[{permission}]{tools}}}}}"
                ),
            ),
        ];

        for (input, expected) in cases {
            assert_eq!(install(&input, settings_path, hook_path).unwrap(), expected);
        }
    }

    #[test]
    fn install_scopes_claude_session_start_sources() {
        let (settings_path, hook_path) = paths();
        let installed = install("{}", settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&installed).unwrap();
        let matcher = settings["hooks"]["SessionStart"][0]["matcher"]
            .as_str()
            .unwrap();
        assert_eq!(matcher, "^(startup|resume|clear|compact|fork)$");
        let pattern = regex::Regex::new(matcher).unwrap();
        for source in ["startup", "resume", "clear", "compact", "fork"] {
            assert!(pattern.is_match(source), "Claude source: {source}");
        }
        for source in ["new", "load", "", "future-source", "startup-extra"] {
            assert!(!pattern.is_match(source), "non-Claude source: {source}");
        }
    }

    #[test]
    fn install_is_a_byte_exact_noop_for_canonical_hooks() {
        let (settings_path, hook_path) = paths();
        let command = command_json(hook_path, "session");
        let reply = command_json(hook_path, "reply");
        let permission = command_json(hook_path, "permission");
        let tool = command_json(hook_path, "tool");
        let input = format!(
            "{{\"hooks\":{{\"PostToolUseFailure\":[{{\"hooks\":[{{\"async\":true,\"timeout\":10,\"type\":\"command\",\"command\":{tool}}}]}}],\"PermissionRequest\": [{{\"hooks\":[{{\"command\":{permission},\"timeout\":86460,\"type\":\"command\"}}]}}],\"PreToolUse\":[{{\"hooks\":[{{\"command\":{tool},\"async\":true,\"type\":\"command\",\"timeout\":10}}]}}],\"Stop\" : [ {{ \"hooks\" : [{{\"timeout\":10,\"type\":\"command\",\"command\":{reply}}}] }} ],\"PostToolUse\":[{{\"hooks\":[{{\"type\":\"command\",\"timeout\":10,\"async\":true,\"command\":{tool}}}]}}],\"SessionStart\":[{{\"hooks\":[{{\"timeout\":10,\"command\":{command},\"type\":\"command\"}}],\"matcher\":\"{SESSION_START_MATCHER}\"}}]}},\"escaped\":\"\\u0061\"}}  \r\n\r\n"
        );

        let updated = install(&input, settings_path, hook_path).unwrap();

        assert_eq!(updated, input);
    }

    #[test]
    fn install_migrates_wildcard_session_start_and_preserves_user_hook() {
        let (settings_path, hook_path) = paths();
        let command = serde_json::to_string(&hook_command(hook_path, Some("session"))).unwrap();
        let user_hook = r#"{ "type" : "command", "command" : "echo keep", "timeout" : 3 }"#;
        let input = format!(
            "{{\n  \"hooks\": {{\n    \"SessionStart\": [{{\"matcher\":\"*\",\"hooks\":[{{\"type\":\"command\",\"command\":{command},\"timeout\":10}},{user_hook}]}}]\n  }}\n}}\n\n"
        );
        let installed = install(&input, settings_path, hook_path).unwrap();
        assert!(installed.contains(user_hook));
        assert!(installed.ends_with("}\n\n"));
        let settings: Value = serde_json::from_str(&installed).unwrap();
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["matcher"], "*");
        assert_eq!(groups[0]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(groups[0]["hooks"][0]["command"], "echo keep");
        assert_eq!(
            groups[1],
            serde_json::from_str::<Value>(&session_start_json(hook_path)).unwrap()
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        assert!(removed.contains(user_hook));
        assert!(!removed.contains(&command));
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn install_preserves_canonical_session_start_position_during_migration() {
        let (settings_path, hook_path) = paths();
        let canonical = session_start_json(hook_path);
        let old_command = serde_json::to_string(&hook_command(hook_path, Some("working"))).unwrap();
        let session_start = format!(
            "\"SessionStart\":[{canonical},{{\"matcher\":\"foreign\",\"hooks\":[{{\"type\":\"command\",\"command\":\"echo keep\"}}]}}]"
        );
        let old_event = [
            "\"PostToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":",
            &old_command,
            "}]}]",
        ]
        .concat();
        let input = ["{\"hooks\":{", &session_start, ",", &old_event, "}}"].concat();
        let tool = tool_json(hook_path);
        // The legacy `working` entry leaves its event in place for the tool hook.
        let post_tool_use = format!("\"PostToolUse\":[{tool}]");
        let stop = format!("\"Stop\":[{}]", stop_json(hook_path));
        let permission = format!("\"PermissionRequest\":[{}]", permission_json(hook_path));
        let other_tool_events = format!("\"PreToolUse\":[{tool}],\"PostToolUseFailure\":[{tool}]");
        let expected = [
            "{\"hooks\":{",
            &session_start,
            ",",
            &post_tool_use,
            ",",
            &stop,
            ",",
            &permission,
            ",",
            &other_tool_events,
            "}}",
        ]
        .concat();

        let updated = install(&input, settings_path, hook_path).unwrap();

        assert_eq!(updated, expected);
    }

    #[test]
    fn install_removes_only_owned_commands_from_shared_hook_groups() {
        let (settings_path, hook_path) = paths();
        let old_command = serde_json::to_string(&hook_command(hook_path, Some("working"))).unwrap();
        let input = format!(
            concat!(
                "{{\n",
                "  \"hooks\": {{\n",
                "    \"PostToolUse\": [{{\n",
                "      \"matcher\": \"*\",\n",
                "      \"hooks\": [\n",
                "        {{\"type\":\"command\",\"command\":{old_command},\"timeout\":10}},\n",
                "        {{  \"type\" : \"command\", \"command\" : \"echo keep\", \"timeout\" : 3  }}\n",
                "      ]\n",
                "    }}],\n",
                "    \"Notification\": [{{\"matcher\":\"keep\",\"hooks\":[]}}]\n",
                "  }}\n",
                "}}\n",
            ),
            old_command = old_command,
        );

        let updated = install(&input, settings_path, hook_path).unwrap();

        assert!(!updated.contains(&old_command));
        assert!(updated.contains(
            "        {  \"type\" : \"command\", \"command\" : \"echo keep\", \"timeout\" : 3  }"
        ));
        assert!(updated.contains("    \"Notification\": [{\"matcher\":\"keep\",\"hooks\":[]}]"));
        let parsed: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(
            parsed["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "echo keep"
        );
        assert_eq!(
            parsed["hooks"]["PostToolUse"][1],
            serde_json::from_str::<Value>(&tool_json(hook_path)).unwrap()
        );
        assert_eq!(parsed["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn uninstall_preserves_unrelated_hook_text() {
        let (settings_path, hook_path) = paths();
        let command = serde_json::to_string(&hook_command(hook_path, Some("session"))).unwrap();
        let input = format!(
            concat!(
                "{{\n",
                "    \"before\" : \"\\u0061\",\n",
                "    \"hooks\" : {{\n",
                "        \"SessionStart\" : [{{\n",
                "            \"matcher\" : \"*\",\n",
                "            \"hooks\" : [\n",
                "                {{\"type\":\"command\",\"command\":{command},\"timeout\":10}},\n",
                "                {{  \"type\" : \"command\", \"command\" : \"echo keep\"  }}\n",
                "            ]\n",
                "        }}]\n",
                "    }},\n",
                "    \"after\" : 1e+02\n",
                "}}\n\n",
            ),
            command = command,
        );

        let updated = uninstall(&input, settings_path, hook_path).unwrap();

        assert_ne!(updated, input);
        assert!(!updated.contains(&command));
        assert!(updated
            .contains("                {  \"type\" : \"command\", \"command\" : \"echo keep\"  }"));
        assert!(updated.starts_with("{\n    \"before\" : \"\\u0061\","));
        assert!(updated.ends_with("    \"after\" : 1e+02\n}\n\n"));
    }

    #[test]
    fn install_adds_reply_stop_hook_without_a_matcher() {
        let (settings_path, hook_path) = paths();
        let installed = install("{}", settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&installed).unwrap();

        assert_eq!(
            settings["hooks"]["Stop"],
            serde_json_value!([{
                "hooks": [{
                    "type": "command",
                    "command": hook_command(hook_path, Some("reply")),
                    "timeout": 10,
                }],
            }])
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"], serde_json_value!({}));
    }

    #[test]
    fn install_appends_the_stop_and_permission_hooks_to_v10_canonical_settings() {
        let (settings_path, hook_path) = paths();
        let session_start = session_start_json(hook_path);
        let input = format!(
            concat!(
                "{{\n",
                "  \"model\": \"opus\",\n",
                "  \"hooks\": {{\n",
                "    \"SessionStart\": [{session_start}]\n",
                "  }}\n",
                "}}\n",
            ),
            session_start = session_start,
        );

        let updated = install(&input, settings_path, hook_path).unwrap();

        assert!(
            updated.starts_with(&format!(
                "{{\n  \"model\": \"opus\",\n  \"hooks\": {{\n    \"SessionStart\": [{session_start}],\n    \"Stop\": ["
            )),
            "{updated}"
        );
        assert!(updated.ends_with("\n  }\n}\n"), "{updated}");
        let settings: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(
            settings["hooks"]["Stop"][0],
            serde_json::from_str::<Value>(&stop_json(hook_path)).unwrap()
        );
        assert_eq!(
            settings["hooks"]["PermissionRequest"][0],
            serde_json::from_str::<Value>(&permission_json(hook_path)).unwrap()
        );
        assert_eq!(
            install(&updated, settings_path, hook_path).unwrap(),
            updated
        );
    }

    #[test]
    fn install_appends_the_permission_and_tool_hooks_to_earlier_v11_settings() {
        let (settings_path, hook_path) = paths();
        let session_start = session_start_json(hook_path);
        let stop = stop_json(hook_path);
        let input = format!(
            concat!(
                "{{\n",
                "  \"model\": \"opus\",\n",
                "  \"hooks\": {{\n",
                "    \"SessionStart\": [{session_start}],\n",
                "    \"Stop\": [{stop}]\n",
                "  }}\n",
                "}}\n",
            ),
            session_start = session_start,
            stop = stop,
        );

        let updated = install(&input, settings_path, hook_path).unwrap();

        assert!(
            updated.starts_with(&format!(
                "{{\n  \"model\": \"opus\",\n  \"hooks\": {{\n    \"SessionStart\": [{session_start}],\n    \"Stop\": [{stop}],\n    \"PermissionRequest\": ["
            )),
            "{updated}"
        );
        assert!(updated.ends_with("\n  }\n}\n"), "{updated}");
        let settings: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(
            settings["hooks"]["PermissionRequest"],
            serde_json_value!(
                [serde_json::from_str::<Value>(&permission_json(hook_path)).unwrap()]
            )
        );
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            assert_eq!(
                settings["hooks"][event],
                serde_json_value!([serde_json::from_str::<Value>(&tool_json(hook_path)).unwrap()]),
                "{event}"
            );
        }
        assert_eq!(
            install(&updated, settings_path, hook_path).unwrap(),
            updated
        );
        let removed = uninstall(&updated, settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"], serde_json_value!({}), "{removed}");
        assert_eq!(settings["model"], "opus");
    }

    #[test]
    fn install_adds_a_permission_request_hook_that_outlasts_the_day_long_wait() {
        let (settings_path, hook_path) = paths();
        let installed = install("{}", settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&installed).unwrap();

        assert_eq!(
            settings["hooks"]["PermissionRequest"],
            serde_json_value!([{
                "hooks": [{
                    "type": "command",
                    "command": hook_command(hook_path, Some("permission")),
                    "timeout": 86_460,
                }],
            }])
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"], serde_json_value!({}));
    }

    #[test]
    fn install_replaces_stale_permission_hooks_and_keeps_user_permission_hooks() {
        let (settings_path, hook_path) = paths();
        let blocked = command_json(hook_path, "blocked");
        let permission = command_json(hook_path, "permission");
        let user_hook = r#"{ "type" : "command", "command" : "echo keep", "timeout" : 3 }"#;
        let input = format!(
            concat!(
                "{{\n",
                "  \"hooks\": {{\n",
                "    \"PermissionRequest\": [\n",
                "      {{\"matcher\":\"*\",\"hooks\":[{{\"type\":\"command\",\"command\":{blocked},\"timeout\":10}},{user_hook}]}},\n",
                "      {{\"hooks\":[{{\"type\":\"command\",\"command\":{permission},\"timeout\":10}}]}}\n",
                "    ]\n",
                "  }}\n",
                "}}\n",
            ),
            blocked = blocked,
            permission = permission,
            user_hook = user_hook,
        );

        let installed = install(&input, settings_path, hook_path).unwrap();

        assert!(installed.contains(user_hook), "{installed}");
        assert!(!installed.contains(&blocked), "{installed}");
        let settings: Value = serde_json::from_str(&installed).unwrap();
        let groups = settings["hooks"]["PermissionRequest"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "{installed}");
        assert_eq!(groups[0]["matcher"], "*");
        assert_eq!(groups[0]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(groups[0]["hooks"][0]["command"], "echo keep");
        assert_eq!(
            groups[1],
            serde_json::from_str::<Value>(&permission_json(hook_path)).unwrap()
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        assert!(removed.contains(user_hook), "{removed}");
        assert!(!removed.contains(&permission), "{removed}");
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(
            settings["hooks"]["PermissionRequest"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn install_preserves_user_stop_hooks_and_removes_legacy_idle() {
        let (settings_path, hook_path) = paths();
        let idle = command_json(hook_path, "idle");
        let reply = command_json(hook_path, "reply");
        let user_hook = r#"{ "type" : "command", "command" : "echo keep", "timeout" : 3 }"#;
        let input = format!(
            concat!(
                "{{\n",
                "  \"hooks\": {{\n",
                "    \"Stop\": [\n",
                "      {{\"matcher\":\"*\",\"hooks\":[{{\"type\":\"command\",\"command\":{idle},\"timeout\":10}},{user_hook}]}},\n",
                "      {{\"hooks\":[{{\"type\":\"command\",\"command\":{reply},\"timeout\":30}}]}},\n",
                "      {{\"hooks\":[{{\"type\":\"command\",\"command\":\"echo user-stop\"}}]}}\n",
                "    ]\n",
                "  }}\n",
                "}}\n",
            ),
            idle = idle,
            reply = reply,
            user_hook = user_hook,
        );

        let installed = install(&input, settings_path, hook_path).unwrap();

        assert!(installed.contains(user_hook), "{installed}");
        assert!(!installed.contains(&idle), "{installed}");
        let settings: Value = serde_json::from_str(&installed).unwrap();
        let stop = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 3, "{installed}");
        assert_eq!(stop[0]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "echo keep");
        assert_eq!(stop[1]["hooks"][0]["command"], "echo user-stop");
        assert_eq!(
            stop[2],
            serde_json::from_str::<Value>(&stop_json(hook_path)).unwrap()
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        assert!(removed.contains(user_hook), "{removed}");
        assert!(!removed.contains(&reply), "{removed}");
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn install_adds_background_tool_hooks_for_every_tool() {
        let (settings_path, hook_path) = paths();
        let installed = install("{}", settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&installed).unwrap();

        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            assert_eq!(
                settings["hooks"][event],
                serde_json_value!([{
                    "hooks": [{
                        "type": "command",
                        "command": hook_command(hook_path, Some("tool")),
                        "timeout": 10,
                        "async": true,
                    }],
                }]),
                "{event}"
            );
        }
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"], serde_json_value!({}));
    }

    #[test]
    fn install_replaces_legacy_working_and_stale_tool_hooks_and_keeps_user_tool_hooks() {
        let (settings_path, hook_path) = paths();
        let working = command_json(hook_path, "working");
        let tool = command_json(hook_path, "tool");
        let user_hook = r#"{ "type" : "command", "command" : "echo keep", "timeout" : 3 }"#;
        let input = format!(
            concat!(
                "{{\n",
                "  \"hooks\": {{\n",
                "    \"PreToolUse\": [\n",
                "      {{\"matcher\":\"Bash\",\"hooks\":[{{\"type\":\"command\",\"command\":{working},\"timeout\":10}},{user_hook}]}},\n",
                "      {{\"hooks\":[{{\"type\":\"command\",\"command\":{tool},\"timeout\":10}}]}}\n",
                "    ]\n",
                "  }}\n",
                "}}\n",
            ),
            working = working,
            tool = tool,
            user_hook = user_hook,
        );

        let installed = install(&input, settings_path, hook_path).unwrap();

        assert!(installed.contains(user_hook), "{installed}");
        assert!(!installed.contains(&working), "{installed}");
        let settings: Value = serde_json::from_str(&installed).unwrap();
        assert_eq!(
            settings["hooks"]["PreToolUse"],
            serde_json_value!([
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo keep", "timeout": 3}]},
                serde_json::from_str::<Value>(&tool_json(hook_path)).unwrap(),
            ]),
            "{installed}"
        );
        assert_eq!(
            install(&installed, settings_path, hook_path).unwrap(),
            installed
        );

        let removed = uninstall(&installed, settings_path, hook_path).unwrap();
        assert!(removed.contains(user_hook), "{removed}");
        assert!(!removed.contains(&tool), "{removed}");
        let settings: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn every_installed_hook_is_removed_on_uninstall() {
        for hook in HOOK_INSTALLS {
            assert!(
                HOOK_REMOVALS
                    .iter()
                    .any(|policy| policy.event == hook.event
                        && policy.actions.contains(&hook.action)),
                "{} {} must be listed in HOOK_REMOVALS",
                hook.event,
                hook.action
            );
        }
    }

    #[test]
    fn install_rejects_duplicate_keys() {
        let (settings_path, hook_path) = paths();
        let error = install(
            r#"{"alpha": 1, "alpha": 2, "hooks": {}}"#,
            settings_path,
            hook_path,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("duplicate key \"alpha\""), "{error}");
    }

    #[test]
    fn install_keeps_structurally_invalid_content_unchanged() {
        let (settings_path, hook_path) = paths();
        for input in ["[]", r#"{"hooks": []}"#, r#"{"hooks":{"SessionStart":{}}}"#] {
            assert!(install(input, settings_path, hook_path).is_err());
        }
    }
}
