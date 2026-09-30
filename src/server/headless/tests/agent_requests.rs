use super::*;

fn api_message(
    id: &str,
    method: api::schema::Method,
    stream_active: Option<Arc<AtomicBool>>,
) -> (api::ApiRequestMessage, std::sync::mpsc::Receiver<String>) {
    let (respond_to, response_rx) = std::sync::mpsc::channel();
    (
        api::ApiRequestMessage {
            request: api::schema::Request {
                id: id.into(),
                method,
            },
            respond_to,
            response_write_complete: None,
            stream_active,
        },
        response_rx,
    )
}

#[test]
fn a_reported_agent_request_is_answered_on_the_hook_channel() {
    let mut server = test_headless_server();
    server.app.state.workspaces = vec![crate::workspace::Workspace::test_new("agent")];
    server.app.state.ensure_test_terminals();
    let pane_id = server.app.state.workspaces[0].tabs[0].root_pane;
    let terminal_id = server.app.state.workspaces[0].panes[&pane_id]
        .attached_terminal_id
        .clone();
    server
        .app
        .state
        .terminals
        .get_mut(&terminal_id)
        .unwrap()
        .set_detected_state(
            Some(crate::detect::Agent::Claude),
            crate::detect::AgentState::Working,
        );
    let public_pane_id = server.app.public_pane_id(0, pane_id).unwrap();

    let waiting = Arc::new(AtomicBool::new(true));
    let (report, hook_rx) = api_message(
        "hook",
        api::schema::Method::PaneReportAgentRequest(api::schema::PaneReportAgentRequestParams {
            pane_id: public_pane_id.clone(),
            source: "herdr:claude".into(),
            agent: "claude".into(),
            agent_session_id: None,
            request: api::schema::AgentRequestContent {
                kind: api::schema::AgentRequestKind::Permission,
                tool_name: "Bash".into(),
                description: None,
                input_preview: "ls".into(),
                decisions: vec![api::schema::AgentRequestDecision::Allow],
                questions: Vec::new(),
            },
            timeout_ms: None,
        }),
        Some(Arc::clone(&waiting)),
    );
    assert!(!server.handle_api_request_with_shutdown_check(report));
    assert!(hook_rx.try_recv().is_err(), "the hook waits for an answer");

    let (answer, answer_rx) = api_message(
        "answer",
        api::schema::Method::AgentAnswer(api::schema::AgentAnswerParams {
            target: public_pane_id,
            request_id: 1,
            answer: api::schema::AgentRequestAnswer {
                decision: Some(api::schema::AgentRequestDecision::Allow),
                message: None,
                answers: None,
            },
        }),
        None,
    );
    server.handle_api_request_with_shutdown_check(answer);

    let answered: serde_json::Value =
        serde_json::from_str(&answer_rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(answered["result"]["type"], "agent_info", "{answered}");
    let hook: serde_json::Value =
        serde_json::from_str(&hook_rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(
        hook,
        serde_json::json!({
            "id": "hook",
            "result": {"type": "agent_request_answered", "request_id": 1, "decision": "allow"},
        })
    );
    shutdown_test_runtimes(&mut server);
}
