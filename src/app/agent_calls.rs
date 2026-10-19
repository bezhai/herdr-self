//! Agent calls: one agent hands a task to another and is told how it went.
//!
//! `agent.call` submits a task to an idle agent the way `agent.prompt` does
//! and registers a call between the calling pane's agent and the target. The
//! call follows the target's status changes and reply reports. It ends when
//! the target's turn ends, with or without a reply, or when the target goes
//! away, and it reports each wait for input on the way. Every outcome becomes
//! a notice: a one-line message that is submitted to the calling agent once
//! it has stayed idle for [`CALL_NOTICE_SETTLE`] without a request of its own
//! pending, one notice per idle period, in the order they were produced.
//! Notices point at the target and at the commands that read its reply or
//! requests; they never carry reply or request content.
//!
//! Calls are server-owned state on [`AppState`]. Status changes, reply
//! reports, and request reports advance them; [`AppState::advance_agent_calls`]
//! runs their timers. The app submits the notices that
//! [`AppState::ready_agent_call_notices`] returns.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::detect::{Agent, AgentState};
use crate::layout::PaneId;

use super::AppState;

/// How long a call waits for the target's reply after its turn ended.
pub(crate) const CALL_REPLY_GRACE: Duration = Duration::from_secs(10);

/// How long a call that answers requests waits for a blocked target to
/// report a request before it reports that a person has to answer.
pub(crate) const CALL_REQUEST_SETTLE: Duration = Duration::from_secs(2);

/// How long a calling agent has to stay idle, without a request of its own
/// pending, before it receives a notice.
///
/// A notice is typed into the caller's terminal and submitted with Enter. A
/// caller that reads idle only for a moment, for example while the screen
/// of a dialog changes, would get the notice typed into the dialog and the
/// dialog answered. Screen detection reads an identified agent every 300 ms,
/// so the idle state has to survive ten readings. The period is longer than
/// [`CALL_REQUEST_SETTLE`], the time a hook's request report may trail the
/// screen, and as long as Herdr waits before it trusts the idle screen of an
/// agent it launched. A caller that has been idle for longer is not delayed.
pub(crate) const CALL_NOTICE_SETTLE: Duration = Duration::from_secs(3);

/// The parties of a new call and how it treats the target's requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewAgentCall {
    pub caller_pane: PaneId,
    pub caller_agent: Agent,
    pub callee_pane: PaneId,
    pub callee_agent: Agent,
    /// The calling agent answers the target's requests.
    pub answer_requests: bool,
    /// The call turned remote answers on, so it turns them off when it ends.
    pub turns_remote_answers_off: bool,
}

/// A notice whose calling agent is ready to receive it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadyCallNotice {
    pub call_id: u64,
    pub ws_idx: usize,
    pub caller_pane: PaneId,
    pub text: String,
}

/// Calls in progress and the notices that wait for their calling agents.
#[derive(Debug, Default)]
pub(crate) struct AgentCalls {
    last_call_id: u64,
    calls: BTreeMap<u64, AgentCall>,
    /// The call each target pane is working on; a target takes one at a time.
    by_callee: HashMap<PaneId, u64>,
    notices: HashMap<PaneId, CallerNotices>,
    /// Target panes whose remote answers a call turned off.
    remote_answers_changed: Vec<PaneId>,
}

impl AgentCalls {
    fn is_empty(&self) -> bool {
        self.calls.is_empty() && self.notices.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentCall {
    id: u64,
    caller_pane: PaneId,
    caller_agent: Agent,
    callee_pane: PaneId,
    callee_agent: Agent,
    /// The target's name and public pane id when the call began, for notices
    /// produced after its pane is gone.
    callee_name: Option<String>,
    callee_public_pane_id: Option<String>,
    /// Replies with a greater seq came after the task was submitted.
    reply_after: u64,
    turn: CallTurn,
    /// The turn's reply arrived before the turn ended.
    reply_seen: bool,
    input_wait: InputWait,
    answer_requests: bool,
    turns_remote_answers_off: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallTurn {
    /// The task was submitted; the target has not started on it yet.
    Submitted,
    /// The target is working on the task.
    Running,
    /// The turn ended without a reply so far; the reply may still come.
    Ended { reply_deadline: Instant },
}

/// Whether the target waits for input, and whether the caller was told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputWait {
    None,
    /// Blocked without a request yet, while requests may still arrive.
    Settling {
        deadline: Instant,
    },
    Reported,
}

/// How a call went, as told to its calling agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallOutcome {
    Finished,
    FinishedWithoutReply,
    Blocked { pending_requests: usize },
    AgentLeft,
    PaneClosed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CallerNotices {
    /// The calling agent; notices are dropped when another agent runs in its pane.
    agent: Agent,
    pending: VecDeque<CallNotice>,
    /// The caller's state change seq when the previous notice was submitted.
    /// The next one waits until that seq changes: the caller left idle for
    /// the previous notice and came back.
    submitted_at_seq: Option<Option<u64>>,
    /// The first notice could not be submitted; it waits at least until then.
    retry_at: Option<Instant>,
    requests: CallerRequests,
}

/// Whether the calling agent waited on a request of its own when its
/// notices were last considered. Herdr knows those requests only while
/// remote answers are on for the caller, for example for a chat bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallerRequests {
    None,
    Pending,
    /// The last pending request was seen gone at this time. The caller
    /// resumes, so like a state change this starts the settle period over.
    EndedAt(Instant),
}

/// What the first notice of a calling agent waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeWait {
    /// Another agent runs in the caller's pane; the notices are dropped.
    Replaced,
    /// The caller took the last notice; nothing is left to wait for.
    Spent,
    /// A change of the caller: to be detected, to take the previous notice,
    /// to finish starting, to become idle, or to end its pending request.
    Caller,
    /// The notice goes out at this time unless the caller changes first.
    Until(Instant),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CallNotice {
    call_id: u64,
    text: String,
}

impl CallerNotices {
    fn new(agent: Agent) -> Self {
        Self {
            agent,
            pending: VecDeque::new(),
            submitted_at_seq: None,
            retry_at: None,
            requests: CallerRequests::None,
        }
    }

    /// Notes whether the caller waits on a request of its own at `now`.
    fn observe_requests(&mut self, pending: bool, now: Instant) {
        self.requests = match (self.requests, pending) {
            (_, true) => CallerRequests::Pending,
            (CallerRequests::Pending, false) => CallerRequests::EndedAt(now),
            (requests, false) => requests,
        };
    }

    /// What the first notice waits for while the caller is in `terminal`.
    ///
    /// The notice goes to an idle caller only, and only once it has stayed
    /// idle for [`CALL_NOTICE_SETTLE`] since its last state change: a caller
    /// that reads idle for a moment may still be showing a dialog that the
    /// notice's Enter would answer. A pending request of the caller's own
    /// holds the notice for the same reason.
    fn wait(&self, terminal: &crate::terminal::TerminalState) -> NoticeWait {
        let Some(agent) = terminal.effective_known_agent() else {
            // Not detected yet, for example right after a live handoff.
            return NoticeWait::Caller;
        };
        if agent != self.agent {
            return NoticeWait::Replaced;
        }
        let took_previous = self
            .submitted_at_seq
            .is_none_or(|seq| seq != terminal.last_agent_state_change_seq);
        if self.pending.is_empty() {
            return if took_previous {
                NoticeWait::Spent
            } else {
                NoticeWait::Caller
            };
        }
        if !took_previous
            || terminal.state != AgentState::Idle
            || terminal.managed_agent_launch_pending()
            || !terminal.agent_requests().is_empty()
        {
            return NoticeWait::Caller;
        }
        let Some(changed_at) = terminal.last_agent_state_change_at else {
            return NoticeWait::Caller;
        };
        let quiet_since = match self.requests {
            CallerRequests::EndedAt(ended_at) => changed_at.max(ended_at),
            CallerRequests::None | CallerRequests::Pending => changed_at,
        };
        let settled_at = quiet_since + CALL_NOTICE_SETTLE;
        NoticeWait::Until(
            self.retry_at
                .map_or(settled_at, |retry_at| retry_at.max(settled_at)),
        )
    }
}

impl AgentCall {
    /// Moves the turn along with the target's effective state; true when the
    /// turn ended and its reply is already here.
    fn follow_state(&mut self, state: AgentState, now: Instant) -> bool {
        match (self.turn, state) {
            (
                CallTurn::Submitted | CallTurn::Ended { .. },
                AgentState::Working | AgentState::Blocked,
            ) => {
                self.turn = CallTurn::Running;
                false
            }
            (CallTurn::Running, AgentState::Idle) if self.reply_seen => true,
            (CallTurn::Running, AgentState::Idle) => {
                self.turn = CallTurn::Ended {
                    reply_deadline: now + CALL_REPLY_GRACE,
                };
                false
            }
            _ => false,
        }
    }

    /// Follows whether the target waits for input; returns the pending
    /// request count when a wait is to be reported now.
    fn follow_input_wait(
        &mut self,
        state: AgentState,
        pending_requests: usize,
        now: Instant,
    ) -> Option<usize> {
        let pending_requests = if self.answer_requests {
            pending_requests
        } else {
            0
        };
        let waiting = state == AgentState::Blocked || pending_requests > 0;
        match self.input_wait {
            _ if !waiting => {
                self.input_wait = InputWait::None;
                None
            }
            InputWait::Reported => None,
            InputWait::None if !self.answer_requests || pending_requests > 0 => {
                self.input_wait = InputWait::Reported;
                Some(pending_requests)
            }
            InputWait::None => {
                self.input_wait = InputWait::Settling {
                    deadline: now + CALL_REQUEST_SETTLE,
                };
                None
            }
            InputWait::Settling { deadline } if pending_requests > 0 || now >= deadline => {
                self.input_wait = InputWait::Reported;
                Some(pending_requests)
            }
            InputWait::Settling { .. } => None,
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        let reply_deadline = match self.turn {
            CallTurn::Ended { reply_deadline } => Some(reply_deadline),
            CallTurn::Submitted | CallTurn::Running => None,
        };
        let settle_deadline = match self.input_wait {
            InputWait::Settling { deadline } => Some(deadline),
            InputWait::None | InputWait::Reported => None,
        };
        reply_deadline.into_iter().chain(settle_deadline).min()
    }
}

impl CallOutcome {
    fn status(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::FinishedWithoutReply => "finished without reply",
            Self::Blocked { .. } => "blocked",
            Self::AgentLeft | Self::PaneClosed => "gone",
        }
    }
}

/// How notices name a call's target.
struct CalleeRef<'a> {
    kind: &'static str,
    name: Option<&'a str>,
    pane: Option<&'a str>,
}

impl CalleeRef<'_> {
    /// `codex agent reviewer (pane w1:p2)`.
    fn description(&self) -> String {
        let mut description = format!("{} agent", self.kind);
        if let Some(name) = self.name {
            description.push(' ');
            description.push_str(name);
        }
        if let Some(pane) = self.pane {
            description.push_str(&format!(" (pane {pane})"));
        }
        description
    }

    /// The target written for `herdr agent` commands.
    fn target(&self) -> &str {
        self.name.or(self.pane).unwrap_or(self.kind)
    }
}

/// The one-line notice that tells a calling agent how call `call_id` went.
fn notice_text(call_id: u64, outcome: CallOutcome, callee: &CalleeRef, reply_after: u64) -> String {
    let who = callee.description();
    let target = callee.target();
    let what = match outcome {
        CallOutcome::Finished => format!(
            "{who} ended its turn with a reply. Read it with: herdr agent replies {target} --after {reply_after}"
        ),
        CallOutcome::FinishedWithoutReply => format!(
            "{who} ended its turn without reporting a reply. See its screen with: herdr agent read {target}"
        ),
        CallOutcome::Blocked {
            pending_requests: 0,
        } => format!(
            "{who} waits for input that a person has to give in its terminal. The call stays open."
        ),
        CallOutcome::Blocked { pending_requests } => {
            let (requests, them) = if pending_requests == 1 {
                ("request", "it")
            } else {
                ("requests", "them")
            };
            format!(
                "{who} waits on {pending_requests} pending {requests}. List {them} with: herdr agent requests {target}. Answer with: herdr agent answer {target} <REQUEST_ID> --decision <DECISION>, or --answers <JSON> for a question. The call stays open."
            )
        }
        CallOutcome::AgentLeft => {
            format!("{who} exited or was replaced. The call has ended.")
        }
        CallOutcome::PaneClosed => {
            format!("{who} is gone because its pane was closed. The call has ended.")
        }
    };
    format!("[herdr] call {call_id} {}: {what}", outcome.status())
}

impl AppState {
    /// The workspace index of `pane_id` and the terminal attached to it.
    fn agent_call_pane(&self, pane_id: PaneId) -> Option<(usize, &crate::terminal::TerminalState)> {
        let (ws_idx, pane) = self
            .workspaces
            .iter()
            .enumerate()
            .find_map(|(ws_idx, ws)| ws.pane_state(pane_id).map(|pane| (ws_idx, pane)))?;
        Some((ws_idx, self.terminals.get(&pane.attached_terminal_id)?))
    }

    /// Registers a call whose task was just submitted to the target and
    /// returns its id.
    pub(crate) fn register_agent_call(&mut self, call: NewAgentCall) -> u64 {
        let (callee_name, callee_public_pane_id) = self
            .agent_call_pane(call.callee_pane)
            .map(|(ws_idx, terminal)| {
                (
                    terminal.agent_name.clone(),
                    self.public_pane_id(ws_idx, call.callee_pane),
                )
            })
            .unwrap_or_default();
        let calls = &mut self.agent_calls;
        calls.last_call_id += 1;
        let id = calls.last_call_id;
        calls.by_callee.insert(call.callee_pane, id);
        calls.calls.insert(
            id,
            AgentCall {
                id,
                caller_pane: call.caller_pane,
                caller_agent: call.caller_agent,
                callee_pane: call.callee_pane,
                callee_agent: call.callee_agent,
                callee_name,
                callee_public_pane_id,
                reply_after: self.next_agent_reply_seq,
                turn: CallTurn::Submitted,
                reply_seen: false,
                input_wait: InputWait::None,
                answer_requests: call.answer_requests,
                turns_remote_answers_off: call.turns_remote_answers_off,
            },
        );
        tracing::debug!(call_id = id, "agent call registered");
        id
    }

    /// The call that the agent in `callee_pane` is working on.
    pub(crate) fn agent_call_of_callee(&self, callee_pane: PaneId) -> Option<u64> {
        self.agent_calls.by_callee.get(&callee_pane).copied()
    }

    /// Ends a call without a notice, because its task never reached the target.
    pub(crate) fn cancel_agent_call(&mut self, call_id: u64) {
        self.end_agent_call(call_id, None);
    }

    /// Someone set remote answers for `callee_pane` explicitly, so the call
    /// leaves the setting alone when it ends.
    pub(crate) fn keep_remote_answers_after_agent_call(&mut self, callee_pane: PaneId) {
        let Some(call_id) = self.agent_call_of_callee(callee_pane) else {
            return;
        };
        if let Some(call) = self.agent_calls.calls.get_mut(&call_id) {
            call.turns_remote_answers_off = false;
        }
    }

    /// Advances calls after the effective state of the agent in `pane_id`
    /// changed. `agent_left` tells that the agent exited, was released, or
    /// was replaced.
    pub(super) fn advance_agent_calls_on_state(
        &mut self,
        pane_id: PaneId,
        state: AgentState,
        agent_left: bool,
        now: Instant,
    ) {
        if self.agent_calls.is_empty() {
            return;
        }
        if agent_left {
            if let Some(call_id) = self.agent_call_of_callee(pane_id) {
                self.end_agent_call(call_id, Some(CallOutcome::AgentLeft));
            }
            self.end_agent_calls_of_caller(pane_id);
            return;
        }
        let Some(call_id) = self.agent_call_of_callee(pane_id) else {
            return;
        };
        let Some(call) = self.agent_calls.calls.get_mut(&call_id) else {
            return;
        };
        if call.follow_state(state, now) {
            self.end_agent_call(call_id, Some(CallOutcome::Finished));
            return;
        }
        self.follow_agent_call_input_wait(call_id, now);
    }

    /// Advances the call of the target in `pane_id` after it reported a reply.
    pub(super) fn advance_agent_calls_on_reply(&mut self, pane_id: PaneId, seq: u64) {
        let Some(call_id) = self.agent_call_of_callee(pane_id) else {
            return;
        };
        let Some(call) = self.agent_calls.calls.get_mut(&call_id) else {
            return;
        };
        if seq <= call.reply_after {
            return;
        }
        match call.turn {
            // A late reply of the turn before this task.
            CallTurn::Submitted => {}
            CallTurn::Running => call.reply_seen = true,
            CallTurn::Ended { .. } => self.end_agent_call(call_id, Some(CallOutcome::Finished)),
        }
    }

    /// Advances the call of the target in `pane_id` after it reported a request.
    pub(super) fn advance_agent_calls_on_request(&mut self, pane_id: PaneId, now: Instant) {
        if let Some(call_id) = self.agent_call_of_callee(pane_id) {
            self.follow_agent_call_input_wait(call_id, now);
        }
    }

    /// Ends the calls of panes that were removed from their workspaces.
    pub(super) fn end_agent_calls_of_removed_panes(&mut self, pane_ids: &[PaneId]) {
        if self.agent_calls.is_empty() {
            return;
        }
        for &pane_id in pane_ids {
            if let Some(call_id) = self.agent_call_of_callee(pane_id) {
                self.end_agent_call(call_id, Some(CallOutcome::PaneClosed));
            }
        }
        for &pane_id in pane_ids {
            self.end_agent_calls_of_caller(pane_id);
        }
    }

    /// Runs the timers of calls: a reply that did not come in time, and a
    /// blocked target that did not report a request in time. Also notices
    /// that a reported wait for input is over, so the next one is reported.
    pub(crate) fn advance_agent_calls(&mut self, now: Instant) {
        if self.agent_calls.calls.is_empty() {
            return;
        }
        let call_ids = self.agent_calls.calls.keys().copied().collect::<Vec<_>>();
        for call_id in call_ids {
            let Some(call) = self.agent_calls.calls.get(&call_id) else {
                continue;
            };
            if matches!(call.turn, CallTurn::Ended { reply_deadline } if now >= reply_deadline) {
                self.end_agent_call(call_id, Some(CallOutcome::FinishedWithoutReply));
            } else if call.input_wait != InputWait::None {
                self.follow_agent_call_input_wait(call_id, now);
            }
        }
    }

    /// The next time [`AppState::advance_agent_calls`] or notice delivery has work.
    pub(crate) fn next_agent_call_deadline(&self) -> Option<Instant> {
        let calls = self
            .agent_calls
            .calls
            .values()
            .filter_map(AgentCall::next_deadline);
        let notices = self
            .agent_calls
            .notices
            .iter()
            .filter_map(|(&caller_pane, queue)| {
                let (_, terminal) = self.agent_call_pane(caller_pane)?;
                match queue.wait(terminal) {
                    NoticeWait::Until(at) => Some(at),
                    NoticeWait::Replaced | NoticeWait::Spent | NoticeWait::Caller => None,
                }
            });
        calls.chain(notices).min()
    }

    /// Target panes whose remote answers a call turned off since the last call.
    pub(crate) fn take_agent_call_remote_answer_changes(&mut self) -> Vec<PaneId> {
        std::mem::take(&mut self.agent_calls.remote_answers_changed)
    }

    /// The first notice of each calling agent that is ready for it; see
    /// [`CallerNotices::wait`]. Drops the notices of a pane whose agent was
    /// replaced.
    pub(crate) fn ready_agent_call_notices(&mut self, now: Instant) -> Vec<ReadyCallNotice> {
        if self.agent_calls.notices.is_empty() {
            return Vec::new();
        }
        let callers = self.agent_calls.notices.keys().copied().collect::<Vec<_>>();
        let mut ready = Vec::new();
        for caller_pane in callers {
            let Some(requests_pending) = self
                .agent_call_pane(caller_pane)
                .map(|(_, terminal)| !terminal.agent_requests().is_empty())
            else {
                continue;
            };
            if let Some(queue) = self.agent_calls.notices.get_mut(&caller_pane) {
                queue.observe_requests(requests_pending, now);
            }
            let (Some((ws_idx, terminal)), Some(queue)) = (
                self.agent_call_pane(caller_pane),
                self.agent_calls.notices.get(&caller_pane),
            ) else {
                continue;
            };
            match queue.wait(terminal) {
                NoticeWait::Replaced => {
                    tracing::debug!(
                        pane = caller_pane.raw(),
                        "dropping agent call notices of a replaced caller"
                    );
                    self.agent_calls.notices.remove(&caller_pane);
                }
                NoticeWait::Spent => {
                    self.agent_calls.notices.remove(&caller_pane);
                }
                NoticeWait::Until(at) if now >= at => {
                    if let Some(notice) = queue.pending.front() {
                        ready.push(ReadyCallNotice {
                            call_id: notice.call_id,
                            ws_idx,
                            caller_pane,
                            text: notice.text.clone(),
                        });
                    }
                }
                NoticeWait::Until(_) | NoticeWait::Caller => {}
            }
        }
        ready
    }

    /// The first notice of `caller_pane` was submitted.
    pub(crate) fn agent_call_notice_submitted(&mut self, caller_pane: PaneId) {
        let seq = self
            .agent_call_pane(caller_pane)
            .and_then(|(_, terminal)| terminal.last_agent_state_change_seq);
        if let Some(queue) = self.agent_calls.notices.get_mut(&caller_pane) {
            queue.pending.pop_front();
            queue.submitted_at_seq = Some(seq);
            queue.retry_at = None;
        }
    }

    /// The first notice of `caller_pane` could not be submitted; try again at `retry_at`.
    pub(crate) fn retry_agent_call_notice_at(&mut self, caller_pane: PaneId, retry_at: Instant) {
        if let Some(queue) = self.agent_calls.notices.get_mut(&caller_pane) {
            queue.retry_at = Some(retry_at);
        }
    }

    fn follow_agent_call_input_wait(&mut self, call_id: u64, now: Instant) {
        let Some(callee_pane) = self
            .agent_calls
            .calls
            .get(&call_id)
            .map(|call| call.callee_pane)
        else {
            return;
        };
        let Some((state, pending_requests)) = self
            .agent_call_pane(callee_pane)
            .map(|(_, terminal)| (terminal.state, terminal.agent_requests().iter().count()))
        else {
            return;
        };
        let Some(call) = self.agent_calls.calls.get_mut(&call_id) else {
            return;
        };
        if let Some(pending_requests) = call.follow_input_wait(state, pending_requests, now) {
            let call = call.clone();
            self.queue_agent_call_notice(&call, CallOutcome::Blocked { pending_requests });
        }
    }

    /// Ends the calls that the agent in `caller_pane` made and drops its
    /// notices: nothing would receive them.
    fn end_agent_calls_of_caller(&mut self, caller_pane: PaneId) {
        let call_ids = self
            .agent_calls
            .calls
            .values()
            .filter(|call| call.caller_pane == caller_pane)
            .map(|call| call.id)
            .collect::<Vec<_>>();
        for call_id in call_ids {
            self.end_agent_call(call_id, None);
        }
        self.agent_calls.notices.remove(&caller_pane);
    }

    /// Ends a call, restores the remote answers it turned on, and queues the
    /// notice for `outcome`.
    fn end_agent_call(&mut self, call_id: u64, outcome: Option<CallOutcome>) {
        let Some(call) = self.agent_calls.calls.remove(&call_id) else {
            return;
        };
        if self.agent_calls.by_callee.get(&call.callee_pane) == Some(&call_id) {
            self.agent_calls.by_callee.remove(&call.callee_pane);
        }
        tracing::debug!(call_id, ?outcome, "agent call ended");
        if call.turns_remote_answers_off {
            let terminal_id = self
                .workspaces
                .iter()
                .find_map(|ws| ws.pane_state(call.callee_pane))
                .map(|pane| pane.attached_terminal_id.clone());
            if let Some(terminal) = terminal_id.and_then(|id| self.terminals.get_mut(&id)) {
                if terminal.remote_answers() {
                    terminal.disable_remote_answers();
                    self.agent_calls
                        .remote_answers_changed
                        .push(call.callee_pane);
                }
            }
        }
        if let Some(outcome) = outcome {
            self.queue_agent_call_notice(&call, outcome);
        }
    }

    fn queue_agent_call_notice(&mut self, call: &AgentCall, outcome: CallOutcome) {
        let current = self
            .agent_call_pane(call.callee_pane)
            .map(|(ws_idx, terminal)| {
                (
                    terminal.agent_name.clone(),
                    self.public_pane_id(ws_idx, call.callee_pane),
                )
            });
        let (name, pane) = match current {
            Some((name, pane)) => (
                name.or_else(|| call.callee_name.clone()),
                pane.or_else(|| call.callee_public_pane_id.clone()),
            ),
            None => (call.callee_name.clone(), call.callee_public_pane_id.clone()),
        };
        let text = notice_text(
            call.id,
            outcome,
            &CalleeRef {
                kind: crate::detect::agent_label(call.callee_agent),
                name: name.as_deref(),
                pane: pane.as_deref(),
            },
            call.reply_after,
        );
        self.agent_calls
            .notices
            .entry(call.caller_pane)
            .or_insert_with(|| CallerNotices::new(call.caller_agent))
            .pending
            .push_back(CallNotice {
                call_id: call.id,
                text,
            });
    }
}

/// Calls and notices that a live handoff carries to the next server.
///
/// Panes are named by their public ids, which survive a handoff; internal
/// pane ids do not. Replies do not cross a handoff either, so the next
/// server counts a carried call's reply from its own first reply. Absent
/// from manifests of servers without agent calls, which carry none.
#[cfg(unix)]
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct AgentCallsHandoff {
    #[serde(default)]
    pub last_call_id: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<AgentCallHandoff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<CallerNoticesHandoff>,
}

#[cfg(unix)]
impl AgentCallsHandoff {
    pub(crate) fn is_empty(&self) -> bool {
        self.last_call_id == 0 && self.calls.is_empty() && self.notices.is_empty()
    }
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct AgentCallHandoff {
    pub id: u64,
    pub caller_pane_id: String,
    pub caller_agent: String,
    pub callee_pane_id: String,
    pub callee_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callee_name: Option<String>,
    pub turn: AgentCallTurnHandoff,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reply_seen: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub input_wait_reported: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub answer_requests: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub turns_remote_answers_off: bool,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentCallTurnHandoff {
    Submitted,
    Running,
    /// The turn ended and the reply is due; the next server waits a full
    /// grace period for it.
    Ended,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CallerNoticesHandoff {
    pub caller_pane_id: String,
    pub caller_agent: String,
    pub notices: Vec<CallNoticeHandoff>,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CallNoticeHandoff {
    pub call_id: u64,
    pub text: String,
}

#[cfg(unix)]
impl AppState {
    /// The calls and notices to carry over a live handoff.
    pub(crate) fn agent_calls_for_handoff(&self) -> AgentCallsHandoff {
        let public_id = |pane_id: PaneId| {
            self.agent_call_pane(pane_id)
                .and_then(|(ws_idx, _)| self.public_pane_id(ws_idx, pane_id))
        };
        let calls = self
            .agent_calls
            .calls
            .values()
            .filter_map(|call| {
                Some(AgentCallHandoff {
                    id: call.id,
                    caller_pane_id: public_id(call.caller_pane)?,
                    caller_agent: crate::detect::agent_label(call.caller_agent).to_string(),
                    callee_pane_id: public_id(call.callee_pane)?,
                    callee_agent: crate::detect::agent_label(call.callee_agent).to_string(),
                    callee_name: call.callee_name.clone(),
                    turn: match call.turn {
                        CallTurn::Submitted => AgentCallTurnHandoff::Submitted,
                        CallTurn::Running => AgentCallTurnHandoff::Running,
                        CallTurn::Ended { .. } => AgentCallTurnHandoff::Ended,
                    },
                    reply_seen: call.reply_seen,
                    input_wait_reported: call.input_wait == InputWait::Reported,
                    answer_requests: call.answer_requests,
                    turns_remote_answers_off: call.turns_remote_answers_off,
                })
            })
            .collect();
        let notices = self
            .agent_calls
            .notices
            .iter()
            .filter(|(_, queue)| !queue.pending.is_empty())
            .filter_map(|(&caller_pane, queue)| {
                Some(CallerNoticesHandoff {
                    caller_pane_id: public_id(caller_pane)?,
                    caller_agent: crate::detect::agent_label(queue.agent).to_string(),
                    notices: queue
                        .pending
                        .iter()
                        .map(|notice| CallNoticeHandoff {
                            call_id: notice.call_id,
                            text: notice.text.clone(),
                        })
                        .collect(),
                })
            })
            .collect();
        AgentCallsHandoff {
            last_call_id: self.agent_calls.last_call_id,
            calls,
            notices,
        }
    }

    /// Takes over the calls and notices that the previous server carried
    /// over a live handoff. Calls and notices whose panes did not survive
    /// the handoff are dropped.
    pub(crate) fn restore_agent_calls_after_handoff(
        &mut self,
        handoff: AgentCallsHandoff,
        now: Instant,
    ) {
        let pane = |state: &Self, public_id: &str, agent: &str| {
            let (_, pane_id) = state.pane_with_current_public_id(public_id)?;
            Some((pane_id, crate::detect::parse_agent_label(agent)?))
        };
        self.agent_calls.last_call_id = self.agent_calls.last_call_id.max(handoff.last_call_id);
        for carried in handoff.calls {
            let (Some((caller_pane, caller_agent)), Some((callee_pane, callee_agent))) = (
                pane(self, &carried.caller_pane_id, &carried.caller_agent),
                pane(self, &carried.callee_pane_id, &carried.callee_agent),
            ) else {
                tracing::debug!(call_id = carried.id, "dropping agent call after handoff");
                continue;
            };
            self.agent_calls.by_callee.insert(callee_pane, carried.id);
            self.agent_calls.calls.insert(
                carried.id,
                AgentCall {
                    id: carried.id,
                    caller_pane,
                    caller_agent,
                    callee_pane,
                    callee_agent,
                    callee_name: carried.callee_name,
                    callee_public_pane_id: Some(carried.callee_pane_id),
                    reply_after: self.next_agent_reply_seq,
                    turn: match carried.turn {
                        AgentCallTurnHandoff::Submitted => CallTurn::Submitted,
                        AgentCallTurnHandoff::Running => CallTurn::Running,
                        AgentCallTurnHandoff::Ended => CallTurn::Ended {
                            reply_deadline: now + CALL_REPLY_GRACE,
                        },
                    },
                    reply_seen: carried.reply_seen,
                    input_wait: if carried.input_wait_reported {
                        InputWait::Reported
                    } else {
                        InputWait::None
                    },
                    answer_requests: carried.answer_requests,
                    turns_remote_answers_off: carried.turns_remote_answers_off,
                },
            );
        }
        for carried in handoff.notices {
            let Some((caller_pane, agent)) =
                pane(self, &carried.caller_pane_id, &carried.caller_agent)
            else {
                tracing::debug!("dropping agent call notices after handoff");
                continue;
            };
            self.agent_calls
                .notices
                .entry(caller_pane)
                .or_insert_with(|| CallerNotices::new(agent))
                .pending
                .extend(carried.notices.into_iter().map(|notice| CallNotice {
                    call_id: notice.call_id,
                    text: notice.text,
                }));
        }
    }
}

#[cfg(test)]
impl AppState {
    /// Texts of the notices that wait for the agent in `caller_pane`.
    pub(crate) fn agent_call_notice_texts(&self, caller_pane: PaneId) -> Vec<String> {
        self.agent_calls
            .notices
            .get(&caller_pane)
            .map(|queue| {
                queue
                    .pending
                    .iter()
                    .map(|notice| notice.text.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use ratatui::layout::Direction;

    use super::{NewAgentCall, CALL_NOTICE_SETTLE, CALL_REPLY_GRACE, CALL_REQUEST_SETTLE};
    use crate::app::AppState;
    use crate::detect::{Agent, AgentState};
    use crate::events::AppEvent;
    use crate::layout::PaneId;
    use crate::workspace::Workspace;

    /// A Claude caller and an idle Codex target named reviewer in one tab.
    fn two_agents() -> (AppState, PaneId, PaneId) {
        let mut state = AppState::test_new();
        let mut ws = Workspace::test_new("calls");
        let caller = ws.tabs[0].root_pane;
        let callee = ws.test_split(Direction::Horizontal);
        state.workspaces.push(ws);
        state.active = Some(0);
        state.ensure_test_terminals();
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        terminal_mut(&mut state, callee).set_agent_name("reviewer".into());
        (state, caller, callee)
    }

    fn terminal_mut(state: &mut AppState, pane_id: PaneId) -> &mut crate::terminal::TerminalState {
        let terminal_id = state.workspaces[0].panes[&pane_id]
            .attached_terminal_id
            .clone();
        state.terminals.get_mut(&terminal_id).unwrap()
    }

    fn set_state(state: &mut AppState, pane_id: PaneId, agent: Agent, agent_state: AgentState) {
        state.handle_app_event(AppEvent::StateChanged {
            pane_id,
            agent: Some(agent),
            state: agent_state,
            visible_blocker: agent_state == AgentState::Blocked,
            visible_working: agent_state == AgentState::Working,
            process_exited: false,
            observed_at: Instant::now(),
        });
    }

    fn call(state: &mut AppState, caller: PaneId, callee: PaneId, answer_requests: bool) -> u64 {
        state.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: callee,
            callee_agent: Agent::Codex,
            answer_requests,
            turns_remote_answers_off: false,
        })
    }

    fn reply(state: &mut AppState, pane_id: PaneId, seq: u64) -> Option<u64> {
        state.record_agent_reply(
            pane_id,
            crate::terminal::agent_replies::AgentReplyReport {
                source: "herdr:codex".into(),
                agent_label: "codex".into(),
                seq: Some(seq),
                agent_session_id: None,
                text: "the reply text stays out of notices".into(),
                truncated: false,
            },
        )
    }

    /// A permission request that the integration of `agent_label` reports
    /// for the agent in `pane_id`.
    fn request(state: &mut AppState, pane_id: PaneId, agent_label: &str) -> Option<u64> {
        state
            .record_agent_request(
                pane_id,
                crate::terminal::agent_requests::AgentRequestReport {
                    source: format!("herdr:{agent_label}"),
                    agent_label: agent_label.into(),
                    agent_session_id: None,
                    content: crate::api::schema::AgentRequestContent {
                        kind: crate::api::schema::AgentRequestKind::Permission,
                        tool_name: "Bash".into(),
                        description: None,
                        input_preview: "rm -rf build".into(),
                        decisions: vec![crate::api::schema::AgentRequestDecision::Allow],
                        questions: Vec::new(),
                    },
                },
            )
            .map(|(_, id)| id)
    }

    fn notices(state: &AppState, caller: PaneId) -> Vec<String> {
        state.agent_call_notice_texts(caller)
    }

    /// When the agent in `pane_id` last changed state.
    fn changed_at(state: &mut AppState, pane_id: PaneId) -> Instant {
        terminal_mut(state, pane_id)
            .last_agent_state_change_at
            .expect("the state change is recorded")
    }

    /// When the agent in `pane_id` has stayed in its state for the settle period.
    fn settled(state: &mut AppState, pane_id: PaneId) -> Instant {
        changed_at(state, pane_id) + CALL_NOTICE_SETTLE
    }

    /// A working Claude caller with one notice waiting: its target blocked.
    fn caller_with_a_notice() -> (AppState, PaneId) {
        let (mut state, caller, callee) = two_agents();
        set_state(&mut state, caller, Agent::Claude, AgentState::Working);
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(notices(&state, caller).len(), 1);
        (state, caller)
    }

    fn public_id(state: &AppState, pane_id: PaneId) -> String {
        let ws = &state.workspaces[0];
        crate::workspace::public_pane_id_for_number(&ws.id, ws.public_pane_number(pane_id).unwrap())
    }

    #[test]
    fn a_turn_that_ends_with_a_reply_finishes_the_call() {
        let (mut state, caller, callee) = two_agents();
        reply(&mut state, callee, 1).expect("an earlier reply is recorded");
        let id = call(&mut state, caller, callee, false);
        assert_eq!(state.agent_call_of_callee(callee), Some(id));

        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        assert!(notices(&state, caller).is_empty(), "the reply is still due");
        reply(&mut state, callee, 2).expect("the turn's reply is recorded");

        let pane = public_id(&state, callee);
        assert_eq!(
            notices(&state, caller),
            [format!(
                "[herdr] call {id} finished: codex agent reviewer (pane {pane}) ended its turn with a reply. Read it with: herdr agent replies reviewer --after 1"
            )]
        );
        assert_eq!(state.agent_call_of_callee(callee), None, "the call ended");
    }

    #[test]
    fn a_reply_that_arrives_before_the_turn_ends_finishes_the_call_at_its_end() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);

        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        reply(&mut state, callee, 1).unwrap();
        assert!(
            notices(&state, caller).is_empty(),
            "the turn is still running"
        );
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);

        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 1, "{texts:?}");
        assert!(
            texts[0].starts_with(&format!("[herdr] call {id} finished: ")),
            "{texts:?}"
        );
        assert!(
            texts[0].ends_with("herdr agent replies reviewer --after 0"),
            "{texts:?}"
        );
        assert!(!texts[0].contains("reply text"), "{texts:?}");
    }

    #[test]
    fn a_turn_without_a_reply_finishes_after_the_grace_period() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        let ended_at = Instant::now();
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);

        let deadline = state
            .next_agent_call_deadline()
            .expect("the grace period runs");
        assert!(deadline >= ended_at + CALL_REPLY_GRACE, "{deadline:?}");
        state.advance_agent_calls(deadline - Duration::from_millis(1));
        assert!(notices(&state, caller).is_empty());
        state.advance_agent_calls(deadline);

        let pane = public_id(&state, callee);
        assert_eq!(
            notices(&state, caller),
            [format!(
                "[herdr] call {id} finished without reply: codex agent reviewer (pane {pane}) ended its turn without reporting a reply. See its screen with: herdr agent read reviewer"
            )]
        );
        assert_eq!(state.agent_call_of_callee(callee), None);
        assert_eq!(
            state.next_agent_call_deadline(),
            Some(settled(&mut state, caller)),
            "only the notice to the idle caller is due"
        );
    }

    #[test]
    fn a_reply_before_the_task_started_and_a_short_idle_do_not_end_the_call() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);
        reply(&mut state, callee, 1).unwrap();
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        state.advance_agent_calls(Instant::now() + CALL_REPLY_GRACE * 2);
        assert!(notices(&state, caller).is_empty(), "the turn goes on");
        assert_eq!(state.agent_call_of_callee(callee), Some(id));

        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        reply(&mut state, callee, 2).unwrap();
        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 1, "{texts:?}");
        assert!(texts[0].contains(" finished: "), "{texts:?}");
    }

    #[test]
    fn each_blocked_episode_is_reported_once_and_the_call_stays_open() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        state.advance_agent_calls(Instant::now() + CALL_REQUEST_SETTLE * 2);
        let pane = public_id(&state, callee);
        let blocked = format!(
            "[herdr] call {id} blocked: codex agent reviewer (pane {pane}) waits for input that a person has to give in its terminal. The call stays open."
        );
        assert_eq!(notices(&state, caller), std::slice::from_ref(&blocked));
        assert_eq!(state.agent_call_of_callee(callee), Some(id));

        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        reply(&mut state, callee, 1).unwrap();

        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 3, "{texts:?}");
        assert_eq!(texts[..2], [blocked.clone(), blocked]);
        assert!(texts[2].contains(" finished: "), "{texts:?}");
    }

    #[test]
    fn a_call_that_answers_requests_points_at_them_and_waits_for_one_before_asking_for_a_person() {
        let (mut state, caller, callee) = two_agents();
        assert!(terminal_mut(&mut state, callee).enable_remote_answers());
        let id = call(&mut state, caller, callee, true);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        request(&mut state, callee, "codex").expect("the request waits for a remote answer");

        let pane = public_id(&state, callee);
        assert_eq!(
            notices(&state, caller),
            [format!(
                "[herdr] call {id} blocked: codex agent reviewer (pane {pane}) waits on 1 pending request. List it with: herdr agent requests reviewer. Answer with: herdr agent answer reviewer <REQUEST_ID> --decision <DECISION>, or --answers <JSON> for a question. The call stays open."
            )]
        );
        assert!(!notices(&state, caller)[0].contains("rm -rf"));

        // The request was answered, and the agent blocked on something else.
        terminal_mut(&mut state, callee).remove_agent_request(1);
        state.advance_agent_calls(Instant::now());
        let blocked_at = Instant::now();
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(notices(&state, caller).len(), 1, "a request may still come");
        state.advance_agent_calls(blocked_at + CALL_REQUEST_SETTLE + Duration::from_millis(1));

        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(
            texts[1].contains("waits for input that a person has to give in its terminal"),
            "{texts:?}"
        );
    }

    #[test]
    fn a_target_that_leaves_or_loses_its_pane_ends_the_call() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        state.publish_pane_process_exit_if_agent(callee, false);
        let pane = public_id(&state, callee);
        assert_eq!(
            notices(&state, caller),
            [format!(
                "[herdr] call {id} gone: codex agent reviewer (pane {pane}) exited or was replaced. The call has ended."
            )]
        );
        assert_eq!(state.agent_call_of_callee(callee), None);

        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        let second = call(&mut state, caller, callee, false);
        state.workspaces[0].close_pane(callee);
        state.forget_removed_panes([callee]);
        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(
            texts[1].starts_with(&format!("[herdr] call {second} gone: codex agent")),
            "{texts:?}"
        );
        assert!(
            texts[1].ends_with(" was closed. The call has ended."),
            "{texts:?}"
        );
        assert_eq!(state.agent_call_of_callee(callee), None);
    }

    #[test]
    fn another_agent_in_the_target_pane_ends_the_call() {
        let (mut state, caller, callee) = two_agents();
        let id = call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Claude, AgentState::Working);
        let texts = notices(&state, caller);
        assert_eq!(texts.len(), 1, "{texts:?}");
        assert!(
            texts[0].starts_with(&format!("[herdr] call {id} gone: codex agent")),
            "{texts:?}"
        );
    }

    #[test]
    fn a_caller_that_leaves_drops_its_calls_and_notices() {
        let (mut state, caller, callee) = two_agents();
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(notices(&state, caller).len(), 1);

        state.publish_pane_process_exit_if_agent(caller, false);

        assert!(notices(&state, caller).is_empty());
        assert_eq!(state.agent_call_of_callee(callee), None);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        reply(&mut state, callee, 1).unwrap();
        assert!(notices(&state, caller).is_empty());
    }

    #[test]
    fn closing_the_caller_pane_drops_its_calls_and_notices() {
        let (mut state, caller, callee) = two_agents();
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);

        state.workspaces[0].close_pane(caller);
        state.forget_removed_panes([caller]);

        assert!(notices(&state, caller).is_empty());
        assert_eq!(state.agent_call_of_callee(callee), None);
        assert_eq!(state.next_agent_call_deadline(), None);
    }

    #[test]
    fn a_call_turns_off_only_the_remote_answers_it_turned_on() {
        let (mut state, caller, callee) = two_agents();
        assert!(terminal_mut(&mut state, callee).enable_remote_answers());
        state.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: callee,
            callee_agent: Agent::Codex,
            answer_requests: true,
            turns_remote_answers_off: true,
        });
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        reply(&mut state, callee, 1).unwrap();
        assert!(!terminal_mut(&mut state, callee).remote_answers());
        assert_eq!(state.take_agent_call_remote_answer_changes(), [callee]);

        // Remote answers were on before this call, for example for a bridge.
        assert!(terminal_mut(&mut state, callee).enable_remote_answers());
        call(&mut state, caller, callee, true);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Idle);
        reply(&mut state, callee, 2).unwrap();
        assert!(terminal_mut(&mut state, callee).remote_answers());
        assert!(state.take_agent_call_remote_answer_changes().is_empty());

        // Someone set them explicitly during the call.
        state.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: callee,
            callee_agent: Agent::Codex,
            answer_requests: true,
            turns_remote_answers_off: true,
        });
        state.keep_remote_answers_after_agent_call(callee);
        state.publish_pane_process_exit_if_agent(caller, false);
        assert!(terminal_mut(&mut state, callee).remote_answers());
        assert!(state.take_agent_call_remote_answer_changes().is_empty());
    }

    #[test]
    fn a_cancelled_call_ends_without_a_notice_and_restores_remote_answers() {
        let (mut state, caller, callee) = two_agents();
        assert!(terminal_mut(&mut state, callee).enable_remote_answers());
        let id = state.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: callee,
            callee_agent: Agent::Codex,
            answer_requests: true,
            turns_remote_answers_off: true,
        });
        state.cancel_agent_call(id);
        assert_eq!(state.agent_call_of_callee(callee), None);
        assert!(notices(&state, caller).is_empty());
        assert!(!terminal_mut(&mut state, callee).remote_answers());
    }

    #[test]
    fn call_ids_are_not_reused() {
        let (mut state, caller, callee) = two_agents();
        let first = call(&mut state, caller, callee, false);
        state.cancel_agent_call(first);
        let second = call(&mut state, caller, callee, false);
        assert!(second > first, "{first} {second}");
    }

    #[test]
    fn notices_wait_for_an_idle_caller_and_go_out_one_per_idle_period_in_order() {
        let (mut state, caller, callee) = two_agents();
        let other = state.workspaces[0].test_split(Direction::Vertical);
        state.ensure_test_terminals();
        set_state(&mut state, other, Agent::Pi, AgentState::Idle);
        set_state(&mut state, caller, Agent::Claude, AgentState::Working);

        let first = call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        state.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: other,
            callee_agent: Agent::Pi,
            answer_requests: false,
            turns_remote_answers_off: false,
        });
        set_state(&mut state, other, Agent::Pi, AgentState::Working);
        state.publish_pane_process_exit_if_agent(other, false);
        assert_eq!(notices(&state, caller).len(), 2);

        let later = Instant::now() + CALL_NOTICE_SETTLE * 10;
        assert!(
            state.ready_agent_call_notices(later).is_empty(),
            "the caller is working"
        );
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let at = settled(&mut state, caller);
        let ready = state.ready_agent_call_notices(at);
        assert_eq!(ready.len(), 1, "{ready:?}");
        assert_eq!(ready[0].caller_pane, caller);
        assert_eq!(ready[0].ws_idx, 0);
        assert_eq!(ready[0].call_id, first);
        assert!(ready[0].text.contains(" blocked: "), "{ready:?}");
        state.agent_call_notice_submitted(caller);
        assert!(
            state.ready_agent_call_notices(at).is_empty(),
            "the caller has not taken the first notice yet"
        );

        set_state(&mut state, caller, Agent::Claude, AgentState::Working);
        assert!(state.ready_agent_call_notices(later).is_empty());
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let at = settled(&mut state, caller);
        let ready = state.ready_agent_call_notices(at);
        assert_eq!(ready.len(), 1, "{ready:?}");
        assert!(ready[0].text.contains(" gone: pi agent"), "{ready:?}");
        state.agent_call_notice_submitted(caller);
        assert!(notices(&state, caller).is_empty());
    }

    #[test]
    fn a_caller_that_just_became_idle_gets_its_notice_only_after_the_settle_period() {
        let (mut state, caller) = caller_with_a_notice();
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let idle_at = changed_at(&mut state, caller);
        let settled = idle_at + CALL_NOTICE_SETTLE;

        assert!(state.ready_agent_call_notices(idle_at).is_empty());
        assert!(state
            .ready_agent_call_notices(settled - Duration::from_millis(1))
            .is_empty());
        assert_eq!(
            state.next_agent_call_deadline(),
            Some(settled),
            "the loop wakes when the caller has been idle for the settle period"
        );

        let ready = state.ready_agent_call_notices(settled);
        assert_eq!(ready.len(), 1, "{ready:?}");
        assert_eq!(ready[0].caller_pane, caller);
    }

    #[test]
    fn a_caller_that_leaves_idle_within_the_settle_period_gets_no_notice() {
        let (mut state, caller) = caller_with_a_notice();
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let idle_at = changed_at(&mut state, caller);
        assert!(state.ready_agent_call_notices(idle_at).is_empty());

        // For example a dialog that the idle screen was a glimpse of.
        set_state(&mut state, caller, Agent::Claude, AgentState::Blocked);
        let later = idle_at + CALL_NOTICE_SETTLE * 10;
        assert!(state.ready_agent_call_notices(later).is_empty());
        assert_eq!(
            state.next_agent_call_deadline(),
            None,
            "a blocked caller is waited for, not timed"
        );

        // Idle again: the settle period starts over.
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let settled = settled(&mut state, caller);
        assert_eq!(state.next_agent_call_deadline(), Some(settled));
        assert!(state
            .ready_agent_call_notices(settled - Duration::from_millis(1))
            .is_empty());
        assert_eq!(state.ready_agent_call_notices(settled).len(), 1);
    }

    #[test]
    fn a_caller_with_a_pending_request_of_its_own_gets_no_notice() {
        let (mut state, caller) = caller_with_a_notice();
        set_state(&mut state, caller, Agent::Claude, AgentState::Idle);
        let settled = settled(&mut state, caller);
        // A client answers the caller's requests, for example a chat bridge,
        // and the caller asks a question while its screen reads idle.
        assert!(terminal_mut(&mut state, caller).enable_remote_answers());
        let request_id = request(&mut state, caller, "claude").expect("the caller's request waits");

        let later = settled + CALL_NOTICE_SETTLE * 10;
        assert!(
            state.ready_agent_call_notices(later).is_empty(),
            "the notice would answer the caller's request"
        );
        assert_eq!(state.next_agent_call_deadline(), None);

        // The request was answered; the caller resumes, so it settles again.
        terminal_mut(&mut state, caller).remove_agent_request(request_id);
        let answered_at = later + Duration::from_secs(1);
        assert!(state.ready_agent_call_notices(answered_at).is_empty());
        assert_eq!(
            state.next_agent_call_deadline(),
            Some(answered_at + CALL_NOTICE_SETTLE)
        );
        assert_eq!(
            state
                .ready_agent_call_notices(answered_at + CALL_NOTICE_SETTLE)
                .len(),
            1
        );
    }

    #[test]
    fn a_notice_that_could_not_be_submitted_waits_until_its_retry_time() {
        let (mut state, caller, callee) = two_agents();
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        let idle_at = changed_at(&mut state, caller);
        let settled = idle_at + CALL_NOTICE_SETTLE;
        state.retry_agent_call_notice_at(caller, idle_at + Duration::from_millis(500));
        assert_eq!(
            state.next_agent_call_deadline(),
            Some(settled),
            "a retry does not cut the settle period short"
        );

        let retry_at = settled + Duration::from_secs(1);
        state.retry_agent_call_notice_at(caller, retry_at);
        assert!(state.ready_agent_call_notices(settled).is_empty());
        assert_eq!(state.next_agent_call_deadline(), Some(retry_at));
        assert_eq!(state.ready_agent_call_notices(retry_at).len(), 1);
    }

    #[test]
    fn a_passed_retry_time_does_not_keep_the_loop_awake() {
        let (mut state, caller, callee) = two_agents();
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        let now = Instant::now();
        state.retry_agent_call_notice_at(caller, now + Duration::from_secs(1));
        set_state(&mut state, caller, Agent::Claude, AgentState::Working);

        assert!(state
            .ready_agent_call_notices(now + Duration::from_secs(2))
            .is_empty());

        assert_eq!(
            state.next_agent_call_deadline(),
            None,
            "the notice waits for the caller's next state change, not a timer"
        );
    }

    #[test]
    fn notices_of_a_caller_whose_agent_was_replaced_are_dropped() {
        let (mut state, caller, callee) = two_agents();
        call(&mut state, caller, callee, false);
        set_state(&mut state, callee, Agent::Codex, AgentState::Working);
        set_state(&mut state, callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(notices(&state, caller).len(), 1);

        set_state(&mut state, caller, Agent::Pi, AgentState::Idle);

        assert!(state.ready_agent_call_notices(Instant::now()).is_empty());
        assert!(notices(&state, caller).is_empty());
    }

    /// The state a live handoff successor starts from: the same workspaces
    /// restored from a snapshot, with new internal pane ids.
    #[cfg(unix)]
    fn handoff_successor(old: &mut AppState) -> AppState {
        let missing = std::env::temp_dir().join("herdr-missing-agent-call-handoff-cwd");
        assert!(!missing.exists());
        for terminal in old.terminals.values_mut() {
            terminal.cwd = missing.clone();
        }
        let snapshot = crate::persist::capture(
            &old.workspaces,
            &old.terminals,
            &crate::terminal::TerminalRuntimeRegistry::default(),
            old.active,
            old.selected,
        );
        let (events, _rx) = tokio::sync::mpsc::channel(32);
        let (workspaces, terminals, runtimes) = crate::persist::restore(
            &snapshot,
            None,
            24,
            80,
            0,
            "/bin/sh",
            crate::config::ShellModeConfig::NonLogin,
            false,
            events,
            std::sync::Arc::new(tokio::sync::Notify::new()),
            std::sync::Arc::new(crate::render_signal::RenderSignal::new()),
        );
        assert!(runtimes.is_empty());
        let mut new = AppState::test_new();
        new.workspaces = workspaces;
        new.terminals = terminals;
        new.active = Some(0);
        new
    }

    #[cfg(unix)]
    #[test]
    fn calls_and_notices_cross_a_live_handoff_and_go_on() {
        let (mut old, caller, callee) = two_agents();
        set_state(&mut old, caller, Agent::Claude, AgentState::Working);
        let first = call(&mut old, caller, callee, false);
        set_state(&mut old, callee, Agent::Codex, AgentState::Working);
        set_state(&mut old, callee, Agent::Codex, AgentState::Idle);
        reply(&mut old, callee, 1).unwrap();
        let waiting_notice = notices(&old, caller);
        assert_eq!(waiting_notice.len(), 1, "the caller is busy");
        assert!(terminal_mut(&mut old, callee).enable_remote_answers());
        let second = old.register_agent_call(NewAgentCall {
            caller_pane: caller,
            caller_agent: Agent::Claude,
            callee_pane: callee,
            callee_agent: Agent::Codex,
            answer_requests: true,
            turns_remote_answers_off: true,
        });
        set_state(&mut old, callee, Agent::Codex, AgentState::Working);
        set_state(&mut old, callee, Agent::Codex, AgentState::Blocked);
        assert_eq!(notices(&old, caller).len(), 1, "a request may still come");
        let caller_id = public_id(&old, caller);
        let callee_id = public_id(&old, callee);

        let carried = old.agent_calls_for_handoff();
        let carried: super::AgentCallsHandoff =
            serde_json::from_value(serde_json::to_value(&carried).unwrap()).unwrap();
        let mut new = handoff_successor(&mut old);
        new.restore_agent_calls_after_handoff(carried, Instant::now());

        let (_, new_caller) = new.pane_with_current_public_id(&caller_id).unwrap();
        let (_, new_callee) = new.pane_with_current_public_id(&callee_id).unwrap();
        assert_ne!(new_caller, caller, "the handoff rebuilds internal pane ids");
        assert_eq!(notices(&new, new_caller), waiting_notice);
        assert_eq!(new.agent_call_of_callee(new_callee), Some(second));
        assert!(
            new.ready_agent_call_notices(Instant::now()).is_empty(),
            "the caller agent is not detected again yet"
        );

        // The agents are detected again; the pane runtime carries remote answers.
        set_state(&mut new, new_caller, Agent::Claude, AgentState::Idle);
        set_state(&mut new, new_callee, Agent::Codex, AgentState::Working);
        terminal_mut(&mut new, new_callee).restore_remote_answers_after_handoff();
        set_state(&mut new, new_callee, Agent::Codex, AgentState::Idle);
        reply(&mut new, new_callee, 1).unwrap();

        let texts = notices(&new, new_caller);
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert_eq!(texts[0], waiting_notice[0]);
        assert!(
            texts[1].starts_with(&format!("[herdr] call {second} finished: ")),
            "{texts:?}"
        );
        assert!(
            texts[1].ends_with(" --after 0"),
            "replies are counted again on the new server: {texts:?}"
        );
        assert!(!terminal_mut(&mut new, new_callee).remote_answers());
        let at = settled(&mut new, new_caller);
        let ready = new.ready_agent_call_notices(at);
        assert_eq!(ready.len(), 1, "{ready:?}");
        assert_eq!(ready[0].call_id, first);
        assert_eq!(ready[0].caller_pane, new_caller);

        let third = call(&mut new, new_caller, new_callee, false);
        assert!(third > second, "call ids are not reused: {third}");
    }

    #[cfg(unix)]
    #[test]
    fn a_handoff_drops_calls_whose_panes_did_not_survive() {
        let (mut old, caller, callee) = two_agents();
        call(&mut old, caller, callee, false);
        let mut carried = old.agent_calls_for_handoff();
        assert_eq!(carried.calls.len(), 1);
        carried.calls[0].caller_pane_id = "w99:p1".into();
        carried.notices.push(super::CallerNoticesHandoff {
            caller_pane_id: "w99:p1".into(),
            caller_agent: "claude".into(),
            notices: vec![super::CallNoticeHandoff {
                call_id: 1,
                text: "[herdr] call 1 gone: ...".into(),
            }],
        });

        let mut new = handoff_successor(&mut old);
        new.restore_agent_calls_after_handoff(carried, Instant::now());

        let (_, new_callee) = new
            .pane_with_current_public_id(&public_id(&old, callee))
            .unwrap();
        assert_eq!(new.agent_call_of_callee(new_callee), None);
        assert!(new.agent_calls.is_empty());
    }
}
