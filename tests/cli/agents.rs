use super::harness::*;

#[test]
fn agent_explain_missing_file_reports_json_error() {
    let base = unique_test_dir();
    let missing = base.join("missing-screen.txt");
    let output = run_named_cli(
        &base.join("config"),
        &base.join("runtime"),
        &[
            "agent",
            "explain",
            "--file",
            missing.to_str().unwrap(),
            "--agent",
            "claude",
            "--json",
        ],
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["id"], "cli:agent:explain");
    assert_eq!(error["error"]["code"], "agent_explain_file_read_failed");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains(missing.to_str().unwrap()));
}

#[test]
fn agent_replies_rejects_invalid_arguments_before_contacting_the_server() {
    let socket_path = Path::new("/tmp/herdr-cli-agent-replies-no-server.sock");

    for (args, expected) in [
        (vec!["agent", "replies"], "usage: herdr agent replies"),
        (
            vec!["agent", "replies", "w1:p1", "--after", "nope"],
            "invalid value for --after: nope",
        ),
        (
            vec!["agent", "replies", "w1:p1", "--after"],
            "missing value for --after",
        ),
        (
            vec!["agent", "replies", "w1:p1", "--bogus"],
            "unknown option: --bogus",
        ),
        (
            vec!["agent", "replies", "w1:p1", "extra"],
            "usage: herdr agent replies",
        ),
    ] {
        let output = run_cli(socket_path, &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(expected), "{args:?}: {stderr}");
    }
}

#[test]
fn agent_request_commands_reject_invalid_arguments_before_contacting_the_server() {
    let socket_path = Path::new("/tmp/herdr-cli-agent-requests-no-server.sock");

    for (args, expected) in [
        (vec!["agent", "requests"], "usage: herdr agent requests"),
        (
            vec!["agent", "requests", "w1:p1", "extra"],
            "usage: herdr agent requests",
        ),
        (
            vec!["agent", "answer", "w1:p1"],
            "usage: herdr agent answer",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1"],
            "usage: herdr agent answer",
        ),
        (
            vec!["agent", "answer", "w1:p1", "one", "--decision", "allow"],
            "invalid value for <request_id>: one",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "--decision", "maybe"],
            "invalid value for --decision: maybe",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "--decision"],
            "missing value for --decision",
        ),
        (
            vec![
                "agent",
                "answer",
                "w1:p1",
                "1",
                "--decision",
                "allow",
                "--answers",
                "{}",
            ],
            "use either --decision or --answers",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "--message", "why"],
            "--message requires --decision",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "--answers", "[\"Red\"]"],
            "invalid value for --answers",
        ),
        (
            vec![
                "agent",
                "answer",
                "w1:p1",
                "1",
                "--answers",
                "{\"Color?\": \"Red\"}",
            ],
            "invalid value for --answers",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "--bogus"],
            "unknown option: --bogus",
        ),
        (
            vec!["agent", "answer", "w1:p1", "1", "2", "--decision", "deny"],
            "usage: herdr agent answer",
        ),
    ] {
        let output = run_cli(socket_path, &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(expected), "{args:?}: {stderr}");
    }
}

#[test]
fn agent_replies_returns_final_replies_reported_by_the_claude_stop_hook() {
    use std::os::unix::fs::PermissionsExt;

    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let bin_dir = base.join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let hook = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/integration/assets/claude/herdr-agent-state.sh");
    // Every input line ends one turn and runs the real Stop hook with that line as the reply.
    let fake_claude = bin_dir.join("claude");
    fs::write(
        &fake_claude,
        format!(
            "#!/bin/sh\nwhile IFS= read -r line; do\n  printf '{{\"hook_event_name\":\"Stop\",\"session_id\":\"e2e-session\",\"last_assistant_message\":\"%s\"}}' \"$line\" | bash '{}' reply\ndone\n",
            hook.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&fake_claude, fs::Permissions::from_mode(0o755)).unwrap();

    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let path_override = format!("{}:{}", bin_dir.display(), inherited_path);
    let herdr = spawn_herdr_with_path(
        &config_home,
        &runtime_dir,
        &socket_path,
        Some(Path::new(&path_override)),
    );
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(run_cli(&socket_path, &["pane", "run", &pane_id, "claude"])
        .status
        .success());
    assert!(
        wait_until(Duration::from_secs(10), Duration::from_millis(50), || {
            run_cli(&socket_path, &["agent", "get", &pane_id])
                .status
                .success()
        }),
        "fake claude was not detected"
    );
    let empty = run_cli_json(&socket_path, &["agent", "replies", &pane_id]);
    assert_eq!(empty["result"]["type"], "agent_replies");
    assert_eq!(empty["result"]["replies"], serde_json::json!([]));

    let reply_seq = |socket_path: &Path| {
        run_cli_json(socket_path, &["agent", "get", &pane_id])["result"]["agent"]["reply_seq"]
            .as_u64()
    };
    for (turn, text) in ["第一轮 **完成**", "second turn"].into_iter().enumerate() {
        assert!(run_cli(&socket_path, &["pane", "run", &pane_id, text])
            .status
            .success());
        assert!(
            wait_until(Duration::from_secs(10), Duration::from_millis(50), || {
                reply_seq(&socket_path) == Some(turn as u64 + 1)
            }),
            "reply {text:?} was not recorded"
        );
    }

    let all = run_cli_json(&socket_path, &["agent", "replies", &pane_id]);
    assert_eq!(all["result"]["agent"]["reply_seq"], 2);
    assert_eq!(
        all["result"]["replies"],
        serde_json::json!([
            {"seq": 1, "text": "第一轮 **完成**", "truncated": false},
            {"seq": 2, "text": "second turn", "truncated": false},
        ])
    );
    let after = run_cli_json(
        &socket_path,
        &["agent", "replies", &pane_id, "--after", "1"],
    );
    assert_eq!(
        after["result"]["replies"],
        serde_json::json!([{"seq": 2, "text": "second turn", "truncated": false}])
    );
    let none = run_cli_json(&socket_path, &["agent", "replies", &pane_id, "--after=2"]);
    assert_eq!(none["result"]["replies"], serde_json::json!([]));

    cleanup_spawned_herdr(herdr, base);
}

/// A real server whose only pane runs a fake `claude` that Herdr detects as Claude Code.
struct FakeClaudeServer {
    herdr: SpawnedHerdr,
    base: PathBuf,
    socket_path: PathBuf,
    pane_id: String,
}

impl FakeClaudeServer {
    fn start() -> Self {
        use std::os::unix::fs::PermissionsExt;

        let base = unique_test_dir();
        let config_home = base.join("config");
        let runtime_dir = base.join("runtime");
        let socket_path = runtime_dir.join("herdr.sock");
        let bin_dir = base.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let fake_claude = bin_dir.join("claude");
        fs::write(
            &fake_claude,
            "#!/bin/sh\nwhile IFS= read -r line; do :; done\n",
        )
        .unwrap();
        fs::set_permissions(&fake_claude, fs::Permissions::from_mode(0o755)).unwrap();
        let path_override = format!(
            "{}:{}",
            bin_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let herdr = spawn_herdr_with_path(
            &config_home,
            &runtime_dir,
            &socket_path,
            Some(Path::new(&path_override)),
        );
        wait_for_socket(&socket_path, Duration::from_secs(5));
        let created = run_cli_json(
            &socket_path,
            &["workspace", "create", "--cwd", base.to_str().unwrap()],
        );
        let pane_id = created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(run_cli(&socket_path, &["pane", "run", &pane_id, "claude"])
            .status
            .success());
        assert!(
            wait_until(Duration::from_secs(10), Duration::from_millis(50), || {
                run_cli(&socket_path, &["agent", "get", &pane_id])
                    .status
                    .success()
            }),
            "fake claude was not detected"
        );
        Self {
            herdr,
            base,
            socket_path,
            pane_id,
        }
    }

    /// Opens a hook connection that reports a request and waits for its outcome.
    fn report_request(&self, id: &str, request: serde_json::Value) -> BufReader<UnixStream> {
        let mut params = serde_json::json!({
            "pane_id": self.pane_id,
            "source": "herdr:claude",
            "agent": "claude",
        });
        params
            .as_object_mut()
            .unwrap()
            .extend(request.as_object().unwrap().clone());
        let mut stream = UnixStream::connect(&self.socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let request = serde_json::json!({
            "id": id,
            "method": "pane.report_agent_request",
            "params": params,
        });
        writeln!(stream, "{request}").unwrap();
        stream.flush().unwrap();
        BufReader::new(stream)
    }

    fn pending_request_ids(&self) -> Vec<u64> {
        run_cli_json(&self.socket_path, &["agent", "requests", &self.pane_id])["result"]["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|request| request["id"].as_u64().unwrap())
            .collect()
    }

    fn wait_for_pending_requests(&self, expected: &[u64]) {
        assert!(
            wait_until(Duration::from_secs(10), Duration::from_millis(50), || {
                self.pending_request_ids() == expected
            }),
            "pending requests never became {expected:?}; last: {:?}",
            self.pending_request_ids()
        );
    }

    fn report_state(&self, state: &str) {
        let output = run_cli(
            &self.socket_path,
            &[
                "pane",
                "report-agent",
                &self.pane_id,
                "--source",
                "e2e:lifecycle",
                "--agent",
                "claude",
                "--state",
                state,
            ],
        );
        assert!(output.status.success(), "{output:?}");
        assert!(
            wait_until(Duration::from_secs(10), Duration::from_millis(50), || {
                run_cli_json(&self.socket_path, &["agent", "get", &self.pane_id])["result"]["agent"]
                    ["agent_status"]
                    == state
            }),
            "agent never became {state}"
        );
    }

    fn stop(self) {
        cleanup_spawned_herdr(self.herdr, self.base);
    }
}

fn read_request_outcome(hook: &mut BufReader<UnixStream>) -> serde_json::Value {
    let mut line = String::new();
    hook.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line:?}"))
}

fn run_cli_error(socket_path: &Path, args: &[&str]) -> serde_json::Value {
    let output = run_cli(socket_path, args);
    assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
    serde_json::from_slice(&output.stderr).unwrap()
}

#[test]
fn agent_answer_reaches_the_hook_connection_waiting_on_the_request() {
    let server = FakeClaudeServer::start();
    let socket_path = server.socket_path.as_path();
    let pane_id = server.pane_id.as_str();
    let mut permission_hook = server.report_request(
        "hook-permission",
        serde_json::json!({
            "kind": "permission",
            "tool_name": "Bash",
            "description": "列出文件",
            "input_preview": "ls -la",
            "decisions": ["allow", "allow_always", "deny"],
            "timeout_ms": 600000,
        }),
    );
    server.wait_for_pending_requests(&[1]);

    let agents = run_cli_json(socket_path, &["agent", "list"]);
    assert_eq!(
        agents["result"]["agents"][0]["request_ids"],
        serde_json::json!([1])
    );
    let listed = run_cli_json(socket_path, &["agent", "requests", pane_id]);
    assert_eq!(listed["result"]["type"], "agent_requests");
    assert_eq!(
        listed["result"]["requests"],
        serde_json::json!([{
            "id": 1,
            "kind": "permission",
            "tool_name": "Bash",
            "description": "列出文件",
            "input_preview": "ls -la",
            "decisions": ["allow", "allow_always", "deny"],
        }])
    );

    let invalid = run_cli_error(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "1",
            "--answers",
            r#"{"Which color?":["Red"]}"#,
        ],
    );
    assert_eq!(invalid["error"]["code"], "invalid_answer", "{invalid}");
    let missing = run_cli_error(
        socket_path,
        &["agent", "answer", pane_id, "42", "--decision", "allow"],
    );
    assert_eq!(missing["error"]["code"], "request_not_found", "{missing}");

    let answered = run_cli_json(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "1",
            "--decision=deny",
            "--message",
            "用户在飞书中拒绝了这次操作",
        ],
    );
    assert_eq!(answered["result"]["type"], "agent_info", "{answered}");
    assert!(answered["result"]["agent"].get("request_ids").is_none());
    assert_eq!(
        read_request_outcome(&mut permission_hook),
        serde_json::json!({
            "id": "hook-permission",
            "result": {
                "type": "agent_request_answered",
                "request_id": 1,
                "decision": "deny",
                "message": "用户在飞书中拒绝了这次操作",
            },
        })
    );

    let mut question_hook = server.report_request(
        "hook-question",
        serde_json::json!({
            "kind": "question",
            "tool_name": "AskUserQuestion",
            "input_preview": "{}",
            "questions": [{
                "question": "Which color?",
                "options": [{"label": "Red"}, {"label": "Blue"}],
                "multi_select": true,
            }],
        }),
    );
    server.wait_for_pending_requests(&[2]);
    run_cli_json(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "2",
            "--answers",
            r#"{"Which color?":["Red","其他颜色"]}"#,
        ],
    );
    assert_eq!(
        read_request_outcome(&mut question_hook)["result"],
        serde_json::json!({
            "type": "agent_request_answered",
            "request_id": 2,
            "answers": {"Which color?": ["Red", "其他颜色"]},
        })
    );
    let answered_again = run_cli_error(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "2",
            "--answers",
            r#"{"Which color?":["Red"]}"#,
        ],
    );
    assert_eq!(answered_again["error"]["code"], "request_not_found");

    server.stop();
}

#[test]
fn agent_request_reports_end_without_an_answer() {
    let server = FakeClaudeServer::start();
    let permission = |timeout_ms: u64| {
        serde_json::json!({
            "kind": "permission",
            "tool_name": "Bash",
            "input_preview": "make deploy",
            "decisions": ["allow", "deny"],
            "timeout_ms": timeout_ms,
        })
    };

    let mut ignored = server.report_request("hook-ignored", {
        let mut request = permission(600_000);
        request["source"] = "custom:claude".into();
        request
    });
    assert_eq!(
        read_request_outcome(&mut ignored)["result"],
        serde_json::json!({"type": "agent_request_ended", "reason": "ignored"})
    );

    let started = Instant::now();
    let mut timed_out = server.report_request("hook-timeout", permission(300));
    assert_eq!(
        read_request_outcome(&mut timed_out),
        serde_json::json!({
            "id": "hook-timeout",
            "result": {"type": "agent_request_ended", "request_id": 1, "reason": "timeout"},
        })
    );
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(server.pending_request_ids().is_empty());

    let disconnected = server.report_request("hook-disconnected", permission(600_000));
    server.wait_for_pending_requests(&[2]);
    drop(disconnected);
    server.wait_for_pending_requests(&[]);
    let withdrawn = run_cli_error(
        &server.socket_path,
        &[
            "agent",
            "answer",
            &server.pane_id,
            "2",
            "--decision",
            "allow",
        ],
    );
    assert_eq!(withdrawn["error"]["code"], "request_not_found");

    server.report_state("working");
    let mut turn = server.report_request("hook-turn", permission(600_000));
    server.wait_for_pending_requests(&[3]);
    server.report_state("blocked");
    assert_eq!(server.pending_request_ids(), [3]);
    server.report_state("idle");
    assert_eq!(
        read_request_outcome(&mut turn)["result"],
        serde_json::json!({"type": "agent_request_ended", "request_id": 3, "reason": "closed"})
    );
    assert!(server.pending_request_ids().is_empty());

    server.stop();
}

/// Starts the real Claude hook `permission` action as Claude Code in the pane would.
fn spawn_claude_permission_hook(
    server: &FakeClaudeServer,
    hook_input: &serde_json::Value,
) -> std::process::Child {
    let hook = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/integration/assets/claude/herdr-agent-state.sh");
    let mut child = Command::new("bash")
        .arg(hook)
        .arg("permission")
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &server.socket_path)
        .env("HERDR_PANE_ID", &server.pane_id)
        .env("HERDR_REMOTE_ANSWERS", "1")
        .env_remove("CURSOR_VERSION")
        .env_remove("GROK_SESSION_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(hook_input.to_string().as_bytes())
        .unwrap();
    child
}

fn claude_hook_decision(hook: std::process::Child) -> serde_json::Value {
    let output = hook.wait_with_output().unwrap();
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&output.stdout)))
}

#[test]
fn claude_permission_hook_prints_the_answer_given_with_herdr_agent_answer() {
    let server = FakeClaudeServer::start();
    // A status change ends pending requests as a finished turn; keep one turn running.
    server.report_state("working");
    let socket_path = server.socket_path.as_path();
    let pane_id = server.pane_id.as_str();
    let suggestions = serde_json::json!([{
        "type": "addRules",
        "rules": [{"toolName": "Bash", "ruleContent": "cargo publish:*"}],
        "behavior": "allow",
        "destination": "localSettings",
    }]);
    let bash_request = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "e2e-session",
        "tool_name": "Bash",
        "tool_input": {"command": "cargo publish --dry-run", "description": "试运行发布"},
        "permission_suggestions": suggestions,
    });

    let permission = spawn_claude_permission_hook(&server, &bash_request);
    server.wait_for_pending_requests(&[1]);
    assert_eq!(
        run_cli_json(socket_path, &["agent", "requests", pane_id])["result"]["requests"],
        serde_json::json!([{
            "id": 1,
            "kind": "permission",
            "tool_name": "Bash",
            "description": "试运行发布",
            "input_preview": "cargo publish --dry-run",
            "decisions": ["allow", "allow_always", "deny"],
        }])
    );
    run_cli_json(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "1",
            "--decision",
            "allow_always",
        ],
    );
    assert_eq!(
        claude_hook_decision(permission),
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow", "updatedPermissions": suggestions},
            },
        })
    );

    let questions = serde_json::json!([{
        "question": "Which color?",
        "header": "Color",
        "options": [{"label": "Red"}, {"label": "Blue"}],
        "multiSelect": true,
    }]);
    let question = spawn_claude_permission_hook(
        &server,
        &serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "e2e-session",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": questions},
        }),
    );
    server.wait_for_pending_requests(&[2]);
    run_cli_json(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "2",
            "--answers",
            r#"{"Which color?":["Red","其他颜色"]}"#,
        ],
    );
    assert_eq!(
        claude_hook_decision(question),
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "allow",
                    "updatedInput": {
                        "questions": questions,
                        "answers": {"Which color?": "Red, 其他颜色"},
                    },
                },
            },
        })
    );

    let denied = spawn_claude_permission_hook(&server, &bash_request);
    server.wait_for_pending_requests(&[3]);
    run_cli_json(
        socket_path,
        &[
            "agent",
            "answer",
            pane_id,
            "3",
            "--decision",
            "deny",
            "--message",
            "用户在飞书中拒绝了这次操作",
        ],
    );
    assert_eq!(
        claude_hook_decision(denied),
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "用户在飞书中拒绝了这次操作",
                    "interrupt": true,
                },
            },
        })
    );

    server.stop();
}

#[test]
fn killing_the_claude_permission_hook_withdraws_its_request() {
    let server = FakeClaudeServer::start();
    // Keep one turn running so that only the closed hook connection can end the request.
    server.report_state("working");
    let mut hook = spawn_claude_permission_hook(
        &server,
        &serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"command": "make deploy"},
        }),
    );
    server.wait_for_pending_requests(&[1]);

    hook.kill().unwrap();
    hook.wait().unwrap();

    server.wait_for_pending_requests(&[]);
    server.stop();
}

fn write_delayed_shell_and_fake_pi(
    base: &Path,
    shell_delay_seconds: &str,
) -> (PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let bin = base.join("bin");
    let delayed_shell = bin.join("delayed-shell");
    let fake_pi = bin.join("pi");
    let invocations = base.join("pi-invocations");
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        &delayed_shell,
        format!("#!/bin/sh\n/bin/sleep {shell_delay_seconds}\nexec /bin/sh\n"),
    )
    .unwrap();
    fs::write(
        &fake_pi,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nexport HERDR_AGENT=pi\n'{}' pane report-agent \"$HERDR_PANE_ID\" --source custom:delayed-shell-pi --agent pi --state idle >/dev/null\nwhile IFS= read -r _prompt; do :; done\n",
            invocations.display(),
            env!("CARGO_BIN_EXE_herdr"),
        ),
    )
    .unwrap();
    fs::set_permissions(&delayed_shell, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();
    (bin, delayed_shell, invocations)
}

#[test]
fn agent_start_waits_for_a_new_pane_shell_to_finish_initializing() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let (bin, delayed_shell, invocations) = write_delayed_shell_and_fake_pi(&base, "0.4");
    let config = format!(
        "onboarding = false\n[terminal]\ndefault_shell = {:?}\nshell_mode = \"non_login\"\n",
        delayed_shell.to_str().unwrap()
    );
    let herdr = spawn_herdr_with_config(
        &config_home,
        &runtime_dir,
        &socket_path,
        Some(&bin),
        &config,
    );
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let seed = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let seed_workspace = seed["result"]["workspace"]["workspace_id"]
        .as_str()
        .unwrap();
    let created = run_cli_json(
        &socket_path,
        &[
            "workspace",
            "create",
            "--cwd",
            base.to_str().unwrap(),
            "--no-focus",
        ],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"].as_str().unwrap();
    let terminal_id = created["result"]["root_pane"]["terminal_id"]
        .as_str()
        .unwrap();
    assert!(!created["result"]["root_pane"]["focused"].as_bool().unwrap());

    let started = run_cli_json(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            pane_id,
            "--timeout",
            "8000",
            "--",
            "--no-context-files",
            "--no-skills",
            "--no-extensions",
        ],
    );

    assert_eq!(started["result"]["agent"]["terminal_id"], terminal_id);
    assert_eq!(started["result"]["agent"]["pane_id"], pane_id);
    assert_eq!(started["result"]["agent"]["interactive_ready"], true);
    assert_eq!(
        fs::read_to_string(&invocations).unwrap(),
        "--no-context-files\n--no-skills\n--no-extensions\n"
    );
    assert_eq!(
        run_cli_json(&socket_path, &["workspace", "list"])["result"]["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workspace| workspace["workspace_id"] == seed_workspace)
            .unwrap()["focused"],
        true
    );

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_stops_retrying_when_the_pane_shell_stays_busy() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let (bin, delayed_shell, invocations) = write_delayed_shell_and_fake_pi(&base, "2.3");
    let config = format!(
        "onboarding = false\n[terminal]\ndefault_shell = {:?}\nshell_mode = \"non_login\"\n",
        delayed_shell.to_str().unwrap()
    );
    let herdr = spawn_herdr_with_config(
        &config_home,
        &runtime_dir,
        &socket_path,
        Some(&bin),
        &config,
    );
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"].as_str().unwrap();

    let started_at = Instant::now();
    let unavailable = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            pane_id,
            "--timeout",
            "8000",
        ],
    );
    assert_eq!(unavailable.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&unavailable.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_pane_busy");
    assert!(started_at.elapsed() >= Duration::from_secs(2));
    assert!(started_at.elapsed() < Duration::from_secs(4));
    assert!(!invocations.exists());

    let retried = run_cli_json(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            pane_id,
            "--timeout",
            "8000",
        ],
    );
    assert_eq!(retried["result"]["type"], "agent_started");
    assert_eq!(fs::read_to_string(&invocations).unwrap(), "\n");

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_command_works() {
    use std::os::unix::fs::PermissionsExt;

    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let bin = base.join("bin");
    let captured_args = base.join("pi-args");
    let captured_prompts = base.join("pi-prompts");
    fs::create_dir_all(&bin).unwrap();
    let fake_pi = bin.join("pi");
    fs::write(
        &fake_pi,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{0}'\nexport HERDR_AGENT=pi\n'{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state idle >/dev/null\nwhile IFS= read -r prompt; do\n  case \"$prompt\" in\n    \"do not transition\") continue ;;\n    \"done churn\")\n      '{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state done >/dev/null\n      '{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state idle >/dev/null\n      continue\n      ;;\n    \"session churn\")\n      '{1}' pane report-agent-session \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --agent-session-id replacement >/dev/null\n      continue\n      ;;\n    \"block after submit\")\n      '{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state blocked >/dev/null\n      continue\n      ;;\n  esac\n  '{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state working >/dev/null\n  '{1}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state idle >/dev/null\n  printf '%s\\n' \"$prompt\" >> '{2}'\ndone\n",
            captured_args.display(),
            env!("CARGO_BIN_EXE_herdr"),
            captured_prompts.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

    let herdr = spawn_herdr_with_path(&config_home, &runtime_dir, &socket_path, Some(&bin));
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    run_cli_json(&socket_path, &["pane", "rename", &pane_id, "shell-pane"]);
    let before = run_cli_json(&socket_path, &["pane", "list"]);
    let before_topology = pane_topology_snapshot(&before);

    let missing = run_cli(
        &socket_path,
        &[
            "agent", "start", "missing", "--kind", "pi", "--pane", "w999:p1",
        ],
    );
    assert_eq!(missing.status.code(), Some(1));
    let missing: serde_json::Value = serde_json::from_slice(&missing.stderr).unwrap();
    assert_eq!(missing["error"]["code"], "agent_pane_not_found");
    assert_eq!(
        pane_topology_snapshot(&run_cli_json(&socket_path, &["pane", "list"])),
        before_topology
    );

    for unsafe_arg in ["tab\tcompletion", "escape\x1b[201~"] {
        let rejected = run_cli(
            &socket_path,
            &[
                "agent",
                "start",
                "invalid-argument",
                "--kind",
                "pi",
                "--pane",
                &pane_id,
                "--",
                unsafe_arg,
            ],
        );
        assert_eq!(rejected.status.code(), Some(1));
        let error: serde_json::Value = serde_json::from_slice(&rejected.stderr).unwrap();
        assert_eq!(error["error"]["code"], "invalid_agent_argument");
    }

    for invalid_timeout in ["3000", "300001", "18446744073709551615"] {
        let rejected = run_cli(
            &socket_path,
            &[
                "agent",
                "start",
                "invalid-timeout",
                "--kind",
                "pi",
                "--pane",
                &pane_id,
                "--timeout",
                invalid_timeout,
            ],
        );
        assert_eq!(rejected.status.code(), Some(1));
        let error: serde_json::Value = serde_json::from_slice(&rejected.stderr).unwrap();
        assert_eq!(error["error"]["code"], "invalid_agent_timeout");
    }

    let started = run_cli_json(
        &socket_path,
        &[
            "agent",
            "start",
            "main",
            "--kind",
            "pi",
            "--pane",
            &pane_id,
            "--timeout",
            "8000",
            "--",
            "--name",
            "scratch",
            "--no-session",
        ],
    );
    assert_eq!(started["result"]["type"], "agent_started");
    assert_eq!(started["result"]["agent"]["name"], "main");
    assert_eq!(started["result"]["agent"]["agent"], "pi");
    assert_eq!(started["result"]["agent"]["pane_id"], pane_id);
    assert_eq!(
        run_cli_json(&socket_path, &["pane", "get", &pane_id])["result"]["pane"]["label"],
        "shell-pane"
    );
    assert_eq!(started["result"]["argv"][0], "pi");
    assert_eq!(started["result"]["argv"][1], "--name");
    assert_eq!(started["result"]["argv"][2], "scratch");
    assert_eq!(started["result"]["argv"][3], "--no-session");
    assert_eq!(
        fs::read_to_string(&captured_args).unwrap(),
        "--name\nscratch\n--no-session\n"
    );

    let literal_flag_prompt = run_cli(&socket_path, &["agent", "prompt", "main", "--wait"]);
    assert!(
        literal_flag_prompt.status.success(),
        "flag-shaped prompt was not treated literally: {}",
        String::from_utf8_lossy(&literal_flag_prompt.stderr)
    );
    let literal_flag_prompt: serde_json::Value =
        serde_json::from_slice(&literal_flag_prompt.stdout).unwrap();
    assert_eq!(literal_flag_prompt["result"]["type"], "agent_prompted");
    assert!(wait_until(
        Duration::from_secs(2),
        Duration::from_millis(25),
        || captured_prompts.exists()
    ));

    let after = run_cli_json(&socket_path, &["pane", "list"]);
    assert_eq!(pane_topology_snapshot(&after), before_topology);

    let prompts_before_blocked = fs::read(&captured_prompts).unwrap();
    let blocked_report = run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &pane_id,
            "--source",
            "custom:fake-pi",
            "--agent",
            "pi",
            "--state",
            "blocked",
        ],
    );
    assert!(blocked_report.status.success());
    assert_eq!(
        run_cli_json(&socket_path, &["agent", "get", "main"])["result"]["agent"]["agent_status"],
        "blocked"
    );

    let blocked_prompt = run_cli(
        &socket_path,
        &[
            "agent",
            "prompt",
            "main",
            "must not be submitted",
            "--wait",
            "--timeout",
            "2000",
        ],
    );
    assert_eq!(blocked_prompt.status.code(), Some(1));
    let blocked_prompt: serde_json::Value = serde_json::from_slice(&blocked_prompt.stderr).unwrap();
    assert_eq!(blocked_prompt["error"]["code"], "agent_blocked");
    thread::sleep(Duration::from_millis(400));
    assert_eq!(fs::read(&captured_prompts).unwrap(), prompts_before_blocked);

    let report_agent = |state| {
        run_cli(
            &socket_path,
            &[
                "pane",
                "report-agent",
                &pane_id,
                "--source",
                "custom:fake-pi",
                "--agent",
                "pi",
                "--state",
                state,
            ],
        )
        .status
        .success()
    };
    let prompt_wait = |prompt, timeout| {
        run_cli(
            &socket_path,
            &[
                "agent",
                "prompt",
                "main",
                prompt,
                "--wait",
                "--timeout",
                timeout,
            ],
        )
    };

    assert!(report_agent("idle"));
    let stale_idle = prompt_wait("do not transition", "500");
    assert_eq!(stale_idle.status.code(), Some(1));
    let stale_idle: serde_json::Value = serde_json::from_slice(&stale_idle.stderr).unwrap();
    assert_eq!(stale_idle["error"]["code"], "timeout");

    let stalled = prompt_wait("do not transition", "6000");
    assert_eq!(stalled.status.code(), Some(1));
    let stalled: serde_json::Value = serde_json::from_slice(&stalled.stderr).unwrap();
    assert_eq!(stalled["error"]["code"], "agent_prompt_stalled");
    assert!(stalled["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("no observed working or blocked state")));

    for prompt in ["done churn", "session churn"] {
        let settled_only = prompt_wait(prompt, "500");
        assert_eq!(settled_only.status.code(), Some(1));
        let settled_only: serde_json::Value = serde_json::from_slice(&settled_only.stderr).unwrap();
        assert_eq!(settled_only["error"]["code"], "timeout");
    }

    let blocked_after_submit = prompt_wait("block after submit", "2000");
    assert!(blocked_after_submit.status.success());
    let blocked_after_submit: serde_json::Value =
        serde_json::from_slice(&blocked_after_submit.stdout).unwrap();
    assert_eq!(
        blocked_after_submit["result"]["agent"]["agent_status"],
        "blocked"
    );
    assert!(report_agent("idle"));
    assert!(report_agent("working"));
    let already_working = prompt_wait("finish active", "2000");
    assert!(already_working.status.success());

    let prompted = prompt_wait("Review this diff", "2000");
    assert!(
        prompted.status.success(),
        "prompt failed: {}",
        String::from_utf8_lossy(&prompted.stderr)
    );
    let prompted: serde_json::Value = serde_json::from_slice(&prompted.stdout).unwrap();
    assert_eq!(prompted["result"]["type"], "agent_prompted");

    let duplicate = run_cli(
        &socket_path,
        &["agent", "start", "main", "--kind", "pi", "--pane", &pane_id],
    );
    assert!(!duplicate.status.success());
    let duplicate_json: serde_json::Value = serde_json::from_slice(&duplicate.stderr).unwrap();
    assert_eq!(duplicate_json["error"]["code"], "agent_name_taken");

    let busy = run_cli(
        &socket_path,
        &[
            "agent", "start", "second", "--kind", "pi", "--pane", &pane_id,
        ],
    );
    assert!(!busy.status.success());
    let busy_json: serde_json::Value = serde_json::from_slice(&busy.stderr).unwrap();
    assert_eq!(busy_json["error"]["code"], "agent_pane_busy");

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_rejects_a_shell_replaced_by_a_foreground_program() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let topology = pane_topology_snapshot(&run_cli_json(&socket_path, &["pane", "list"]));
    assert!(
        run_cli(&socket_path, &["pane", "run", &pane_id, "exec sleep 5"])
            .status
            .success()
    );
    thread::sleep(Duration::from_millis(150));

    let started = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            &pane_id,
            "--timeout",
            "4000",
        ],
    );
    assert_eq!(started.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&started.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_pane_busy");
    assert_eq!(
        pane_topology_snapshot(&run_cli_json(&socket_path, &["pane", "list"])),
        topology
    );

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_timeout_releases_the_name_for_reuse() {
    use std::os::unix::fs::PermissionsExt;

    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let bin = base.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let fake_pi = bin.join("pi");
    fs::write(
        &fake_pi,
        "#!/bin/sh\nunset HERDR_AGENT\nexec /bin/sleep 20\n",
    )
    .unwrap();
    fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

    let herdr = spawn_herdr_with_path(&config_home, &runtime_dir, &socket_path, Some(&bin));
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let split = run_cli_json(
        &socket_path,
        &["pane", "split", &pane_id, "--direction", "right"],
    );
    let reuse_pane_id = split["result"]["pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &reuse_pane_id,
            "--source",
            "custom:reuse",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());

    let started = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            &pane_id,
            "--timeout",
            "3100",
        ],
    );
    assert_eq!(started.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&started.stderr).unwrap();
    assert_eq!(error["error"]["code"], "timeout");

    let reused = run_cli(&socket_path, &["agent", "rename", &reuse_pane_id, "worker"]);
    assert!(
        reused.status.success(),
        "name was not released: {}",
        String::from_utf8_lossy(&reused.stderr)
    );

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_reports_detected_kind_mismatch_before_released_name() {
    use std::os::unix::fs::PermissionsExt;

    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let bin = base.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let fake_pi = bin.join("pi");
    fs::write(
        &fake_pi,
        "#!/bin/sh\nHERDR_AGENT=codex exec /bin/sleep 10\n",
    )
    .unwrap();
    fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

    let herdr = spawn_herdr_with_path(&config_home, &runtime_dir, &socket_path, Some(&bin));
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let split = run_cli_json(
        &socket_path,
        &["pane", "split", &pane_id, "--direction", "right"],
    );
    let reuse_pane_id = split["result"]["pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();

    let started = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "worker",
            "--kind",
            "pi",
            "--pane",
            &pane_id,
            "--timeout",
            "5000",
        ],
    );
    assert_eq!(started.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&started.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_kind_mismatch");

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &reuse_pane_id,
            "--source",
            "custom:reuse",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());
    let reused = run_cli(&socket_path, &["agent", "rename", &reuse_pane_id, "worker"]);
    assert!(reused.status.success());

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_follows_its_named_terminal_when_the_pane_moves() {
    use std::os::unix::fs::PermissionsExt;

    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let bin = base.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let fake_pi = bin.join("pi");
    fs::write(&fake_pi, "#!/bin/sh\nHERDR_AGENT=pi exec /bin/sleep 10\n").unwrap();
    fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

    let herdr = spawn_herdr_with_path(&config_home, &runtime_dir, &socket_path, Some(&bin));
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let first = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let start_socket = socket_path.clone();
    let start_pane = first.clone();
    let starter = thread::spawn(move || {
        run_cli(
            &start_socket,
            &[
                "agent",
                "start",
                "worker",
                "--kind",
                "pi",
                "--pane",
                &start_pane,
                "--timeout",
                "8000",
            ],
        )
    });
    assert!(wait_until(
        Duration::from_secs(2),
        Duration::from_millis(25),
        || run_cli(&socket_path, &["agent", "get", "worker"])
            .status
            .success()
    ));

    let moved = run_cli(
        &socket_path,
        &[
            "pane",
            "move",
            &first,
            "--new-workspace",
            "--label",
            "moved",
            "--no-focus",
        ],
    );
    assert!(
        moved.status.success(),
        "move failed: {}",
        String::from_utf8_lossy(&moved.stderr)
    );

    let started = starter.join().unwrap();
    assert!(
        started.status.success(),
        "start failed after swap: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    let started: serde_json::Value = serde_json::from_slice(&started.stdout).unwrap();
    assert_ne!(started["result"]["agent"]["pane_id"], first);

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_start_and_rename_reject_invalid_names() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let expected_message = "agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)";

    let started = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "reviewer one",
            "--kind",
            "pi",
            "--pane",
            &pane_id,
        ],
    );
    assert_eq!(started.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&started.stderr).unwrap();
    assert_eq!(error["error"]["code"], "invalid_agent_name");
    assert_eq!(error["error"]["message"], expected_message);

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &pane_id,
            "--source",
            "custom:name",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());
    let renamed = run_cli(&socket_path, &["agent", "rename", &pane_id, "reviewer one"]);
    assert_eq!(renamed.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&renamed.stderr).unwrap();
    assert_eq!(error["error"]["code"], "invalid_agent_name");
    assert_eq!(error["error"]["message"], expected_message);

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_commands_work() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");

    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));

    let created = run_cli(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    assert!(created.status.success());
    let created_json: serde_json::Value = serde_json::from_slice(&created.stdout).unwrap();
    let root_pane_id = created_json["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let terminal_id = created_json["result"]["root_pane"]["terminal_id"]
        .as_str()
        .unwrap()
        .to_string();

    let reported = run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &root_pane_id,
            "--source",
            "custom:test",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    );
    assert!(reported.status.success());
    let renamed = run_cli(&socket_path, &["agent", "rename", &root_pane_id, "worker"]);
    assert!(renamed.status.success());

    let listed = run_cli_json(&socket_path, &["agent", "list"]);
    assert_eq!(listed["result"]["type"], "agent_list");
    assert_eq!(listed["result"]["agents"][0]["terminal_id"], terminal_id);
    assert_eq!(listed["result"]["agents"][0]["name"], "worker");

    let fetched = run_cli_json(&socket_path, &["agent", "get", "worker"]);
    assert_eq!(fetched["result"]["agent"]["pane_id"], root_pane_id);
    let waited = run_cli_json(
        &socket_path,
        &["agent", "wait", "worker", "--timeout", "100"],
    );
    assert_eq!(waited["result"]["agent"]["pane_id"], root_pane_id);

    // A stale semantic report must not allow prompt text into the resumed shell.
    let prompted = run_cli(
        &socket_path,
        &["agent", "prompt", "worker", "echo prompt-must-not-run"],
    );
    assert_eq!(prompted.status.code(), Some(1));
    let prompted_json: serde_json::Value = serde_json::from_slice(&prompted.stderr).unwrap();
    assert_eq!(prompted_json["error"]["code"], "agent_not_ready");

    let working = run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &root_pane_id,
            "--source",
            "custom:wait",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    );
    assert!(working.status.success());
    let blocked_socket = socket_path.clone();
    let blocked_pane = root_pane_id.clone();
    let blocked_transition = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        let blocked = run_cli(
            &blocked_socket,
            &[
                "pane",
                "report-agent",
                &blocked_pane,
                "--source",
                "custom:wait",
                "--agent",
                "pi",
                "--state",
                "blocked",
            ],
        );
        assert!(blocked.status.success());
    });
    let waited = run_cli_json(
        &socket_path,
        &["agent", "wait", "worker", "--timeout", "2000"],
    );
    blocked_transition.join().unwrap();
    assert_eq!(waited["result"]["agent"]["agent_status"], "blocked");
    let immediate_blocked =
        run_cli_json(&socket_path, &["agent", "wait", "worker", "--timeout", "1"]);
    assert_eq!(
        immediate_blocked["result"]["agent"]["agent_status"],
        "blocked"
    );

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &root_pane_id,
            "--source",
            "custom:wait",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    let idle_socket = socket_path.clone();
    let idle_pane = root_pane_id.clone();
    let idle_transition = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        assert!(run_cli(
            &idle_socket,
            &[
                "pane",
                "report-agent",
                &idle_pane,
                "--source",
                "custom:wait",
                "--agent",
                "pi",
                "--state",
                "idle",
            ],
        )
        .status
        .success());
    });
    let idle_wait = run_cli_json(
        &socket_path,
        &["agent", "wait", "worker", "--timeout", "2000"],
    );
    idle_transition.join().unwrap();
    assert!(matches!(
        idle_wait["result"]["agent"]["agent_status"].as_str(),
        Some("idle" | "done")
    ));

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &root_pane_id,
            "--source",
            "custom:wait",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    let timed_out = run_cli(
        &socket_path,
        &["agent", "wait", "worker", "--timeout", "100"],
    );
    assert_eq!(timed_out.status.code(), Some(1));
    let timeout: serde_json::Value = serde_json::from_slice(&timed_out.stderr).unwrap();
    assert_eq!(timeout["error"]["code"], "timeout");

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &root_pane_id,
            "--source",
            "custom:wait",
            "--agent",
            "pi",
            "--state",
            "unknown",
        ],
    )
    .status
    .success());
    let unknown = run_cli_json(
        &socket_path,
        &[
            "agent",
            "wait",
            "worker",
            "--until",
            "unknown",
            "--timeout",
            "1000",
        ],
    );
    assert_eq!(unknown["result"]["agent"]["agent_status"], "unknown");

    let pane_read = run_cli(
        &socket_path,
        &["pane", "read", &root_pane_id, "--source", "visible"],
    );
    let agent_read = run_cli(
        &socket_path,
        &["agent", "read", &root_pane_id, "--source", "visible"],
    );
    assert!(pane_read.status.success());
    assert!(agent_read.status.success());
    assert_eq!(agent_read.stdout, pane_read.stdout);

    let missing_read = run_cli(&socket_path, &["agent", "read", "missing"]);
    assert_eq!(missing_read.status.code(), Some(1));
    let missing_read: serde_json::Value = serde_json::from_slice(&missing_read.stderr).unwrap();
    assert_eq!(missing_read["error"]["code"], "agent_not_found");

    let sent = run_cli(&socket_path, &["agent", "send-keys", "worker", "enter"]);
    assert_eq!(sent.status.code(), Some(1));
    let sent: serde_json::Value = serde_json::from_slice(&sent.stderr).unwrap();
    assert_eq!(sent["error"]["code"], "agent_not_ready");

    let agent_renamed = run_cli_json(&socket_path, &["agent", "rename", "worker", "reviewer"]);
    assert_eq!(agent_renamed["result"]["agent"]["name"], "reviewer");

    let focused = run_cli_json(&socket_path, &["agent", "focus", "reviewer"]);
    assert_eq!(focused["result"]["agent"]["focused"], true);

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_wait_returns_immediately_for_unseen_done_agent() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));

    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let first = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let workspace_id = created["result"]["workspace"]["workspace_id"]
        .as_str()
        .unwrap();
    let second_tab = run_cli_json(
        &socket_path,
        &["tab", "create", "--workspace", workspace_id],
    );
    let second_tab_id = second_tab["result"]["tab"]["tab_id"].as_str().unwrap();
    assert_ne!(second_tab_id, "w1:t1");
    assert!(run_cli(&socket_path, &["tab", "focus", second_tab_id])
        .status
        .success());
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &first,
            "--source",
            "custom:done",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    assert!(
        run_cli(&socket_path, &["agent", "rename", &first, "worker"])
            .status
            .success()
    );
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &first,
            "--source",
            "custom:done",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());

    let waited = run_cli_json(&socket_path, &["agent", "wait", "worker", "--timeout", "1"]);
    assert_eq!(waited["result"]["agent"]["agent_status"], "done");

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_wait_tolerates_detection_uncertainty_and_pane_target_rename() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));
    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let pane_id = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &pane_id,
            "--source",
            "custom:uncertain",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    assert!(
        run_cli(&socket_path, &["agent", "rename", &pane_id, "worker"])
            .status
            .success()
    );

    let wait_socket = socket_path.clone();
    let waiter = thread::spawn(move || {
        run_cli(
            &wait_socket,
            &[
                "agent",
                "wait",
                "worker",
                "--until",
                "unknown",
                "--timeout",
                "2000",
            ],
        )
    });
    thread::sleep(Duration::from_millis(150));
    let cleared = send_request(
        &socket_path,
        &format!(
            r#"{{"id":"agent_wait_uncertain","method":"pane.clear_agent_authority","params":{{"pane_id":"{}","source":"custom:uncertain"}}}}"#,
            pane_id
        ),
    );
    assert_eq!(cleared["result"]["type"], "ok");
    let waited = waiter.join().unwrap();
    assert!(
        waited.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&waited.stderr)
    );
    let waited: serde_json::Value = serde_json::from_slice(&waited.stdout).unwrap();
    assert_eq!(waited["result"]["agent"]["agent_status"], "unknown");
    assert_eq!(waited["result"]["agent"]["name"], "worker");

    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &pane_id,
            "--source",
            "custom:return",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    let wait_socket = socket_path.clone();
    let wait_pane = pane_id.clone();
    let waiter = thread::spawn(move || {
        run_cli(
            &wait_socket,
            &[
                "agent",
                "wait",
                &wait_pane,
                "--until",
                "idle",
                "--timeout",
                "2000",
            ],
        )
    });
    thread::sleep(Duration::from_millis(150));
    assert!(
        run_cli(&socket_path, &["agent", "rename", "worker", "reviewer"])
            .status
            .success()
    );
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &pane_id,
            "--source",
            "custom:return",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());
    let waited = waiter.join().unwrap();
    assert!(
        waited.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&waited.stderr)
    );
    let waited: serde_json::Value = serde_json::from_slice(&waited.stdout).unwrap();
    assert_eq!(waited["result"]["agent"]["agent_status"], "idle");
    assert_eq!(waited["result"]["agent"]["name"], "reviewer");

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_wait_pins_the_original_terminal_when_name_is_reused() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));

    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let first = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let split = run_cli_json(
        &socket_path,
        &["pane", "split", &first, "--direction", "right"],
    );
    let second = split["result"]["pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &first,
            "--source",
            "custom:race",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    assert!(
        run_cli(&socket_path, &["agent", "rename", &first, "worker"])
            .status
            .success()
    );

    let wait_socket = socket_path.clone();
    let waiter = thread::spawn(move || {
        run_cli(
            &wait_socket,
            &["agent", "wait", "worker", "--timeout", "2000"],
        )
    });
    thread::sleep(Duration::from_millis(250));
    assert!(
        run_cli(&socket_path, &["agent", "rename", "worker", "--clear"])
            .status
            .success()
    );
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &second,
            "--source",
            "custom:race",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());
    assert!(
        run_cli(&socket_path, &["agent", "rename", &second, "worker"])
            .status
            .success()
    );

    let waited = waiter.join().unwrap();
    assert_eq!(waited.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&waited.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_not_running");

    cleanup_spawned_herdr(herdr, base);
}

#[test]
fn agent_wait_ignores_other_panes_and_errors_when_its_pane_closes() {
    let base = unique_test_dir();
    let config_home = base.join("config");
    let runtime_dir = base.join("runtime");
    let socket_path = runtime_dir.join("herdr.sock");
    let herdr = spawn_herdr(&config_home, &runtime_dir, &socket_path);
    wait_for_socket(&socket_path, Duration::from_secs(5));

    let created = run_cli_json(
        &socket_path,
        &["workspace", "create", "--cwd", base.to_str().unwrap()],
    );
    let first = created["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let split = run_cli_json(
        &socket_path,
        &["pane", "split", &first, "--direction", "right"],
    );
    let second = split["result"]["pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &first,
            "--source",
            "custom:close",
            "--agent",
            "pi",
            "--state",
            "working",
        ],
    )
    .status
    .success());
    assert!(
        run_cli(&socket_path, &["agent", "rename", &first, "worker"])
            .status
            .success()
    );

    let wait_socket = socket_path.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(run_cli(
            &wait_socket,
            &["agent", "wait", "worker", "--timeout", "3000"],
        ));
    });
    thread::sleep(Duration::from_millis(150));
    assert!(run_cli(
        &socket_path,
        &[
            "pane",
            "report-agent",
            &second,
            "--source",
            "custom:close",
            "--agent",
            "pi",
            "--state",
            "idle",
        ],
    )
    .status
    .success());
    thread::sleep(Duration::from_millis(150));
    assert!(matches!(
        done_rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));

    assert!(run_cli(&socket_path, &["pane", "close", &first])
        .status
        .success());
    let waited = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(waited.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&waited.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_not_running");

    cleanup_spawned_herdr(herdr, base);
}
