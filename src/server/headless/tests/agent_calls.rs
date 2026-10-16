use super::*;

fn set_state(
    server: &mut HeadlessServer,
    pane_id: crate::layout::PaneId,
    agent: crate::detect::Agent,
    state: crate::detect::AgentState,
) {
    server
        .app
        .handle_internal_event(crate::events::AppEvent::StateChanged {
            pane_id,
            agent: Some(agent),
            state,
            visible_blocker: false,
            visible_working: state == crate::detect::AgentState::Working,
            process_exited: false,
            observed_at: Instant::now(),
        });
}

fn recv_input(rx: &mut tokio::sync::mpsc::Receiver<bytes::Bytes>) -> bytes::Bytes {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(bytes) = rx.try_recv() {
            return bytes;
        }
        assert!(Instant::now() < deadline, "terminal input did not arrive");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn agent_call_through_the_server_responds_once_the_task_was_submitted() {
    let mut server = test_headless_server();
    let mut ws = crate::workspace::Workspace::test_new("calls");
    let caller = ws.tabs[0].root_pane;
    let callee = ws.test_split(ratatui::layout::Direction::Horizontal);
    server.app.state.workspaces = vec![ws];
    server.app.state.ensure_test_terminals();
    let mut inputs = Vec::new();
    for (pane_id, agent) in [
        (caller, crate::detect::Agent::Claude),
        (callee, crate::detect::Agent::Codex),
    ] {
        set_state(&mut server, pane_id, agent, crate::detect::AgentState::Idle);
        let (runtime, rx) = crate::terminal::TerminalRuntime::test_with_channel(80, 24);
        let terminal_id = server.app.state.workspaces[0].panes[&pane_id]
            .attached_terminal_id
            .clone();
        server.app.terminal_runtimes.insert(terminal_id, runtime);
        inputs.push(rx);
    }
    let callee_id = server.app.public_pane_id(0, callee).unwrap();
    let (respond_to, response_rx) = std::sync::mpsc::channel();
    server.handle_api_request_with_shutdown_check(api::ApiRequestMessage {
        request: api::schema::Request {
            id: "call".into(),
            method: api::schema::Method::AgentCall(api::schema::AgentCallParams {
                target: callee_id.clone(),
                text: "review".into(),
                caller_pane_id: server.app.public_pane_id(0, caller).unwrap(),
                answer_requests: false,
            }),
        },
        respond_to,
        response_write_complete: None,
        stream_active: None,
    });

    let response: serde_json::Value = serde_json::from_str(
        &response_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("agent.call responds"),
    )
    .unwrap();
    assert_eq!(response["result"]["type"], "agent_called", "{response}");
    assert_eq!(response["result"]["agent"]["pane_id"], callee_id.as_str());
    assert_eq!(
        recv_input(&mut inputs[1]),
        bytes::Bytes::from_static(b"review")
    );

    set_state(
        &mut server,
        callee,
        crate::detect::Agent::Codex,
        crate::detect::AgentState::Working,
    );
    set_state(
        &mut server,
        callee,
        crate::detect::Agent::Codex,
        crate::detect::AgentState::Idle,
    );
    server
        .app
        .advance_agent_calls(Instant::now() + crate::app::agent_calls::CALL_REPLY_GRACE);
    let notice = recv_input(&mut inputs[0]);
    assert!(
        notice.starts_with(b"[herdr] call 1 finished without reply: codex agent (pane "),
        "{:?}",
        String::from_utf8_lossy(&notice)
    );
    shutdown_test_runtimes(&mut server);
}
