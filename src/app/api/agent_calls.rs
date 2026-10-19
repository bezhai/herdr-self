//! `agent.call` and the delivery of call notices.
//!
//! The calls themselves are server state on `AppState` (see
//! `crate::app::agent_calls`); this module validates and submits a call's
//! task and submits due notices to their calling agents, both through the
//! same submission path as `agent.prompt`.

use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use crate::api::schema::{AgentCallParams, AgentInfo, ResponseResult};
use crate::app::agent_calls::NewAgentCall;
use crate::app::App;
use crate::detect::AgentState;
use crate::events::AppEvent;

use super::agents::{wait_for_submission, AgentSubmitError};
use super::panes::pane_not_found;
use super::responses::{encode_error, encode_error_body, encode_success};

/// How long a notice waits before another try when its calling agent could
/// not take it, for example because the agent is not the pane's foreground
/// process at the moment.
const NOTICE_RETRY: Duration = Duration::from_secs(1);

/// A call whose task is on its way to the target.
struct QueuedAgentCall {
    call_id: u64,
    agent: AgentInfo,
    completion: Receiver<std::io::Result<()>>,
}

impl App {
    /// Handles `agent.call`: answers on `respond_to` once the task reached
    /// the target's terminal, or at once when the call is refused.
    pub(super) fn start_agent_call(
        &mut self,
        id: String,
        params: AgentCallParams,
        respond_to: Sender<String>,
    ) {
        let queued = match self.queue_agent_call(&id, &params) {
            Ok(queued) => queued,
            Err(response) => {
                let _ = respond_to.send(response);
                return;
            }
        };
        tracing::info!(
            call_id = queued.call_id,
            target = %params.target,
            caller = %params.caller_pane_id,
            answer_requests = params.answer_requests,
            "agent call submitted"
        );
        let events = self.event_tx.clone();
        std::thread::spawn(move || {
            let response = match wait_for_submission(queued.completion) {
                Ok(()) => encode_success(
                    id,
                    ResponseResult::AgentCalled {
                        call_id: queued.call_id,
                        agent: queued.agent,
                    },
                ),
                Err(failure) => {
                    tracing::warn!(call_id = queued.call_id, %failure, "agent call task was not submitted");
                    let _ = events.blocking_send(AppEvent::AgentCallSubmissionFailed {
                        call_id: queued.call_id,
                    });
                    failure.encode(id)
                }
            };
            let _ = respond_to.send(response);
        });
    }

    /// Checks the call, submits its task, and registers it; the error is the
    /// response to send.
    fn queue_agent_call(
        &mut self,
        id: &str,
        params: &AgentCallParams,
    ) -> Result<QueuedAgentCall, String> {
        if params.text.is_empty() {
            return Err(encode_error(
                id.to_string(),
                "empty_agent_prompt",
                "agent call text must not be empty",
            ));
        }
        let Some((caller_ws_idx, caller_pane)) = self.parse_pane_id(&params.caller_pane_id) else {
            return Err(pane_not_found(id.to_string(), &params.caller_pane_id));
        };
        let Some(caller_agent) = self
            .state
            .terminal_id_for_pane(caller_ws_idx, caller_pane)
            .and_then(|terminal_id| self.state.terminals.get(&terminal_id))
            .and_then(crate::terminal::TerminalState::effective_known_agent)
        else {
            return Err(encode_error(
                id.to_string(),
                "caller_not_agent",
                format!(
                    "caller pane {} does not run an agent",
                    params.caller_pane_id
                ),
            ));
        };
        let resolved = self
            .resolve_agent_target(&params.target)
            .map_err(|err| encode_error_body(id.to_string(), self.agent_target_error_body(err)))?;
        if resolved.pane_id == caller_pane {
            return Err(encode_error(
                id.to_string(),
                "caller_is_target",
                format!(
                    "agent {} runs in the caller pane {}",
                    params.target, params.caller_pane_id
                ),
            ));
        }
        let Some(callee) = self
            .state
            .terminal_id_for_pane(resolved.ws_idx, resolved.pane_id)
            .and_then(|terminal_id| self.state.terminals.get(&terminal_id))
        else {
            return Err(AgentSubmitError::NotFound.encode(id.to_string(), &params.target));
        };
        if callee.state == AgentState::Working {
            return Err(encode_error(
                id.to_string(),
                "agent_working",
                format!("agent {} is working on a turn", params.target),
            ));
        }
        if let Some(call_id) = self.state.agent_call_of_callee(resolved.pane_id) {
            return Err(encode_error(
                id.to_string(),
                "agent_working",
                format!("agent {} is working on call {call_id}", params.target),
            ));
        }
        if !matches!(callee.state, AgentState::Idle | AgentState::Blocked) {
            return Err(encode_error(
                id.to_string(),
                "agent_not_ready",
                format!("agent {} is not idle", params.target),
            ));
        }
        let remote_answers_were_on = callee.remote_answers();
        let submission = self
            .submit_agent_prompt(resolved.ws_idx, resolved.pane_id, &params.text, None)
            .map_err(|err| err.encode(id.to_string(), &params.target))?;
        let Some(callee_agent) = self
            .state
            .terminal_id_for_pane(resolved.ws_idx, resolved.pane_id)
            .and_then(|terminal_id| self.state.terminals.get_mut(&terminal_id))
            .and_then(|terminal| {
                if params.answer_requests && !remote_answers_were_on {
                    terminal.enable_remote_answers();
                }
                terminal.effective_known_agent()
            })
        else {
            return Err(AgentSubmitError::NotFound.encode(id.to_string(), &params.target));
        };
        let turns_remote_answers_off = params.answer_requests && !remote_answers_were_on;
        if turns_remote_answers_off {
            self.emit_pane_updated(resolved.ws_idx, resolved.pane_id);
        }
        let call_id = self.state.register_agent_call(NewAgentCall {
            caller_pane,
            caller_agent,
            callee_pane: resolved.pane_id,
            callee_agent,
            answer_requests: params.answer_requests,
            turns_remote_answers_off,
        });
        Ok(QueuedAgentCall {
            call_id,
            agent: submission.agent,
            completion: submission.completion,
        })
    }

    /// Runs the timers of agent calls, reports the remote answers that ended
    /// calls turned off, and submits the notices whose calling agents are
    /// ready for them (see `AppState::ready_agent_call_notices`).
    pub(crate) fn advance_agent_calls(&mut self, now: Instant) {
        self.state.advance_agent_calls(now);
        let changed = self.state.take_agent_call_remote_answer_changes();
        if !changed.is_empty() {
            for pane_id in changed {
                if let Some((ws_idx, _)) = self.find_pane(pane_id) {
                    self.emit_pane_updated(ws_idx, pane_id);
                }
            }
            // Hooks still waiting learn now that no answer will come.
            self.settle_agent_requests(now);
        }
        for notice in self.state.ready_agent_call_notices(now) {
            match self.submit_agent_prompt(notice.ws_idx, notice.caller_pane, &notice.text, None) {
                Ok(submission) => {
                    self.state.agent_call_notice_submitted(notice.caller_pane);
                    tracing::info!(call_id = notice.call_id, "agent call notice submitted");
                    let call_id = notice.call_id;
                    std::thread::spawn(move || {
                        if let Err(failure) = wait_for_submission(submission.completion) {
                            tracing::warn!(call_id, %failure, "agent call notice was not submitted");
                        }
                    });
                }
                Err(err) => {
                    tracing::debug!(
                        call_id = notice.call_id,
                        ?err,
                        "agent call notice waits for its calling agent"
                    );
                    self.state
                        .retry_agent_call_notice_at(notice.caller_pane, now + NOTICE_RETRY);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    use bytes::Bytes;
    use ratatui::layout::Direction;

    use crate::api::schema::{
        AgentCallParams, Method, PaneMoveDestination, PaneMoveParams, PaneSetRemoteAnswersParams,
        Request,
    };
    use crate::app::agent_calls::CALL_NOTICE_SETTLE;
    use crate::app::App;
    use crate::detect::{Agent, AgentState};
    use crate::events::AppEvent;
    use crate::layout::PaneId;
    use crate::workspace::Workspace;

    const SUBMITTED: Duration = Duration::from_secs(2);

    struct Fixture {
        app: App,
        caller: PaneId,
        callee: PaneId,
        caller_id: String,
        caller_input: tokio::sync::mpsc::Receiver<Bytes>,
        callee_input: tokio::sync::mpsc::Receiver<Bytes>,
    }

    /// An idle Claude caller and an idle Codex target named reviewer.
    fn fixture() -> Fixture {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(
            &crate::config::Config::default(),
            crate::app::AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        let mut ws = Workspace::test_new("calls");
        let caller = ws.tabs[0].root_pane;
        let callee = ws.test_split(Direction::Horizontal);
        app.state.workspaces = vec![ws];
        app.state.ensure_test_terminals();
        app.state.active = Some(0);
        app.state.selected = 0;
        app.state.mode = crate::app::Mode::Terminal;
        set_state(&mut app, caller, Agent::Claude, AgentState::Idle);
        set_state(&mut app, callee, Agent::Codex, AgentState::Idle);
        terminal_mut(&mut app, callee).set_agent_name("reviewer".into());
        let caller_input = attach_runtime(&mut app, caller);
        let callee_input = attach_runtime(&mut app, callee);
        let caller_id = app.public_pane_id(0, caller).unwrap();
        Fixture {
            app,
            caller,
            callee,
            caller_id,
            caller_input,
            callee_input,
        }
    }

    fn attach_runtime(app: &mut App, pane_id: PaneId) -> tokio::sync::mpsc::Receiver<Bytes> {
        let (runtime, rx) = crate::terminal::TerminalRuntime::test_with_channel(80, 24);
        let terminal_id = terminal_id(app, pane_id);
        app.terminal_runtimes.insert(terminal_id, runtime);
        rx
    }

    fn terminal_id(app: &App, pane_id: PaneId) -> crate::terminal::TerminalId {
        app.find_pane(pane_id)
            .map(|(_, pane)| pane.attached_terminal_id.clone())
            .unwrap()
    }

    fn terminal_mut(app: &mut App, pane_id: PaneId) -> &mut crate::terminal::TerminalState {
        let terminal_id = terminal_id(app, pane_id);
        app.state.terminals.get_mut(&terminal_id).unwrap()
    }

    fn set_state(app: &mut App, pane_id: PaneId, agent: Agent, state: AgentState) {
        app.handle_internal_event(AppEvent::StateChanged {
            pane_id,
            agent: Some(agent),
            state,
            visible_blocker: state == AgentState::Blocked,
            visible_working: state == AgentState::Working,
            process_exited: false,
            observed_at: Instant::now(),
        });
    }

    /// When the agent in `pane_id` last changed state.
    fn changed_at(app: &mut App, pane_id: PaneId) -> Instant {
        terminal_mut(app, pane_id)
            .last_agent_state_change_at
            .expect("the state change is recorded")
    }

    /// When the agent in `pane_id` has stayed in its state for the notice
    /// settle period.
    fn settled(app: &mut App, pane_id: PaneId) -> Instant {
        changed_at(app, pane_id) + CALL_NOTICE_SETTLE
    }

    fn start_call(app: &mut App, params: AgentCallParams) -> Receiver<String> {
        let (respond_to, response_rx) = std::sync::mpsc::channel();
        assert!(app.handle_deferred_agent_api_request(
            Request {
                id: "req".into(),
                method: Method::AgentCall(params),
            },
            respond_to,
        ));
        response_rx
    }

    fn call(app: &mut App, params: AgentCallParams) -> serde_json::Value {
        let response = start_call(app, params)
            .recv_timeout(SUBMITTED)
            .expect("agent.call responds after the task was submitted");
        serde_json::from_str(&response).unwrap()
    }

    impl Fixture {
        fn call(&mut self, text: &str) -> serde_json::Value {
            let params = self.params(text);
            call(&mut self.app, params)
        }

        fn params(&self, text: &str) -> AgentCallParams {
            AgentCallParams {
                target: "reviewer".into(),
                text: text.into(),
                caller_pane_id: self.caller_id.clone(),
                answer_requests: false,
            }
        }
    }

    fn reply(app: &mut App, pane_id: PaneId, seq: u64) {
        app.state
            .record_agent_reply(
                pane_id,
                crate::terminal::agent_replies::AgentReplyReport {
                    source: "herdr:codex".into(),
                    agent_label: "codex".into(),
                    seq: Some(seq),
                    agent_session_id: None,
                    text: "done".into(),
                    truncated: false,
                },
            )
            .expect("the reply is recorded");
    }

    /// Runs the target through a turn that ends with a reply.
    fn finish_turn(app: &mut App, callee: PaneId, seq: u64) {
        set_state(app, callee, Agent::Codex, AgentState::Working);
        set_state(app, callee, Agent::Codex, AgentState::Idle);
        reply(app, callee, seq);
    }

    async fn received(rx: &mut tokio::sync::mpsc::Receiver<Bytes>) -> Bytes {
        tokio::time::timeout(SUBMITTED, rx.recv())
            .await
            .expect("terminal input arrives")
            .expect("terminal input channel stays open")
    }

    async fn nothing_received(rx: &mut tokio::sync::mpsc::Receiver<Bytes>) {
        assert!(
            tokio::time::timeout(Duration::from_millis(400), rx.recv())
                .await
                .is_err(),
            "no terminal input expected"
        );
    }

    #[tokio::test]
    async fn agent_call_submits_the_task_and_returns_the_call_id_and_the_target() {
        let mut f = fixture();
        let response = f.call("review the diff");

        assert_eq!(response["result"]["type"], "agent_called", "{response}");
        assert_eq!(response["result"]["call_id"], 1);
        assert_eq!(response["result"]["agent"]["name"], "reviewer");
        assert_eq!(response["result"]["agent"]["agent_status"], "idle");
        assert_eq!(
            received(&mut f.callee_input).await,
            Bytes::from_static(b"review the diff")
        );
        assert_eq!(
            received(&mut f.callee_input).await,
            Bytes::from_static(b"\r")
        );
        assert_eq!(f.app.state.agent_call_of_callee(f.callee), Some(1));
    }

    #[tokio::test]
    async fn agent_call_rejects_invalid_calls_without_writing() {
        let mut f = fixture();
        let shell = f.app.state.workspaces[0].test_split(Direction::Vertical);
        f.app.state.ensure_test_terminals();
        let shell_id = f.app.public_pane_id(0, shell).unwrap();
        let callee_id = f.app.public_pane_id(0, f.callee).unwrap();

        let rejected = |app: &mut App, params: AgentCallParams| -> String {
            let response = call(app, params);
            response["error"]["code"]
                .as_str()
                .unwrap_or_else(|| panic!("expected an error: {response}"))
                .to_string()
        };
        let base = f.params("task");
        let cases = [
            (
                AgentCallParams {
                    text: String::new(),
                    ..base.clone()
                },
                "empty_agent_prompt",
            ),
            (
                AgentCallParams {
                    caller_pane_id: "w9:p9".into(),
                    ..base.clone()
                },
                "pane_not_found",
            ),
            (
                AgentCallParams {
                    caller_pane_id: shell_id,
                    ..base.clone()
                },
                "caller_not_agent",
            ),
            (
                AgentCallParams {
                    caller_pane_id: callee_id,
                    ..base.clone()
                },
                "caller_is_target",
            ),
            (
                AgentCallParams {
                    target: "nobody".into(),
                    ..base.clone()
                },
                "agent_not_found",
            ),
        ];
        for (params, code) in cases {
            assert_eq!(rejected(&mut f.app, params.clone()), code, "{params:?}");
        }

        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Working);
        assert_eq!(rejected(&mut f.app, base.clone()), "agent_working");
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(rejected(&mut f.app, base.clone()), "agent_blocked");
        assert_eq!(f.app.state.agent_call_of_callee(f.callee), None);
        nothing_received(&mut f.callee_input).await;

        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Idle);
        assert_eq!(call(&mut f.app, base.clone())["result"]["call_id"], 1);
        received(&mut f.callee_input).await;
        received(&mut f.callee_input).await;
        assert_eq!(
            rejected(&mut f.app, base),
            "agent_working",
            "the target is already on a call"
        );
        nothing_received(&mut f.callee_input).await;
    }

    #[tokio::test]
    async fn a_failed_submission_cancels_the_call_without_a_notice() {
        let mut f = fixture();
        drop(std::mem::replace(
            &mut f.callee_input,
            tokio::sync::mpsc::channel(1).1,
        ));

        let response = f.call("task");

        assert_eq!(
            response["error"]["code"], "agent_prompt_failed",
            "{response}"
        );
        f.app.drain_all_internal_events();
        assert_eq!(f.app.state.agent_call_of_callee(f.callee), None);
        assert!(f.app.state.agent_call_notice_texts(f.caller).is_empty());
    }

    #[tokio::test]
    async fn agent_call_turns_remote_answers_on_for_the_call_and_restores_them() {
        let mut f = fixture();
        let answering = AgentCallParams {
            answer_requests: true,
            ..f.params("task")
        };
        call(&mut f.app, answering.clone());
        assert!(terminal_mut(&mut f.app, f.callee).remote_answers());
        finish_turn(&mut f.app, f.callee, 1);
        let before = f.app.event_hub.current_sequence();
        f.app.advance_agent_calls(Instant::now());
        assert!(!terminal_mut(&mut f.app, f.callee).remote_answers());
        assert!(
            f.app
                .event_hub
                .events_after(before)
                .iter()
                .any(|(_, event)| event.event == crate::api::schema::EventKind::PaneUpdated),
            "clients learn that remote answers are off again"
        );

        // A client turned remote answers on before the call; they stay on.
        let callee_id = f.app.public_pane_id(0, f.callee).unwrap();
        f.app.handle_pane_set_remote_answers(
            "remote-answers".into(),
            PaneSetRemoteAnswersParams {
                pane_id: callee_id.clone(),
                enabled: true,
            },
        );
        call(&mut f.app, answering.clone());
        finish_turn(&mut f.app, f.callee, 2);
        f.app.advance_agent_calls(Instant::now());
        assert!(terminal_mut(&mut f.app, f.callee).remote_answers());

        // A client turns them on during a call that turned them on; they stay on.
        f.app.handle_pane_set_remote_answers(
            "remote-answers-off".into(),
            PaneSetRemoteAnswersParams {
                pane_id: callee_id.clone(),
                enabled: false,
            },
        );
        call(&mut f.app, answering);
        f.app.handle_pane_set_remote_answers(
            "remote-answers-on".into(),
            PaneSetRemoteAnswersParams {
                pane_id: callee_id,
                enabled: true,
            },
        );
        finish_turn(&mut f.app, f.callee, 3);
        f.app.advance_agent_calls(Instant::now());
        assert!(terminal_mut(&mut f.app, f.callee).remote_answers());
    }

    #[tokio::test]
    async fn notices_are_submitted_to_the_idle_caller_one_per_idle_period() {
        let mut f = fixture();
        f.call("task");
        received(&mut f.callee_input).await;
        received(&mut f.callee_input).await;
        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Working);
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Working);
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Blocked);
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Idle);
        reply(&mut f.app, f.callee, 1);
        assert_eq!(f.app.state.agent_call_notice_texts(f.caller).len(), 2);

        f.app.advance_agent_calls(Instant::now());
        nothing_received(&mut f.caller_input).await;

        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Idle);
        let at = settled(&mut f.app, f.caller);
        f.app.advance_agent_calls(at);
        let first = received(&mut f.caller_input).await;
        assert!(
            first.starts_with(b"[herdr] call 1 blocked: "),
            "{:?}",
            String::from_utf8_lossy(&first)
        );
        assert_eq!(
            received(&mut f.caller_input).await,
            Bytes::from_static(b"\r")
        );
        f.app.advance_agent_calls(at);
        nothing_received(&mut f.caller_input).await;

        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Working);
        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Idle);
        let at = settled(&mut f.app, f.caller);
        f.app.advance_agent_calls(at);
        let second = received(&mut f.caller_input).await;
        assert!(
            second.starts_with(b"[herdr] call 1 finished: "),
            "{:?}",
            String::from_utf8_lossy(&second)
        );
        received(&mut f.caller_input).await;
        assert!(f.app.state.agent_call_notice_texts(f.caller).is_empty());
    }

    #[tokio::test]
    async fn notices_follow_a_caller_pane_that_moved_to_another_workspace() {
        let mut f = fixture();
        f.call("task");
        received(&mut f.callee_input).await;
        received(&mut f.callee_input).await;

        let moved = f.app.handle_pane_move(
            "move".into(),
            PaneMoveParams {
                pane_id: f.caller_id.clone(),
                destination: PaneMoveDestination::NewWorkspace {
                    label: Some("elsewhere".into()),
                    tab_label: None,
                },
                focus: false,
            },
        );
        let moved: serde_json::Value = serde_json::from_str(&moved).unwrap();
        assert_ne!(
            moved["result"]["move_result"]["pane"]["pane_id"],
            f.caller_id.as_str(),
            "{moved}"
        );
        finish_turn(&mut f.app, f.callee, 1);
        let at = settled(&mut f.app, f.caller);
        f.app.advance_agent_calls(at);

        let notice = received(&mut f.caller_input).await;
        assert!(
            notice.starts_with(b"[herdr] call 1 finished: "),
            "{:?}",
            String::from_utf8_lossy(&notice)
        );
    }

    #[tokio::test]
    async fn nothing_is_typed_into_a_caller_until_it_has_been_idle_for_the_settle_period() {
        let mut f = fixture();
        f.call("task");
        received(&mut f.callee_input).await;
        received(&mut f.callee_input).await;
        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Working);
        finish_turn(&mut f.app, f.callee, 1);
        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Idle);
        let idle_at = changed_at(&mut f.app, f.caller);

        f.app.advance_agent_calls(idle_at);
        nothing_received(&mut f.caller_input).await;
        assert_eq!(
            f.app
                .next_headless_loop_deadline_with_git_refresh(idle_at, false, false),
            Some(idle_at + CALL_NOTICE_SETTLE),
            "the loop wakes when the caller has settled"
        );

        // The idle screen was a glimpse: the caller shows a dialog. Enter
        // would answer it.
        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Blocked);
        f.app.advance_agent_calls(idle_at + CALL_NOTICE_SETTLE * 10);
        nothing_received(&mut f.caller_input).await;

        set_state(&mut f.app, f.caller, Agent::Claude, AgentState::Idle);
        let at = settled(&mut f.app, f.caller);
        f.app.advance_agent_calls(at - Duration::from_millis(1));
        nothing_received(&mut f.caller_input).await;
        f.app.advance_agent_calls(at);
        let notice = received(&mut f.caller_input).await;
        assert!(
            notice.starts_with(b"[herdr] call 1 finished: "),
            "{:?}",
            String::from_utf8_lossy(&notice)
        );
        assert_eq!(
            received(&mut f.caller_input).await,
            Bytes::from_static(b"\r")
        );
    }

    #[tokio::test]
    async fn the_loop_wakes_for_the_reply_grace_period() {
        let mut f = fixture();
        f.call("task");
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Working);
        set_state(&mut f.app, f.callee, Agent::Codex, AgentState::Idle);

        let now = Instant::now();
        let deadline = f
            .app
            .next_headless_loop_deadline_with_git_refresh(now, false, false)
            .expect("the loop has a deadline");
        let grace = crate::app::agent_calls::CALL_REPLY_GRACE;
        assert!(
            deadline <= now + grace && deadline + Duration::from_secs(1) > now + grace,
            "{deadline:?}"
        );
    }
}
