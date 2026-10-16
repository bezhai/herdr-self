use super::harness::*;

/// A real server with a fake `pi` on its PATH and a calling agent: a shell
/// pane that reports itself as an idle `pi` agent.
struct CallServer {
    herdr: SpawnedHerdr,
    base: PathBuf,
    socket_path: PathBuf,
    caller: String,
    caller_dir: PathBuf,
    /// Arguments, one per line, of every fake `pi` launch.
    pi_args: PathBuf,
    /// Working directory of every fake `pi` launch.
    pi_cwds: PathBuf,
    /// Prompts that fake `pi` agents received.
    pi_prompts: PathBuf,
    /// While this file exists, fake `pi` agents stay blocked at startup, the
    /// way Codex stops at its "Trust this folder?" dialog.
    block_startup: PathBuf,
}

impl CallServer {
    fn start() -> Self {
        use std::os::unix::fs::PermissionsExt;

        let base = unique_test_dir();
        let config_home = base.join("config");
        let runtime_dir = base.join("runtime");
        let socket_path = runtime_dir.join("herdr.sock");
        let bin = base.join("bin");
        let caller_dir = base.join("caller");
        let pi_args = base.join("pi-args");
        let pi_cwds = base.join("pi-cwds");
        let pi_prompts = base.join("pi-prompts");
        let block_startup = base.join("block-startup");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&caller_dir).unwrap();
        let fake_pi = bin.join("pi");
        fs::write(
            &fake_pi,
            format!(
                "#!/bin/sh\n\
                 printf '%s\\n' \"$@\" >> '{args}'\n\
                 pwd >> '{cwds}'\n\
                 export HERDR_AGENT=pi\n\
                 state=idle\n\
                 if [ -e '{block}' ]; then state=blocked; fi\n\
                 '{herdr}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state \"$state\" >/dev/null\n\
                 while IFS= read -r prompt; do\n\
                 \x20 '{herdr}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state working >/dev/null\n\
                 \x20 printf '%s\\n' \"$prompt\" >> '{prompts}'\n\
                 \x20 '{herdr}' pane report-agent \"$HERDR_PANE_ID\" --source custom:fake-pi --agent pi --state idle >/dev/null\n\
                 done\n",
                args = pi_args.display(),
                cwds = pi_cwds.display(),
                block = block_startup.display(),
                prompts = pi_prompts.display(),
                herdr = env!("CARGO_BIN_EXE_herdr"),
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let herdr = spawn_herdr_with_path(
            &config_home,
            &runtime_dir,
            &socket_path,
            Some(Path::new(&path)),
        );
        wait_for_socket(&socket_path, Duration::from_secs(5));
        let created = run_cli_json(
            &socket_path,
            &["workspace", "create", "--cwd", caller_dir.to_str().unwrap()],
        );
        let caller = created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();
        let reported = run_cli(
            &socket_path,
            &[
                "pane",
                "report-agent",
                &caller,
                "--source",
                "custom:caller",
                "--agent",
                "pi",
                "--state",
                "idle",
            ],
        );
        assert!(reported.status.success(), "{reported:?}");
        Self {
            herdr,
            base,
            socket_path,
            caller,
            caller_dir,
            pi_args,
            pi_cwds,
            pi_prompts,
            block_startup,
        }
    }

    /// Starts a fake `pi` named `name` in a new workspace and returns its pane.
    fn start_callee(&self, name: &str) -> String {
        let created = run_cli_json(
            &self.socket_path,
            &[
                "workspace",
                "create",
                "--cwd",
                self.base.to_str().unwrap(),
                "--no-focus",
            ],
        );
        let pane = created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();
        let started = run_cli_json(
            &self.socket_path,
            &[
                "agent",
                "start",
                name,
                "--kind",
                "pi",
                "--pane",
                &pane,
                "--timeout",
                "8000",
            ],
        );
        assert_eq!(started["result"]["agent"]["interactive_ready"], true);
        pane
    }

    /// A plain shell pane in a new workspace, which runs no agent.
    fn shell_pane(&self) -> String {
        let created = run_cli_json(
            &self.socket_path,
            &[
                "workspace",
                "create",
                "--cwd",
                self.base.to_str().unwrap(),
                "--no-focus",
            ],
        );
        created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Runs `herdr agent call ARGS` with `HERDR_PANE_ID` set to `pane_env`,
    /// or unset.
    fn call(&self, pane_env: Option<&str>, args: &[&str]) -> std::process::Output {
        run_agent_call(&self.socket_path, pane_env, args)
    }

    fn pane(&self, pane_id: &str) -> serde_json::Value {
        run_cli_json(&self.socket_path, &["pane", "get", pane_id])["result"]["pane"].clone()
    }

    fn topology(&self) -> Vec<serde_json::Value> {
        pane_topology_snapshot(&run_cli_json(&self.socket_path, &["pane", "list"]))
    }

    fn wait_for_prompt(&self, prompt: &str) {
        assert!(
            wait_until(Duration::from_secs(5), Duration::from_millis(25), || {
                fs::read_to_string(&self.pi_prompts)
                    .is_ok_and(|prompts| prompts.lines().any(|line| line == prompt))
            }),
            "fake pi never received {prompt:?}; prompts: {:?}",
            fs::read_to_string(&self.pi_prompts)
        );
    }

    fn stop(self) {
        cleanup_spawned_herdr(self.herdr, self.base);
    }
}

fn run_agent_call(
    socket_path: &Path,
    pane_env: Option<&str>,
    args: &[&str],
) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_herdr"));
    command
        .args(["agent", "call"])
        .args(args)
        .env("HERDR_SOCKET_PATH", socket_path)
        .env_remove("HERDR_CLIENT_SOCKET_PATH");
    match pane_env {
        Some(pane) => command.env("HERDR_PANE_ID", pane),
        None => command.env_remove("HERDR_PANE_ID"),
    };
    command.output().unwrap()
}

fn success_json(output: &std::process::Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "agent call failed: {:?}\nstderr: {}\nstdout: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn error_json(output: &std::process::Output) -> serde_json::Value {
    assert_eq!(
        output.status.code(),
        Some(1),
        "stderr: {}\nstdout: {}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(output.stdout.is_empty());
    serde_json::from_slice(&output.stderr).unwrap_or_else(|err| {
        panic!(
            "stderr is not JSON ({err}): {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn agent_call_hands_a_task_to_an_existing_agent_for_the_pane_it_runs_in() {
    let server = CallServer::start();
    let reviewer = server.start_callee("reviewer");

    let called =
        success_json(&server.call(Some(&server.caller), &["reviewer", "Review this diff"]));

    assert_eq!(called["id"], "cli:agent:call");
    assert_eq!(called["result"]["type"], "agent_called");
    assert!(called["result"]["call_id"]
        .as_u64()
        .is_some_and(|id| id > 0));
    assert_eq!(called["result"]["agent"]["name"], "reviewer");
    assert_eq!(called["result"]["agent"]["pane_id"], reviewer);
    server.wait_for_prompt("Review this diff");
    assert_eq!(
        server.pane(&reviewer)["remote_answers"],
        serde_json::Value::Null
    );

    let missing = error_json(&server.call(Some(&server.caller), &["nobody", "Review this diff"]));
    assert_eq!(missing["error"]["code"], "agent_not_found");
    let itself = error_json(&server.call(Some(&reviewer), &["reviewer", "Review this diff"]));
    assert_eq!(itself["error"]["code"], "caller_is_target");

    server.stop();
}

#[test]
fn agent_call_to_names_the_caller_instead_of_the_pane_it_runs_in() {
    let server = CallServer::start();
    let checker = server.start_callee("checker");
    let shell = server.shell_pane();

    let refused = error_json(&server.call(Some(&shell), &["checker", "Check the tests"]));
    assert_eq!(refused["error"]["code"], "caller_not_agent");

    let called = success_json(&server.call(
        Some(&shell),
        &[
            "checker",
            "Check the tests",
            "--to",
            &server.caller,
            "--answer-requests",
        ],
    ));
    assert_eq!(called["result"]["agent"]["name"], "checker");
    assert_eq!(called["result"]["agent"]["pane_id"], checker);
    server.wait_for_prompt("Check the tests");
    assert_eq!(server.pane(&checker)["remote_answers"], true);

    server.stop();
}

#[test]
fn agent_call_without_a_caller_is_a_usage_error() {
    let base = unique_test_dir();
    // Nothing listens here: a command that contacted the server would report
    // server_not_running instead of a usage error.
    let socket_path = base.join("missing.sock");

    for args in [
        &["reviewer", "Review this diff"][..],
        &["--kind", "pi", "Review this diff"][..],
    ] {
        let output = run_agent_call(&socket_path, None, args);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--to"), "{args:?}: {stderr}");
        assert!(stderr.contains("HERDR_PANE_ID"), "{args:?}: {stderr}");
    }

    cleanup_test_base(&base);
}

#[test]
fn agent_call_kind_starts_the_agent_beside_the_caller_and_calls_it() {
    let server = CallServer::start();
    let caller_tab = server.pane(&server.caller)["tab_id"].clone();
    assert_eq!(server.pane(&server.caller)["focused"], true);

    let called = success_json(&server.call(
        Some(&server.caller),
        &["--kind", "pi", "Write the tests", "--", "--no-session"],
    ));

    assert_eq!(called["id"], "cli:agent:call");
    assert_eq!(called["result"]["type"], "agent_called");
    assert!(called["result"]["call_id"].as_u64().is_some());
    assert_eq!(called["result"]["agent"]["name"], "pi-1");
    assert_eq!(called["result"]["agent"]["agent"], "pi");
    let callee = called["result"]["agent"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(callee, server.caller);
    let callee_pane = server.pane(&callee);
    assert_eq!(callee_pane["tab_id"], caller_tab);
    assert_eq!(callee_pane["focused"], false);
    assert_eq!(server.pane(&server.caller)["focused"], true);
    let neighbor = run_cli_json(
        &server.socket_path,
        &[
            "pane",
            "neighbor",
            "--pane",
            &server.caller,
            "--direction",
            "right",
        ],
    );
    assert_eq!(neighbor["result"]["neighbor"]["neighbor_pane_id"], callee);
    assert_eq!(
        fs::read_to_string(&server.pi_args).unwrap(),
        "--no-session\n"
    );
    assert_eq!(
        fs::read_to_string(&server.pi_cwds).unwrap(),
        format!("{}\n", server.caller_dir.display())
    );
    server.wait_for_prompt("Write the tests");

    let elsewhere = server.base.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    let second = success_json(&server.call(
        Some(&server.caller),
        &[
            "--kind",
            "pi",
            "--cwd",
            elsewhere.to_str().unwrap(),
            "Write the docs",
        ],
    ));
    assert_eq!(second["result"]["agent"]["name"], "pi-2");
    assert_eq!(
        fs::read_to_string(&server.pi_cwds).unwrap(),
        format!("{}\n{}\n", server.caller_dir.display(), elsewhere.display())
    );
    server.wait_for_prompt("Write the docs");

    server.stop();
}

#[test]
fn agent_call_kind_splits_the_to_pane() {
    let server = CallServer::start();
    let shell = server.shell_pane();

    let called = success_json(&server.call(
        Some(&shell),
        &["--kind", "pi", "--to", &server.caller, "Write the tests"],
    ));

    let callee = called["result"]["agent"]["pane_id"].as_str().unwrap();
    assert_eq!(
        server.pane(callee)["tab_id"],
        server.pane(&server.caller)["tab_id"]
    );
    server.wait_for_prompt("Write the tests");

    server.stop();
}

#[test]
fn agent_call_kind_keeps_and_reports_the_new_pane_when_the_agent_does_not_start() {
    let server = CallServer::start();
    fs::write(&server.block_startup, "").unwrap();
    let before = server.topology();

    let failed = error_json(&server.call(
        Some(&server.caller),
        &["--kind", "pi", "--name", "helper", "Write the tests"],
    ));

    assert_eq!(failed["error"]["code"], "agent_not_ready");
    assert_eq!(failed["error"]["agent_name"], "helper");
    let kept = failed["error"]["pane_id"].as_str().unwrap().to_string();
    let message = failed["error"]["message"].as_str().unwrap();
    assert!(message.contains(&kept), "{message}");
    assert!(message.contains("helper"), "{message}");
    let after = server.topology();
    assert_eq!(after.len(), before.len() + 1);
    assert!(after.iter().any(|pane| pane["pane_id"] == kept.as_str()));
    assert_eq!(
        server.pane(&kept)["tab_id"],
        server.pane(&server.caller)["tab_id"]
    );
    assert!(!server.pi_prompts.exists());

    server.stop();
}

#[test]
fn agent_call_kind_checks_its_arguments_and_the_caller_before_splitting() {
    let server = CallServer::start();
    let shell = server.shell_pane();
    let named = server.shell_pane();
    for args in [
        &[
            "pane",
            "report-agent",
            &named,
            "--source",
            "custom:named",
            "--agent",
            "pi",
            "--state",
            "idle",
        ][..],
        &["agent", "rename", &named, "taken"][..],
    ] {
        let output = run_cli(&server.socket_path, args);
        assert!(output.status.success(), "{args:?}: {output:?}");
    }
    let before = server.topology();

    let not_agent = error_json(&server.call(Some(&shell), &["--kind", "pi", "Write the tests"]));
    assert_eq!(not_agent["error"]["code"], "caller_not_agent");

    let missing = error_json(&server.call(
        Some(&server.caller),
        &["--kind", "pi", "--to", "w999:p1", "Write the tests"],
    ));
    assert_eq!(missing["error"]["code"], "pane_not_found");

    let taken = error_json(&server.call(
        Some(&server.caller),
        &["--kind", "pi", "--name", "taken", "Write the tests"],
    ));
    assert_eq!(taken["error"]["code"], "agent_name_taken");

    for args in [
        &["--kind", "nope", "Write the tests"][..],
        &["--kind", "pi", "--name", "Not-Valid", "Write the tests"][..],
        &["--kind", "pi", ""][..],
        &["--kind", "pi", "pi-1", "Write the tests"][..],
        &["--name", "helper", "reviewer", "Write the tests"][..],
    ] {
        let output = server.call(Some(&server.caller), args);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
    }

    assert_eq!(server.topology(), before);
    assert!(!server.pi_args.exists());

    server.stop();
}
