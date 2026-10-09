pub mod agent_replies;
pub mod agent_requests;
pub mod agent_tool_calls;
mod history_read;
mod id;
mod runtime;
mod runtime_registry;
pub mod state;
mod title;

pub(crate) use history_read::{merge_scrolled_up, snapshot_text, ScreenSnapshot, UpwardMerge};
pub use id::TerminalId;
pub use runtime::TerminalRuntime;
pub(crate) use runtime_registry::TerminalRuntimeRegistry;
pub use state::{
    AgentMetadataReport, EffectivePresentation, EffectiveStateChange, TerminalState,
    TerminalStateMutation,
};
pub(crate) use title::stripped_terminal_title;

/// Truncates `text` to at most `max_bytes` at a UTF-8 character boundary,
/// returning whether anything was cut.
fn truncate_to_char_boundary(text: &mut String, max_bytes: usize) -> bool {
    if text.len() <= max_bytes {
        return false;
    }
    let end = text.floor_char_boundary(max_bytes);
    text.truncate(end);
    true
}
