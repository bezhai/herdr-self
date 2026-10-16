use std::time::{Duration, Instant};

use crate::api::schema::{
    AgentAnswerParams, AgentCallParams, AgentPromptParams, AgentPromptWaitOptions, AgentReadParams,
    AgentRenameParams, AgentRepliesParams, AgentRequestAnswer, AgentRequestDecision,
    AgentSendKeysParams, AgentStartParams, AgentTarget, AgentToolCallsParams, AgentWaitParams,
    EmptyParams, ErrorBody, ErrorResponse, Method, PaneProcessInfoParams, PaneRightClickTarget,
    PaneSplitParams, PaneTarget, ReadFormat, ReadSource, Request, SplitDirection,
};

const AGENT_START_POLL_INTERVAL: Duration = Duration::from_millis(100);
const PANE_SHELL_READINESS_RETRY_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) fn run_agent_command(args: &[String]) -> std::io::Result<i32> {
    let Some(subcommand) = args.first().map(|arg| arg.as_str()) else {
        print_agent_help();
        return Ok(2);
    };

    match subcommand {
        "list" => agent_list(&args[1..]),
        "get" => agent_get(&args[1..]),
        "replies" => agent_replies(&args[1..]),
        "tool-calls" => agent_tool_calls(&args[1..]),
        "requests" => agent_requests(&args[1..]),
        "answer" => agent_answer(&args[1..]),
        "read" => agent_read(&args[1..]),
        "send-keys" => agent_send_keys(&args[1..]),
        "prompt" => agent_prompt(&args[1..]),
        "call" => agent_call(&args[1..]),
        "rename" => agent_rename(&args[1..]),
        "focus" => agent_focus(&args[1..]),
        "wait" => agent_wait(&args[1..]),
        "attach" => agent_attach(&args[1..]),
        "start" => agent_start(&args[1..]),
        "explain" => agent_explain(&args[1..]),
        "help" | "--help" | "-h" => {
            print_agent_help();
            Ok(0)
        }
        _ => {
            print_agent_help();
            Ok(2)
        }
    }
}

fn agent_explain(args: &[String]) -> std::io::Result<i32> {
    let mut file = None;
    let mut agent = None;
    let mut json = false;
    let mut verbose = false;
    let mut target = None;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--file" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --file");
                    return Ok(2);
                };
                file = Some(value.clone());
                index += 2;
            }
            "--agent" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --agent");
                    return Ok(2);
                };
                agent = Some(value.clone());
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--format" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --format");
                    return Ok(2);
                };
                match value.as_str() {
                    "json" => json = true,
                    "text" => json = false,
                    other => {
                        eprintln!("invalid --format: {other} (expected text or json)");
                        return Ok(2);
                    }
                }
                index += 2;
            }
            "--verbose" | "-v" => {
                verbose = true;
                index += 1;
            }
            "help" | "--help" | "-h" => {
                eprintln!("usage: herdr agent explain <target> [--json|--verbose]");
                eprintln!(
                    "usage: herdr agent explain --file PATH --agent LABEL [--json|--verbose]"
                );
                return Ok(0);
            }
            value if value.starts_with('-') => {
                eprintln!("unknown option: {value}");
                return Ok(2);
            }
            value => {
                if target.is_some() {
                    eprintln!("usage: herdr agent explain <target> [--json]");
                    return Ok(2);
                }
                target = Some(value.to_string());
                index += 1;
            }
        }
    }

    let explain = if let Some(path) = file {
        if target.is_some() {
            eprintln!("usage: herdr agent explain --file PATH --agent LABEL [--json]");
            return Ok(2);
        }
        let Some(agent_label) = agent else {
            eprintln!("herdr agent explain --file requires --agent LABEL");
            return Ok(2);
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(err) => {
                let response = ErrorResponse {
                    id: "cli:agent:explain".into(),
                    error: ErrorBody {
                        code: "agent_explain_file_read_failed".into(),
                        message: format!("failed to read agent explain file {path}: {err}"),
                    },
                };
                let response = serde_json::to_string(&response).map_err(std::io::Error::other)?;
                eprintln!("{response}");
                return Ok(1);
            }
        };
        crate::detect::manifest::explain_to_json_value(&crate::detect::manifest::explain_for_label(
            &agent_label,
            &content,
        ))
    } else {
        let Some(target) = target else {
            eprintln!("usage: herdr agent explain <target> [--json]");
            eprintln!("usage: herdr agent explain --file PATH --agent LABEL [--json]");
            return Ok(2);
        };
        if agent.is_some() {
            eprintln!("--agent is only valid with --file");
            return Ok(2);
        }

        let response = super::send_request(&Request {
            id: "cli:agent:explain".into(),
            method: Method::AgentExplain(AgentTarget {
                target: target.to_owned(),
            }),
        })?;
        if response.get("error").is_some() {
            eprintln!("{}", serde_json::to_string(&response).unwrap());
            return Ok(1);
        }
        response["result"]["explain"].clone()
    };

    if json {
        println!("{explain}");
    } else {
        print_agent_explain_text(&explain, verbose);
    }
    Ok(0)
}

fn print_agent_explain_text(explain: &serde_json::Value, verbose: bool) {
    println!("agent: {}", explain["agent"].as_str().unwrap_or("unknown"));
    println!("state: {}", explain["state"].as_str().unwrap_or("unknown"));
    println!(
        "manifest: {} {}",
        explain["manifest_source"].as_str().unwrap_or("none"),
        explain["manifest_version"].as_str().unwrap_or("unknown")
    );
    if let Some(rule) = explain["matched_rule"].as_object() {
        let rule_id = rule
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        println!(
            "rule: {} (region={} priority={})",
            rule_id,
            rule.get("region")
                .and_then(|value| value.as_str())
                .unwrap_or("-"),
            rule.get("priority")
                .and_then(|value| value.as_i64())
                .unwrap_or(0),
        );
        if let Some(preview) = matched_rule_region_preview(explain, rule_id) {
            println!("evidence: {preview:?}");
        }
    } else {
        println!("rule: none");
    }
    if let Some(reason) = explain["fallback_reason"].as_str() {
        println!("fallback_reason: {reason}");
    }
    if let Some(reason) = explain["screen_detection_skip_reason"].as_str() {
        println!("screen_detection_skip_reason: {reason}");
    }
    if let Some(reason) = explain["skipped_update_reason"].as_str() {
        println!("skipped_update_reason: {reason}");
    }
    if let Some(warning) = explain["warning"].as_str() {
        println!("warning: {warning}");
    }

    if !verbose {
        return;
    }

    println!(
        "visible: idle={} blocker={} working={}",
        explain["visible_idle"].as_bool().unwrap_or(false),
        explain["visible_blocker"].as_bool().unwrap_or(false),
        explain["visible_working"].as_bool().unwrap_or(false)
    );
    println!(
        "cached_remote_version: {}",
        explain["cached_remote_version"].as_str().unwrap_or("none")
    );
    println!(
        "local_override_shadowing_remote: {}",
        explain["local_override_shadowing_remote"]
            .as_bool()
            .unwrap_or(false)
    );
    if let Some(status) = explain["remote_update_status"].as_str() {
        println!("remote_update_status: {status}");
    }
    if let Some(error) = explain["remote_update_error"].as_str() {
        println!("remote_update_error: {error}");
    }
    if let Some(evaluated_rules) = explain["evaluated_rules"]
        .as_array()
        .filter(|rules| !rules.is_empty())
    {
        println!("evaluated_rules:");
        for rule in evaluated_rules {
            println!(
                "  {} {} priority={} region={} state={}",
                if rule["matched"].as_bool().unwrap_or(false) {
                    "✓"
                } else {
                    "✗"
                },
                rule["id"].as_str().unwrap_or("-"),
                rule["priority"].as_i64().unwrap_or(0),
                rule["region"].as_str().unwrap_or("-"),
                rule["state"].as_str().unwrap_or("unknown")
            );
            let evidence = &rule["evidence"];
            println!(
                "    matchers: contains={:?} regex={:?} line_regex={:?} all={} any={} not={}",
                evidence["contains"],
                evidence["regex"],
                evidence["line_regex"],
                evidence["all_count"].as_u64().unwrap_or(0),
                evidence["any_count"].as_u64().unwrap_or(0),
                evidence["not_count"].as_u64().unwrap_or(0)
            );
            println!(
                "    region: bytes={} preview={:?}",
                evidence["region_bytes"].as_u64().unwrap_or(0),
                evidence["region_preview"].as_str().unwrap_or("")
            );
        }
    }
}

fn matched_rule_region_preview<'a>(
    explain: &'a serde_json::Value,
    rule_id: &str,
) -> Option<&'a str> {
    explain["evaluated_rules"]
        .as_array()?
        .iter()
        .find(|rule| rule["id"].as_str() == Some(rule_id))?["evidence"]["region_preview"]
        .as_str()
        .filter(|preview| !preview.is_empty())
}

fn agent_start(args: &[String]) -> std::io::Result<i32> {
    let request = match parse_agent_start_args(args) {
        Ok(request) => request,
        Err(exit_code) => return Ok(exit_code),
    };
    match start_agent_in_pane(&request)? {
        AgentStartEnd::Response(response) => super::print_response(&response),
        AgentStartEnd::WaitFailed(err) => {
            print_agent_transport_error(err, "cli:agent:start", "agent_start_transport_failed")
        }
    }
}

/// An agent to start in an existing shell pane.
struct AgentStartRequest {
    name: String,
    /// Canonical agent kind label.
    kind: String,
    pane_id: String,
    agent_args: Vec<String>,
    timeout_ms: Option<u64>,
}

/// How starting an agent ended.
enum AgentStartEnd {
    /// The response to print: the started agent, or why it did not start.
    Response(serde_json::Value),
    /// The server stopped answering while the agent was starting.
    WaitFailed(std::io::Error),
}

/// Parses `herdr agent start`; the error is the exit code of a usage error
/// that was already printed.
fn parse_agent_start_args(args: &[String]) -> Result<AgentStartRequest, i32> {
    let Some(name) = args.first() else {
        eprintln!("usage: herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]");
        return Err(2);
    };
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut kind = None;
    let mut pane_id = None;
    let mut timeout_ms = None;
    let mut index = 1;
    while index < separator {
        match args[index].as_str() {
            "--kind" => {
                let Some(value) = args.get(index + 1).filter(|_| index + 1 < separator) else {
                    eprintln!("missing value for --kind");
                    return Err(2);
                };
                kind = Some(value.clone());
                index += 2;
            }
            "--pane" => {
                let Some(value) = args.get(index + 1).filter(|_| index + 1 < separator) else {
                    eprintln!("missing value for --pane");
                    return Err(2);
                };
                pane_id = Some(super::normalize_pane_id(value));
                index += 2;
            }
            "--timeout" => {
                let Some(value) = args.get(index + 1).filter(|_| index + 1 < separator) else {
                    eprintln!("missing value for --timeout");
                    return Err(2);
                };
                timeout_ms = Some(parse_timeout(value)?);
                index += 2;
            }
            other => {
                eprintln!("unknown option: {other}");
                return Err(2);
            }
        }
    }
    let Some(kind) = kind else {
        eprintln!("missing required --kind");
        return Err(2);
    };
    let Some(pane_id) = pane_id else {
        eprintln!("missing required --pane");
        return Err(2);
    };
    let kind = agent_kind_label(&kind).map_err(|message| {
        eprintln!("{message}");
        2
    })?;
    let agent_args = if separator < args.len() {
        args[separator + 1..].to_vec()
    } else {
        Vec::new()
    };
    Ok(AgentStartRequest {
        name: name.clone(),
        kind,
        pane_id,
        agent_args,
        timeout_ms,
    })
}

/// The canonical label of agent kind `kind`, or the usage error for a kind
/// Herdr cannot start.
fn agent_kind_label(kind: &str) -> Result<String, String> {
    crate::detect::parse_agent_label(kind)
        .map(|agent| crate::detect::agent_label(agent).to_string())
        .ok_or_else(|| format!("unsupported interactive agent kind: {kind}"))
}

/// Starts the agent in its pane and waits until it is ready for prompts.
fn start_agent_in_pane(request: &AgentStartRequest) -> std::io::Result<AgentStartEnd> {
    let AgentStartRequest {
        name,
        kind,
        pane_id,
        agent_args,
        timeout_ms,
    } = request;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let retryable_timeout = timeout > crate::app::AGENT_START_SETTLE_DELAY
        && timeout <= crate::app::MAX_AGENT_START_TIMEOUT;
    let pinned_terminal_id = pane_terminal_id(pane_id)?;
    let mut retry_deadline = None;
    let mut previous_busy_response: Option<serde_json::Value> = None;
    let mut response = loop {
        if let Some(previous_busy_response) = previous_busy_response.as_ref() {
            let retry_expired = retry_deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if retry_expired
                || pane_terminal_id(pane_id)? != pinned_terminal_id
                || !pane_shell_is_initializing(pane_id)?
            {
                return Ok(AgentStartEnd::Response(previous_busy_response.clone()));
            }
        }

        let response = super::send_request(&Request {
            id: "cli:agent:start".into(),
            method: Method::AgentStart(AgentStartParams {
                name: name.clone(),
                kind: kind.clone(),
                pane_id: pane_id.clone(),
                args: agent_args.clone(),
                timeout_ms: *timeout_ms,
            }),
        })?;
        if response.get("error").is_none() {
            break response;
        }
        if response["error"]["code"].as_str() != Some("agent_pane_busy")
            || !retryable_timeout
            || pinned_terminal_id.is_none()
            || pane_terminal_id(pane_id)? != pinned_terminal_id
            || !pane_shell_is_initializing(pane_id)?
        {
            return Ok(AgentStartEnd::Response(response));
        }

        let deadline = *retry_deadline
            .get_or_insert_with(|| Instant::now() + PANE_SHELL_READINESS_RETRY_TIMEOUT);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(AgentStartEnd::Response(response));
        }
        previous_busy_response = Some(response);
        std::thread::sleep(AGENT_START_POLL_INTERVAL.min(remaining));
    };

    let Some(expected_terminal_id) = response["result"]["agent"]["terminal_id"].as_str() else {
        return Ok(AgentStartEnd::Response(cli_agent_error(
            "cli:agent:start",
            "agent_start_failed",
            "agent start response did not include terminal_id",
        )));
    };
    if pinned_terminal_id
        .as_deref()
        .is_some_and(|pinned| pinned != expected_terminal_id)
    {
        return Ok(AgentStartEnd::Response(agent_name_lost_error(
            "cli:agent:start",
            name,
        )));
    }
    let waited = wait_for_named_agent(name, pane_id, timeout, kind, expected_terminal_id);
    Ok(match waited {
        Ok(Ok(agent)) => {
            response["result"]["agent"] = agent;
            AgentStartEnd::Response(response)
        }
        Ok(Err(error)) => AgentStartEnd::Response(error),
        Err(err) => AgentStartEnd::WaitFailed(err),
    })
}

fn agent_list(args: &[String]) -> std::io::Result<i32> {
    if !args.is_empty() {
        eprintln!("usage: herdr agent list");
        return Ok(2);
    }

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:list".into(),
        method: Method::AgentList(EmptyParams::default()),
    })?)
}

fn agent_get(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = args.first() else {
        eprintln!("usage: herdr agent get <target>");
        return Ok(2);
    };
    if args.len() != 1 {
        eprintln!("usage: herdr agent get <target>");
        return Ok(2);
    }

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:get".into(),
        method: Method::AgentGet(AgentTarget {
            target: target.clone(),
        }),
    })?)
}

fn agent_replies(args: &[String]) -> std::io::Result<i32> {
    let (target, after_seq) =
        match parse_target_after_seq(args, "usage: herdr agent replies <target> [--after SEQ]") {
            Ok(parsed) => parsed,
            Err(message) => {
                eprintln!("{message}");
                return Ok(2);
            }
        };

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:replies".into(),
        method: Method::AgentReplies(AgentRepliesParams { target, after_seq }),
    })?)
}

fn agent_tool_calls(args: &[String]) -> std::io::Result<i32> {
    let (target, after_seq) = match parse_target_after_seq(
        args,
        "usage: herdr agent tool-calls <target> [--after SEQ]",
    ) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:tool-calls".into(),
        method: Method::AgentToolCalls(AgentToolCallsParams { target, after_seq }),
    })?)
}

/// Parses `<target> [--after SEQ]`, the arguments of commands that read an
/// agent's retained records incrementally.
fn parse_target_after_seq(args: &[String], usage: &str) -> Result<(String, Option<u64>), String> {
    let args = super::expand_equals_args(args, &["--after"]);
    let mut target = None;
    let mut after_seq = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--after" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --after".to_string())?;
                after_seq =
                    Some(super::parse_u64_flag("--after", value).map_err(|err| err.to_string())?);
                index += 2;
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {other}")),
            value if target.is_none() => {
                target = Some(value.to_string());
                index += 1;
            }
            _ => return Err(usage.to_string()),
        }
    }
    let target = target.ok_or_else(|| usage.to_string())?;
    Ok((target, after_seq))
}

fn agent_requests(args: &[String]) -> std::io::Result<i32> {
    let [target] = args else {
        eprintln!("usage: herdr agent requests <target>");
        return Ok(2);
    };

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:requests".into(),
        method: Method::AgentRequests(AgentTarget {
            target: target.clone(),
        }),
    })?)
}

const AGENT_ANSWER_USAGE: &str = "usage: herdr agent answer <target> <request_id> (--decision allow|allow_always|deny [--message TEXT] | --answers JSON)";

fn agent_answer(args: &[String]) -> std::io::Result<i32> {
    match parse_agent_answer(args) {
        Ok(params) => super::print_response(&super::send_request(&Request {
            id: "cli:agent:answer".into(),
            method: Method::AgentAnswer(params),
        })?),
        Err(message) => {
            eprintln!("{message}");
            Ok(2)
        }
    }
}

fn parse_agent_answer(args: &[String]) -> Result<AgentAnswerParams, String> {
    let args = super::expand_equals_args(args, &["--decision", "--message", "--answers"]);
    let mut positionals = Vec::new();
    let mut decision = None;
    let mut message = None;
    let mut answers = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--decision" | "--message" | "--answers" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("missing value for {arg}"))?;
                match arg {
                    "--decision" => decision = Some(parse_agent_decision(value)?),
                    "--message" => message = Some(value.clone()),
                    _ => answers = Some(parse_agent_answers(value)?),
                }
                index += 2;
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {other}")),
            value => {
                positionals.push(value.to_string());
                index += 1;
            }
        }
    }
    let [target, request_id] = positionals.as_slice() else {
        return Err(AGENT_ANSWER_USAGE.into());
    };
    let request_id =
        super::parse_u64_flag("<request_id>", request_id).map_err(|err| err.to_string())?;
    if decision.is_some() && answers.is_some() {
        return Err("use either --decision or --answers".into());
    }
    if message.is_some() && decision.is_none() {
        return Err("--message requires --decision".into());
    }
    if decision.is_none() && answers.is_none() {
        return Err(AGENT_ANSWER_USAGE.into());
    }
    Ok(AgentAnswerParams {
        target: target.clone(),
        request_id,
        answer: AgentRequestAnswer {
            decision,
            message,
            answers,
        },
    })
}

fn parse_agent_decision(value: &str) -> Result<AgentRequestDecision, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string())).map_err(|_| {
        format!("invalid value for --decision: {value} (expected allow, allow_always, or deny)")
    })
}

fn parse_agent_answers(
    value: &str,
) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    serde_json::from_str(value).map_err(|err| {
        format!(
            "invalid value for --answers: expected a JSON object mapping each question to an array of strings ({err})"
        )
    })
}

fn agent_focus(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = args.first() else {
        eprintln!("usage: herdr agent focus <target>");
        return Ok(2);
    };
    if args.len() != 1 {
        eprintln!("usage: herdr agent focus <target>");
        return Ok(2);
    }

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:focus".into(),
        method: Method::AgentFocus(AgentTarget {
            target: target.clone(),
        }),
    })?)
}

fn agent_attach(args: &[String]) -> std::io::Result<i32> {
    let (target, takeover) =
        match super::parse_attach_target(args, "usage: herdr agent attach <target> [--takeover]") {
            Ok(parsed) => parsed,
            Err(code) => return Ok(code),
        };

    let response = resolve_agent_target(&target, "cli:agent:attach:resolve")?;
    if response.get("error").is_some() {
        eprintln!("{}", serde_json::to_string(&response).unwrap());
        return Ok(1);
    }
    let Some(terminal_id) = response["result"]["agent"]["terminal_id"].as_str() else {
        eprintln!("agent attach failed: response did not include terminal_id");
        return Ok(1);
    };
    crate::client::run_terminal_attach(terminal_id.to_owned(), takeover)?;
    Ok(0)
}

fn agent_wait(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = args.first() else {
        eprintln!("usage: herdr agent wait <target> [--until STATUS]... [--timeout MS]");
        return Ok(2);
    };
    let mut until = Vec::new();
    let mut timeout_ms = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--until" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("--until requires at least one status");
                    return Ok(2);
                };
                let status = match super::parse_agent_status(value) {
                    Ok(status) => status,
                    Err(err) => {
                        eprintln!("{err}");
                        return Ok(2);
                    }
                };
                until.push(status);
                index += 2;
            }
            "--timeout" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --timeout");
                    return Ok(2);
                };
                timeout_ms = match parse_timeout(value) {
                    Ok(timeout_ms) => Some(timeout_ms),
                    Err(exit_code) => return Ok(exit_code),
                };
                index += 2;
            }
            "help" | "--help" | "-h" => {
                eprintln!("usage: herdr agent wait <target> [--until STATUS]... [--timeout MS]");
                return Ok(0);
            }
            other => {
                eprintln!("unknown option: {other}");
                return Ok(2);
            }
        }
    }
    super::print_response(&super::send_request(&Request {
        id: "cli:agent:wait".into(),
        method: Method::AgentWait(AgentWaitParams {
            target: target.clone(),
            until,
            timeout_ms,
        }),
    })?)
}

fn wait_for_named_agent(
    name: &str,
    fallback_pane_id: &str,
    timeout: Duration,
    expected_kind: &str,
    expected_terminal_id: &str,
) -> std::io::Result<Result<serde_json::Value, serde_json::Value>> {
    let deadline = Instant::now().checked_add(timeout);
    let mut first_poll = true;
    loop {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            // Let the server reconcile its matching startup deadline before
            // returning so the pending name is immediately reusable.
            let _ = resolve_agent_target_unchecked(name, "cli:agent:start:timeout");
            return Ok(Err(agent_wait_timeout()));
        }
        let poll_id = "cli:agent:start";
        let mut response = if first_poll {
            first_poll = false;
            resolve_agent_target(name, poll_id)?
        } else {
            resolve_agent_target_unchecked(name, poll_id)?
        };
        if response.get("error").is_some() {
            response = resolve_agent_target_unchecked(fallback_pane_id, poll_id)?;
            if response.get("error").is_some() {
                std::thread::sleep(AGENT_START_POLL_INTERVAL);
                continue;
            }
        }
        let agent = &response["result"]["agent"];
        let outcome = if agent["terminal_id"].as_str() != Some(expected_terminal_id) {
            Some(Err(agent_name_lost_error("cli:agent:start", name)))
        } else if let Some(actual) = agent["agent"]
            .as_str()
            .filter(|actual| *actual != expected_kind)
        {
            Some(Err(cli_agent_error(
                "cli:agent:start",
                "agent_kind_mismatch",
                format!("expected {expected_kind}, detected {actual}"),
            )))
        } else if agent["name"].as_str() != Some(name) {
            Some(Err(agent_name_lost_error("cli:agent:start", name)))
        } else {
            match agent["agent_status"].as_str() {
                Some("blocked") => Some(Err(cli_agent_error(
                    "cli:agent:start",
                    "agent_not_ready",
                    format!("agent {name} is blocked during startup and is not ready for prompts"),
                ))),
                Some("working" | "unknown") => None,
                Some("idle" | "done") if agent["interactive_ready"].as_bool() == Some(true) => {
                    Some(Ok(agent.clone()))
                }
                Some("idle" | "done") if !agent["launch_pending"].as_bool().unwrap_or(false) => {
                    Some(Err(cli_agent_error(
                        "cli:agent:start",
                        "agent_start_failed",
                        "agent process exited before becoming interactive",
                    )))
                }
                _ => None,
            }
        };
        if let Some(outcome) = outcome {
            return Ok(outcome);
        }
        std::thread::sleep(AGENT_START_POLL_INTERVAL);
    }
}

fn pane_terminal_id(pane_id: &str) -> std::io::Result<Option<String>> {
    let response = super::send_request(&Request {
        id: "cli:agent:start:pane".into(),
        method: Method::PaneGet(PaneTarget {
            pane_id: pane_id.to_owned(),
        }),
    })?;
    Ok(response["result"]["pane"]["terminal_id"]
        .as_str()
        .map(str::to_owned))
}

fn pane_shell_is_initializing(pane_id: &str) -> std::io::Result<bool> {
    let response = super::send_request(&Request {
        id: "cli:agent:start:process_info".into(),
        method: Method::PaneProcessInfo(PaneProcessInfoParams {
            pane_id: Some(pane_id.to_owned()),
        }),
    })?;
    Ok(process_info_shows_shell_initialization(
        &response["result"]["process_info"],
    ))
}

#[cfg(unix)]
fn process_info_shows_shell_initialization(process_info: &serde_json::Value) -> bool {
    let Some(shell_pid) = process_info["shell_pid"].as_u64() else {
        return false;
    };
    if process_info["foreground_process_group_id"].as_u64() != Some(shell_pid) {
        return false;
    }
    process_info["foreground_processes"]
        .as_array()
        .is_some_and(|processes| {
            processes.iter().any(|process| {
                process["pid"].as_u64() == Some(shell_pid)
                    && (process["name"]
                        .as_str()
                        .is_some_and(crate::platform::is_pane_shell_process_name)
                        || process["argv"]
                            .as_array()
                            .and_then(|argv| argv.first())
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(crate::platform::is_pane_shell_process_name))
            })
        })
}

// Windows exposes no foreground process group, so shell initialization is not
// observable and a busy `agent.start` is not retried there.
#[cfg(not(unix))]
fn process_info_shows_shell_initialization(_process_info: &serde_json::Value) -> bool {
    false
}

fn agent_name_lost_error(request_id: &str, expected_name: &str) -> serde_json::Value {
    cli_agent_error(
        request_id,
        "agent_name_not_found",
        format!("named agent {expected_name} no longer owns the target terminal"),
    )
}

fn print_agent_transport_error(
    err: std::io::Error,
    request_id: &str,
    code: &str,
) -> std::io::Result<i32> {
    match agent_transport_error_response(err, request_id, code)? {
        Some(response) => super::print_response(&response),
        None => Ok(1),
    }
}

/// The error response for a request that lost the server, or `None` when
/// the failure was already reported.
fn agent_transport_error_response(
    err: std::io::Error,
    request_id: &str,
    code: &str,
) -> std::io::Result<Option<serde_json::Value>> {
    if super::protocol_mismatch_was_reported(&err) {
        return Ok(None);
    }
    // A dead-server marker reaches here from `send_request` in the agent
    // startup path; surface its deferred response exactly once instead of
    // printing a second, generic transport-error line.
    if let Some(response) = super::server_not_running_reported_response(&err) {
        return serde_json::to_value(response)
            .map(Some)
            .map_err(std::io::Error::other);
    }
    Ok(Some(cli_agent_error(request_id, code, err.to_string())))
}

fn agent_wait_timeout() -> serde_json::Value {
    cli_agent_error(
        "cli:agent:start",
        "timeout",
        "timed out waiting for agent startup",
    )
}

fn cli_agent_error(id: &str, code: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn resolve_agent_target(target: &str, request_id: &str) -> std::io::Result<serde_json::Value> {
    super::send_request(&agent_get_request(target, request_id))
}

fn resolve_agent_target_unchecked(
    target: &str,
    request_id: &str,
) -> std::io::Result<serde_json::Value> {
    super::send_request_unchecked(&agent_get_request(target, request_id))
}

fn agent_get_request(target: &str, request_id: &str) -> Request {
    Request {
        id: request_id.into(),
        method: Method::AgentGet(AgentTarget {
            target: target.to_owned(),
        }),
    }
}

fn agent_rename(args: &[String]) -> std::io::Result<i32> {
    let [target, value] = args else {
        eprintln!("usage: herdr agent rename <target> <name>|--clear");
        return Ok(2);
    };
    let name = if value == "--clear" {
        None
    } else {
        Some(value.clone())
    };

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:rename".into(),
        method: Method::AgentRename(AgentRenameParams {
            target: target.clone(),
            name,
        }),
    })?)
}

fn agent_prompt(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = args.first() else {
        eprintln!(
            "usage: herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]"
        );
        return Ok(2);
    };
    let Some(text) = args.get(1) else {
        eprintln!("agent prompt requires text");
        return Ok(2);
    };
    let mut wait = false;
    let mut until = Vec::new();
    let mut timeout_ms = None;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--wait" => {
                wait = true;
                index += 1;
            }
            "--until" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("--until requires at least one status");
                    return Ok(2);
                };
                let status = match super::parse_agent_status(value) {
                    Ok(status) => status,
                    Err(err) => {
                        eprintln!("{err}");
                        return Ok(2);
                    }
                };
                until.push(status);
                index += 2;
            }
            "--timeout" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --timeout");
                    return Ok(2);
                };
                timeout_ms = match parse_timeout(value) {
                    Ok(timeout_ms) => Some(timeout_ms),
                    Err(exit_code) => return Ok(exit_code),
                };
                index += 2;
            }
            option => {
                eprintln!("unknown option: {option}");
                return Ok(2);
            }
        }
    }
    if !until.is_empty() && !wait {
        eprintln!("--until requires --wait");
        return Ok(2);
    }
    if timeout_ms.is_some() && !wait {
        eprintln!("--timeout requires --wait");
        return Ok(2);
    }
    let response = super::send_request(&Request {
        id: "cli:agent:prompt".into(),
        method: Method::AgentPrompt(AgentPromptParams {
            target: target.clone(),
            text: text.clone(),
            wait: wait.then_some(AgentPromptWaitOptions {
                until,
                timeout_ms,
                submission_deadline: None,
            }),
        }),
    })?;
    super::print_response(&response)
}

const AGENT_CALL_USAGE: &str = "usage: herdr agent call <target> <text> [--to PANE] [--answer-requests]\n       herdr agent call --kind KIND [--name NAME] [--cwd PATH] [--to PANE] [--answer-requests] <text> [-- <agent-args...>]";

const AGENT_CALL_NEEDS_CALLER: &str = "agent call needs the calling agent's pane: run it in a Herdr pane, which sets HERDR_PANE_ID, or pass --to PANE";

/// How many generated names `agent call --kind` tries when agents starting
/// at the same time take them first.
const GENERATED_NAME_ATTEMPTS: usize = 3;

/// A parsed `herdr agent call`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentCallArgs {
    /// Pane of the calling agent, which receives the call's notices.
    caller_pane_id: String,
    text: String,
    answer_requests: bool,
    callee: CalleeArgs,
}

/// The agent that does the task.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CalleeArgs {
    /// A running agent, written like an `agent prompt` target.
    Existing(String),
    /// An agent to start in a new pane beside the caller.
    New(NewCalleeArgs),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NewCalleeArgs {
    /// Canonical agent kind label.
    kind: String,
    /// The agent's name; one is generated when absent.
    name: Option<String>,
    /// Working directory of the new pane; the caller's when absent.
    cwd: Option<String>,
    agent_args: Vec<String>,
}

fn agent_call(args: &[String]) -> std::io::Result<i32> {
    let env_pane_id = super::target::caller_pane_id();
    let call = match parse_agent_call_args(args, env_pane_id.as_deref()) {
        Ok(call) => call,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };
    match &call.callee {
        CalleeArgs::Existing(target) => {
            super::print_response(&super::send_request(&agent_call_request(&call, target))?)
        }
        CalleeArgs::New(new) => call_new_agent(&call, new),
    }
}

/// Parses `herdr agent call`; `env_pane_id` is the pane the command runs in.
fn parse_agent_call_args(
    args: &[String],
    env_pane_id: Option<&str>,
) -> Result<AgentCallArgs, String> {
    let (options, agent_args) = match args.iter().position(|arg| arg == "--") {
        Some(separator) => (&args[..separator], Some(args[separator + 1..].to_vec())),
        None => (args, None),
    };
    let options = super::expand_equals_args(options, &["--to", "--kind", "--name", "--cwd"]);
    let mut to = None;
    let mut kind = None;
    let mut name = None;
    let mut cwd = None;
    let mut answer_requests = false;
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < options.len() {
        let arg = options[index].as_str();
        match arg {
            "--to" | "--kind" | "--name" | "--cwd" => {
                let value = options
                    .get(index + 1)
                    .cloned()
                    .ok_or_else(|| format!("missing value for {arg}"))?;
                match arg {
                    "--to" => to = Some(super::normalize_pane_id(&value)),
                    "--kind" => kind = Some(value),
                    "--name" => name = Some(value),
                    _ => cwd = Some(value),
                }
                index += 2;
            }
            "--answer-requests" => {
                answer_requests = true;
                index += 1;
            }
            other if other.starts_with("--") => return Err(format!("unknown option: {other}")),
            value => {
                positionals.push(value.to_string());
                index += 1;
            }
        }
    }

    let (callee, text) = match kind {
        Some(kind) => {
            let [text] =
                <[String; 1]>::try_from(positionals).map_err(|_| AGENT_CALL_USAGE.to_string())?;
            let kind = agent_kind_label(&kind)?;
            if name
                .as_deref()
                .is_some_and(|name| !crate::app::valid_agent_name(name))
            {
                return Err(crate::app::INVALID_AGENT_NAME_MESSAGE.to_string());
            }
            let new = NewCalleeArgs {
                kind,
                name,
                cwd,
                agent_args: agent_args.unwrap_or_default(),
            };
            (CalleeArgs::New(new), text)
        }
        None => {
            if name.is_some() {
                return Err("--name requires --kind".into());
            }
            if cwd.is_some() {
                return Err("--cwd requires --kind".into());
            }
            if agent_args.is_some() {
                return Err("agent arguments after -- require --kind".into());
            }
            let [target, text] =
                <[String; 2]>::try_from(positionals).map_err(|_| AGENT_CALL_USAGE.to_string())?;
            (CalleeArgs::Existing(target), text)
        }
    };
    if text.is_empty() {
        return Err("agent call requires a non-empty task".into());
    }
    let caller_pane_id = to
        .or_else(|| env_pane_id.map(super::normalize_pane_id))
        .ok_or_else(|| AGENT_CALL_NEEDS_CALLER.to_string())?;
    Ok(AgentCallArgs {
        caller_pane_id,
        text,
        answer_requests,
        callee,
    })
}

fn agent_call_request(call: &AgentCallArgs, target: &str) -> Request {
    Request {
        id: "cli:agent:call".into(),
        method: Method::AgentCall(AgentCallParams {
            target: target.to_owned(),
            text: call.text.clone(),
            caller_pane_id: call.caller_pane_id.clone(),
            answer_requests: call.answer_requests,
        }),
    }
}

/// Starts a new agent in a pane split off the caller's, then calls it.
///
/// Whatever can be checked before the split is checked first, so a refused
/// call leaves the layout as it was. Once the pane exists it stays whatever
/// fails next, and the error names it, so that a person can deal with the
/// agent there and the caller can retry with it or close the pane.
fn call_new_agent(call: &AgentCallArgs, new: &NewCalleeArgs) -> std::io::Result<i32> {
    let caller = super::send_request(&Request {
        id: "cli:agent:call:caller".into(),
        method: Method::PaneGet(PaneTarget {
            pane_id: call.caller_pane_id.clone(),
        }),
    })?;
    if caller.get("error").is_some() {
        return super::print_response(&caller);
    }
    let caller = &caller["result"]["pane"];
    if !pane_runs_known_agent(caller) {
        return super::print_response(&cli_agent_error(
            "cli:agent:call",
            "caller_not_agent",
            format!("caller pane {} does not run an agent", call.caller_pane_id),
        ));
    }
    let agents = super::send_request(&Request {
        id: "cli:agent:call:agents".into(),
        method: Method::AgentList(EmptyParams::default()),
    })?;
    if agents.get("error").is_some() {
        return super::print_response(&agents);
    }
    let mut taken = agent_names(&agents);
    if let Some(name) = new.name.as_deref().filter(|name| taken.contains(*name)) {
        return super::print_response(&cli_agent_error(
            "cli:agent:call",
            "agent_name_taken",
            format!("agent name {name} is already used"),
        ));
    }

    let split = super::send_request(&Request {
        id: "cli:agent:call:split".into(),
        method: Method::PaneSplit(PaneSplitParams {
            workspace_id: None,
            target_pane_id: Some(call.caller_pane_id.clone()),
            direction: SplitDirection::Right,
            ratio: None,
            cwd: new_agent_cwd(new, caller),
            focus: false,
            right_click: PaneRightClickTarget::Herdr,
            env: std::collections::HashMap::new(),
        }),
    })?;
    if split.get("error").is_some() {
        return super::print_response(&split);
    }
    let Some(pane_id) = split["result"]["pane"]["pane_id"]
        .as_str()
        .map(str::to_owned)
    else {
        return super::print_response(&cli_agent_error(
            "cli:agent:call:split",
            "pane_split_failed",
            "pane split response did not include pane_id",
        ));
    };

    let mut attempts = 0;
    let name = loop {
        let name = new
            .name
            .clone()
            .unwrap_or_else(|| generated_agent_name(&new.kind, &taken));
        let started = start_agent_in_pane(&AgentStartRequest {
            name: name.clone(),
            kind: new.kind.clone(),
            pane_id: pane_id.clone(),
            agent_args: new.agent_args.clone(),
            timeout_ms: None,
        });
        let response = match started {
            Ok(AgentStartEnd::Response(response)) => response,
            Ok(AgentStartEnd::WaitFailed(err)) | Err(err) => {
                return print_kept_pane_transport_error(
                    err,
                    "cli:agent:start",
                    "agent_start_transport_failed",
                    &pane_id,
                    &name,
                );
            }
        };
        if response.get("error").is_none() {
            break name;
        }
        attempts += 1;
        let generated_name_was_taken = new.name.is_none()
            && response["error"]["code"].as_str() == Some("agent_name_taken")
            && attempts < GENERATED_NAME_ATTEMPTS;
        if !generated_name_was_taken {
            return super::print_response(&kept_pane_error(response, &pane_id, &name));
        }
        taken.insert(name);
    };

    match super::send_request(&agent_call_request(call, &name)) {
        Ok(response) if response.get("error").is_some() => {
            super::print_response(&kept_pane_error(response, &pane_id, &name))
        }
        Ok(response) => super::print_response(&response),
        Err(err) => print_kept_pane_transport_error(
            err,
            "cli:agent:call",
            "agent_call_transport_failed",
            &pane_id,
            &name,
        ),
    }
}

/// Whether the pane described by a `pane get` result runs an agent that
/// Herdr recognizes, which it must to call another agent.
fn pane_runs_known_agent(pane: &serde_json::Value) -> bool {
    pane["agent"]
        .as_str()
        .and_then(crate::detect::parse_agent_label)
        .is_some()
}

/// The names of the agents in an `agent list` response.
fn agent_names(list: &serde_json::Value) -> std::collections::BTreeSet<String> {
    list["result"]["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|agent| agent["name"].as_str().map(str::to_owned))
        .collect()
}

/// `<kind>-<n>` with the smallest `n` that no name in `taken` uses.
fn generated_agent_name(kind: &str, taken: &std::collections::BTreeSet<String>) -> String {
    let mut number = 1_u64;
    loop {
        let name = format!("{kind}-{number}");
        if !taken.contains(&name) {
            return name;
        }
        number += 1;
    }
}

/// Where the new agent's pane starts: `--cwd`, or where the calling agent
/// runs, which the caller's `pane get` result reports as its foreground
/// directory, or else its shell's. `None` leaves it to `pane.split`.
fn new_agent_cwd(new: &NewCalleeArgs, caller: &serde_json::Value) -> Option<String> {
    new.cwd.clone().or_else(|| {
        caller["foreground_cwd"]
            .as_str()
            .or_else(|| caller["cwd"].as_str())
            .map(str::to_owned)
    })
}

/// Adds the pane that a failed `agent call --kind` created, and its agent,
/// to the error `response`.
fn kept_pane_error(
    mut response: serde_json::Value,
    pane_id: &str,
    agent_name: &str,
) -> serde_json::Value {
    if let Some(error) = response
        .get_mut("error")
        .and_then(serde_json::Value::as_object_mut)
    {
        let message = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let message = format!("{message}; the new pane {pane_id} (agent {agent_name}) stays open");
        error.insert("message".into(), message.into());
        error.insert("pane_id".into(), pane_id.into());
        error.insert("agent_name".into(), agent_name.into());
    }
    response
}

fn print_kept_pane_transport_error(
    err: std::io::Error,
    request_id: &str,
    code: &str,
    pane_id: &str,
    agent_name: &str,
) -> std::io::Result<i32> {
    match agent_transport_error_response(err, request_id, code)? {
        Some(response) => super::print_response(&kept_pane_error(response, pane_id, agent_name)),
        None => Ok(1),
    }
}

fn agent_send_keys(args: &[String]) -> std::io::Result<i32> {
    if args.len() < 2 {
        eprintln!("usage: herdr agent send-keys <target> <key> [key ...]");
        return Ok(2);
    }

    super::print_response(&super::send_request(&Request {
        id: "cli:agent:send-keys".into(),
        method: Method::AgentSendKeys(AgentSendKeysParams {
            target: args[0].clone(),
            keys: args[1..].to_vec(),
        }),
    })?)
}

fn agent_read(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = args.first() else {
        eprintln!("usage: herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]");
        return Ok(2);
    };

    let mut source = ReadSource::Recent;
    let mut lines = None;
    let mut format = ReadFormat::Text;
    let mut strip_ansi = true;

    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--source" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --source");
                    return Ok(2);
                };
                source = super::parse_read_source(value)?;
                index += 2;
            }
            "--lines" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --lines");
                    return Ok(2);
                };
                lines = Some(super::parse_u32_flag("--lines", value)?);
                index += 2;
            }
            "--format" => {
                let Some(value) = args.get(index + 1) else {
                    eprintln!("missing value for --format");
                    return Ok(2);
                };
                format = super::parse_read_format(value)?;
                strip_ansi = !matches!(format, ReadFormat::Ansi);
                index += 2;
            }
            "--ansi" => {
                format = ReadFormat::Ansi;
                strip_ansi = false;
                index += 1;
            }
            other => {
                eprintln!("unknown option: {other}");
                return Ok(2);
            }
        }
    }

    let response = super::send_request(&Request {
        id: "cli:agent:read".into(),
        method: Method::AgentRead(AgentReadParams {
            target: target.clone(),
            source,
            lines,
            format,
            strip_ansi,
        }),
    })?;
    super::print_read_response(&response)
}

fn print_agent_help() {
    eprintln!("herdr agent commands:");
    eprintln!("  herdr agent list");
    eprintln!("  herdr agent get <target>");
    eprintln!("  herdr agent replies <target> [--after SEQ]");
    eprintln!("  herdr agent tool-calls <target> [--after SEQ]");
    eprintln!("  herdr agent requests <target>");
    eprintln!("  herdr agent answer <target> <request_id> --decision allow|allow_always|deny [--message TEXT]");
    eprintln!("  herdr agent answer <target> <request_id> --answers JSON");
    eprintln!("  herdr agent read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--ansi]");
    eprintln!("  herdr agent send-keys <target> <key> [key ...]");
    eprintln!("  herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]");
    eprintln!("  herdr agent call <target> <text> [--to PANE] [--answer-requests]");
    eprintln!("  herdr agent call --kind KIND [--name NAME] [--cwd PATH] [--to PANE] [--answer-requests] <text> [-- <agent-args...>]");
    eprintln!("  herdr agent rename <target> <name>|--clear");
    eprintln!("  herdr agent focus <target>");
    eprintln!("  herdr agent wait <target> [--until STATUS]... [--timeout MS]");
    eprintln!("  herdr agent attach <target> [--takeover]");
    eprintln!(
        "  herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]"
    );
    eprintln!("  herdr agent explain <target> [--json|--format text|json] [--verbose]");
    eprintln!(
        "  herdr agent explain --file PATH --agent LABEL [--json|--format text|json] [--verbose]"
    );
    eprintln!("  targets accept unique agent names and pane ids that currently host agents");
    eprintln!("  kinds: {}", super::spec::agent_kind_values().join("|"));
}

fn parse_timeout(value: &str) -> Result<u64, i32> {
    super::parse_u64_flag("--timeout", value).map_err(|err| {
        eprintln!("{err}");
        2
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn names(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn agent_call_args_default_the_caller_to_the_pane_the_command_runs_in() {
        assert_eq!(
            parse_agent_call_args(&args(&["reviewer", "Review this diff"]), Some("w1:p1")),
            Ok(AgentCallArgs {
                caller_pane_id: "w1:p1".into(),
                text: "Review this diff".into(),
                answer_requests: false,
                callee: CalleeArgs::Existing("reviewer".into()),
            })
        );
    }

    #[test]
    fn agent_call_args_to_overrides_the_pane_the_command_runs_in() {
        for values in [
            &["reviewer", "Review", "--to", "w2:p3", "--answer-requests"][..],
            &["--to=w2:p3", "--answer-requests", "reviewer", "Review"][..],
        ] {
            assert_eq!(
                parse_agent_call_args(&args(values), Some("w1:p1")),
                Ok(AgentCallArgs {
                    caller_pane_id: "w2:p3".into(),
                    text: "Review".into(),
                    answer_requests: true,
                    callee: CalleeArgs::Existing("reviewer".into()),
                }),
                "{values:?}"
            );
        }
        assert_eq!(
            parse_agent_call_args(&args(&["reviewer", "Review", "--to", "w2:p3"]), None)
                .map(|call| call.caller_pane_id),
            Ok("w2:p3".into())
        );
    }

    #[test]
    fn agent_call_args_require_a_caller() {
        for values in [
            &["reviewer", "Review"][..],
            &["--kind", "codex", "Review"][..],
        ] {
            let error = parse_agent_call_args(&args(values), None).unwrap_err();
            assert!(error.contains("--to"), "{error}");
            assert!(error.contains("HERDR_PANE_ID"), "{error}");
        }
    }

    #[test]
    fn agent_call_args_describe_a_new_agent_with_kind() {
        assert_eq!(
            parse_agent_call_args(
                &args(&[
                    "--kind",
                    "claude-code",
                    "--name",
                    "helper",
                    "Write the tests",
                    "--cwd=/work",
                    "--",
                    "--to",
                    "x",
                ]),
                Some("w1:p1"),
            ),
            Ok(AgentCallArgs {
                caller_pane_id: "w1:p1".into(),
                text: "Write the tests".into(),
                answer_requests: false,
                callee: CalleeArgs::New(NewCalleeArgs {
                    kind: "claude".into(),
                    name: Some("helper".into()),
                    cwd: Some("/work".into()),
                    agent_args: args(&["--to", "x"]),
                }),
            })
        );
        assert_eq!(
            parse_agent_call_args(&args(&["--kind", "codex", "Review"]), Some("w1:p1"))
                .map(|call| call.callee),
            Ok(CalleeArgs::New(NewCalleeArgs {
                kind: "codex".into(),
                name: None,
                cwd: None,
                agent_args: Vec::new(),
            }))
        );
    }

    #[test]
    fn agent_call_args_reject_mistakes_before_anything_runs() {
        for values in [
            &[][..],
            &["reviewer"][..],
            &["reviewer", ""][..],
            &["reviewer", "Review", "extra"][..],
            &["reviewer", "Review", "--wait"][..],
            &["reviewer", "Review", "--to"][..],
            &["--name", "helper", "reviewer", "Review"][..],
            &["--cwd", "/work", "reviewer", "Review"][..],
            &["reviewer", "Review", "--", "--model"][..],
            &["--kind", "nope", "Review"][..],
            &["--kind", "codex"][..],
            &["--kind", "codex", ""][..],
            &["--kind", "codex", "reviewer", "Review"][..],
            &["--kind", "codex", "--name", "Not-Valid", "Review"][..],
            &["--kind", "codex", "--name"][..],
        ] {
            assert!(
                parse_agent_call_args(&args(values), Some("w1:p1")).is_err(),
                "{values:?} was accepted"
            );
        }
    }

    #[test]
    fn generated_agent_names_take_the_lowest_free_number() {
        assert_eq!(generated_agent_name("codex", &names(&[])), "codex-1");
        assert_eq!(
            generated_agent_name("codex", &names(&["codex-1", "codex-3", "claude-2"])),
            "codex-2"
        );
        for kind in super::super::spec::agent_kind_values() {
            let name = generated_agent_name(kind, &names(&[]));
            assert!(crate::app::valid_agent_name(&name), "{name}");
        }
    }

    #[test]
    fn agent_names_lists_the_names_of_live_agents() {
        let list = serde_json::json!({
            "result": {
                "agents": [{ "name": "reviewer" }, { "name": null }, {}, { "name": "codex-1" }]
            }
        });
        assert_eq!(agent_names(&list), names(&["reviewer", "codex-1"]));
    }

    #[test]
    fn new_agents_start_in_cwd_or_where_the_calling_agent_runs() {
        let new = |cwd: Option<&str>| NewCalleeArgs {
            kind: "codex".into(),
            name: None,
            cwd: cwd.map(str::to_string),
            agent_args: Vec::new(),
        };
        let caller = serde_json::json!({ "cwd": "/shell", "foreground_cwd": "/agent" });
        assert_eq!(
            new_agent_cwd(&new(Some("/work")), &caller),
            Some("/work".into())
        );
        assert_eq!(new_agent_cwd(&new(None), &caller), Some("/agent".into()));
        assert_eq!(
            new_agent_cwd(&new(None), &serde_json::json!({ "cwd": "/shell" })),
            Some("/shell".into())
        );
        assert_eq!(new_agent_cwd(&new(None), &serde_json::json!({})), None);
    }

    #[test]
    fn only_panes_that_run_a_recognized_agent_can_call() {
        assert!(pane_runs_known_agent(
            &serde_json::json!({ "agent": "claude" })
        ));
        assert!(!pane_runs_known_agent(
            &serde_json::json!({ "agent": "something-else" })
        ));
        assert!(!pane_runs_known_agent(&serde_json::json!({})));
    }

    #[test]
    fn errors_after_the_split_name_the_kept_pane_and_its_agent() {
        let error = kept_pane_error(
            serde_json::json!({
                "id": "cli:agent:start",
                "error": {
                    "code": "agent_not_ready",
                    "message": "agent codex-1 is blocked during startup and is not ready for prompts"
                }
            }),
            "w1:p2",
            "codex-1",
        );

        assert_eq!(error["id"], "cli:agent:start");
        assert_eq!(error["error"]["code"], "agent_not_ready");
        assert_eq!(error["error"]["pane_id"], "w1:p2");
        assert_eq!(error["error"]["agent_name"], "codex-1");
        assert_eq!(
            error["error"]["message"],
            "agent codex-1 is blocked during startup and is not ready for prompts; the new pane w1:p2 (agent codex-1) stays open"
        );
    }
}
