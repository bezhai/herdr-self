//! Agent requests over the API.
//!
//! A hook reports a request with `pane.report_agent_request`, and its
//! connection waits in the API server until the request is answered with
//! `agent.answer`, times out, or ends because the turn ended or the agent went
//! away. Pending requests are terminal state; this module keeps the waiting
//! hook connections and delivers each request's outcome to its hook.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::api::schema::{
    AgentAnswerParams, AgentRequestEndReason, AgentRequestInfo, AgentTarget,
    PaneReportAgentRequestParams, ResponseResult,
};
use crate::app::App;
use crate::terminal::agent_requests::{validate_agent_request, AgentRequestReport};
use crate::terminal::TerminalId;

use super::panes::{invalid_agent, pane_not_found};
use super::responses::{encode_error, encode_error_body, encode_success};

/// Longest a hook waits for an answer, and the wait when it names none.
const MAX_AGENT_REQUEST_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

/// The API connection of a hook that reported an agent request.
struct WaitingHook {
    respond_to: Sender<String>,
    waiting: Arc<AtomicBool>,
}

impl WaitingHook {
    fn has_left(&self) -> bool {
        !self.waiting.load(Ordering::Acquire)
    }

    /// Sends `response` unless the hook already stopped waiting; returns
    /// whether the hook receives it.
    fn respond(self, response: String) -> bool {
        if !crate::api::end_connection_wait(&self.waiting) {
            return false;
        }
        let _ = self.respond_to.send(response);
        true
    }
}

/// A hook waiting for the outcome of one pending agent request.
pub(crate) struct AgentRequestWaiter {
    api_request_id: String,
    terminal_id: TerminalId,
    deadline: Instant,
    hook: WaitingHook,
}

impl AgentRequestWaiter {
    fn respond(self, result: ResponseResult) -> bool {
        self.hook
            .respond(encode_success(self.api_request_id, result))
    }
}

impl App {
    /// Handles `pane.report_agent_request` from a hook connection that waits
    /// while `connection_waiting` is true.
    pub(crate) fn handle_agent_request_report(
        &mut self,
        id: String,
        params: PaneReportAgentRequestParams,
        respond_to: Sender<String>,
        connection_waiting: Option<Arc<AtomicBool>>,
    ) {
        let Some(waiting) = connection_waiting else {
            let _ = respond_to.send(encode_error(
                id,
                "invalid_request",
                "pane.report_agent_request needs a waiting API connection",
            ));
            return;
        };
        let hook = WaitingHook {
            respond_to,
            waiting,
        };
        if hook.has_left() {
            return;
        }
        let wait = params
            .timeout_ms
            .map_or(MAX_AGENT_REQUEST_WAIT, |timeout_ms| {
                Duration::from_millis(timeout_ms).min(MAX_AGENT_REQUEST_WAIT)
            });
        match self.record_reported_agent_request(&id, params) {
            Err(response) => {
                hook.respond(response);
            }
            Ok(None) => {
                hook.respond(encode_success(
                    id,
                    ResponseResult::AgentRequestEnded {
                        request_id: None,
                        reason: AgentRequestEndReason::Ignored,
                    },
                ));
            }
            Ok(Some((terminal_id, request_id))) => {
                self.agent_request_waiters.insert(
                    request_id,
                    AgentRequestWaiter {
                        api_request_id: id,
                        terminal_id,
                        deadline: Instant::now() + wait,
                        hook,
                    },
                );
            }
        }
    }

    /// Returns the recorded request, `None` for a report that does not belong
    /// to the pane's current agent, or an error response.
    fn record_reported_agent_request(
        &mut self,
        id: &str,
        params: PaneReportAgentRequestParams,
    ) -> Result<Option<(TerminalId, u64)>, String> {
        let Some((_ws_idx, pane_id)) = self.parse_pane_id(&params.pane_id) else {
            return Err(pane_not_found(id.to_string(), &params.pane_id));
        };
        let Some(agent_label) =
            crate::app::api_helpers::normalize_reported_agent_label(&params.agent)
        else {
            return Err(invalid_agent(id.to_string()));
        };
        let content = validate_agent_request(params.request)
            .map_err(|message| encode_error(id.to_string(), "invalid_agent_request", message))?;
        Ok(self.state.record_agent_request(
            pane_id,
            AgentRequestReport {
                source: params.source,
                agent_label,
                agent_session_id: params.agent_session_id,
                content,
            },
        ))
    }

    /// Ends waits whose request is over: the hook left, the deadline passed,
    /// or the request was dropped with its turn, agent, or pane.
    pub(crate) fn settle_agent_requests(&mut self, now: Instant) {
        if self.agent_request_waiters.is_empty() {
            return;
        }
        for (request_id, waiter) in std::mem::take(&mut self.agent_request_waiters) {
            let pending = self
                .state
                .terminals
                .get(&waiter.terminal_id)
                .is_some_and(|terminal| terminal.agent_requests().get(request_id).is_some());
            let reason = if waiter.hook.has_left() {
                None
            } else if !pending {
                Some(AgentRequestEndReason::Closed)
            } else if now >= waiter.deadline {
                Some(AgentRequestEndReason::Timeout)
            } else {
                self.agent_request_waiters.insert(request_id, waiter);
                continue;
            };
            self.remove_pending_agent_request(&waiter.terminal_id, request_id);
            let Some(reason) = reason else {
                tracing::debug!(request_id, "agent request withdrawn by its hook");
                continue;
            };
            tracing::debug!(request_id, ?reason, "agent request ended");
            waiter.respond(ResponseResult::AgentRequestEnded {
                request_id: Some(request_id),
                reason,
            });
        }
    }

    fn remove_pending_agent_request(&mut self, terminal_id: &TerminalId, request_id: u64) {
        if let Some(terminal) = self.state.terminals.get_mut(terminal_id) {
            terminal.remove_agent_request(request_id);
        }
    }

    pub(super) fn handle_agent_requests(&mut self, id: String, target: AgentTarget) -> String {
        let resolved = match self.resolve_agent(&target.target) {
            Ok(resolved) => resolved,
            Err(err) => return encode_error_body(id, err),
        };
        let requests = self
            .state
            .terminals
            .get(&resolved.terminal_id)
            .map(|terminal| {
                terminal
                    .agent_requests()
                    .iter()
                    .map(|request| AgentRequestInfo {
                        id: request.id,
                        content: request.content.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        encode_success(
            id,
            ResponseResult::AgentRequests {
                agent: resolved.agent,
                requests,
            },
        )
    }

    pub(super) fn handle_agent_answer(&mut self, id: String, params: AgentAnswerParams) -> String {
        let resolved = match self.resolve_agent(&params.target) {
            Ok(resolved) => resolved,
            Err(err) => return encode_error_body(id, err),
        };
        let Some(request) = self
            .state
            .terminals
            .get(&resolved.terminal_id)
            .and_then(|terminal| terminal.agent_requests().get(params.request_id))
        else {
            return request_not_found(id, params.request_id);
        };
        if let Err(message) = request.check_answer(&params.answer) {
            return encode_error(id, "invalid_answer", message);
        }

        self.remove_pending_agent_request(&resolved.terminal_id, params.request_id);
        let delivered = self
            .agent_request_waiters
            .remove(&params.request_id)
            .is_some_and(|waiter| {
                waiter.respond(ResponseResult::AgentRequestAnswered {
                    request_id: params.request_id,
                    answer: params.answer,
                })
            });
        if !delivered {
            // The hook stopped waiting before the answer reached it.
            return request_not_found(id, params.request_id);
        }
        tracing::debug!(request_id = params.request_id, "agent request answered");
        let agent = self
            .agent_info(resolved.ws_idx, resolved.pane_id)
            .unwrap_or(resolved.agent);
        encode_success(id, ResponseResult::AgentInfo { agent })
    }
}

fn request_not_found(id: String, request_id: u64) -> String {
    encode_error(
        id,
        "request_not_found",
        format!("agent request {request_id} is not pending"),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use crate::api::schema::{
        AgentAnswerParams, AgentQuestion, AgentRequestAnswer, AgentRequestContent,
        AgentRequestDecision, AgentRequestKind, AgentTarget, Method, PaneReportAgentRequestParams,
        Request,
    };
    use crate::app::App;
    use crate::detect::{Agent, AgentState};

    fn claude_app() -> (App, String) {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(
            &crate::config::Config::default(),
            crate::app::AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        app.state.workspaces = vec![crate::workspace::Workspace::test_new("agent")];
        app.state.ensure_test_terminals();
        app.state.active = Some(0);
        app.state.mode = crate::app::Mode::Terminal;
        set_claude_state(&mut app, AgentState::Working);
        let pane_id = app.state.workspaces[0].tabs[0].root_pane;
        let public_pane_id = app.public_pane_id(0, pane_id).unwrap();
        (app, public_pane_id)
    }

    fn set_agent_state(app: &mut App, agent: Agent, state: AgentState) {
        let pane_id = app.state.workspaces[0].tabs[0].root_pane;
        app.state
            .handle_app_event(crate::events::AppEvent::StateChanged {
                pane_id,
                agent: Some(agent),
                state,
                visible_blocker: false,
                visible_working: state == AgentState::Working,
                process_exited: false,
                observed_at: Instant::now(),
            });
    }

    fn set_claude_state(app: &mut App, state: AgentState) {
        set_agent_state(app, Agent::Claude, state);
    }

    fn permission(decisions: &[AgentRequestDecision]) -> AgentRequestContent {
        AgentRequestContent {
            kind: AgentRequestKind::Permission,
            tool_name: "Bash".into(),
            description: Some("列出文件".into()),
            input_preview: "ls -la".into(),
            decisions: decisions.to_vec(),
            questions: Vec::new(),
        }
    }

    fn color_question() -> AgentRequestContent {
        AgentRequestContent {
            kind: AgentRequestKind::Question,
            tool_name: "AskUserQuestion".into(),
            description: None,
            input_preview: "{}".into(),
            decisions: Vec::new(),
            questions: vec![AgentQuestion {
                question: "Which color?".into(),
                header: None,
                options: Vec::new(),
                multi_select: true,
            }],
        }
    }

    fn report_params(
        pane_id: &str,
        source: &str,
        request: AgentRequestContent,
    ) -> PaneReportAgentRequestParams {
        PaneReportAgentRequestParams {
            pane_id: pane_id.into(),
            source: source.into(),
            agent: "claude".into(),
            agent_session_id: None,
            request,
            timeout_ms: None,
        }
    }

    struct HookConnection {
        waiting: Arc<AtomicBool>,
        responses: Receiver<String>,
    }

    impl HookConnection {
        fn response(&self) -> Option<serde_json::Value> {
            self.responses
                .try_recv()
                .ok()
                .map(|response| serde_json::from_str(&response).unwrap())
        }

        fn leave(&self) {
            assert!(crate::api::end_connection_wait(&self.waiting));
        }
    }

    fn report(app: &mut App, params: PaneReportAgentRequestParams) -> HookConnection {
        let waiting = Arc::new(AtomicBool::new(true));
        let (respond_to, responses) = std::sync::mpsc::channel();
        app.handle_agent_request_report(
            "hook".into(),
            params,
            respond_to,
            Some(Arc::clone(&waiting)),
        );
        HookConnection { waiting, responses }
    }

    fn api_request(app: &mut App, method: Method) -> serde_json::Value {
        let response = app.handle_api_request(Request {
            id: "req".into(),
            method,
        });
        serde_json::from_str(&response).unwrap()
    }

    fn requests(app: &mut App, target: &str) -> serde_json::Value {
        api_request(
            app,
            Method::AgentRequests(AgentTarget {
                target: target.into(),
            }),
        )
    }

    fn answer(
        app: &mut App,
        target: &str,
        request_id: u64,
        answer: AgentRequestAnswer,
    ) -> serde_json::Value {
        api_request(
            app,
            Method::AgentAnswer(AgentAnswerParams {
                target: target.into(),
                request_id,
                answer,
            }),
        )
    }

    fn decision(decision: AgentRequestDecision, message: Option<&str>) -> AgentRequestAnswer {
        AgentRequestAnswer {
            decision: Some(decision),
            message: message.map(str::to_string),
            answers: None,
        }
    }

    fn request_ids(app: &mut App, target: &str) -> serde_json::Value {
        let agent = api_request(
            app,
            Method::AgentGet(AgentTarget {
                target: target.into(),
            }),
        );
        agent["result"]["agent"]
            .get("request_ids")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    }

    use AgentRequestDecision::{Allow, AllowAlways, Deny};

    #[test]
    fn reported_request_waits_until_it_is_answered() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(
                &pane_id,
                "herdr:claude",
                permission(&[Allow, AllowAlways, Deny]),
            ),
        );
        assert!(hook.response().is_none(), "the hook waits for an answer");

        let listed = requests(&mut app, &pane_id);
        assert_eq!(listed["result"]["type"], "agent_requests", "{listed}");
        assert_eq!(
            listed["result"]["agent"]["request_ids"],
            serde_json::json!([1])
        );
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
        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([1]));

        let answered = answer(&mut app, &pane_id, 1, decision(Deny, Some("不行")));
        assert_eq!(answered["result"]["type"], "agent_info", "{answered}");
        assert!(answered["result"]["agent"].get("request_ids").is_none());
        assert_eq!(
            hook.response().unwrap(),
            serde_json::json!({
                "id": "hook",
                "result": {
                    "type": "agent_request_answered",
                    "request_id": 1,
                    "decision": "deny",
                    "message": "不行",
                },
            })
        );
        assert!(!hook.waiting.load(Ordering::Acquire));
        assert_eq!(
            requests(&mut app, &pane_id)["result"]["requests"],
            serde_json::json!([])
        );
        assert_eq!(
            answer(&mut app, &pane_id, 1, decision(Allow, None))["error"]["code"],
            "request_not_found"
        );
    }

    #[test]
    fn question_requests_are_answered_with_answer_lists() {
        let (mut app, pane_id) = claude_app();
        let permission_hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );
        let question_hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", color_question()),
        );
        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([1, 2]));

        let answers = AgentRequestAnswer {
            decision: None,
            message: None,
            answers: Some(BTreeMap::from([(
                "Which color?".to_string(),
                vec!["红".to_string(), "Blue".to_string()],
            )])),
        };
        assert_eq!(
            answer(&mut app, &pane_id, 2, answers)["result"]["type"],
            "agent_info"
        );
        assert_eq!(
            question_hook.response().unwrap()["result"],
            serde_json::json!({
                "type": "agent_request_answered",
                "request_id": 2,
                "answers": {"Which color?": ["红", "Blue"]},
            })
        );
        assert!(permission_hook.response().is_none());
        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([1]));
    }

    #[test]
    fn invalid_answers_leave_the_request_pending() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow, Deny])),
        );

        for invalid in [
            decision(AllowAlways, None),
            AgentRequestAnswer {
                decision: None,
                message: None,
                answers: Some(BTreeMap::new()),
            },
        ] {
            let response = answer(&mut app, &pane_id, 1, invalid);
            assert_eq!(response["error"]["code"], "invalid_answer", "{response}");
        }
        assert_eq!(
            answer(&mut app, &pane_id, 9, decision(Allow, None))["error"]["code"],
            "request_not_found"
        );
        assert_eq!(
            answer(&mut app, "no-such-agent", 1, decision(Allow, None))["error"]["code"],
            "agent_not_found"
        );
        assert_eq!(
            requests(&mut app, "no-such-agent")["error"]["code"],
            "agent_not_found"
        );

        assert!(hook.response().is_none());
        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([1]));
    }

    #[test]
    fn requests_of_another_agent_cannot_be_answered_through_this_one() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );
        app.state
            .workspaces
            .push(crate::workspace::Workspace::test_new("other"));
        app.state.ensure_test_terminals();
        let other_pane = app.state.workspaces[1].tabs[0].root_pane;
        let other_terminal = app.state.workspaces[1].panes[&other_pane]
            .attached_terminal_id
            .clone();
        app.state
            .terminals
            .get_mut(&other_terminal)
            .unwrap()
            .set_detected_state(Some(Agent::Codex), AgentState::Working);
        let other_pane_id = app.public_pane_id(1, other_pane).unwrap();

        assert_eq!(
            answer(&mut app, &other_pane_id, 1, decision(Allow, None))["error"]["code"],
            "request_not_found"
        );
        assert!(hook.response().is_none());
    }

    #[test]
    fn reports_that_do_not_match_the_agent_end_as_ignored() {
        let (mut app, pane_id) = claude_app();
        let mut other_session = report_params(&pane_id, "herdr:claude", permission(&[Allow]));
        other_session.agent_session_id = Some("unknown-session".into());
        app.state
            .terminals
            .values_mut()
            .next()
            .unwrap()
            .set_persisted_agent_session(crate::agent_resume::PersistedAgentSession {
                source: "herdr:claude".into(),
                agent: "claude".into(),
                session_ref: crate::agent_resume::AgentSessionRef::id("current").unwrap(),
            });

        for params in [
            report_params(&pane_id, "custom:claude", permission(&[Allow])),
            other_session,
        ] {
            let hook = report(&mut app, params);
            assert_eq!(
                hook.response().unwrap(),
                serde_json::json!({
                    "id": "hook",
                    "result": {"type": "agent_request_ended", "reason": "ignored"},
                })
            );
        }
        assert!(request_ids(&mut app, &pane_id).is_null());
    }

    #[test]
    fn malformed_reports_are_errors() {
        let (mut app, pane_id) = claude_app();
        let mut empty_agent = report_params(&pane_id, "herdr:claude", permission(&[Allow]));
        empty_agent.agent = " ".into();

        for (params, code) in [
            (
                report_params("w9:p9", "herdr:claude", permission(&[Allow])),
                "pane_not_found",
            ),
            (empty_agent, "invalid_agent"),
            (
                report_params(&pane_id, "herdr:claude", permission(&[])),
                "invalid_agent_request",
            ),
        ] {
            let hook = report(&mut app, params);
            assert_eq!(hook.response().unwrap()["error"]["code"], code);
        }

        let direct = api_request(
            &mut app,
            Method::PaneReportAgentRequest(report_params(
                &pane_id,
                "herdr:claude",
                permission(&[Allow]),
            )),
        );
        assert_eq!(direct["error"]["code"], "invalid_request", "{direct}");
        assert!(request_ids(&mut app, &pane_id).is_null());
    }

    #[test]
    fn requests_end_with_timeout_at_their_deadline() {
        let (mut app, pane_id) = claude_app();
        let mut short = report_params(&pane_id, "herdr:claude", permission(&[Allow]));
        short.timeout_ms = Some(1_000);
        let short = report(&mut app, short);
        let mut long = report_params(&pane_id, "herdr:claude", permission(&[Allow]));
        long.timeout_ms = Some(u64::MAX);
        let long = report(&mut app, long);
        let default = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );
        let reported_at = Instant::now();

        app.settle_agent_requests(reported_at);
        assert!(short.response().is_none());

        app.settle_agent_requests(reported_at + Duration::from_secs(2));
        assert_eq!(
            short.response().unwrap()["result"],
            serde_json::json!({"type": "agent_request_ended", "request_id": 1, "reason": "timeout"})
        );
        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([2, 3]));

        let day = Duration::from_secs(24 * 60 * 60);
        app.settle_agent_requests(reported_at + day - Duration::from_secs(1));
        assert!(long.response().is_none());
        app.settle_agent_requests(reported_at + day + Duration::from_secs(1));
        for (hook, request_id) in [(long, 2), (default, 3)] {
            assert_eq!(
                hook.response().unwrap()["result"],
                serde_json::json!({
                    "type": "agent_request_ended",
                    "request_id": request_id,
                    "reason": "timeout",
                })
            );
        }
        assert!(request_ids(&mut app, &pane_id).is_null());
    }

    #[test]
    fn a_hook_that_leaves_withdraws_its_request() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );
        let other = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );

        hook.leave();

        assert_eq!(request_ids(&mut app, &pane_id), serde_json::json!([2]));
        assert_eq!(
            answer(&mut app, &pane_id, 1, decision(Allow, None))["error"]["code"],
            "request_not_found"
        );
        assert!(hook.response().is_none());
        assert!(other.response().is_none());
    }

    #[test]
    fn a_hook_that_left_before_its_report_arrived_records_nothing() {
        let (mut app, pane_id) = claude_app();
        let waiting = Arc::new(AtomicBool::new(false));
        let (respond_to, responses) = std::sync::mpsc::channel();

        app.handle_agent_request_report(
            "hook".into(),
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
            respond_to,
            Some(waiting),
        );

        assert!(responses.try_recv().is_err());
        assert!(request_ids(&mut app, &pane_id).is_null());
    }

    #[test]
    fn requests_close_when_the_turn_ends() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );
        set_claude_state(&mut app, AgentState::Blocked);
        app.settle_agent_requests(Instant::now());
        assert!(hook.response().is_none());

        set_claude_state(&mut app, AgentState::Idle);
        app.settle_agent_requests(Instant::now());

        assert_eq!(
            hook.response().unwrap()["result"],
            serde_json::json!({"type": "agent_request_ended", "request_id": 1, "reason": "closed"})
        );
        assert!(!hook.waiting.load(Ordering::Acquire));
        assert_eq!(
            answer(&mut app, &pane_id, 1, decision(Allow, None))["error"]["code"],
            "request_not_found"
        );
    }

    #[test]
    fn requests_close_when_the_agent_changes() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );

        set_agent_state(&mut app, Agent::Codex, AgentState::Working);
        let listed = requests(&mut app, &pane_id);

        assert_eq!(listed["result"]["requests"], serde_json::json!([]));
        assert_eq!(hook.response().unwrap()["result"]["reason"], "closed");
    }

    #[test]
    fn requests_close_when_their_pane_goes_away() {
        let (mut app, pane_id) = claude_app();
        let hook = report(
            &mut app,
            report_params(&pane_id, "herdr:claude", permission(&[Allow])),
        );

        app.state.terminals.clear();
        app.settle_agent_requests(Instant::now());

        assert_eq!(hook.response().unwrap()["result"]["reason"], "closed");
    }

    #[test]
    fn agent_request_methods_do_not_change_the_ui() {
        for method in [
            Method::PaneReportAgentRequest(report_params(
                "w1:p1",
                "herdr:claude",
                permission(&[Allow]),
            )),
            Method::AgentRequests(AgentTarget {
                target: "w1:p1".into(),
            }),
            Method::AgentAnswer(AgentAnswerParams {
                target: "w1:p1".into(),
                request_id: 1,
                answer: decision(Allow, None),
            }),
        ] {
            assert!(!crate::api::request_changes_ui(&Request {
                id: "req".into(),
                method,
            }));
        }
    }
}
