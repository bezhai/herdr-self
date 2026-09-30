//! Final assistant replies reported by agent integrations.
//!
//! Replies are shared runtime facts kept in memory only; they are not persisted
//! in session snapshots and do not survive a server restart or live handoff.

use std::collections::VecDeque;

/// Number of replies retained per agent terminal.
pub const MAX_AGENT_REPLIES: usize = 8;
/// Largest stored reply text in UTF-8 bytes.
pub const MAX_AGENT_REPLY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReply {
    pub seq: u64,
    pub text: String,
    pub truncated: bool,
}

/// A final reply reported for a pane by an agent integration hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReplyReport {
    pub source: String,
    pub agent_label: String,
    pub seq: Option<u64>,
    pub agent_session_id: Option<String>,
    pub text: String,
    pub truncated: bool,
}

/// The most recent replies of one agent terminal, oldest first.
#[derive(Debug, Clone, Default)]
pub struct AgentReplies {
    replies: VecDeque<AgentReply>,
}

impl AgentReplies {
    pub fn push(&mut self, seq: u64, mut text: String, truncated: bool) {
        let truncated = truncate_to_char_boundary(&mut text, MAX_AGENT_REPLY_BYTES) || truncated;
        if self.replies.len() == MAX_AGENT_REPLIES {
            self.replies.pop_front();
        }
        self.replies.push_back(AgentReply {
            seq,
            text,
            truncated,
        });
    }

    pub fn latest_seq(&self) -> Option<u64> {
        self.replies.back().map(|reply| reply.seq)
    }

    /// Retained replies with a seq greater than `after_seq`, or all of them.
    pub fn after(&self, after_seq: Option<u64>) -> impl Iterator<Item = &AgentReply> {
        self.replies
            .iter()
            .filter(move |reply| after_seq.is_none_or(|after_seq| reply.seq > after_seq))
    }

    pub fn clear(&mut self) {
        self.replies.clear();
    }
}

/// Truncates `text` to at most `max_bytes`, returning whether anything was cut.
fn truncate_to_char_boundary(text: &mut String, max_bytes: usize) -> bool {
    if text.len() <= max_bytes {
        return false;
    }
    let end = text.floor_char_boundary(max_bytes);
    text.truncate(end);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_latest_replies_in_seq_order() {
        let mut replies = AgentReplies::default();
        assert_eq!(replies.latest_seq(), None);
        assert_eq!(replies.after(None).count(), 0);

        for seq in 1..=(MAX_AGENT_REPLIES as u64 + 2) {
            replies.push(seq, format!("reply {seq}"), false);
        }

        let seqs: Vec<u64> = replies.after(None).map(|reply| reply.seq).collect();
        assert_eq!(seqs, (3..=10).collect::<Vec<_>>());
        assert_eq!(replies.latest_seq(), Some(10));
        assert_eq!(
            replies.after(None).next(),
            Some(&AgentReply {
                seq: 3,
                text: "reply 3".into(),
                truncated: false,
            })
        );
    }

    #[test]
    fn filters_replies_after_a_seq() {
        let mut replies = AgentReplies::default();
        for seq in [4, 7, 9] {
            replies.push(seq, format!("reply {seq}"), false);
        }

        let after = |seq| {
            replies
                .after(Some(seq))
                .map(|reply| reply.seq)
                .collect::<Vec<_>>()
        };
        assert_eq!(after(0), [4, 7, 9]);
        assert_eq!(after(4), [7, 9]);
        assert_eq!(after(8), [9]);
        assert!(after(9).is_empty());
    }

    #[test]
    fn truncates_text_at_a_utf8_character_boundary() {
        let mut replies = AgentReplies::default();
        let text = "界".repeat(MAX_AGENT_REPLY_BYTES);
        replies.push(1, text.clone(), false);
        replies.push(2, "short".into(), true);
        replies.push(3, "a".repeat(MAX_AGENT_REPLY_BYTES), false);

        let stored: Vec<&AgentReply> = replies.after(None).collect();
        assert_eq!(stored[0].text.len(), MAX_AGENT_REPLY_BYTES / 3 * 3);
        assert!(text.starts_with(&stored[0].text));
        assert!(stored[0].truncated);
        assert_eq!(stored[1].text, "short");
        assert!(stored[1].truncated, "a reporter-side truncation is kept");
        assert_eq!(stored[2].text.len(), MAX_AGENT_REPLY_BYTES);
        assert!(!stored[2].truncated);
    }

    #[test]
    fn clear_drops_every_reply() {
        let mut replies = AgentReplies::default();
        replies.push(1, "one".into(), false);

        replies.clear();

        assert_eq!(replies.latest_seq(), None);
        assert_eq!(replies.after(None).count(), 0);
    }
}
