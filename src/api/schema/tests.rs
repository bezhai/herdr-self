use std::collections::HashMap;

use super::*;

fn protocol_schema_entry<T: schemars::JsonSchema>(name: &str) -> serde_json::Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
    rewrite_schema_refs(&mut schema, name);
    schema
}

fn rewrite_schema_refs(value: &mut serde_json::Value, schema_name: &str) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(serde_json::Value::String(reference)) = object.get_mut("$ref") {
                if let Some(path) = reference.strip_prefix("#/") {
                    *reference = format!("#/schemas/{schema_name}/{path}");
                }
            }
            for child in object.values_mut() {
                rewrite_schema_refs(child, schema_name);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_schema_refs(item, schema_name);
            }
        }
        _ => {}
    }
}

fn protocol_schema_document() -> serde_json::Value {
    serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Herdr API",
        "schema_version": 1,
        "protocol": crate::protocol::PROTOCOL_VERSION,
        "schemas": {
            "request": protocol_schema_entry::<Request>("request"),
            "success_response": protocol_schema_entry::<SuccessResponse>("success_response"),
            "error_response": protocol_schema_entry::<ErrorResponse>("error_response"),
            "event": protocol_schema_entry::<EventEnvelope>("event"),
            "subscription_event": protocol_schema_entry::<SubscriptionEventEnvelope>("subscription_event"),
        },
    })
}

#[test]
fn request_uses_dot_method_names() {
    let request = Request {
        id: "req_1".into(),
        method: Method::WorkspaceCreate(WorkspaceCreateParams {
            source_workspace_id: None,
            cwd: Some("/tmp".into()),
            focus: true,
            label: Some("api".into()),
            env: Default::default(),
        }),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "workspace.create");
}

#[test]
fn workspace_close_group_intent_defaults_false_and_round_trips() {
    let request: Request = serde_json::from_value(serde_json::json!({
        "id": "close",
        "method": "workspace.close",
        "params": { "workspace_id": "w1" }
    }))
    .unwrap();
    assert!(matches!(
        request.method,
        Method::WorkspaceClose(WorkspaceCloseParams {
            close_group: false,
            ..
        })
    ));

    let explicit = Request {
        id: "close-group".into(),
        method: Method::WorkspaceClose(WorkspaceCloseParams {
            workspace_id: "w1".into(),
            close_group: true,
        }),
    };
    let json = serde_json::to_value(&explicit).unwrap();
    assert_eq!(json["params"]["close_group"], true);
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), explicit);
}

#[test]
fn agent_start_and_prompt_requests_round_trip() {
    let start = Request {
        id: "start".into(),
        method: Method::AgentStart(AgentStartParams {
            name: "reviewer".into(),
            kind: "pi".into(),
            pane_id: "w1:p2".into(),
            args: vec!["--no-session".into()],
            timeout_ms: Some(30_000),
        }),
    };
    let start_json = serde_json::to_value(&start).unwrap();
    assert_eq!(start_json["method"], "agent.start");
    assert_eq!(start_json["params"]["pane_id"], "w1:p2");
    assert_eq!(
        serde_json::from_value::<Request>(start_json).unwrap(),
        start
    );

    let prompt = Request {
        id: "prompt".into(),
        method: Method::AgentPrompt(AgentPromptParams {
            target: "reviewer".into(),
            text: "review this".into(),
            wait: None,
        }),
    };
    let prompt_json = serde_json::to_value(&prompt).unwrap();
    assert_eq!(prompt_json["method"], "agent.prompt");
    assert_eq!(
        serde_json::from_value::<Request>(prompt_json).unwrap(),
        prompt
    );

    let prompt_and_wait = Request {
        id: "prompt-and-wait".into(),
        method: Method::AgentPrompt(AgentPromptParams {
            target: "reviewer".into(),
            text: "review this".into(),
            wait: Some(AgentPromptWaitOptions {
                until: vec![AgentStatus::Idle, AgentStatus::Done],
                timeout_ms: Some(120_000),
                submission_deadline: None,
            }),
        }),
    };
    let prompt_and_wait_json = serde_json::to_value(&prompt_and_wait).unwrap();
    assert_eq!(
        prompt_and_wait_json["params"]["wait"]["until"],
        serde_json::json!(["idle", "done"])
    );
    assert_eq!(
        prompt_and_wait_json["params"]["wait"]["timeout_ms"],
        120_000
    );
    assert_eq!(
        serde_json::from_value::<Request>(prompt_and_wait_json).unwrap(),
        prompt_and_wait
    );
}

#[test]
fn bundled_protocol_schema_refs_resolve_inside_bundle() {
    fn assert_no_standalone_refs(value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                if let Some(serde_json::Value::String(reference)) = object.get("$ref") {
                    assert!(
                        !reference.starts_with("#/$defs/"),
                        "schema bundle contains standalone ref {reference}"
                    );
                }
                for child in object.values() {
                    assert_no_standalone_refs(child);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    assert_no_standalone_refs(item);
                }
            }
            _ => {}
        }
    }

    assert_no_standalone_refs(&protocol_schema_document());
}

#[test]
fn generated_protocol_schema_artifact_is_current() {
    let actual = format!(
        "{}\n",
        serde_json::to_string_pretty(&protocol_schema_document()).unwrap()
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("docs/next/api/herdr-api.schema.json");

    if std::env::var_os("HERDR_UPDATE_API_SCHEMA").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &actual).unwrap();
        return;
    }

    let expected = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "failed to read {}; run `HERDR_UPDATE_API_SCHEMA=1 just test-one generated_protocol_schema_artifact_is_current`: {err}",
            path.display()
        )
    });
    assert_eq!(
        expected, actual,
        "generated API schema artifact is stale; run `HERDR_UPDATE_API_SCHEMA=1 just test-one generated_protocol_schema_artifact_is_current`"
    );
}

#[test]
fn request_round_trips_for_server_stop() {
    let request = Request {
        id: "req_stop".into(),
        method: Method::ServerStop(EmptyParams::default()),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "server.stop");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn request_round_trips_for_server_reload_config() {
    let request = Request {
        id: "req_reload".into(),
        method: Method::ServerReloadConfig(EmptyParams::default()),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "server.reload_config");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn request_round_trips_for_server_reload_agent_manifests() {
    let request = Request {
        id: "req_reload_agent_manifests".into(),
        method: Method::ServerReloadAgentManifests(EmptyParams::default()),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "server.reload_agent_manifests");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn request_round_trips_for_server_agent_manifests() {
    let request = Request {
        id: "req_agent_manifests".into(),
        method: Method::ServerAgentManifests(EmptyParams::default()),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "server.agent_manifests");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn request_round_trips_for_agent_explain() {
    let request = Request {
        id: "req_agent_explain".into(),
        method: Method::AgentExplain(AgentTarget {
            target: "agent-1".into(),
        }),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "agent.explain");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn agent_reply_requests_and_response_round_trip() {
    let report = Request {
        id: "req_reply".into(),
        method: Method::PaneReportAgentReply(PaneReportAgentReplyParams {
            pane_id: "w1:p1".into(),
            source: "herdr:claude".into(),
            agent: "claude".into(),
            seq: Some(42),
            agent_session_id: Some("claude-session".into()),
            text: "已完成 **done**".into(),
            truncated: false,
        }),
    };
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["method"], "pane.report_agent_reply");
    assert_eq!(json["params"]["text"], "已完成 **done**");
    assert!(json["params"].get("truncated").is_none());
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, report);

    let minimal: Request = serde_json::from_value(serde_json::json!({
        "id": "req_min",
        "method": "pane.report_agent_reply",
        "params": {
            "pane_id": "w1:p1",
            "source": "herdr:codex",
            "agent": "codex",
            "text": "done",
            "truncated": true,
        },
    }))
    .unwrap();
    let Method::PaneReportAgentReply(params) = minimal.method else {
        panic!("expected a reply report");
    };
    assert_eq!(params.seq, None);
    assert_eq!(params.agent_session_id, None);
    assert!(params.truncated);

    for after_seq in [None, Some(7)] {
        let replies = Request {
            id: "req_replies".into(),
            method: Method::AgentReplies(AgentRepliesParams {
                target: "reviewer".into(),
                after_seq,
            }),
        };
        let json = serde_json::to_value(&replies).unwrap();
        assert_eq!(json["method"], "agent.replies");
        assert_eq!(
            json["params"].get("after_seq").is_some(),
            after_seq.is_some()
        );
        let restored: Request = serde_json::from_value(json).unwrap();
        assert_eq!(restored, replies);
    }

    let response = SuccessResponse {
        id: "req_replies".into(),
        result: ResponseResult::AgentReplies {
            agent: AgentInfo {
                terminal_id: "term_1".into(),
                name: Some("reviewer".into()),
                agent: Some("claude".into()),
                title: None,
                terminal_title: None,
                terminal_title_stripped: None,
                display_agent: None,
                agent_status: AgentStatus::Idle,
                screen_detection_skipped: false,
                state_labels: HashMap::new(),
                tokens: HashMap::new(),
                agent_session: None,
                workspace_id: "w1".into(),
                tab_id: "w1:t1".into(),
                pane_id: "w1:p1".into(),
                focused: false,
                launch_pending: false,
                interactive_ready: false,
                state_change_seq: 3,
                completion_seq: None,
                reply_seq: Some(2),
                request_ids: Vec::new(),
                remote_answers: false,
                cwd: None,
                foreground_cwd: None,
                revision: 5,
            },
            replies: vec![
                AgentReplyInfo {
                    seq: 1,
                    text: "first".into(),
                    truncated: false,
                },
                AgentReplyInfo {
                    seq: 2,
                    text: "second".into(),
                    truncated: true,
                },
            ],
        },
    };
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["result"]["type"], "agent_replies");
    assert_eq!(json["result"]["agent"]["reply_seq"], 2);
    assert_eq!(json["result"]["replies"][0]["truncated"], false);
    assert_eq!(json["result"]["replies"][1]["text"], "second");
    let restored: SuccessResponse = serde_json::from_value(json).unwrap();
    assert_eq!(restored, response);

    let ResponseResult::AgentReplies { mut agent, .. } = restored.result else {
        panic!("expected agent replies");
    };
    agent.reply_seq = None;
    let json = serde_json::to_value(&agent).unwrap();
    assert!(json.get("reply_seq").is_none());
    assert!(json.get("request_ids").is_none());
}

#[test]
fn pane_set_remote_answers_round_trips() {
    let request = Request {
        id: "req_remote_answers".into(),
        method: Method::PaneSetRemoteAnswers(PaneSetRemoteAnswersParams {
            pane_id: "w1:p1".into(),
            enabled: true,
        }),
    };
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "id": "req_remote_answers",
            "method": "pane.set_remote_answers",
            "params": {"pane_id": "w1:p1", "enabled": true},
        })
    );
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), request);

    let missing_enabled = serde_json::from_value::<Request>(serde_json::json!({
        "id": "req_remote_answers",
        "method": "pane.set_remote_answers",
        "params": {"pane_id": "w1:p1"},
    }));
    assert!(missing_enabled.is_err());
}

#[test]
fn remote_answers_is_an_optional_flag_of_pane_and_agent_info() {
    let pane = serde_json::json!({
        "pane_id": "w1:p1",
        "terminal_id": "term_1",
        "workspace_id": "w1",
        "tab_id": "w1:t1",
        "focused": false,
        "agent_status": "idle",
        "revision": 0,
    });
    let parsed: PaneInfo = serde_json::from_value(pane.clone()).unwrap();
    assert!(!parsed.remote_answers);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), pane);
    let enabled = PaneInfo {
        remote_answers: true,
        ..parsed
    };
    assert_eq!(
        serde_json::to_value(&enabled).unwrap()["remote_answers"],
        true
    );

    let agent = serde_json::json!({
        "terminal_id": "term_1",
        "agent": "claude",
        "agent_status": "idle",
        "workspace_id": "w1",
        "tab_id": "w1:t1",
        "pane_id": "w1:p1",
        "focused": false,
        "state_change_seq": 0,
        "revision": 0,
    });
    let parsed: AgentInfo = serde_json::from_value(agent.clone()).unwrap();
    assert!(!parsed.remote_answers);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), agent);
    let enabled = AgentInfo {
        remote_answers: true,
        ..parsed
    };
    assert_eq!(
        serde_json::to_value(&enabled).unwrap()["remote_answers"],
        true
    );
}

fn permission_request_content() -> AgentRequestContent {
    AgentRequestContent {
        kind: AgentRequestKind::Permission,
        tool_name: "Bash".into(),
        description: Some("列出文件".into()),
        input_preview: "ls -la".into(),
        decisions: vec![
            AgentRequestDecision::Allow,
            AgentRequestDecision::AllowAlways,
            AgentRequestDecision::Deny,
        ],
        questions: Vec::new(),
    }
}

#[test]
fn agent_request_report_is_flat_and_round_trips() {
    let report = Request {
        id: "req_request".into(),
        method: Method::PaneReportAgentRequest(PaneReportAgentRequestParams {
            pane_id: "w1:p1".into(),
            source: "herdr:claude".into(),
            agent: "claude".into(),
            agent_session_id: Some("claude-session".into()),
            request: permission_request_content(),
            timeout_ms: Some(600_000),
        }),
    };
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "id": "req_request",
            "method": "pane.report_agent_request",
            "params": {
                "pane_id": "w1:p1",
                "source": "herdr:claude",
                "agent": "claude",
                "agent_session_id": "claude-session",
                "kind": "permission",
                "tool_name": "Bash",
                "description": "列出文件",
                "input_preview": "ls -la",
                "decisions": ["allow", "allow_always", "deny"],
                "timeout_ms": 600000,
            },
        })
    );
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), report);

    let question: Request = serde_json::from_value(serde_json::json!({
        "id": "req_question",
        "method": "pane.report_agent_request",
        "params": {
            "pane_id": "w1:p1",
            "source": "herdr:claude",
            "agent": "claude",
            "kind": "question",
            "tool_name": "AskUserQuestion",
            "input_preview": "{}",
            "questions": [
                {
                    "question": "Which color?",
                    "header": "Color",
                    "options": [{"label": "Red", "description": "warm"}, {"label": "Blue"}],
                    "multi_select": true,
                },
                {"question": "Proceed?"},
            ],
        },
    }))
    .unwrap();
    let Method::PaneReportAgentRequest(params) = question.method else {
        panic!("expected an agent request report");
    };
    assert_eq!(params.agent_session_id, None);
    assert_eq!(params.timeout_ms, None);
    assert_eq!(params.request.kind, AgentRequestKind::Question);
    assert_eq!(params.request.description, None);
    assert!(params.request.decisions.is_empty());
    assert_eq!(
        params.request.questions,
        vec![
            AgentQuestion {
                question: "Which color?".into(),
                header: Some("Color".into()),
                options: vec![
                    AgentQuestionOption {
                        label: "Red".into(),
                        description: Some("warm".into()),
                    },
                    AgentQuestionOption {
                        label: "Blue".into(),
                        description: None,
                    },
                ],
                multi_select: true,
            },
            AgentQuestion {
                question: "Proceed?".into(),
                header: None,
                options: Vec::new(),
                multi_select: false,
            },
        ]
    );
}

#[test]
fn agent_request_list_and_answer_round_trip() {
    let requests = Request {
        id: "req_requests".into(),
        method: Method::AgentRequests(AgentTarget {
            target: "w1:p1".into(),
        }),
    };
    let json = serde_json::to_value(&requests).unwrap();
    assert_eq!(json["method"], "agent.requests");
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), requests);

    let decision = Request {
        id: "req_answer".into(),
        method: Method::AgentAnswer(AgentAnswerParams {
            target: "w1:p1".into(),
            request_id: 7,
            answer: AgentRequestAnswer {
                decision: Some(AgentRequestDecision::Deny),
                message: Some("用户拒绝".into()),
                answers: None,
            },
        }),
    };
    let json = serde_json::to_value(&decision).unwrap();
    assert_eq!(
        json["params"],
        serde_json::json!({
            "target": "w1:p1",
            "request_id": 7,
            "decision": "deny",
            "message": "用户拒绝",
        })
    );
    assert_eq!(json["method"], "agent.answer");
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), decision);

    let answers: Request = serde_json::from_value(serde_json::json!({
        "id": "req_answers",
        "method": "agent.answer",
        "params": {
            "target": "reviewer",
            "request_id": 8,
            "answers": {"Which color?": ["Red", "Blue"]},
        },
    }))
    .unwrap();
    let Method::AgentAnswer(params) = answers.method else {
        panic!("expected an agent answer");
    };
    assert_eq!(params.answer.decision, None);
    assert_eq!(params.answer.message, None);
    assert_eq!(
        params.answer.answers,
        Some(std::collections::BTreeMap::from([(
            "Which color?".to_string(),
            vec!["Red".to_string(), "Blue".to_string()],
        )]))
    );
}

#[test]
fn agent_request_results_round_trip() {
    let listed = SuccessResponse {
        id: "req_requests".into(),
        result: ResponseResult::AgentRequests {
            agent: AgentInfo {
                terminal_id: "term_1".into(),
                name: None,
                agent: Some("claude".into()),
                title: None,
                terminal_title: None,
                terminal_title_stripped: None,
                display_agent: None,
                agent_status: AgentStatus::Blocked,
                screen_detection_skipped: false,
                state_labels: HashMap::new(),
                tokens: HashMap::new(),
                agent_session: None,
                workspace_id: "w1".into(),
                tab_id: "w1:t1".into(),
                pane_id: "w1:p1".into(),
                focused: false,
                launch_pending: false,
                interactive_ready: false,
                state_change_seq: 3,
                completion_seq: None,
                reply_seq: None,
                request_ids: vec![4],
                remote_answers: false,
                cwd: None,
                foreground_cwd: None,
                revision: 5,
            },
            requests: vec![AgentRequestInfo {
                id: 4,
                content: permission_request_content(),
            }],
        },
    };
    let json = serde_json::to_value(&listed).unwrap();
    assert_eq!(json["result"]["type"], "agent_requests");
    assert_eq!(
        json["result"]["agent"]["request_ids"],
        serde_json::json!([4])
    );
    assert_eq!(
        json["result"]["requests"],
        serde_json::json!([{
            "id": 4,
            "kind": "permission",
            "tool_name": "Bash",
            "description": "列出文件",
            "input_preview": "ls -la",
            "decisions": ["allow", "allow_always", "deny"],
        }])
    );
    assert_eq!(
        serde_json::from_value::<SuccessResponse>(json).unwrap(),
        listed
    );

    for (result, expected) in [
        (
            ResponseResult::AgentRequestAnswered {
                request_id: 4,
                answer: AgentRequestAnswer {
                    decision: Some(AgentRequestDecision::AllowAlways),
                    message: None,
                    answers: None,
                },
            },
            serde_json::json!({
                "type": "agent_request_answered",
                "request_id": 4,
                "decision": "allow_always",
            }),
        ),
        (
            ResponseResult::AgentRequestAnswered {
                request_id: 5,
                answer: AgentRequestAnswer {
                    decision: None,
                    message: None,
                    answers: Some(std::collections::BTreeMap::from([(
                        "Proceed?".to_string(),
                        vec!["是".to_string()],
                    )])),
                },
            },
            serde_json::json!({
                "type": "agent_request_answered",
                "request_id": 5,
                "answers": {"Proceed?": ["是"]},
            }),
        ),
        (
            ResponseResult::AgentRequestEnded {
                request_id: Some(6),
                reason: AgentRequestEndReason::Timeout,
            },
            serde_json::json!({
                "type": "agent_request_ended",
                "request_id": 6,
                "reason": "timeout",
            }),
        ),
        (
            ResponseResult::AgentRequestEnded {
                request_id: None,
                reason: AgentRequestEndReason::Ignored,
            },
            serde_json::json!({"type": "agent_request_ended", "reason": "ignored"}),
        ),
        (
            ResponseResult::AgentRequestEnded {
                request_id: Some(7),
                reason: AgentRequestEndReason::Closed,
            },
            serde_json::json!({
                "type": "agent_request_ended",
                "request_id": 7,
                "reason": "closed",
            }),
        ),
    ] {
        let response = SuccessResponse {
            id: "req_request".into(),
            result,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["result"], expected);
        assert_eq!(
            serde_json::from_value::<SuccessResponse>(json).unwrap(),
            response
        );
    }
}

#[test]
fn integration_list_request_and_response_round_trip() {
    let request = Request {
        id: "req_integrations".into(),
        method: Method::IntegrationList(EmptyParams::default()),
    };
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "integration.list");
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), request);

    let response = SuccessResponse {
        id: "req_integrations".into(),
        result: ResponseResult::IntegrationList {
            integrations: vec![IntegrationInfo {
                target: IntegrationTarget::Codex,
                label: "codex".into(),
                command: "codex".into(),
                available: true,
                state: IntegrationState::Outdated,
            }],
        },
    };
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["result"]["type"], "integration_list");
    assert_eq!(json["result"]["integrations"][0]["state"], "outdated");
    assert_eq!(
        serde_json::from_value::<SuccessResponse>(json).unwrap(),
        response
    );
}

#[test]
fn command_invoke_request_round_trips_without_command_text() {
    let request = Request {
        id: "req_command".into(),
        method: Method::CommandInvoke(CommandInvokeParams {
            command_id: "cmd_0123456789abcdef0123456789abcdef".into(),
            workspace_id: Some("w1".into()),
            tab_id: Some("w1:t1".into()),
            pane_id: Some("w1:p1".into()),
            selection: None,
        }),
    };
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "command.invoke");
    assert_eq!(serde_json::from_value::<Request>(json).unwrap(), request);
}

#[test]
fn notification_show_request_parses() {
    let json = r#"{"id":"req_1","method":"notification.show","params":{"title":"build failed","body":"api workspace","position":"top-left","sound":"request"}}"#;
    let request: Request = serde_json::from_str(json).unwrap();
    let Method::NotificationShow(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert_eq!(params.title, "build failed");
    assert_eq!(params.body.as_deref(), Some("api workspace"));
    assert_eq!(
        params.position,
        Some(crate::config::ToastHerdrPosition::TopLeft)
    );
    assert_eq!(params.sound, NotificationShowSound::Request);
}

#[test]
fn notification_show_sound_defaults_to_none() {
    let json = r#"{"id":"req_1","method":"notification.show","params":{"title":"build failed"}}"#;
    let request: Request = serde_json::from_str(json).unwrap();
    let Method::NotificationShow(params) = request.method else {
        panic!("wrong method parsed");
    };

    assert_eq!(params.sound, NotificationShowSound::None);
}

#[test]
fn client_window_title_requests_round_trip() {
    let set = Request {
        id: "req_title_set".into(),
        method: Method::ClientWindowTitleSet(ClientWindowTitleSetParams {
            title: "herdr api".into(),
        }),
    };
    let json = serde_json::to_value(&set).unwrap();
    assert_eq!(json["method"], "client.window_title.set");
    assert_eq!(json["params"]["title"], "herdr api");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, set);

    let clear = Request {
        id: "req_title_clear".into(),
        method: Method::ClientWindowTitleClear(EmptyParams::default()),
    };
    let json = serde_json::to_value(&clear).unwrap();
    assert_eq!(json["method"], "client.window_title.clear");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, clear);
}

#[test]
fn agent_view_requests_round_trip() {
    let set_json = serde_json::json!({
        "id": "view-set",
        "method": "agent.view.set",
        "params": {
            "source": "example.views",
            "label": "current + attention",
            "filter": {
                "op": "any",
                "filters": [
                    {
                        "op": "eq",
                        "field": "workspace_id",
                        "value": {"context": "current_workspace_id"}
                    },
                    {
                        "op": "in",
                        "field": "status",
                        "values": ["blocked", "done"]
                    }
                ]
            },
            "sort": [
                {"field": "attention", "order": "desc"},
                {"field": "state_change_seq", "order": "desc"}
            ]
        }
    });
    let request: Request = serde_json::from_value(set_json.clone()).unwrap();
    assert!(matches!(request.method, Method::AgentViewSet(_)));
    assert_eq!(serde_json::to_value(request).unwrap(), set_json);

    let clear_json = serde_json::json!({
        "id": "view-clear",
        "method": "agent.view.clear",
        "params": {"source": "example.views"}
    });
    let request: Request = serde_json::from_value(clear_json.clone()).unwrap();
    assert!(matches!(request.method, Method::AgentViewClear(_)));
    assert_eq!(serde_json::to_value(request).unwrap(), clear_json);
}

#[test]
fn unknown_method_is_rejected() {
    let json = r#"{"id":"req_1","method":"nope","params":{}}"#;
    let err = serde_json::from_str::<Request>(json)
        .unwrap_err()
        .to_string();
    assert!(err.contains("unknown variant"));
}

#[test]
fn missing_required_params_are_rejected() {
    let json = r#"{"id":"req_1","method":"pane.send_text","params":{"pane_id":"p_1"}}"#;
    let err = serde_json::from_str::<Request>(json)
        .unwrap_err()
        .to_string();
    assert!(err.contains("text"));
}

#[test]
fn pane_send_input_defaults_to_empty_text_and_keys() {
    let json = r#"
    {
        "id": "req_1",
        "method": "pane.send_input",
        "params": {
            "pane_id": "p_1"
        }
    }
    "#;

    let request: Request = serde_json::from_str(json).unwrap();
    let Method::PaneSendInput(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert_eq!(params.pane_id, "p_1");
    assert!(params.text.is_empty());
    assert!(params.keys.is_empty());
}

#[test]
fn pane_wait_for_output_defaults_strip_ansi_to_true() {
    let json = r#"
    {
        "id": "req_1",
        "method": "pane.wait_for_output",
        "params": {
            "pane_id": "p_1",
            "source": "recent",
            "match": { "type": "substring", "value": "ready" }
        }
    }
    "#;

    let request: Request = serde_json::from_str(json).unwrap();
    let Method::PaneWaitForOutput(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert!(params.strip_ansi);
}

#[test]
fn pane_read_defaults_to_text_format() {
    let json = r#"
    {
        "id": "req_1",
        "method": "pane.read",
        "params": {
            "pane_id": "p_1",
            "source": "visible"
        }
    }
    "#;

    let request: Request = serde_json::from_str(json).unwrap();
    let serialized = serde_json::to_value(&request).unwrap();
    assert!(serialized["params"].get("intent").is_none());
    let Method::PaneRead(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert_eq!(params.format, ReadFormat::Text);
    assert_eq!(params.intent, ReadIntent::Interactive);
}

#[test]
fn pane_current_request_round_trips() {
    let request = Request {
        id: "req_current".into(),
        method: Method::PaneCurrent(PaneCurrentParams {
            caller_pane_id: Some("w1-1".into()),
        }),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "pane.current");
    assert_eq!(json["params"]["caller_pane_id"], "w1-1");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn pane_process_info_request_round_trips() {
    let request = Request {
        id: "req_process_info".into(),
        method: Method::PaneProcessInfo(PaneProcessInfoParams {
            pane_id: Some("w1-1".into()),
        }),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "pane.process_info");
    assert_eq!(json["params"]["pane_id"], "w1-1");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn event_envelope_round_trips() {
    let events = [
        EventEnvelope {
            event: EventKind::PaneOutputChanged,
            data: EventData::PaneOutputChanged {
                pane_id: "p_1".into(),
                workspace_id: "w_1".into(),
                revision: 42,
            },
        },
        EventEnvelope {
            event: EventKind::WorkspaceMoved,
            data: EventData::WorkspaceMoved {
                workspace_id: "w_1".into(),
                insert_index: 2,
                workspaces: vec![],
            },
        },
        EventEnvelope {
            event: EventKind::WorkspaceReordered,
            data: EventData::WorkspaceReordered {
                workspace_ids: vec!["w_1".into(), "w_2".into()],
                before_workspace_id: Some("w_3".into()),
                workspaces: vec![],
            },
        },
        EventEnvelope {
            event: EventKind::TabMoved,
            data: EventData::TabMoved {
                tab_id: "w_1:1".into(),
                workspace_id: "w_1".into(),
                insert_index: 1,
                tabs: vec![],
            },
        },
        EventEnvelope {
            event: EventKind::LayoutUpdated,
            data: EventData::LayoutUpdated {
                layout: PaneLayoutSnapshot {
                    workspace_id: "w_1".into(),
                    tab_id: "w_1:1".into(),
                    zoomed: false,
                    area: PaneLayoutRect {
                        x: 0,
                        y: 0,
                        width: 100,
                        height: 24,
                    },
                    focused_pane_id: "w_1-1".into(),
                    panes: vec![PaneLayoutPane {
                        pane_id: "w_1-1".into(),
                        focused: true,
                        rect: PaneLayoutRect {
                            x: 0,
                            y: 0,
                            width: 100,
                            height: 24,
                        },
                    }],
                    splits: vec![],
                },
            },
        },
    ];

    for event in events {
        let json = serde_json::to_string(&event).unwrap();
        let restored: EventEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, event);
    }
}

#[test]
fn subscribe_request_parses_parameterized_subscriptions() {
    let json = r#"
    {
        "id": "sub_1",
        "method": "events.subscribe",
        "params": {
            "subscriptions": [
                {
                    "type": "pane.output_matched",
                    "pane_id": "p_1_1",
                    "source": "recent",
                    "lines": 200,
                    "match": { "type": "substring", "value": "auth: received" }
                },
                {
                    "type": "pane.agent_status_changed",
                    "pane_id": "p_1_1",
                    "agent_status": "done"
                },
                {
                    "type": "pane.scroll_changed",
                    "pane_id": "p_1_1"
                }
            ]
        }
    }
    "#;

    let request: Request = serde_json::from_str(json).unwrap();
    let Method::EventsSubscribe(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert_eq!(params.subscriptions.len(), 3);
    assert!(matches!(
        &params.subscriptions[0],
        Subscription::PaneOutputMatched {
            pane_id,
            source: ReadSource::Recent,
            lines: Some(200),
            r#match: OutputMatch::Substring { value },
            strip_ansi: true,
        } if pane_id == "p_1_1" && value == "auth: received"
    ));
    assert!(matches!(
        &params.subscriptions[1],
        Subscription::PaneAgentStatusChanged {
            pane_id,
            agent_status: Some(AgentStatus::Done),
        } if pane_id == "p_1_1"
    ));
    assert!(matches!(
        &params.subscriptions[2],
        Subscription::PaneScrollChanged { pane_id } if pane_id == "p_1_1"
    ));
}

#[test]
fn subscription_event_envelope_round_trips() {
    let event = SubscriptionEventEnvelope {
        event: SubscriptionEventKind::PaneOutputMatched,
        data: SubscriptionEventData::PaneOutputMatched(PaneOutputMatchedEvent {
            pane_id: "p_1_1".into(),
            matched_line: "auth: received".into(),
            read: PaneReadResult {
                pane_id: "p_1_1".into(),
                workspace_id: "w_1".into(),
                tab_id: "t_1_1".into(),
                source: ReadSource::Recent,
                format: ReadFormat::Text,
                text: "auth: received\n".into(),
                revision: 0,
                truncated: false,
            },
        }),
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"event\":\"pane.output_matched\""));
    let restored: SubscriptionEventEnvelope = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, event);
}

#[test]
fn scroll_changed_subscription_event_round_trips() {
    let event = SubscriptionEventEnvelope {
        event: SubscriptionEventKind::ScrollChanged,
        data: SubscriptionEventData::ScrollChanged(PaneScrollChangedEvent {
            pane_id: "p_1_1".into(),
            workspace_id: "w_1".into(),
            scroll: PaneScrollInfo {
                offset_from_bottom: 12,
                max_offset_from_bottom: 240,
                viewport_rows: 30,
            },
        }),
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"event\":\"pane.scroll_changed\""));
    let restored: SubscriptionEventEnvelope = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, event);
}

#[test]
fn agent_status_request_values_remain_strict() {
    assert!(serde_json::from_str::<AgentStatus>(r#""working""#).is_ok());
    assert!(serde_json::from_str::<AgentStatus>(r#""future_status""#).is_err());
}

#[test]
fn success_response_round_trips() {
    let response = SuccessResponse {
        id: "req_1".into(),
        result: ResponseResult::Pong {
            version: "0.1.2".into(),
            protocol: 6,
            capabilities: Some(ServerCapabilities {
                live_handoff: true,
                detached_server_daemon: true,
                endpoint_protocol_generation: Some(1),
                surface_interest: true,
                health_check: true,
                ssh_agent_registration: false,
            }),
        },
    };

    let json = serde_json::to_string(&response).unwrap();
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn session_snapshot_request_and_response_round_trip() {
    let request = Request {
        id: "req_snapshot".into(),
        method: Method::SessionSnapshot(EmptyParams::default()),
    };
    let json = serde_json::to_string(&request).unwrap();
    assert!(json.contains("\"method\":\"session.snapshot\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, request);

    let response = SuccessResponse {
        id: "req_snapshot".into(),
        result: ResponseResult::SessionSnapshot {
            snapshot: Box::new(SessionSnapshot {
                version: "0.1.2".into(),
                protocol: 16,
                focused_workspace_id: None,
                focused_tab_id: None,
                focused_pane_id: None,
                workspaces: Vec::new(),
                tabs: Vec::new(),
                panes: Vec::new(),
                layouts: Vec::new(),
                agents: Vec::new(),
            }),
        },
    };
    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"type\":\"session_snapshot\""));
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn worktree_request_and_response_round_trip() {
    let request = Request {
        id: "req_worktree".into(),
        method: Method::WorktreeCreate(WorktreeCreateParams {
            workspace_id: Some("1".into()),
            branch: Some("worktree/api".into()),
            base: Some("HEAD".into()),
            focus: true,
            trust_repository: true,
            ..WorktreeCreateParams::default()
        }),
    };
    let json = serde_json::to_string(&request).unwrap();
    assert!(json.contains("\"trust_repository\":true"));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, request);

    let response = SuccessResponse {
        id: "req_worktree".into(),
        result: ResponseResult::WorktreeCreated {
            workspace: WorkspaceInfo {
                workspace_id: "w_1".into(),
                number: 2,
                label: "herdr".into(),
                focused: true,
                pane_count: 1,
                tab_count: 1,
                active_tab_id: "w_1:1".into(),
                agent_status: AgentStatus::Unknown,
                tokens: HashMap::new(),
                worktree: Some(WorkspaceWorktreeInfo {
                    repo_key: "/repo/herdr/.git".into(),
                    repo_name: "herdr".into(),
                    repo_root: "/repo/herdr".into(),
                    checkout_path: "/worktrees/herdr/worktree-api".into(),
                    is_linked_worktree: true,
                }),
            },
            tab: TabInfo {
                tab_id: "w_1:1".into(),
                workspace_id: "w_1".into(),
                number: 1,
                label: "herdr".into(),
                focused: true,
                pane_count: 1,
                agent_status: AgentStatus::Unknown,
            },
            root_pane: PaneInfo {
                pane_id: "w_1-1".into(),
                terminal_id: "term_1".into(),
                workspace_id: "w_1".into(),
                tab_id: "w_1:1".into(),
                focused: true,
                cwd: Some("/worktrees/herdr/worktree-api".into()),
                foreground_cwd: None,
                restore_error: None,
                label: None,
                agent: None,
                title: None,
                terminal_title: None,
                terminal_title_stripped: None,
                display_agent: None,
                agent_status: AgentStatus::Unknown,
                state_labels: HashMap::new(),
                tokens: HashMap::new(),
                agent_session: None,
                scroll: None,
                remote_answers: false,
                revision: 0,
            },
            worktree: WorktreeInfo {
                path: "/worktrees/herdr/worktree-api".into(),
                branch: Some("worktree/api".into()),
                is_bare: false,
                is_detached: false,
                is_prunable: false,
                is_linked_worktree: true,
                open_workspace_id: Some("w_1".into()),
                label: "herdr".into(),
            },
        },
    };
    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"type\":\"worktree_created\""));
    assert!(json.contains("\"worktree\""));
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn worktree_lifecycle_events_round_trip() {
    let subscription = Request {
        id: "sub_worktrees".into(),
        method: Method::EventsSubscribe(EventsSubscribeParams {
            subscriptions: vec![
                Subscription::WorktreeCreated {},
                Subscription::WorktreeOpened {},
                Subscription::WorktreeRemoved {},
            ],
        }),
    };
    let json = serde_json::to_string(&subscription).unwrap();
    assert!(json.contains("\"type\":\"worktree.created\""));
    assert!(json.contains("\"type\":\"worktree.opened\""));
    assert!(json.contains("\"type\":\"worktree.removed\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, subscription);

    let workspace = WorkspaceInfo {
        workspace_id: "w_2".into(),
        number: 2,
        label: "herdr".into(),
        focused: true,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: "w_2:1".into(),
        agent_status: AgentStatus::Unknown,
        tokens: HashMap::new(),
        worktree: Some(WorkspaceWorktreeInfo {
            repo_key: "/repo/herdr/.git".into(),
            repo_name: "herdr".into(),
            repo_root: "/repo/herdr".into(),
            checkout_path: "/worktrees/herdr/worktree-api".into(),
            is_linked_worktree: true,
        }),
    };
    let worktree = WorktreeInfo {
        path: "/worktrees/herdr/worktree-api".into(),
        branch: Some("worktree/api".into()),
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: Some("w_2".into()),
        label: "herdr".into(),
    };

    for event in [
        EventEnvelope {
            event: EventKind::WorktreeCreated,
            data: EventData::WorktreeCreated {
                workspace: workspace.clone(),
                worktree: worktree.clone(),
            },
        },
        EventEnvelope {
            event: EventKind::WorktreeOpened,
            data: EventData::WorktreeOpened {
                workspace: workspace.clone(),
                worktree: worktree.clone(),
                already_open: false,
            },
        },
        EventEnvelope {
            event: EventKind::WorktreeRemoved,
            data: EventData::WorktreeRemoved {
                workspace_id: "w_2".into(),
                workspace: Some(workspace.clone()),
                worktree: WorktreeInfo {
                    open_workspace_id: None,
                    ..worktree.clone()
                },
                forced: false,
            },
        },
        EventEnvelope {
            event: EventKind::WorkspaceClosed,
            data: EventData::WorkspaceClosed {
                workspace_id: "w_2".into(),
                workspace: Some(workspace.clone()),
            },
        },
    ] {
        let json = serde_json::to_string(&event).unwrap();
        let restored: EventEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, event);
    }
}

#[test]
fn plugin_link_list_unlink_round_trip() {
    let link = Request {
        id: "plugin_link".into(),
        method: Method::PluginLink(PluginLinkParams {
            path: "/plugins/worktree-bootstrap".into(),
            enabled: true,
            source: None,
        }),
    };
    let json = serde_json::to_string(&link).unwrap();
    assert!(json.contains("\"method\":\"plugin.link\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, link);

    let list = Request {
        id: "plugin_list".into(),
        method: Method::PluginList(PluginListParams {
            plugin_id: Some("example.worktree-bootstrap".into()),
        }),
    };
    let json = serde_json::to_string(&list).unwrap();
    assert!(json.contains("\"method\":\"plugin.list\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, list);

    let unlink = Request {
        id: "plugin_unlink".into(),
        method: Method::PluginUnlink(PluginUnlinkParams {
            plugin_id: "example.worktree-bootstrap".into(),
        }),
    };
    let json = serde_json::to_string(&unlink).unwrap();
    assert!(json.contains("\"method\":\"plugin.unlink\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, unlink);

    let plugin = InstalledPluginInfo {
        plugin_id: "example.worktree-bootstrap".into(),
        name: "Worktree Bootstrap".into(),
        version: "0.1.0".into(),
        min_herdr_version: crate::build_info::BASE_VERSION.into(),
        description: Some("Prepare new worktrees".into()),
        manifest_path: "/plugins/worktree-bootstrap/herdr-plugin.toml".into(),
        plugin_root: "/plugins/worktree-bootstrap".into(),
        enabled: true,
        platforms: None,
        build: vec![PluginManifestBuild {
            platforms: None,
            command: vec!["bun".into(), "install".into()],
        }],
        startup: vec![],
        actions: vec![PluginManifestAction {
            id: "bootstrap".into(),
            title: "Bootstrap worktree".into(),
            description: None,
            contexts: vec![PluginActionContext::Workspace],
            platforms: None,
            command: vec!["bun".into(), "run".into(), "bootstrap.ts".into()],
        }],
        events: vec![PluginManifestEventHook {
            on: "worktree.created".into(),
            platforms: None,
            command: vec!["bun".into(), "run".into(), "bootstrap.ts".into()],
        }],
        panes: vec![PluginManifestPane {
            id: "board".into(),
            title: "Board".into(),
            description: None,
            platforms: None,
            placement: PluginPanePlacement::Overlay,
            width: None,
            height: None,
            command: vec!["bun".into(), "run".into(), "board.ts".into()],
        }],
        link_handlers: vec![PluginManifestLinkHandler {
            id: "github-pr".into(),
            title: "Open GitHub PR".into(),
            pattern: "^https://github.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$".into(),
            action: "bootstrap".into(),
            platforms: None,
        }],
        source: Default::default(),
        warnings: vec![],
    };

    for response in [
        SuccessResponse {
            id: "plugin_link".into(),
            result: ResponseResult::PluginLinked {
                plugin: plugin.clone(),
            },
        },
        SuccessResponse {
            id: "plugin_list".into(),
            result: ResponseResult::PluginList {
                plugins: vec![plugin.clone()],
            },
        },
        SuccessResponse {
            id: "plugin_unlink".into(),
            result: ResponseResult::PluginUnlinked {
                plugin_id: plugin.plugin_id.clone(),
                removed: true,
            },
        },
    ] {
        let json = serde_json::to_string(&response).unwrap();
        let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, response);
    }
}

#[test]
fn layout_export_apply_round_trip() {
    let root = LayoutNode::Split {
        direction: SplitDirection::Right,
        ratio: 0.6,
        first: Box::new(LayoutNode::Pane {
            pane: LayoutPane {
                label: Some("editor".into()),
                cwd: Some("/repo".into()),
                ..Default::default()
            },
        }),
        second: Box::new(LayoutNode::Pane {
            pane: LayoutPane {
                label: Some("tests".into()),
                command: Some(vec!["sh".into(), "-c".into(), "just test".into()]),
                env: HashMap::from([("HERDR_ROLE".into(), "tests".into())]),
                ..Default::default()
            },
        }),
    };

    let export = Request {
        id: "layout_export".into(),
        method: Method::LayoutExport(LayoutExportParams {
            tab_id: Some("w1:1".into()),
            pane_id: None,
        }),
    };
    let json = serde_json::to_string(&export).unwrap();
    assert!(json.contains("\"method\":\"layout.export\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, export);

    let apply = Request {
        id: "layout_apply".into(),
        method: Method::LayoutApply(LayoutApplyParams {
            workspace_id: Some("w1".into()),
            tab_id: None,
            tab_label: Some("dev".into()),
            focus: true,
            root: root.clone(),
        }),
    };
    let json = serde_json::to_string(&apply).unwrap();
    assert!(json.contains("\"method\":\"layout.apply\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, apply);

    let response = SuccessResponse {
        id: "layout_export".into(),
        result: ResponseResult::LayoutExport {
            layout: LayoutDescription {
                workspace_id: "w1".into(),
                tab_id: "w1:1".into(),
                zoomed: false,
                focused_pane_id: "w1-1".into(),
                root,
            },
        },
    };
    let json = serde_json::to_string(&response).unwrap();
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);

    let response = SuccessResponse {
        id: "layout_ratio".into(),
        result: ResponseResult::LayoutSplitRatioSet {
            layout: LayoutDescription {
                workspace_id: "w1".into(),
                tab_id: "w1:1".into(),
                zoomed: false,
                focused_pane_id: "w1-1".into(),
                root: LayoutNode::Pane {
                    pane: LayoutPane {
                        pane_id: Some("w1-1".into()),
                        ..Default::default()
                    },
                },
            },
        },
    };
    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"type\":\"layout_split_ratio_set\""));
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn authority_mutation_requests_round_trip() {
    let workspace_move = Request {
        id: "move_ws".into(),
        method: Method::WorkspaceMove(WorkspaceMoveParams {
            workspace_id: "w1".into(),
            insert_index: 2,
        }),
    };
    let json = serde_json::to_value(&workspace_move).unwrap();
    assert_eq!(json["method"], "workspace.move");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, workspace_move);

    let workspace_move_block = Request {
        id: "move_ws_block".into(),
        method: Method::WorkspaceMoveBlock(WorkspaceMoveBlockParams {
            workspace_ids: vec!["w1".into(), "w2".into()],
            before_workspace_id: Some("w3".into()),
        }),
    };
    let json = serde_json::to_value(&workspace_move_block).unwrap();
    assert_eq!(json["method"], "workspace.move_block");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, workspace_move_block);

    let tab_move = Request {
        id: "move_tab".into(),
        method: Method::TabMove(TabMoveParams {
            tab_id: "w1:1".into(),
            insert_index: 1,
        }),
    };
    let json = serde_json::to_value(&tab_move).unwrap();
    assert_eq!(json["method"], "tab.move");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, tab_move);

    let pane_focus = Request {
        id: "focus_pane".into(),
        method: Method::PaneFocus(PaneTarget {
            pane_id: "w1:1".into(),
        }),
    };
    let json = serde_json::to_value(&pane_focus).unwrap();
    assert_eq!(json["method"], "pane.focus");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, pane_focus);

    let split_ratio = Request {
        id: "set_ratio".into(),
        method: Method::LayoutSetSplitRatio(LayoutSetSplitRatioParams {
            tab_id: Some("w1:1".into()),
            pane_id: None,
            path: vec![false, true],
            ratio: 0.6,
        }),
    };
    let json = serde_json::to_value(&split_ratio).unwrap();
    assert_eq!(json["method"], "layout.set_split_ratio");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, split_ratio);

    let subscription = Request {
        id: "sub_moves".into(),
        method: Method::EventsSubscribe(EventsSubscribeParams {
            subscriptions: vec![
                Subscription::WorkspaceMoved {},
                Subscription::WorkspaceReordered {},
                Subscription::TabMoved {},
                Subscription::LayoutUpdated {},
            ],
        }),
    };
    let json = serde_json::to_string(&subscription).unwrap();
    assert!(json.contains("\"type\":\"workspace.moved\""));
    assert!(json.contains("\"type\":\"workspace.reordered\""));
    assert!(json.contains("\"type\":\"tab.moved\""));
    assert!(json.contains("\"type\":\"layout.updated\""));
    let restored: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, subscription);
}

#[test]
fn create_response_round_trips_with_root_pane() {
    let response = SuccessResponse {
        id: "req_2".into(),
        result: ResponseResult::TabCreated {
            tab: TabInfo {
                tab_id: "w_1:2".into(),
                workspace_id: "w_1".into(),
                number: 2,
                label: "review".into(),
                focused: false,
                pane_count: 1,
                agent_status: AgentStatus::Unknown,
            },
            root_pane: PaneInfo {
                pane_id: "w_1-3".into(),
                terminal_id: "term_example".into(),
                workspace_id: "w_1".into(),
                tab_id: "w_1:2".into(),
                focused: false,
                cwd: Some("/tmp/review".into()),
                foreground_cwd: None,
                restore_error: None,
                label: None,
                agent: None,
                title: None,
                terminal_title: None,
                terminal_title_stripped: None,
                display_agent: None,
                agent_status: AgentStatus::Unknown,
                state_labels: HashMap::new(),
                tokens: HashMap::new(),
                agent_session: None,
                scroll: None,
                remote_answers: false,
                revision: 0,
            },
        },
    };

    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"type\":\"tab_created\""));
    assert!(json.contains("\"root_pane\""));
    let restored: SuccessResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn error_response_round_trips() {
    let response = ErrorResponse {
        id: "req_1".into(),
        error: ErrorBody {
            code: "pane_not_found".into(),
            message: "pane p_1 not found".into(),
        },
    };

    let json = serde_json::to_string(&response).unwrap();
    let restored: ErrorResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn event_wait_parses_typed_match() {
    let json = r#"
    {
        "id": "req_9",
        "method": "events.wait",
        "params": {
            "match_event": {
                "event": "pane_agent_status_changed",
                "pane_id": "p_1",
                "agent_status": "done"
            },
            "timeout_ms": 30000
        }
    }
    "#;

    let request: Request = serde_json::from_str(json).unwrap();
    let Method::EventsWait(params) = request.method else {
        panic!("wrong method parsed");
    };
    assert_eq!(
        params.match_event,
        EventMatch::PaneAgentStatusChanged {
            pane_id: "p_1".into(),
            agent_status: AgentStatus::Done,
        }
    );
}

#[test]
fn pane_link_activate_round_trips() {
    let request = Request {
        id: "req_pane_link".into(),
        method: Method::PaneLinkActivate(PaneLinkActivateParams {
            pane_id: "w1:p1".into(),
            viewport_row: 3,
            col: 7,
            content_revision: Some(42),
            offset_from_bottom: Some(5),
        }),
    };
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "pane.link.activate");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);

    let response = ResponseResult::PaneLinkActivated {
        url: Some("https://example.test".into()),
        handled: false,
    };
    let json = serde_json::to_string(&response).unwrap();
    let restored: ResponseResult = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, response);
}

#[test]
fn plugin_action_list_and_invoke_round_trips() {
    let list = Request {
        id: "req_plugin_action_list".into(),
        method: Method::PluginActionList(PluginActionListParams {
            plugin_id: Some("example.issue-flow".into()),
        }),
    };
    let json = serde_json::to_value(&list).unwrap();
    assert_eq!(json["method"], "plugin.action.list");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, list);

    let invoke = Request {
        id: "req_plugin_action_invoke".into(),
        method: Method::PluginActionInvoke(PluginActionInvokeParams {
            plugin_id: Some("example.issue-flow".into()),
            action_id: "assign-issue".into(),
            context: None,
        }),
    };
    let json = serde_json::to_value(&invoke).unwrap();
    assert_eq!(json["method"], "plugin.action.invoke");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, invoke);

    let action_info = PluginActionInfo {
        plugin_id: "example.issue-flow".into(),
        action_id: "assign-issue".into(),
        title: "Assign Issue".into(),
        description: Some("Open the issue assignment UI".into()),
        contexts: vec![PluginActionContext::Workspace, PluginActionContext::Pane],
        command: vec!["assign".into(), "--issue".into()],
        platforms: Some(vec![PluginPlatform::Linux, PluginPlatform::Macos]),
    };
    assert_eq!(
        action_info.qualified_id(),
        "example.issue-flow.assign-issue"
    );
    let json = serde_json::to_string(&action_info).unwrap();
    let restored: PluginActionInfo = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, action_info);
}

#[test]
fn plugin_pane_open_request_round_trips() {
    let request = Request {
        id: "req_plugin_pane".into(),
        method: Method::PluginPaneOpen(PluginPaneOpenParams {
            plugin_id: "example.board".into(),
            entrypoint: "board".into(),
            placement: Some(PluginPanePlacement::Popup),
            width: Some(crate::popup_size::PopupSize::Cells(90)),
            height: Some(crate::popup_size::PopupSize::Percent(80)),
            workspace_id: None,
            target_pane_id: None,
            direction: None,
            cwd: Some("/tmp".into()),
            focus: true,
            env: [("HERDR_ROLE".to_string(), "board".to_string())].into(),
        }),
    };

    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "plugin.pane.open");
    assert_eq!(json["params"]["placement"], "popup");
    assert_eq!(json["params"]["width"], 90);
    assert_eq!(json["params"]["height"], "80%");
    assert_eq!(json["params"]["env"]["HERDR_ROLE"], "board");
    let restored: Request = serde_json::from_value(json).unwrap();
    assert_eq!(restored, request);
}

#[test]
fn popup_close_request_round_trips() {
    let request = Request {
        id: "popup-close".into(),
        method: Method::PopupClose(EmptyParams::default()),
    };

    let json = serde_json::to_value(request).unwrap();

    assert_eq!(json["method"], "popup.close");
    assert_eq!(json["params"], serde_json::json!({}));
}

#[test]
fn pane_link_resolve_round_trips() {
    let request: Request = serde_json::from_value(serde_json::json!({
        "id": "hover", "method": "pane.link.resolve",
        "params": {"pane_id": "pane-1", "viewport_row": 2, "col": 3}
    }))
    .unwrap();
    assert!(matches!(request.method, Method::PaneLinkResolve(_)));
    let result = ResponseResult::PaneLinkResolved {
        regions: vec![PaneLinkRegion {
            row: 2,
            start_col: 3,
            end_col: 9,
        }],
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["type"], "pane_link_resolved");
    assert_eq!(json["regions"][0]["end_col"], 9);
    assert_eq!(
        serde_json::from_value::<ResponseResult>(json).unwrap(),
        result
    );
}

#[test]
fn targeted_notification_method_requires_a_target_and_ordinary_method_accepts_optional_target() {
    let request: Request = serde_json::from_value(serde_json::json!({
        "id": "n", "method": "notification.show_targeted", "params": { "title": "codex approval", "target": {"pane_id": "pane_1"} }
    })).unwrap();
    assert!(
        matches!(request.method, Method::NotificationShowTargeted(params) if params.target.pane_id.as_deref() == Some("pane_1"))
    );
    assert!(serde_json::from_value::<Request>(serde_json::json!({"id":"n", "method":"notification.show_targeted", "params":{"title":"notice"}})).is_err());
    let request: Request = serde_json::from_value(serde_json::json!({"id":"n", "method":"notification.show", "params":{"title":"notice", "target":{"tab_id":"tab_1"}}})).unwrap();
    assert!(
        matches!(request.method, Method::NotificationShow(params) if params.target.as_ref().unwrap().tab_id.as_deref() == Some("tab_1"))
    );
}
