//! Tool calls reported by agent integrations, as start and end events.
//!
//! Like replies, tool call events are shared runtime facts kept in memory only;
//! they are not persisted in session snapshots and do not survive a server
//! restart or live handoff.

use std::collections::VecDeque;

use crate::api::schema::AgentToolCallPhase;

/// Number of events retained per agent terminal.
pub const MAX_AGENT_TOOL_CALL_EVENTS: usize = 256;
/// Longest stored tool call id, tool name, and title, in characters.
pub const MAX_AGENT_TOOL_CALL_TEXT_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolCallEvent {
    pub seq: u64,
    pub tool_call_id: String,
    pub phase: AgentToolCallPhase,
    pub tool_name: String,
    pub title: Option<String>,
    pub failed: bool,
}

/// The start or end of a tool call reported for a pane by an agent integration hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolCallReport {
    pub source: String,
    pub agent_label: String,
    pub agent_session_id: Option<String>,
    pub tool_call_id: String,
    pub phase: AgentToolCallPhase,
    pub tool_name: String,
    pub title: Option<String>,
    pub failed: bool,
}

/// The most recent tool call events of one agent terminal, oldest first.
#[derive(Debug, Clone, Default)]
pub struct AgentToolCalls {
    events: VecDeque<AgentToolCallEvent>,
}

impl AgentToolCalls {
    /// Records the event of `report` with the next seq and returns that seq.
    ///
    /// Events without a tool call id or tool name are not recorded, and
    /// neither is a start that arrives after the end of the same call. An end
    /// of a call with no retained event is recorded after a start made from
    /// it, so every retained end follows a start of its call; the returned seq
    /// is then the end's. Each recorded event consumes one seq.
    pub fn record(&mut self, report: AgentToolCallReport, next_seq: &mut u64) -> Option<u64> {
        let tool_call_id = capped(report.tool_call_id);
        let tool_name = capped(report.tool_name);
        if tool_call_id.is_empty() || tool_name.is_empty() {
            return None;
        }
        let title = report.title.map(capped).filter(|title| !title.is_empty());
        // Hooks that run in the background can deliver the end of a quick
        // call before its start. The end then brings its own start, and the
        // late start is dropped. An end whose start was evicted gets a start
        // again too.
        match report.phase {
            AgentToolCallPhase::Start if self.has_ended(&tool_call_id) => return None,
            AgentToolCallPhase::End if !self.has_event(&tool_call_id) => {
                *next_seq += 1;
                self.push(AgentToolCallEvent {
                    seq: *next_seq,
                    tool_call_id: tool_call_id.clone(),
                    phase: AgentToolCallPhase::Start,
                    tool_name: tool_name.clone(),
                    title: title.clone(),
                    failed: false,
                });
            }
            _ => {}
        }
        *next_seq += 1;
        self.push(AgentToolCallEvent {
            seq: *next_seq,
            tool_call_id,
            phase: report.phase,
            tool_name,
            title,
            failed: report.failed && report.phase == AgentToolCallPhase::End,
        });
        Some(*next_seq)
    }

    fn has_ended(&self, tool_call_id: &str) -> bool {
        self.events.iter().any(|event| {
            event.phase == AgentToolCallPhase::End && event.tool_call_id == tool_call_id
        })
    }

    fn has_event(&self, tool_call_id: &str) -> bool {
        self.events
            .iter()
            .any(|event| event.tool_call_id == tool_call_id)
    }

    /// Appends `event`, evicting the oldest event when the buffer is full.
    fn push(&mut self, event: AgentToolCallEvent) {
        if self.events.len() == MAX_AGENT_TOOL_CALL_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    pub fn latest_seq(&self) -> Option<u64> {
        self.events.back().map(|event| event.seq)
    }

    /// Retained events with a seq greater than `after_seq`, or all of them.
    pub fn after(&self, after_seq: Option<u64>) -> impl Iterator<Item = &AgentToolCallEvent> {
        self.events
            .iter()
            .filter(move |event| after_seq.is_none_or(|after_seq| event.seq > after_seq))
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }
}

fn capped(mut text: String) -> String {
    if let Some((end, _)) = text.char_indices().nth(MAX_AGENT_TOOL_CALL_TEXT_CHARS) {
        text.truncate(end);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(tool_call_id: &str, phase: AgentToolCallPhase) -> AgentToolCallReport {
        AgentToolCallReport {
            source: "herdr:claude".into(),
            agent_label: "claude".into(),
            agent_session_id: None,
            tool_call_id: tool_call_id.into(),
            phase,
            tool_name: "Bash".into(),
            title: Some(format!("run {tool_call_id}")),
            failed: false,
        }
    }

    fn start(tool_call_id: &str) -> AgentToolCallReport {
        report(tool_call_id, AgentToolCallPhase::Start)
    }

    fn end(tool_call_id: &str) -> AgentToolCallReport {
        report(tool_call_id, AgentToolCallPhase::End)
    }

    fn seqs(tool_calls: &AgentToolCalls, after_seq: Option<u64>) -> Vec<u64> {
        tool_calls.after(after_seq).map(|event| event.seq).collect()
    }

    #[test]
    fn records_events_with_increasing_seqs() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 40;
        assert_eq!(tool_calls.latest_seq(), None);

        assert_eq!(tool_calls.record(start("a"), &mut next_seq), Some(41));
        let mut failed_end = end("a");
        failed_end.failed = true;
        assert_eq!(tool_calls.record(failed_end, &mut next_seq), Some(42));

        assert_eq!(next_seq, 42);
        assert_eq!(tool_calls.latest_seq(), Some(42));
        assert_eq!(
            tool_calls.after(None).cloned().collect::<Vec<_>>(),
            [
                AgentToolCallEvent {
                    seq: 41,
                    tool_call_id: "a".into(),
                    phase: AgentToolCallPhase::Start,
                    tool_name: "Bash".into(),
                    title: Some("run a".into()),
                    failed: false,
                },
                AgentToolCallEvent {
                    seq: 42,
                    tool_call_id: "a".into(),
                    phase: AgentToolCallPhase::End,
                    tool_name: "Bash".into(),
                    title: Some("run a".into()),
                    failed: true,
                },
            ]
        );
    }

    #[test]
    fn interleaved_calls_are_recorded_in_arrival_order() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        for report in [start("a"), start("b"), end("b"), end("a")] {
            assert!(tool_calls.record(report, &mut next_seq).is_some());
        }

        let order: Vec<(String, AgentToolCallPhase)> = tool_calls
            .after(None)
            .map(|event| (event.tool_call_id.clone(), event.phase))
            .collect();
        assert_eq!(
            order,
            [
                ("a".to_string(), AgentToolCallPhase::Start),
                ("b".to_string(), AgentToolCallPhase::Start),
                ("b".to_string(), AgentToolCallPhase::End),
                ("a".to_string(), AgentToolCallPhase::End),
            ]
        );
    }

    #[test]
    fn an_end_that_arrives_before_its_start_is_recorded_after_a_start_made_from_it() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        let mut failed_end = end("a");
        failed_end.failed = true;

        assert_eq!(tool_calls.record(failed_end, &mut next_seq), Some(2));
        assert_eq!(next_seq, 2);
        assert_eq!(tool_calls.latest_seq(), Some(2));
        assert_eq!(
            tool_calls.after(None).cloned().collect::<Vec<_>>(),
            [
                AgentToolCallEvent {
                    seq: 1,
                    tool_call_id: "a".into(),
                    phase: AgentToolCallPhase::Start,
                    tool_name: "Bash".into(),
                    title: Some("run a".into()),
                    failed: false,
                },
                AgentToolCallEvent {
                    seq: 2,
                    tool_call_id: "a".into(),
                    phase: AgentToolCallPhase::End,
                    tool_name: "Bash".into(),
                    title: Some("run a".into()),
                    failed: true,
                },
            ]
        );

        assert_eq!(tool_calls.record(start("a"), &mut next_seq), None);
        assert_eq!(next_seq, 2, "a dropped start consumes no seq");
        assert_eq!(tool_calls.record(start("b"), &mut next_seq), Some(3));
        assert_eq!(seqs(&tool_calls, None), [1, 2, 3]);
    }

    #[test]
    fn an_end_whose_start_was_evicted_is_recorded_after_a_start_made_from_it() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        tool_calls.record(start("a"), &mut next_seq);
        for index in 0..MAX_AGENT_TOOL_CALL_EVENTS {
            tool_calls.record(start(&index.to_string()), &mut next_seq);
        }
        let seq_before_end = next_seq;
        let first_seq = seq_before_end - MAX_AGENT_TOOL_CALL_EVENTS as u64 + 1;
        assert_eq!(seqs(&tool_calls, None).first(), Some(&first_seq));

        assert_eq!(
            tool_calls.record(end("a"), &mut next_seq),
            Some(seq_before_end + 2)
        );

        assert_eq!(next_seq, seq_before_end + 2);
        let events: Vec<&AgentToolCallEvent> = tool_calls.after(None).collect();
        assert_eq!(events.len(), MAX_AGENT_TOOL_CALL_EVENTS);
        assert_eq!(events[0].seq, first_seq + 2, "two events evict two");
        let last_two: Vec<(&str, AgentToolCallPhase, u64)> = events[events.len() - 2..]
            .iter()
            .map(|event| (event.tool_call_id.as_str(), event.phase, event.seq))
            .collect();
        assert_eq!(
            last_two,
            [
                ("a", AgentToolCallPhase::Start, seq_before_end + 1),
                ("a", AgentToolCallPhase::End, seq_before_end + 2),
            ]
        );
        assert_eq!(tool_calls.latest_seq(), Some(seq_before_end + 2));
    }

    #[test]
    fn only_end_events_keep_the_failed_flag() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        let mut failed_start = start("a");
        failed_start.failed = true;

        tool_calls.record(failed_start, &mut next_seq);

        assert!(!tool_calls.after(None).next().unwrap().failed);
    }

    #[test]
    fn events_without_an_id_or_tool_name_are_not_recorded() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        let mut no_name = start("a");
        no_name.tool_name = String::new();

        assert_eq!(tool_calls.record(start(""), &mut next_seq), None);
        assert_eq!(tool_calls.record(no_name, &mut next_seq), None);
        assert_eq!(next_seq, 0);
        assert_eq!(tool_calls.latest_seq(), None);
    }

    #[test]
    fn keeps_the_latest_events_and_filters_after_a_seq() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        for index in 0..MAX_AGENT_TOOL_CALL_EVENTS + 2 {
            tool_calls.record(start(&index.to_string()), &mut next_seq);
        }

        let all = seqs(&tool_calls, None);
        assert_eq!(all.len(), MAX_AGENT_TOOL_CALL_EVENTS);
        assert_eq!(all.first(), Some(&3));
        assert_eq!(tool_calls.latest_seq(), Some(next_seq));
        assert_eq!(
            seqs(&tool_calls, Some(next_seq - 2)),
            [next_seq - 1, next_seq]
        );
        assert!(seqs(&tool_calls, Some(next_seq)).is_empty());
        assert_eq!(seqs(&tool_calls, Some(0)).len(), MAX_AGENT_TOOL_CALL_EVENTS);
    }

    #[test]
    fn caps_text_fields_at_a_character_boundary_and_drops_empty_titles() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        let long = "界".repeat(MAX_AGENT_TOOL_CALL_TEXT_CHARS + 10);
        let mut long_report = start(&long);
        long_report.tool_name = long.clone();
        long_report.title = Some(long.clone());
        let mut untitled = start("b");
        untitled.title = Some(String::new());

        tool_calls.record(long_report, &mut next_seq);
        tool_calls.record(untitled, &mut next_seq);

        let events: Vec<&AgentToolCallEvent> = tool_calls.after(None).collect();
        let capped = "界".repeat(MAX_AGENT_TOOL_CALL_TEXT_CHARS);
        assert_eq!(events[0].tool_call_id, capped);
        assert_eq!(events[0].tool_name, capped);
        assert_eq!(events[0].title.as_deref(), Some(capped.as_str()));
        assert_eq!(events[1].title, None);
    }

    #[test]
    fn a_capped_start_is_still_paired_with_its_capped_end() {
        let long = "x".repeat(MAX_AGENT_TOOL_CALL_TEXT_CHARS + 1);

        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        tool_calls.record(start(&long), &mut next_seq);
        assert_eq!(tool_calls.record(end(&long), &mut next_seq), Some(2));
        assert_eq!(seqs(&tool_calls, None), [1, 2], "the end finds its start");

        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        tool_calls.record(end(&long), &mut next_seq);
        assert_eq!(tool_calls.record(start(&long), &mut next_seq), None);
    }

    #[test]
    fn clear_drops_every_event() {
        let mut tool_calls = AgentToolCalls::default();
        let mut next_seq = 0;
        tool_calls.record(start("a"), &mut next_seq);

        tool_calls.clear();

        assert_eq!(tool_calls.latest_seq(), None);
        assert_eq!(tool_calls.after(None).count(), 0);
    }
}
