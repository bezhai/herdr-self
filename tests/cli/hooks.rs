use super::harness::*;

fn run_claude_hook(action: &str, hook_input: &str) -> Option<serde_json::Value> {
    run_shell_hook(
        "src/integration/assets/claude/herdr-agent-state.sh",
        &[action],
        hook_input,
    )
}

fn run_codex_hook(action: &str, hook_input: &str) -> Option<serde_json::Value> {
    run_shell_hook(
        "src/integration/assets/codex/herdr-agent-state.sh",
        &[action],
        hook_input,
    )
}

fn run_copilot_hook(hook_input: &str) -> Option<serde_json::Value> {
    run_shell_hook(
        "src/integration/assets/copilot/herdr-agent-state.sh",
        &[],
        hook_input,
    )
}

fn run_devin_hook(
    action: &str,
    hook_input: &str,
    envs: &[(&str, &str)],
) -> Option<serde_json::Value> {
    run_shell_hook_with_env(
        "src/integration/assets/devin/herdr-agent-state.sh",
        &[action],
        hook_input,
        envs,
    )
}

fn run_grok_hook(hook_input: &str, envs: &[(&str, &str)]) -> Option<serde_json::Value> {
    run_shell_hook_with_env(
        "src/integration/assets/grok/herdr-agent-state.sh",
        &["session"],
        hook_input,
        envs,
    )
}

fn run_shell_hook(asset_path: &str, args: &[&str], hook_input: &str) -> Option<serde_json::Value> {
    run_shell_hook_with_env(asset_path, args, hook_input, &[])
}

fn run_shell_hook_with_env(
    asset_path: &str,
    args: &[&str],
    hook_input: &str,
    envs: &[(&str, &str)],
) -> Option<serde_json::Value> {
    run_shell_hook_raw_with_env(asset_path, args, hook_input, envs)
        .map(|line| serde_json::from_str(&line).unwrap())
}

/// Runs a hook against a fake socket and returns the raw request line it sent.
fn run_shell_hook_raw_with_env(
    asset_path: &str,
    args: &[&str],
    hook_input: &str,
    envs: &[(&str, &str)],
) -> Option<String> {
    let base = unique_test_dir();
    fs::create_dir_all(&base).unwrap();
    let socket_path = base.join("herdr.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();

    let server = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_millis(700);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    reader.read_line(&mut line).unwrap();
                    let _ = stream.write_all(br#"{"id":"test","result":{"type":"ok"}}"#);
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                    return Some(line);
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(err) => panic!("accept failed: {err}"),
            }
        }
        None
    });

    let hook_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(asset_path);
    let mut command = Command::new("bash");
    command
        .arg(hook_path)
        .args(args)
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket_path)
        .env("HERDR_PANE_ID", "p_test")
        .env_remove("CODEX_THREAD_ID")
        .env_remove("CURSOR_VERSION")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(hook_input.as_bytes()).unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "hook failed: status={:?} stderr={} stdout={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );

    let request = server.join().unwrap();
    cleanup_test_base(&base);
    request
}

#[test]
fn claude_hook_ignores_state_actions() {
    let subagent_input = r#"{"hook_event_name":"Notification","agent_id":"agent-abc123","agent_type":"Explore","notification_type":"permission_prompt"}"#;

    assert!(run_claude_hook("working", subagent_input).is_none());
    assert!(run_claude_hook("blocked", subagent_input).is_none());
}

#[test]
fn claude_hook_ignores_subagent_completion_reports() {
    let subagent_input =
        r#"{"hook_event_name":"SubagentStop","agent_id":"agent-abc123","agent_type":"Explore"}"#;

    assert!(run_claude_hook("working", subagent_input).is_none());
    assert!(run_claude_hook("idle", subagent_input).is_none());
    assert!(run_claude_hook("release", subagent_input).is_none());
}

#[test]
fn claude_hook_keeps_parent_agent_type_only_blocked() {
    let request = run_claude_hook(
        "blocked",
        r#"{"hook_event_name":"PermissionRequest","agent_type":"Explore"}"#,
    );

    assert!(request.is_none());
}

#[test]
fn claude_hook_reports_session_id_from_stdin() {
    let request = run_claude_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","session_id":"claude-session"}"#,
    )
    .expect("session start should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent_session_id"], "claude-session");
    assert!(request["params"].get("state").is_none());
}

#[test]
fn claude_hook_ignores_cursor_compatibility_payloads() {
    assert!(run_claude_hook(
        "session",
        r#"{"hook_event_name":"sessionStart","session_id":"cursor-session"}"#,
    )
    .is_none());

    assert!(run_claude_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","session_id":"cursor-session","cursor_version":"2026.08.11-e8db854"}"#,
    )
    .is_none());

    for cursor_version in ["2026.08.11-e8db854", ""] {
        assert!(run_shell_hook_with_env(
            "src/integration/assets/claude/herdr-agent-state.sh",
            &["session"],
            r#"{"hook_event_name":"SessionStart","session_id":"cursor-session"}"#,
            &[("CURSOR_VERSION", cursor_version)],
        )
        .is_none());
    }
}

const CLAUDE_HOOK_ASSET: &str = "src/integration/assets/claude/herdr-agent-state.sh";
const CODEX_HOOK_ASSET: &str = "src/integration/assets/codex/herdr-agent-state.sh";
const MAX_REPLY_BYTES: usize = 64 * 1024;

fn stop_input(fields: serde_json::Value) -> String {
    let mut input = serde_json::json!({ "hook_event_name": "Stop" });
    input
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    input.to_string()
}

#[test]
fn claude_reply_hook_reports_last_assistant_message_on_stop() {
    let request = run_claude_hook(
        "reply",
        &stop_input(serde_json::json!({
            "session_id": "claude-session",
            "last_assistant_message": "Done. See **README.md**.",
        })),
    )
    .expect("stop should report the final reply");

    assert_eq!(request["method"], "pane.report_agent_reply");
    let params = &request["params"];
    assert_eq!(params["pane_id"], "p_test");
    assert_eq!(params["source"], "herdr:claude");
    assert_eq!(params["agent"], "claude");
    assert_eq!(params["agent_session_id"], "claude-session");
    assert_eq!(params["text"], "Done. See **README.md**.");
    assert!(params["seq"].as_u64().is_some_and(|seq| seq > 0));
    assert!(params.get("truncated").is_none());

    let without_session = run_claude_hook(
        "reply",
        &stop_input(serde_json::json!({ "last_assistant_message": "ok" })),
    )
    .expect("a reply without session id should still report");
    assert!(without_session["params"].get("agent_session_id").is_none());
    assert_eq!(without_session["params"]["text"], "ok");
}

#[test]
fn claude_reply_hook_sends_non_ascii_text_as_utf8() {
    let raw = run_shell_hook_raw_with_env(
        CLAUDE_HOOK_ASSET,
        &["reply"],
        &stop_input(serde_json::json!({
            "session_id": "claude-session",
            "last_assistant_message": "已完成：**修复**登录",
        })),
        &[],
    )
    .expect("stop should report the final reply");

    assert!(raw.contains("已完成：**修复**登录"), "raw request: {raw}");
    assert!(!raw.contains("\\u"), "raw request: {raw}");
}

#[test]
fn claude_reply_hook_truncates_long_messages_at_a_character_boundary() {
    let message = "界".repeat(30_000);
    let request = run_claude_hook(
        "reply",
        &stop_input(serde_json::json!({ "last_assistant_message": message })),
    )
    .expect("long replies should still report");

    let text = request["params"]["text"].as_str().unwrap();
    assert_eq!(text.len(), MAX_REPLY_BYTES / 3 * 3);
    assert!(message.starts_with(text));
    assert_eq!(request["params"]["truncated"], true);
}

#[test]
fn claude_reply_hook_ignores_subagent_cursor_and_grok_stops() {
    let message = serde_json::json!({ "last_assistant_message": "done" });
    let with = |fields: serde_json::Value| {
        let mut merged = message.clone();
        merged
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        stop_input(merged)
    };

    assert!(
        run_claude_hook("reply", &with(serde_json::json!({ "agent_id": "agent-1" }))).is_none()
    );
    assert!(run_claude_hook(
        "reply",
        &with(serde_json::json!({ "cursor_version": "2026.08.11-e8db854" }))
    )
    .is_none());
    assert!(run_shell_hook_with_env(
        CLAUDE_HOOK_ASSET,
        &["reply"],
        &with(serde_json::json!({})),
        &[("CURSOR_VERSION", "2026.08.11-e8db854")],
    )
    .is_none());
    assert!(run_shell_hook_with_env(
        CLAUDE_HOOK_ASSET,
        &["reply"],
        &with(serde_json::json!({})),
        &[("GROK_SESSION_ID", "grok-session")],
    )
    .is_none());
}

#[test]
fn claude_reply_hook_requires_a_stop_event_with_a_message() {
    for input in [
        stop_input(serde_json::json!({})),
        stop_input(serde_json::json!({ "last_assistant_message": "" })),
        stop_input(serde_json::json!({ "last_assistant_message": null })),
        stop_input(serde_json::json!({ "last_assistant_message": ["done"] })),
        serde_json::json!({
            "hook_event_name": "SubagentStop",
            "last_assistant_message": "done",
        })
        .to_string(),
        serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "last_assistant_message": "done",
        })
        .to_string(),
    ] {
        assert!(
            run_claude_hook("reply", &input).is_none(),
            "reply action should ignore {input}"
        );
    }

    assert!(run_claude_hook(
        "session",
        &stop_input(serde_json::json!({
            "session_id": "claude-session",
            "last_assistant_message": "done",
        })),
    )
    .is_none());
}

#[test]
fn codex_reply_hook_reports_last_assistant_message_on_stop() {
    let input = stop_input(serde_json::json!({
        "session_id": "codex-session",
        "turn_id": "turn-1",
        "last_assistant_message": "修好了 `cargo test`",
    }));
    let raw = run_shell_hook_raw_with_env(CODEX_HOOK_ASSET, &["reply"], &input, &[])
        .expect("codex stop should report the final reply");
    assert!(!raw.contains("\\u"), "raw request: {raw}");
    let request: serde_json::Value = serde_json::from_str(&raw).unwrap();

    assert_eq!(request["method"], "pane.report_agent_reply");
    let params = &request["params"];
    assert_eq!(params["pane_id"], "p_test");
    assert_eq!(params["source"], "herdr:codex");
    assert_eq!(params["agent"], "codex");
    assert_eq!(params["agent_session_id"], "codex-session");
    assert_eq!(params["text"], "修好了 `cargo test`");
    assert!(params["seq"].as_u64().is_some_and(|seq| seq > 0));
    assert!(params.get("truncated").is_none());

    let matching = run_shell_hook_with_env(
        CODEX_HOOK_ASSET,
        &["reply"],
        &input,
        &[("CODEX_THREAD_ID", "codex-session")],
    )
    .expect("the root thread should still report");
    assert_eq!(matching["params"]["agent_session_id"], "codex-session");

    let message = "界".repeat(30_000);
    let truncated = run_codex_hook(
        "reply",
        &stop_input(serde_json::json!({
            "session_id": "codex-session",
            "last_assistant_message": message,
        })),
    )
    .expect("long replies should still report");
    let text = truncated["params"]["text"].as_str().unwrap();
    assert_eq!(text.len(), MAX_REPLY_BYTES / 3 * 3);
    assert_eq!(truncated["params"]["truncated"], true);
}

#[test]
fn codex_reply_hook_ignores_nested_sessions_and_missing_messages() {
    assert!(run_shell_hook_with_env(
        CODEX_HOOK_ASSET,
        &["reply"],
        &stop_input(serde_json::json!({
            "session_id": "nested-session",
            "last_assistant_message": "done",
        })),
        &[("CODEX_THREAD_ID", "parent-session")],
    )
    .is_none());

    for input in [
        stop_input(serde_json::json!({
            "session_id": "codex-session",
            "last_assistant_message": null,
        })),
        stop_input(serde_json::json!({
            "session_id": "codex-session",
            "last_assistant_message": "",
        })),
        serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "codex-session",
            "transcript_path": "/tmp/codex-session.jsonl",
            "last_assistant_message": "done",
        })
        .to_string(),
    ] {
        assert!(
            run_codex_hook("reply", &input).is_none(),
            "reply action should ignore {input}"
        );
    }
}

#[test]
fn codex_hook_reports_persisted_root_session_and_ignores_ephemeral_or_nested_sessions() {
    let request = run_codex_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","session_id":"codex-session","transcript_path":"/tmp/codex-session.jsonl"}"#,
    )
    .expect("codex hook should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent_session_id"], "codex-session");
    assert!(request["params"].get("state").is_none());

    let matching_request = run_shell_hook_with_env(
        "src/integration/assets/codex/herdr-agent-state.sh",
        &["session"],
        r#"{"hook_event_name":"SessionStart","session_id":"codex-session","transcript_path":"/tmp/codex-session.jsonl"}"#,
        &[("CODEX_THREAD_ID", "codex-session")],
    )
    .expect("matching inherited session should still report");
    assert_eq!(
        matching_request["params"]["agent_session_id"],
        "codex-session"
    );

    assert!(run_codex_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","session_id":"side-session","transcript_path":null}"#,
    )
    .is_none());

    assert!(run_shell_hook_with_env(
        "src/integration/assets/codex/herdr-agent-state.sh",
        &["session"],
        r#"{"hook_event_name":"SessionStart","session_id":"nested-session","transcript_path":"/tmp/nested-session.jsonl"}"#,
        &[("CODEX_THREAD_ID", "parent-session")],
    )
    .is_none());
}

const ANTIGRAVITY_HOOK_ASSET: &str = "src/integration/assets/antigravity_cli/herdr-agent-state.sh";
const AGY_MAIN_CONVERSATION: &str = "176ae574-4a86-43ba-ab88-4ee9f74a2539";
const AGY_SUBAGENT_CONVERSATION: &str = "be0252c5-8c75-4f4a-900b-e15651ad60ad";

/// Runs the Antigravity CLI hook against a fake Herdr socket that answers
/// every connection, collecting each request line: the `reply` action reports
/// the conversation before the reply.
struct AntigravityHook {
    action: &'static str,
    input: String,
    envs: Vec<(&'static str, &'static str)>,
    address_space_limit_kib: Option<u64>,
}

/// What one Antigravity CLI hook run sent to Herdr.
struct AntigravityHookRun {
    raw_requests: Vec<String>,
}

impl AntigravityHook {
    fn new(action: &'static str, payload: serde_json::Value) -> Self {
        Self::raw(action, payload.to_string())
    }

    fn raw(action: &'static str, input: impl Into<String>) -> Self {
        Self {
            action,
            input: input.into(),
            envs: Vec::new(),
            address_space_limit_kib: None,
        }
    }

    fn env(mut self, key: &'static str, value: &'static str) -> Self {
        self.envs.push((key, value));
        self
    }

    /// Runs the hook under `ulimit -v`, so reading a large transcript whole
    /// runs out of memory instead of succeeding slowly.
    fn address_space_limit_kib(mut self, kib: u64) -> Self {
        self.address_space_limit_kib = Some(kib);
        self
    }

    fn run(self) -> AntigravityHookRun {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let base = unique_test_dir();
        fs::create_dir_all(&base).unwrap();
        let socket_path = base.join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let hook_exited = Arc::new(AtomicBool::new(false));

        let server = thread::spawn({
            let hook_exited = Arc::clone(&hook_exited);
            move || {
                let mut requests = Vec::new();
                loop {
                    // Read the flag before accepting, so a connection made just
                    // before the hook exited is still collected.
                    let exited = hook_exited.load(Ordering::Acquire);
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            let mut line = String::new();
                            BufReader::new(stream.try_clone().unwrap())
                                .read_line(&mut line)
                                .unwrap();
                            let _ = (&stream)
                                .write_all(b"{\"id\":\"test\",\"result\":{\"type\":\"ok\"}}\n");
                            requests.push(line);
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            if exited {
                                return requests;
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(err) => panic!("accept failed: {err}"),
                    }
                }
            }
        });

        let hook_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(ANTIGRAVITY_HOOK_ASSET);
        let mut command = Command::new("bash");
        if let Some(kib) = self.address_space_limit_kib {
            command
                .arg("-c")
                .arg(format!("ulimit -v {kib} && exec bash \"$0\" \"$1\""));
        }
        command
            .arg(hook_path)
            .arg(self.action)
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", &socket_path)
            .env("HERDR_PANE_ID", "p_test")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.envs {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap();
        // A hook that ignores its input may exit before reading it.
        let _ = child.stdin.take().unwrap().write_all(self.input.as_bytes());
        let output = child.wait_with_output().unwrap();
        hook_exited.store(true, Ordering::Release);
        let raw_requests = server.join().unwrap();
        cleanup_test_base(&base);

        assert!(
            output.status.success(),
            "hook failed: status={:?} stderr={} stdout={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        // Antigravity CLI rejects hook output that is not a JSON object.
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "{}\n");
        AntigravityHookRun { raw_requests }
    }
}

impl AntigravityHookRun {
    fn requests(&self) -> Vec<serde_json::Value> {
        self.raw_requests
            .iter()
            .map(|raw| serde_json::from_str(raw).unwrap_or_else(|err| panic!("{err}: {raw:?}")))
            .collect()
    }

    fn methods(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|request| request["method"].as_str().unwrap().to_string())
            .collect()
    }

    /// The params of the only request sent with `method`.
    fn params(&self, method: &str) -> serde_json::Value {
        let mut matching = self
            .requests()
            .into_iter()
            .filter(|request| request["method"] == method)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "requests: {:?}", self.raw_requests);
        let mut request = matching.remove(0);
        request["params"].take()
    }
}

/// Antigravity CLI conversation transcripts laid out like
/// `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
struct AgyBrain {
    base: PathBuf,
}

impl AgyBrain {
    fn new() -> Self {
        let base = unique_test_dir();
        fs::create_dir_all(&base).unwrap();
        Self { base }
    }

    fn transcript_path(&self, conversation_id: &str) -> PathBuf {
        self.base
            .join("brain")
            .join(conversation_id)
            .join(".system_generated/logs/transcript_full.jsonl")
    }

    /// Writes one compact JSON record per line, as Antigravity CLI 1.2.14 does.
    fn write(&self, conversation_id: &str, records: &[serde_json::Value]) -> PathBuf {
        let lines = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>();
        self.write_raw(conversation_id, lines.as_bytes())
    }

    fn write_raw(&self, conversation_id: &str, contents: &[u8]) -> PathBuf {
        let path = self.transcript_path(conversation_id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for AgyBrain {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn agy_record(step: u64, source: &str, kind: &str, fields: serde_json::Value) -> serde_json::Value {
    let mut record = serde_json::json!({
        "step_index": step,
        "source": source,
        "type": kind,
        "status": "DONE",
        "created_at": "2026-10-01T13:56:39Z",
    });
    record
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    record
}

fn agy_user_input(step: u64, request: &str) -> serde_json::Value {
    agy_record(
        step,
        "USER_EXPLICIT",
        "USER_INPUT",
        serde_json::json!({ "content": format!("<USER_REQUEST>\n{request}\n</USER_REQUEST>") }),
    )
}

fn agy_system_message(step: u64, content: &str) -> serde_json::Value {
    agy_record(
        step,
        "SYSTEM",
        "SYSTEM_MESSAGE",
        serde_json::json!({ "content": content }),
    )
}

fn agy_tool_call(step: u64) -> serde_json::Value {
    agy_record(
        step,
        "MODEL",
        "PLANNER_RESPONSE",
        serde_json::json!({
            "tool_calls": [{
                "name": "run_command",
                "args": { "CommandLine": "date", "toolSummary": "Run date" },
            }],
        }),
    )
}

fn agy_tool_result(step: u64) -> serde_json::Value {
    agy_record(
        step,
        "MODEL",
        "GENERIC",
        serde_json::json!({ "content": "Command completed." }),
    )
}

fn agy_final_reply(step: u64, text: &str) -> serde_json::Value {
    agy_record(
        step,
        "MODEL",
        "PLANNER_RESPONSE",
        serde_json::json!({ "thinking": "The command ran.", "content": text }),
    )
}

/// A main conversation whose turn ends with `last`.
fn agy_main_transcript(last: serde_json::Value) -> Vec<serde_json::Value> {
    vec![
        agy_user_input(0, "在终端运行 date 命令"),
        agy_tool_call(1),
        agy_tool_result(2),
        agy_system_message(
            3,
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
        ),
        last,
    ]
}

/// A subagent conversation: it starts with its parent's message, not user input.
fn agy_subagent_transcript() -> Vec<serde_json::Value> {
    vec![
        agy_system_message(
            0,
            &format!(
                "The following is a <SYSTEM_MESSAGE> not actually sent by the user. [Message] sender={AGY_MAIN_CONVERSATION} content=Reply OK"
            ),
        ),
        agy_final_reply(1, "OK"),
    ]
}

fn agy_pre_invocation(conversation_id: &str, transcript_path: &Path) -> serde_json::Value {
    serde_json::json!({
        "conversationId": conversation_id,
        "transcriptPath": transcript_path,
        "artifactDirectoryPath": transcript_path.parent().unwrap(),
        "modelName": "auto",
        "workspacePaths": ["/tmp/project"],
        "invocationNum": 1,
        "initialNumSteps": 1,
    })
}

fn agy_stop(
    conversation_id: &str,
    transcript_path: &Path,
    termination_reason: &str,
) -> serde_json::Value {
    serde_json::json!({
        "conversationId": conversation_id,
        "transcriptPath": transcript_path,
        "artifactDirectoryPath": transcript_path.parent().unwrap(),
        "modelName": "auto",
        "workspacePaths": ["/tmp/project"],
        "error": "",
        "executionNum": 0,
        "fullyIdle": true,
        "terminationReason": termination_reason,
    })
}

#[test]
fn antigravity_session_hook_reports_the_main_conversation() {
    let brain = AgyBrain::new();
    let transcript = brain.write(AGY_MAIN_CONVERSATION, &[agy_user_input(0, "只回复：收到")]);

    let run = AntigravityHook::new(
        "session",
        agy_pre_invocation(AGY_MAIN_CONVERSATION, &transcript),
    )
    .run();

    assert_eq!(run.methods(), ["pane.report_agent_session"]);
    let params = run.params("pane.report_agent_session");
    assert_eq!(params["pane_id"], "p_test");
    assert_eq!(params["source"], "herdr:antigravity_cli");
    assert_eq!(params["agent"], "agy");
    assert_eq!(params["agent_session_id"], AGY_MAIN_CONVERSATION);
    assert_eq!(params["agent_session_path"], transcript.to_str().unwrap());
    assert!(params["seq"].as_u64().is_some_and(|seq| seq > 0));
}

#[test]
fn antigravity_session_hook_ignores_subagent_conversations() {
    let brain = AgyBrain::new();
    let subagent = brain.write(AGY_SUBAGENT_CONVERSATION, &agy_subagent_transcript());
    let empty = brain.write_raw("empty-conversation", b"");
    let malformed = brain.write_raw("malformed-conversation", b"{\"step_index\":0,\n");
    // A subagent's first PreInvocation runs before its transcript exists.
    let missing = brain.transcript_path("missing-conversation");

    for (case, payload) in [
        (
            "subagent transcript",
            agy_pre_invocation(AGY_SUBAGENT_CONVERSATION, &subagent),
        ),
        (
            "missing transcript",
            agy_pre_invocation("missing-conversation", &missing),
        ),
        (
            "empty transcript",
            agy_pre_invocation("empty-conversation", &empty),
        ),
        (
            "malformed transcript",
            agy_pre_invocation("malformed-conversation", &malformed),
        ),
        (
            "no transcript path",
            serde_json::json!({ "conversationId": AGY_MAIN_CONVERSATION }),
        ),
    ] {
        let run = AntigravityHook::new("session", payload).run();
        assert!(
            run.raw_requests.is_empty(),
            "{case}: reported {:?}",
            run.raw_requests
        );
    }
}

#[test]
fn antigravity_reply_hook_reports_the_conversation_then_the_final_reply() {
    let brain = AgyBrain::new();
    let reply = "已完成：\n- **苹果**\n- `香蕉`";
    let transcript = brain.write(
        AGY_MAIN_CONVERSATION,
        &agy_main_transcript(agy_final_reply(4, reply)),
    );

    let run = AntigravityHook::new(
        "reply",
        agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL"),
    )
    .run();

    // The conversation reaches Herdr no later than the end of its first turn,
    // and before the reply that must match it.
    assert_eq!(
        run.methods(),
        ["pane.report_agent_session", "pane.report_agent_reply"]
    );
    let session = run.params("pane.report_agent_session");
    assert_eq!(session["agent_session_id"], AGY_MAIN_CONVERSATION);
    assert_eq!(session["agent_session_path"], transcript.to_str().unwrap());

    let params = run.params("pane.report_agent_reply");
    assert_eq!(params["pane_id"], "p_test");
    assert_eq!(params["source"], "herdr:antigravity_cli");
    assert_eq!(params["agent"], "agy");
    assert_eq!(params["agent_session_id"], AGY_MAIN_CONVERSATION);
    assert_eq!(params["text"], reply);
    assert!(params.get("truncated").is_none());
    assert!(
        params["seq"].as_u64().unwrap() > session["seq"].as_u64().unwrap(),
        "the reply must be newer than the session report from the same source"
    );
    let raw_reply = &run.raw_requests[1];
    assert!(raw_reply.contains("已完成"), "raw request: {raw_reply}");
    assert!(!raw_reply.contains("\\u"), "raw request: {raw_reply}");
}

#[test]
fn antigravity_reply_hook_prefers_a_non_empty_final_model_output() {
    let brain = AgyBrain::new();
    let transcript = brain.write(
        AGY_MAIN_CONVERSATION,
        &agy_main_transcript(agy_final_reply(4, "from the transcript")),
    );
    let stop_with_output = |output: &str| {
        let mut payload = agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL");
        payload["finalModelOutput"] = serde_json::json!(output);
        payload
    };

    let from_payload = AntigravityHook::new("reply", stop_with_output("from the payload")).run();
    assert_eq!(
        from_payload.params("pane.report_agent_reply")["text"],
        "from the payload"
    );

    let empty_output = AntigravityHook::new("reply", stop_with_output("")).run();
    assert_eq!(
        empty_output.params("pane.report_agent_reply")["text"],
        "from the transcript"
    );
}

#[test]
fn antigravity_reply_hook_truncates_long_replies_at_a_character_boundary() {
    let brain = AgyBrain::new();
    // Longer than one 64 KiB read from the end of the transcript.
    let reply = "界".repeat(30_000);
    let transcript = brain.write(
        AGY_MAIN_CONVERSATION,
        &agy_main_transcript(agy_final_reply(4, &reply)),
    );

    let run = AntigravityHook::new(
        "reply",
        agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL"),
    )
    .run();

    let params = run.params("pane.report_agent_reply");
    let text = params["text"].as_str().unwrap();
    assert_eq!(text.len(), MAX_REPLY_BYTES / 3 * 3);
    assert!(reply.starts_with(text));
    assert_eq!(params["truncated"], true);
}

#[test]
fn antigravity_reply_hook_reads_only_the_ends_of_a_large_transcript() {
    use std::io::Seek;

    let brain = AgyBrain::new();
    let transcript = brain.write(AGY_MAIN_CONVERSATION, &[agy_user_input(0, "总结这个仓库")]);
    // A 512 MiB sparse gap stands in for a long conversation; reading it whole
    // exceeds the hook's address space limit below.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(&transcript)
        .unwrap();
    let end = file.seek(std::io::SeekFrom::End(0)).unwrap();
    file.set_len(end + 512 * 1024 * 1024).unwrap();
    file.seek(std::io::SeekFrom::End(0)).unwrap();
    writeln!(file).unwrap();
    writeln!(file, "{}", agy_final_reply(9, "总结完成")).unwrap();
    drop(file);

    let run = AntigravityHook::new(
        "reply",
        agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL"),
    )
    .address_space_limit_kib(256 * 1024)
    .run();

    assert_eq!(
        run.methods(),
        ["pane.report_agent_session", "pane.report_agent_reply"]
    );
    assert_eq!(run.params("pane.report_agent_reply")["text"], "总结完成");
}

#[test]
fn antigravity_reply_hook_ignores_subagent_stops() {
    let brain = AgyBrain::new();
    let subagent = brain.write(AGY_SUBAGENT_CONVERSATION, &agy_subagent_transcript());
    let missing = brain.transcript_path("missing-conversation");

    for (case, payload) in [
        (
            "subagent transcript",
            agy_stop(AGY_SUBAGENT_CONVERSATION, &subagent, "NO_TOOL_CALL"),
        ),
        (
            "missing transcript",
            agy_stop("missing-conversation", &missing, "NO_TOOL_CALL"),
        ),
        (
            "no transcript path",
            serde_json::json!({
                "conversationId": AGY_MAIN_CONVERSATION,
                "terminationReason": "NO_TOOL_CALL",
                "finalModelOutput": "done",
            }),
        ),
    ] {
        let run = AntigravityHook::new("reply", payload).run();
        assert!(
            run.raw_requests.is_empty(),
            "{case}: reported {:?}",
            run.raw_requests
        );
    }
}

#[test]
fn antigravity_reply_hook_reports_no_reply_for_turns_that_did_not_end_normally() {
    let brain = AgyBrain::new();
    let transcript = brain.write(
        AGY_MAIN_CONVERSATION,
        &agy_main_transcript(agy_final_reply(4, "partial answer")),
    );

    let mut errored = agy_stop(AGY_MAIN_CONVERSATION, &transcript, "ERROR");
    errored["error"] = serde_json::json!("model unavailable");
    let mut without_reason = agy_stop(AGY_MAIN_CONVERSATION, &transcript, "");
    without_reason
        .as_object_mut()
        .unwrap()
        .remove("terminationReason");

    for (case, payload) in [
        ("error", errored),
        (
            "max invocations",
            agy_stop(AGY_MAIN_CONVERSATION, &transcript, "MAX_INVOCATIONS"),
        ),
        ("no termination reason", without_reason),
    ] {
        let run = AntigravityHook::new("reply", payload).run();
        // The conversation is still the pane's; only the reply is withheld.
        assert_eq!(
            run.methods(),
            ["pane.report_agent_session"],
            "{case}: requests {:?}",
            run.raw_requests
        );
    }
}

#[test]
fn antigravity_reply_hook_requires_a_final_model_reply_as_the_last_record() {
    let brain = AgyBrain::new();
    let mut with_tool_calls = agy_final_reply(4, "Let me check.");
    with_tool_calls["tool_calls"] = agy_tool_call(4)["tool_calls"].clone();

    for (case, last) in [
        ("tool call", agy_tool_call(4)),
        ("reply with tool calls", with_tool_calls),
        ("empty reply", agy_final_reply(4, "")),
        ("tool result", agy_tool_result(4)),
        ("user input", agy_user_input(4, "继续")),
        (
            "system message",
            agy_system_message(4, "The following is a <SYSTEM_MESSAGE>."),
        ),
        (
            "checkpoint",
            agy_record(
                4,
                "SYSTEM",
                "CHECKPOINT",
                serde_json::json!({ "content": "{{ CHECKPOINT 1 }}" }),
            ),
        ),
        (
            "user-sourced planner response",
            agy_record(
                4,
                "USER_EXPLICIT",
                "PLANNER_RESPONSE",
                serde_json::json!({ "content": "done" }),
            ),
        ),
    ] {
        let transcript = brain.write(AGY_MAIN_CONVERSATION, &agy_main_transcript(last));
        let run = AntigravityHook::new(
            "reply",
            agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL"),
        )
        .run();
        assert_eq!(
            run.methods(),
            ["pane.report_agent_session"],
            "{case}: requests {:?}",
            run.raw_requests
        );
    }

    // A record still being written is not a reply.
    let mut partial = agy_main_transcript(agy_tool_result(4))
        .iter()
        .map(|record| format!("{record}\n"))
        .collect::<String>();
    partial.push_str(
        "{\"step_index\":5,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"content\":\"hal",
    );
    let transcript = brain.write_raw(AGY_MAIN_CONVERSATION, partial.as_bytes());
    let run = AntigravityHook::new(
        "reply",
        agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL"),
    )
    .run();
    assert_eq!(run.methods(), ["pane.report_agent_session"]);
}

#[test]
fn antigravity_hook_prints_an_empty_object_without_reporting_outside_its_actions() {
    let brain = AgyBrain::new();
    let transcript = brain.write(
        AGY_MAIN_CONVERSATION,
        &agy_main_transcript(agy_final_reply(4, "done")),
    );
    let stop = agy_stop(AGY_MAIN_CONVERSATION, &transcript, "NO_TOOL_CALL");

    for (case, hook) in [
        (
            "outside herdr",
            AntigravityHook::new("reply", stop.clone()).env("HERDR_ENV", "0"),
        ),
        (
            "without a pane",
            AntigravityHook::new("reply", stop.clone()).env("HERDR_PANE_ID", ""),
        ),
        ("unknown action", AntigravityHook::new("idle", stop.clone())),
        ("invalid json", AntigravityHook::raw("reply", "not json")),
        ("non-object json", AntigravityHook::raw("reply", "[]")),
        (
            "no conversation",
            AntigravityHook::new("reply", {
                let mut payload = stop.clone();
                payload.as_object_mut().unwrap().remove("conversationId");
                payload
            }),
        ),
    ] {
        let run = hook.run();
        assert!(
            run.raw_requests.is_empty(),
            "{case}: reported {:?}",
            run.raw_requests
        );
    }
}

#[test]
fn copilot_hook_reports_session_id_from_stdin() {
    let request = run_copilot_hook(
        r#"{"hook_event_name":"SessionStart","session_id":"copilot-session","source":"resume"}"#,
    )
    .expect("copilot session start should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent"], "copilot");
    assert_eq!(request["params"]["agent_session_id"], "copilot-session");
    assert!(request["params"].get("state").is_none());

    let camel = run_copilot_hook(
        r#"{"sessionId":"copilot-camel-session","source":"new","initialPrompt":"run tests"}"#,
    )
    .expect("copilot camelCase session start should report session identity");

    assert_eq!(camel["method"], "pane.report_agent_session");
    assert_eq!(camel["params"]["agent_session_id"], "copilot-camel-session");
    assert!(camel["params"].get("state").is_none());
}

#[test]
fn grok_hook_reports_new_session_source() {
    let request = run_grok_hook(
        r#"{"hook_event_name":"session_start","source":"new","session_id":"new-session"}"#,
        &[("GROK_SESSION_ID", "new-session")],
    )
    .expect("grok session start should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent_session_id"], "new-session");
    assert_eq!(request["params"]["session_start_source"], "new");
}

#[test]
fn copilot_hook_does_not_report_lifecycle_state() {
    for payload in [
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"copilot-session","prompt":"run tests"}"#,
        r#"{"hook_event_name":"PreToolUse","session_id":"copilot-session","tool_name":"ask_user"}"#,
        r#"{"hook_event_name":"notification","session_id":"copilot-session","notification_type":"permission_prompt"}"#,
        r#"{"hook_event_name":"agentStop","session_id":"copilot-session","stop_reason":"end_turn"}"#,
        r#"{"hook_event_name":"SessionEnd","session_id":"copilot-session","reason":"user_exit"}"#,
    ] {
        assert!(
            run_copilot_hook(payload).is_none(),
            "copilot session-only hook should ignore lifecycle payload {payload}"
        );
    }
}

#[test]
fn devin_hook_ignores_prompt_session_list_fallback() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"UserPromptSubmit","prompt":"run tests"}"#,
        &[
            ("DEVIN_PROJECT_DIR", "/tmp/project"),
            (
                "HERDR_DEVIN_LIST_JSON",
                r#"[{"id":"older-session","working_directory":"/tmp/other"},{"id":"devin-session","working_directory":"/tmp/project"}]"#,
            ),
        ],
    );

    assert!(request.is_none());
}

#[test]
fn devin_hook_reports_session_id_from_stdin_without_state() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","session_id":"devin-session","source":"startup"}"#,
        &[("HERDR_DEVIN_LIST_JSON", r#"[{"id":"older-session"}]"#)],
    )
    .expect("devin session start should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent"], "devin");
    assert_eq!(request["params"]["agent_session_id"], "devin-session");
    assert!(request["params"].get("state").is_none());
}

#[test]
fn devin_hook_prefers_hook_session_id_over_list() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"PreToolUse","sessionId":"fresh-session","tool_name":"exec"}"#,
        &[
            ("DEVIN_PROJECT_DIR", "/tmp/project"),
            (
                "HERDR_DEVIN_LIST_JSON",
                r#"[{"id":"older-session","working_directory":"/tmp/project"}]"#,
            ),
        ],
    )
    .expect("devin tool hook should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent_session_id"], "fresh-session");
    assert!(request["params"].get("state").is_none());
}

#[test]
fn devin_hook_reports_tool_session_from_list_without_state() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"PreToolUse","tool_name":"exec"}"#,
        &[
            ("DEVIN_PROJECT_DIR", "/tmp/project"),
            (
                "HERDR_DEVIN_LIST_JSON",
                r#"[{"id":"older-session","working_directory":"/tmp/other"},{"id":"devin-session","working_directory":"/tmp/project"}]"#,
            ),
        ],
    )
    .expect("devin tool hook should report session identity");

    assert_eq!(request["method"], "pane.report_agent_session");
    assert_eq!(request["params"]["agent"], "devin");
    assert_eq!(request["params"]["agent_session_id"], "devin-session");
    assert!(request["params"].get("state").is_none());
}

#[test]
fn devin_hook_ignores_startup_session_list_fallback() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"SessionStart","source":"startup"}"#,
        &[
            ("DEVIN_PROJECT_DIR", "/tmp/project"),
            (
                "HERDR_DEVIN_LIST_JSON",
                r#"[{"id":"stale-session","working_directory":"/tmp/project"}]"#,
            ),
        ],
    );

    assert!(request.is_none());
}

#[test]
fn devin_hook_ignores_non_matching_session_list_entries() {
    let request = run_devin_hook(
        "session",
        r#"{"hook_event_name":"PreToolUse","tool_name":"exec"}"#,
        &[
            ("DEVIN_PROJECT_DIR", "/tmp/project"),
            (
                "HERDR_DEVIN_LIST_JSON",
                r#"[{"id":"other-session","working_directory":"/tmp/other"}]"#,
            ),
        ],
    );

    assert!(request.is_none());
}

const MAX_PREVIEW_BYTES: usize = 8 * 1024;

/// Runs the `permission` action as an agent in a pane that takes remote answers
/// would, against a fake Herdr socket.
struct PermissionHook {
    asset_path: &'static str,
    input: String,
    envs: Vec<(&'static str, &'static str)>,
    removed_envs: Vec<&'static str>,
    response: Option<String>,
    answer_after: Duration,
}

/// What the `permission` action did.
struct PermissionHookRun {
    /// The request line the hook sent, or `None` when it never connected.
    raw_request: Option<String>,
    stdout: String,
    /// The hook half-closed its socket or wrote more before it was answered.
    left_before_answer: bool,
}

impl PermissionHook {
    fn claude(input: String) -> Self {
        Self::new(CLAUDE_HOOK_ASSET, input)
    }

    fn codex(input: String) -> Self {
        Self::new(CODEX_HOOK_ASSET, input)
    }

    fn new(asset_path: &'static str, input: String) -> Self {
        Self {
            asset_path,
            input,
            envs: Vec::new(),
            removed_envs: Vec::new(),
            response: None,
            answer_after: Duration::from_millis(300),
        }
    }

    fn env(mut self, key: &'static str, value: &'static str) -> Self {
        self.envs.push((key, value));
        self
    }

    fn without_env(mut self, key: &'static str) -> Self {
        self.removed_envs.push(key);
        self
    }

    /// The fake server answers with this line; without it, the server closes
    /// the connection without a response.
    fn answer(mut self, response: impl Into<String>) -> Self {
        self.response = Some(response.into());
        self
    }

    fn answer_after(mut self, delay: Duration) -> Self {
        self.answer_after = delay;
        self
    }

    fn run(self) -> PermissionHookRun {
        use std::io::Read;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let base = unique_test_dir();
        fs::create_dir_all(&base).unwrap();
        let socket_path = base.join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let hook_exited = Arc::new(AtomicBool::new(false));
        let response = self.response;
        let answer_after = self.answer_after;

        let server = thread::spawn({
            let hook_exited = Arc::clone(&hook_exited);
            move || loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        // Anything after the request line, EOF included, means the hook left.
                        let mut left = !reader.buffer().is_empty();
                        stream.set_read_timeout(Some(answer_after)).unwrap();
                        let mut probe = [0_u8; 1];
                        match (&stream).read(&mut probe) {
                            Ok(_) => left = true,
                            Err(err)
                                if matches!(
                                    err.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) => {}
                            Err(err) => panic!("probe failed: {err}"),
                        }
                        if let Some(response) = &response {
                            let _ = (&stream).write_all(format!("{response}\n").as_bytes());
                        }
                        return Some((line, left));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        if hook_exited.load(Ordering::Acquire) {
                            return None;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(err) => panic!("accept failed: {err}"),
                }
            }
        });

        let hook_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(self.asset_path);
        let mut command = Command::new("bash");
        command
            .arg(hook_path)
            .arg("permission")
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", &socket_path)
            .env("HERDR_PANE_ID", "p_test")
            .env("HERDR_REMOTE_ANSWERS", "1")
            .env_remove("CODEX_THREAD_ID")
            .env_remove("CURSOR_VERSION")
            .env_remove("GROK_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.envs {
            command.env(key, value);
        }
        for key in &self.removed_envs {
            command.env_remove(key);
        }
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(self.input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        hook_exited.store(true, Ordering::Release);
        let served = server.join().unwrap();
        cleanup_test_base(&base);

        assert!(
            output.status.success(),
            "hook failed: status={:?} stderr={} stdout={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            output.stderr.is_empty(),
            "hook stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (raw_request, left_before_answer) = match served {
            Some((line, left)) => (Some(line), left),
            None => (None, false),
        };
        PermissionHookRun {
            raw_request,
            stdout: String::from_utf8(output.stdout).unwrap(),
            left_before_answer,
        }
    }
}

impl PermissionHookRun {
    fn request(&self) -> serde_json::Value {
        let raw = self
            .raw_request
            .as_deref()
            .expect("the hook should report the request");
        serde_json::from_str(raw).unwrap_or_else(|err| panic!("{err}: {raw:?}"))
    }

    fn output(&self) -> Option<serde_json::Value> {
        let stdout = self.stdout.trim();
        (!stdout.is_empty())
            .then(|| serde_json::from_str(stdout).unwrap_or_else(|err| panic!("{err}: {stdout:?}")))
    }

    /// The hook reported its request, waited for the answer, and printed nothing.
    fn assert_reported_without_output(&self, case: &str) {
        assert!(self.raw_request.is_some(), "{case}: hook never reported");
        assert!(
            !self.left_before_answer,
            "{case}: hook left before the answer"
        );
        assert_eq!(self.stdout, "", "{case}: hook printed a decision");
    }

    /// The hook exited without touching the socket or printing anything.
    fn assert_ignored(&self, case: &str) {
        assert_eq!(self.raw_request, None, "{case}: hook reported a request");
        assert_eq!(self.stdout, "", "{case}: hook printed a decision");
    }
}

fn permission_request_input(fields: serde_json::Value) -> String {
    let mut input = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "cwd": "/tmp/project",
        "permission_mode": "default",
    });
    input
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    input.to_string()
}

fn answered(answer: serde_json::Value) -> String {
    let mut result = serde_json::json!({ "type": "agent_request_answered", "request_id": 7 });
    result
        .as_object_mut()
        .unwrap()
        .extend(answer.as_object().unwrap().clone());
    serde_json::json!({ "id": "hook", "result": result }).to_string()
}

fn ended(reason: &str) -> String {
    serde_json::json!({
        "id": "hook",
        "result": { "type": "agent_request_ended", "request_id": 7, "reason": reason },
    })
    .to_string()
}

fn permission_output(decision: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        },
    })
}

/// Responses after which the hook leaves the decision to the terminal.
fn responses_without_a_decision() -> Vec<(&'static str, Option<String>)> {
    vec![
        ("closed", Some(ended("closed"))),
        ("timeout", Some(ended("timeout"))),
        (
            "ignored",
            Some(
                serde_json::json!({
                    "id": "hook",
                    "result": { "type": "agent_request_ended", "reason": "ignored" },
                })
                .to_string(),
            ),
        ),
        (
            "error",
            Some(
                serde_json::json!({
                    "id": "hook",
                    "error": { "code": "invalid_agent_request", "message": "bad request" },
                })
                .to_string(),
            ),
        ),
        (
            "unknown decision",
            Some(answered(serde_json::json!({ "decision": "maybe" }))),
        ),
        (
            "unexpected result",
            Some(r#"{"id":"hook","result":{"type":"ok"}}"#.to_string()),
        ),
        ("garbage", Some("not json".to_string())),
        ("connection closed", None),
    ]
}

fn claude_bash_suggestions() -> serde_json::Value {
    serde_json::json!([{
        "type": "addRules",
        "rules": [{ "toolName": "Bash", "ruleContent": "cargo test:*" }],
        "behavior": "allow",
        "destination": "localSettings",
    }])
}

fn claude_bash_request() -> String {
    permission_request_input(serde_json::json!({
        "session_id": "claude-session",
        "tool_name": "Bash",
        "tool_input": { "command": "cargo test -p 构建", "description": "运行测试" },
        "permission_suggestions": claude_bash_suggestions(),
    }))
}

#[test]
fn claude_permission_hook_reports_the_request_and_prints_the_allow_decision() {
    let run = PermissionHook::claude(claude_bash_request())
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .run();

    assert!(
        !run.left_before_answer,
        "the hook must wait on an open socket"
    );
    let raw = run.raw_request.as_deref().unwrap();
    assert!(raw.contains("cargo test -p 构建"), "raw request: {raw}");
    assert!(raw.contains("运行测试"), "raw request: {raw}");
    assert!(!raw.contains("\\u"), "raw request: {raw}");
    let request = run.request();
    assert_eq!(request["method"], "pane.report_agent_request");
    assert!(request["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(
        request["params"],
        serde_json::json!({
            "pane_id": "p_test",
            "source": "herdr:claude",
            "agent": "claude",
            "agent_session_id": "claude-session",
            "kind": "permission",
            "tool_name": "Bash",
            "description": "运行测试",
            "input_preview": "cargo test -p 构建",
            "decisions": ["allow", "allow_always", "deny"],
            "timeout_ms": 86_400_000_u64,
        })
    );
    assert_eq!(
        run.output(),
        Some(permission_output(
            serde_json::json!({ "behavior": "allow" })
        ))
    );
}

#[test]
fn claude_permission_hook_maps_allow_always_and_deny_answers() {
    let always = PermissionHook::claude(claude_bash_request())
        .answer(answered(serde_json::json!({ "decision": "allow_always" })))
        .run();
    assert_eq!(
        always.output(),
        Some(permission_output(serde_json::json!({
            "behavior": "allow",
            "updatedPermissions": claude_bash_suggestions(),
        })))
    );

    let denied = PermissionHook::claude(claude_bash_request())
        .answer(answered(serde_json::json!({
            "decision": "deny",
            "message": "用户在飞书中拒绝了这次操作",
        })))
        .run();
    assert!(
        denied.stdout.contains("用户在飞书中拒绝了这次操作"),
        "stdout: {}",
        denied.stdout
    );
    assert_eq!(
        denied.output(),
        Some(permission_output(serde_json::json!({
            "behavior": "deny",
            "message": "用户在飞书中拒绝了这次操作",
            "interrupt": true,
        })))
    );

    let denied_without_message = PermissionHook::claude(claude_bash_request())
        .answer(answered(serde_json::json!({ "decision": "deny" })))
        .run()
        .output()
        .expect("deny should print a decision");
    let decision = &denied_without_message["hookSpecificOutput"]["decision"];
    assert_eq!(decision["behavior"], "deny");
    assert_eq!(decision["interrupt"], true);
    assert!(decision["message"]
        .as_str()
        .is_some_and(|message| !message.is_empty()));
}

#[test]
fn claude_permission_hook_previews_tool_input_json_and_offers_allow_always_only_with_suggestions() {
    let tool_input = r#"{"file_path":"/tmp/说明.md","content":"你好"}"#;
    for suggestions in ["", r#","permission_suggestions":[]"#] {
        let input = format!(
            r#"{{"hook_event_name":"PermissionRequest","session_id":"claude-session","tool_name":"Write","tool_input":{tool_input}{suggestions}}}"#
        );
        let run = PermissionHook::claude(input)
            .answer(answered(serde_json::json!({ "decision": "allow" })))
            .run();

        let params = &run.request()["params"];
        assert_eq!(params["kind"], "permission");
        assert_eq!(params["tool_name"], "Write");
        assert_eq!(params["decisions"], serde_json::json!(["allow", "deny"]));
        assert_eq!(
            params["input_preview"],
            "{\n  \"file_path\": \"/tmp/说明.md\",\n  \"content\": \"你好\"\n}"
        );
        assert!(params.get("description").is_none(), "{params}");
        assert_eq!(
            run.output(),
            Some(permission_output(
                serde_json::json!({ "behavior": "allow" })
            ))
        );
    }
}

#[test]
fn claude_permission_hook_reports_ask_user_question_and_returns_the_answers() {
    let tool_input = serde_json::json!({
        "questions": [
            {
                "question": "用哪个数据库?",
                "header": "数据库",
                "options": [
                    { "label": "Postgres", "description": "关系型" },
                    { "label": "SQLite" },
                ],
                "multiSelect": false,
            },
            {
                "question": "Which features?",
                "header": "Features",
                "options": [{ "label": "Auth" }, { "label": "Search" }],
                "multiSelect": true,
            },
        ],
    });
    let input = permission_request_input(serde_json::json!({
        "session_id": "claude-session",
        "tool_name": "AskUserQuestion",
        "tool_input": tool_input,
    }));
    let run = PermissionHook::claude(input)
        .answer(answered(serde_json::json!({
            "answers": {
                "用哪个数据库?": ["SQLite"],
                "Which features?": ["Auth", "其他: 全文检索"],
            },
        })))
        .run();

    assert!(!run.left_before_answer);
    let params = run.request()["params"].clone();
    assert_eq!(params["kind"], "question");
    assert_eq!(params["tool_name"], "AskUserQuestion");
    assert_eq!(params["timeout_ms"], 86_400_000_u64);
    assert!(params.get("decisions").is_none(), "{params}");
    assert!(params.get("description").is_none(), "{params}");
    assert!(params["input_preview"]
        .as_str()
        .is_some_and(|preview| preview.contains("用哪个数据库?")));
    assert_eq!(
        params["questions"],
        serde_json::json!([
            {
                "question": "用哪个数据库?",
                "header": "数据库",
                "options": [
                    { "label": "Postgres", "description": "关系型" },
                    { "label": "SQLite" },
                ],
                "multi_select": false,
            },
            {
                "question": "Which features?",
                "header": "Features",
                "options": [{ "label": "Auth" }, { "label": "Search" }],
                "multi_select": true,
            },
        ])
    );
    assert!(
        run.stdout.contains("其他: 全文检索"),
        "stdout: {}",
        run.stdout
    );
    let mut updated_input = tool_input.clone();
    updated_input["answers"] = serde_json::json!({
        "用哪个数据库?": "SQLite",
        "Which features?": "Auth, 其他: 全文检索",
    });
    assert_eq!(
        run.output(),
        Some(permission_output(serde_json::json!({
            "behavior": "allow",
            "updatedInput": updated_input,
        })))
    );

    let decision_for_question =
        PermissionHook::claude(permission_request_input(serde_json::json!({
            "tool_name": "AskUserQuestion",
            "tool_input": tool_input,
        })))
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .run();
    decision_for_question.assert_reported_without_output("decision for a question");
}

#[test]
fn claude_permission_hook_reports_subagent_requests() {
    let input = permission_request_input(serde_json::json!({
        "session_id": "claude-session",
        "agent_id": "agent-1",
        "agent_type": "Explore",
        "tool_name": "Bash",
        "tool_input": { "command": "ls" },
    }));
    let run = PermissionHook::claude(input)
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .run();

    assert_eq!(run.request()["params"]["input_preview"], "ls");
    assert_eq!(
        run.output(),
        Some(permission_output(
            serde_json::json!({ "behavior": "allow" })
        ))
    );
}

#[test]
fn claude_permission_hook_waits_longer_than_other_hook_reports() {
    let run = PermissionHook::claude(claude_bash_request())
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .answer_after(Duration::from_millis(2_500))
        .run();

    assert!(!run.left_before_answer);
    assert_eq!(
        run.output(),
        Some(permission_output(
            serde_json::json!({ "behavior": "allow" })
        ))
    );
}

#[test]
fn claude_permission_hook_ignores_other_events_panes_and_tools() {
    let allow = answered(serde_json::json!({ "decision": "allow" }));
    let bash = serde_json::json!({
        "tool_name": "Bash",
        "tool_input": { "command": "ls" },
    });
    let with = |fields: serde_json::Value| {
        let mut merged = bash.clone();
        merged
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        permission_request_input(merged)
    };
    let cases = [
        (
            "notification event",
            PermissionHook::claude(with(
                serde_json::json!({ "hook_event_name": "Notification" }),
            )),
        ),
        (
            "pre tool use event",
            PermissionHook::claude(with(serde_json::json!({ "hook_event_name": "PreToolUse" }))),
        ),
        (
            "missing HERDR_REMOTE_ANSWERS",
            PermissionHook::claude(with(serde_json::json!({}))).without_env("HERDR_REMOTE_ANSWERS"),
        ),
        (
            "empty HERDR_REMOTE_ANSWERS",
            PermissionHook::claude(with(serde_json::json!({}))).env("HERDR_REMOTE_ANSWERS", ""),
        ),
        (
            "cursor environment",
            PermissionHook::claude(with(serde_json::json!({})))
                .env("CURSOR_VERSION", "2026.08.11-e8db854"),
        ),
        (
            "cursor payload",
            PermissionHook::claude(with(
                serde_json::json!({ "cursor_version": "2026.08.11-e8db854" }),
            )),
        ),
        (
            "grok",
            PermissionHook::claude(with(serde_json::json!({}))).env("GROK_SESSION_ID", "grok"),
        ),
        (
            "plan approval",
            PermissionHook::claude(permission_request_input(serde_json::json!({
                "tool_name": "ExitPlanMode",
                "tool_input": { "plan": "1. 修复" },
            }))),
        ),
    ];

    for (case, hook) in cases {
        hook.answer(allow.clone()).run().assert_ignored(case);
    }
}

#[test]
fn claude_permission_hook_prints_nothing_when_the_request_ends_without_a_decision() {
    for (case, response) in responses_without_a_decision() {
        let mut hook = PermissionHook::claude(claude_bash_request());
        if let Some(response) = response {
            hook = hook.answer(response);
        }
        hook.run().assert_reported_without_output(case);
    }
}

#[test]
fn claude_permission_hook_truncates_the_preview_at_a_character_boundary() {
    let command = "界".repeat(3_000);
    let input = permission_request_input(serde_json::json!({
        "tool_name": "Bash",
        "tool_input": { "command": command },
    }));
    let run = PermissionHook::claude(input).answer(ended("closed")).run();

    let preview = run.request()["params"]["input_preview"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(preview.len(), MAX_PREVIEW_BYTES / 3 * 3);
    assert!(command.starts_with(&preview));
}

fn codex_bash_request() -> String {
    permission_request_input(serde_json::json!({
        "session_id": "codex-session",
        "turn_id": "turn-1",
        "transcript_path": "/tmp/codex-session.jsonl",
        "model": "gpt-5.5",
        "tool_name": "Bash",
        "tool_input": { "command": "rm -rf 构建目录", "description": "清理构建产物" },
    }))
}

#[test]
fn codex_permission_hook_reports_the_request_and_prints_the_decision() {
    let run = PermissionHook::codex(codex_bash_request())
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .run();

    assert!(
        !run.left_before_answer,
        "the hook must wait on an open socket"
    );
    let raw = run.raw_request.as_deref().unwrap();
    assert!(raw.contains("rm -rf 构建目录"), "raw request: {raw}");
    assert!(!raw.contains("\\u"), "raw request: {raw}");
    let request = run.request();
    assert_eq!(request["method"], "pane.report_agent_request");
    assert_eq!(
        request["params"],
        serde_json::json!({
            "pane_id": "p_test",
            "source": "herdr:codex",
            "agent": "codex",
            "agent_session_id": "codex-session",
            "kind": "permission",
            "tool_name": "Bash",
            "description": "清理构建产物",
            "input_preview": "rm -rf 构建目录",
            "decisions": ["allow", "deny"],
            "timeout_ms": 600_000_u64,
        })
    );
    assert_eq!(
        run.output(),
        Some(permission_output(
            serde_json::json!({ "behavior": "allow" })
        ))
    );

    let root_thread = PermissionHook::codex(codex_bash_request())
        .env("CODEX_THREAD_ID", "codex-session")
        .answer(answered(serde_json::json!({ "decision": "allow" })))
        .run();
    assert_eq!(
        root_thread.output(),
        Some(permission_output(
            serde_json::json!({ "behavior": "allow" })
        ))
    );

    let denied = PermissionHook::codex(codex_bash_request())
        .answer(answered(serde_json::json!({
            "decision": "deny",
            "message": "用户在飞书中拒绝了这次操作",
        })))
        .run();
    assert!(
        denied.stdout.contains("用户在飞书中拒绝了这次操作"),
        "stdout: {}",
        denied.stdout
    );
    assert_eq!(
        denied.output(),
        Some(permission_output(serde_json::json!({
            "behavior": "deny",
            "message": "用户在飞书中拒绝了这次操作",
        })))
    );

    let denied_without_message = PermissionHook::codex(codex_bash_request())
        .answer(answered(serde_json::json!({ "decision": "deny" })))
        .run()
        .output()
        .expect("deny should print a decision");
    let decision = denied_without_message["hookSpecificOutput"]["decision"]
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(decision["behavior"], "deny");
    assert!(decision["message"]
        .as_str()
        .is_some_and(|message| !message.is_empty()));
    assert_eq!(decision.len(), 2, "{decision:?}");
}

#[test]
fn codex_permission_hook_previews_tool_input_json() {
    let input = r#"{"hook_event_name":"PermissionRequest","session_id":"codex-session","tool_name":"mcp__docs__search","tool_input":{"query":"权限","limit":3}}"#;
    let run = PermissionHook::codex(input.to_string())
        .answer(ended("timeout"))
        .run();

    let params = &run.request()["params"];
    assert_eq!(params["tool_name"], "mcp__docs__search");
    assert_eq!(
        params["input_preview"],
        "{\n  \"query\": \"权限\",\n  \"limit\": 3\n}"
    );
    assert!(params.get("description").is_none(), "{params}");
    assert_eq!(run.stdout, "");
}

#[test]
fn codex_permission_hook_ignores_other_events_panes_and_nested_sessions() {
    let allow = answered(serde_json::json!({ "decision": "allow" }));
    let stop = permission_request_input(serde_json::json!({
        "hook_event_name": "Stop",
        "session_id": "codex-session",
        "tool_name": "Bash",
        "tool_input": { "command": "ls" },
    }));
    let cases = [
        ("stop event", PermissionHook::codex(stop)),
        (
            "missing HERDR_REMOTE_ANSWERS",
            PermissionHook::codex(codex_bash_request()).without_env("HERDR_REMOTE_ANSWERS"),
        ),
        (
            "empty HERDR_REMOTE_ANSWERS",
            PermissionHook::codex(codex_bash_request()).env("HERDR_REMOTE_ANSWERS", ""),
        ),
        (
            "nested session",
            PermissionHook::codex(codex_bash_request()).env("CODEX_THREAD_ID", "parent-session"),
        ),
    ];

    for (case, hook) in cases {
        hook.answer(allow.clone()).run().assert_ignored(case);
    }
}

#[test]
fn codex_permission_hook_prints_nothing_when_the_request_ends_without_a_decision() {
    for (case, response) in responses_without_a_decision() {
        let mut hook = PermissionHook::codex(codex_bash_request());
        if let Some(response) = response {
            hook = hook.answer(response);
        }
        hook.run().assert_reported_without_output(case);
    }
}

#[test]
fn codex_permission_hook_truncates_the_preview_at_a_character_boundary() {
    let command = "界".repeat(3_000);
    let input = permission_request_input(serde_json::json!({
        "session_id": "codex-session",
        "tool_name": "Bash",
        "tool_input": { "command": command },
    }));
    let run = PermissionHook::codex(input).answer(ended("closed")).run();

    let preview = run.request()["params"]["input_preview"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(preview.len(), MAX_PREVIEW_BYTES / 3 * 3);
    assert!(command.starts_with(&preview));
}
