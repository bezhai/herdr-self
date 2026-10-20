//! Agent notifications that nobody needs: the Finished of the turn that a
//! callee ends during an agent call, and every agent notification of a pane
//! whose remote answers are on.

use super::*;
use crate::detect::{Agent, AgentState};
use crate::layout::PaneId;
use protocol::SemanticNotificationKind::{Finished, NeedsAttention};

/// How the callee's state changes reach the server.
#[derive(Debug, Clone, Copy)]
enum Report {
    /// Screen detection, handled as an internal event.
    Screen,
    /// An integration hook, handled as an API request.
    Hook,
}

const REPORTS: [Report; 2] = [Report::Screen, Report::Hook];

/// What the foreground client shell received: the kinds of semantic
/// notifications, and the titles of legacy toast and sound notifies.
#[derive(Debug, Default, PartialEq, Eq)]
struct Received {
    semantic: Vec<protocol::SemanticNotificationKind>,
    legacy: Vec<String>,
}

impl Received {
    fn nothing() -> Self {
        Self::default()
    }

    fn finished() -> Self {
        Self {
            semantic: vec![Finished],
            legacy: vec!["agent done".into(), "pi finished".into()],
        }
    }

    fn needs_attention() -> Self {
        Self {
            semantic: vec![NeedsAttention],
            legacy: vec!["agent attention".into(), "pi needs attention".into()],
        }
    }
}

/// A Claude caller and an idle Pi callee in a background workspace, and a
/// foreground client shell that takes system toasts and sounds. Pi reports
/// its states through its integration hooks as well as on screen.
struct Fixture {
    server: HeadlessServer,
    control_rx: std::sync::mpsc::Receiver<Vec<u8>>,
    _render_rx: std::sync::mpsc::Receiver<Vec<u8>>,
    caller: PaneId,
    callee: PaneId,
    session_path: String,
    hook_seq: u64,
}

impl Fixture {
    fn new() -> Self {
        let mut server = test_headless_server();
        let mut background = crate::workspace::Workspace::test_new("background");
        let caller = background.tabs[0].root_pane;
        let callee = background.test_split(ratatui::layout::Direction::Horizontal);
        server.app.state.workspaces =
            vec![background, crate::workspace::Workspace::test_new("active")];
        server.app.state.ensure_test_terminals();
        server.app.state.active = Some(1);
        server.app.state.toast_config.delivery = crate::config::ToastDelivery::System;
        server.app.state.toast_config.delay_seconds = 0;
        server.app.state.sound.enabled = true;
        for (pane_id, agent) in [(caller, Agent::Claude), (callee, Agent::Pi)] {
            let terminal_id = server.app.state.workspaces[0].panes[&pane_id]
                .attached_terminal_id
                .clone();
            server
                .app
                .state
                .terminals
                .get_mut(&terminal_id)
                .unwrap()
                .set_detected_state(Some(agent), AgentState::Idle);
        }
        // Pi's integration reports the states of the session Herdr knows.
        let session_path = std::env::current_dir()
            .unwrap()
            .join("quiet-notifications-pi.jsonl")
            .display()
            .to_string();
        let terminal_id = server.app.state.workspaces[0].panes[&callee]
            .attached_terminal_id
            .clone();
        server
            .app
            .state
            .terminals
            .get_mut(&terminal_id)
            .unwrap()
            .set_persisted_agent_session(crate::agent_resume::PersistedAgentSession {
                source: "herdr:pi".into(),
                agent: "pi".into(),
                session_ref: crate::agent_resume::AgentSessionRef::path(session_path.clone())
                    .unwrap(),
            });
        let (writer, control_rx, render_rx) = test_client_writer();
        server.clients.insert(
            1,
            ClientConnection::new(
                (80, 24),
                Default::default(),
                1,
                RenderEncoding::SemanticFrame,
                Some(writer),
            ),
        );
        server.foreground_client_id = Some(1);
        server.sync_foreground_client_state();
        let mut fixture = Self {
            server,
            control_rx,
            _render_rx: render_rx,
            caller,
            callee,
            session_path,
            hook_seq: 0,
        };
        fixture.received();
        fixture
    }

    fn callee_public_id(&self) -> String {
        self.server.app.public_pane_id(0, self.callee).unwrap()
    }

    fn callee_terminal(&self) -> &crate::terminal::TerminalState {
        let terminal_id =
            &self.server.app.state.workspaces[0].panes[&self.callee].attached_terminal_id;
        &self.server.app.state.terminals[terminal_id]
    }

    fn next_hook_seq(&mut self) -> Option<u64> {
        self.hook_seq += 1;
        Some(self.hook_seq)
    }

    /// The Claude agent in the caller pane calls the Pi callee.
    fn call(&mut self) -> u64 {
        self.server
            .app
            .state
            .register_agent_call(crate::app::agent_calls::NewAgentCall {
                caller_pane: self.caller,
                caller_agent: Agent::Claude,
                callee_pane: self.callee,
                callee_agent: Agent::Pi,
                answer_requests: false,
                turns_remote_answers_off: false,
            })
    }

    fn report(&mut self, report: Report, state: AgentState) {
        match report {
            Report::Screen => {
                self.server
                    .handle_internal_event_with_forwarding(AppEvent::StateChanged {
                        pane_id: self.callee,
                        agent: Some(Agent::Pi),
                        state,
                        visible_blocker: state == AgentState::Blocked,
                        visible_working: state == AgentState::Working,
                        process_exited: false,
                        observed_at: Instant::now(),
                    });
            }
            Report::Hook => {
                let state = match state {
                    AgentState::Idle => api::schema::PaneAgentState::Idle,
                    AgentState::Working => api::schema::PaneAgentState::Working,
                    AgentState::Blocked => api::schema::PaneAgentState::Blocked,
                    AgentState::Unknown => api::schema::PaneAgentState::Unknown,
                };
                let params = api::schema::PaneReportAgentParams {
                    pane_id: self.callee_public_id(),
                    source: "herdr:pi".into(),
                    agent: "pi".into(),
                    state,
                    message: None,
                    seq: self.next_hook_seq(),
                    agent_session_id: None,
                    agent_session_path: Some(self.session_path.clone()),
                };
                completion_guard_api_report(
                    &mut self.server,
                    api::schema::Method::PaneReportAgent(params),
                );
            }
        }
    }

    /// The callee's integration reports the reply of its turn.
    fn reply(&mut self) {
        let params = api::schema::PaneReportAgentReplyParams {
            pane_id: self.callee_public_id(),
            source: "herdr:pi".into(),
            agent: "pi".into(),
            seq: self.next_hook_seq(),
            agent_session_id: None,
            text: "the review".into(),
            truncated: false,
        };
        completion_guard_api_report(
            &mut self.server,
            api::schema::Method::PaneReportAgentReply(params),
        );
    }

    fn set_remote_answers(&mut self, enabled: bool) {
        let params = api::schema::PaneSetRemoteAnswersParams {
            pane_id: self.callee_public_id(),
            enabled,
        };
        completion_guard_api_report(
            &mut self.server,
            api::schema::Method::PaneSetRemoteAnswers(params),
        );
    }

    /// Everything the client received since the last call.
    fn received(&mut self) -> Received {
        self.server.send_to_client(
            1,
            ServerMessage::EndpointControl {
                kind: "test.quiet-barrier".into(),
                data: String::new(),
            },
        );
        let mut received = Received::default();
        loop {
            let message = read_server_message(
                self.control_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("notification barrier"),
            );
            match message {
                ServerMessage::EndpointControl { kind, .. } if kind == "test.quiet-barrier" => {
                    received.legacy.sort();
                    return received;
                }
                ServerMessage::SemanticNotification(notification) => {
                    received.semantic.push(notification.kind);
                }
                ServerMessage::Notify { message, .. } => received.legacy.push(message),
                _ => {}
            }
        }
    }

    /// The callee's status as the API reports it.
    fn callee_status(&mut self) -> String {
        let (respond_to, response_rx) = std::sync::mpsc::channel();
        self.server
            .handle_api_request_with_shutdown_check(api::ApiRequestMessage {
                request: api::schema::Request {
                    id: "status".into(),
                    method: api::schema::Method::PaneGet(api::schema::PaneTarget {
                        pane_id: self.callee_public_id(),
                    }),
                },
                respond_to,
                response_write_complete: None,
                stream_active: None,
            });
        let response: serde_json::Value = serde_json::from_str(
            &response_rx
                .recv_timeout(Duration::from_millis(100))
                .expect("pane.get responds"),
        )
        .unwrap();
        response["result"]["pane"]["agent_status"]
            .as_str()
            .unwrap_or_else(|| panic!("pane.get has an agent status: {response}"))
            .to_string()
    }

    /// The turn that just ended is a completion the sidebar and API show.
    fn assert_callee_done(&mut self, report: Report) {
        let terminal = self.callee_terminal();
        assert!(
            terminal.last_agent_completion_seq.is_some(),
            "{report:?}: the turn completes"
        );
        assert_eq!(
            terminal.last_agent_completion_seq, terminal.last_agent_state_change_seq,
            "{report:?}: the completion is the last change"
        );
        assert_eq!(self.callee_status(), "done", "{report:?}");
    }

    fn caller_notices(&self) -> Vec<String> {
        self.server.app.state.agent_call_notice_texts(self.caller)
    }
}

#[test]
fn callee_turn_with_its_reply_before_idle_finishes_without_a_notification() {
    for report in REPORTS {
        let mut fixture = Fixture::new();
        let call_id = fixture.call();
        fixture.report(report, AgentState::Working);
        fixture.reply();
        fixture.report(report, AgentState::Idle);

        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");
        assert_eq!(
            fixture
                .server
                .app
                .state
                .agent_call_of_callee(fixture.callee),
            None,
            "{report:?}: the idle callee ended the call"
        );
        let notices = fixture.caller_notices();
        assert_eq!(notices.len(), 1, "{report:?}: {notices:?}");
        assert!(
            notices[0].starts_with(&format!("[herdr] call {call_id} finished: ")),
            "{report:?}: {notices:?}"
        );
        fixture.assert_callee_done(report);
    }
}

#[test]
fn callee_turn_that_goes_idle_before_its_reply_finishes_without_a_notification() {
    for report in REPORTS {
        let mut fixture = Fixture::new();
        let call_id = fixture.call();
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Idle);
        assert_eq!(
            fixture
                .server
                .app
                .state
                .agent_call_of_callee(fixture.callee),
            Some(call_id),
            "{report:?}: the call waits for the reply"
        );
        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");
        fixture.assert_callee_done(report);

        fixture.reply();
        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");
        let notices = fixture.caller_notices();
        assert_eq!(notices.len(), 1, "{report:?}: {notices:?}");
        assert!(
            notices[0].starts_with(&format!("[herdr] call {call_id} finished: ")),
            "{report:?}: {notices:?}"
        );
        fixture.assert_callee_done(report);
    }
}

#[test]
fn callee_that_needs_attention_during_a_call_still_notifies() {
    for report in REPORTS {
        let mut fixture = Fixture::new();
        fixture.call();
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Blocked);

        assert_eq!(
            fixture.received(),
            Received::needs_attention(),
            "{report:?}"
        );
    }
}

#[test]
fn callee_turn_after_the_call_ended_notifies_finished() {
    for report in REPORTS {
        let mut fixture = Fixture::new();
        fixture.call();
        fixture.report(report, AgentState::Working);
        fixture.reply();
        fixture.report(report, AgentState::Idle);
        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");

        // A person prompts the callee directly once the call is over.
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Idle);

        assert_eq!(fixture.received(), Received::finished(), "{report:?}");
    }
}

#[test]
fn remote_answers_keep_finished_and_needs_attention_quiet_until_turned_off() {
    for report in REPORTS {
        let mut fixture = Fixture::new();
        fixture.set_remote_answers(true);
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Blocked);
        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Idle);
        assert_eq!(fixture.received(), Received::nothing(), "{report:?}");
        fixture.assert_callee_done(report);

        fixture.set_remote_answers(false);
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Blocked);
        assert_eq!(
            fixture.received(),
            Received::needs_attention(),
            "{report:?}"
        );
        fixture.report(report, AgentState::Working);
        fixture.report(report, AgentState::Idle);
        assert_eq!(fixture.received(), Received::finished(), "{report:?}");
    }
}

#[test]
fn callee_that_exits_during_its_call_turn_finishes_without_a_notification() {
    let mut fixture = Fixture::new();
    let call_id = fixture.call();
    fixture.report(Report::Screen, AgentState::Working);
    fixture
        .server
        .handle_internal_event_with_forwarding(AppEvent::PaneDied {
            pane_id: fixture.callee,
            exit_reason: crate::platform::ChildExitReason::Exited,
        });

    assert_eq!(fixture.received(), Received::nothing());
    let notices = fixture.caller_notices();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(
        notices[0].starts_with(&format!("[herdr] call {call_id} gone: ")),
        "{notices:?}"
    );
}

#[test]
fn agent_that_exits_with_remote_answers_on_finishes_without_a_notification() {
    let mut fixture = Fixture::new();
    fixture.set_remote_answers(true);
    fixture.report(Report::Screen, AgentState::Working);
    fixture
        .server
        .handle_internal_event_with_forwarding(AppEvent::PaneDied {
            pane_id: fixture.callee,
            exit_reason: crate::platform::ChildExitReason::Exited,
        });

    // Remote answers end with the agent, but the turn ended while they were on.
    assert_eq!(fixture.received(), Received::nothing());
}
