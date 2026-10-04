#[cfg(unix)]
use serde::{Deserialize, Serialize};

/// Long-lived pane runtime transferred during server replacement.
///
/// Handoff preserves server-owned session state such as PTYs, processes, agent
/// identity, and durable plugin/session metadata. It intentionally does not
/// preserve transient coordination such as in-flight requests, waits,
/// subscriptions, client sockets, or pane-to-pane messages; clients reconnect
/// and retry those operations after replacement.
#[cfg(unix)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HandoffRuntimeState {
    pub pane_id: u32,
    pub child_pid: u32,
    pub rows: u16,
    pub cols: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
    #[serde(default)]
    pub keyboard_protocol_flags: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard_protocol_ansi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_state: Option<crate::pane::InputState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_history_ansi: Option<String>,
    /// Requests of the pane's agent wait for remote answers. The agent keeps
    /// running across the handoff, and the client that turned this on is not
    /// told that the server changed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remote_answers: bool,
}

#[cfg(unix)]
impl HandoffRuntimeState {
    pub fn with_pane_id(mut self, pane_id: crate::layout::PaneId) -> Self {
        self.pane_id = pane_id.raw();
        self
    }
}

#[derive(Debug)]
pub(crate) struct ImportedHandoffRuntime {
    #[cfg(unix)]
    pub master_fd: std::os::fd::RawFd,
    #[cfg(unix)]
    pub state: HandoffRuntimeState,
}

impl ImportedHandoffRuntime {
    /// Whether the pane's agent waited for remote answers on the old server.
    pub fn remote_answers(&self) -> bool {
        #[cfg(unix)]
        {
            self.state.remote_answers
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::HandoffRuntimeState;

    #[test]
    fn remote_answers_cross_a_handoff_only_when_on() {
        let older: HandoffRuntimeState = serde_json::from_value(serde_json::json!({
            "pane_id": 1,
            "child_pid": 42,
            "rows": 24,
            "cols": 80,
            "cell_width_px": 8,
            "cell_height_px": 16,
        }))
        .unwrap();
        assert!(
            !older.remote_answers,
            "panes from a server without the field load as off"
        );
        assert!(serde_json::to_value(&older)
            .unwrap()
            .get("remote_answers")
            .is_none());

        let on = HandoffRuntimeState {
            remote_answers: true,
            ..older
        };
        let json = serde_json::to_value(&on).unwrap();
        assert_eq!(json["remote_answers"], true);
        let restored: HandoffRuntimeState = serde_json::from_value(json).unwrap();
        assert!(restored.remote_answers);
    }
}
