use std::io;

use tracing::{debug, warn};

use crate::protocol::NotifyKind;

use super::shell;

pub(super) fn handle_shell_notification_effects(
    effects: Vec<shell::ClientShellNotificationEffect>,
    sound_config: &crate::config::SoundConfig,
    callback_socket: Option<&std::path::Path>,
) {
    for effect in effects {
        match effect {
            shell::ClientShellNotificationEffect::Sound { sound, agent } => {
                let agent = agent.as_deref().and_then(crate::detect::parse_agent_label);
                if sound_config.allows(agent) {
                    crate::sound::play(sound, sound_config);
                }
            }
            shell::ClientShellNotificationEffect::Terminal { title, body } => {
                if let Err(err) = crate::terminal_notify::show_notification(&title, body.as_deref())
                {
                    warn!(err = %err, "failed to emit terminal notification");
                }
            }
            shell::ClientShellNotificationEffect::System {
                title,
                body,
                activation,
            } => {
                let has_target = activation.target.pane_id.is_some()
                    || activation.target.tab_id.is_some()
                    || activation.target.workspace_id.is_some();
                let callback = callback_socket.filter(|_| has_target).map(|socket| {
                    crate::platform::NotificationCallback {
                        socket: socket.to_owned(),
                        activation,
                    }
                });
                crate::platform::queue_desktop_notification(title, body, callback);
            }
        }
    }
}

pub(super) fn handle_notify(
    kind: NotifyKind,
    message: &str,
    body: Option<&str>,
    sound_config: &crate::config::SoundConfig,
) {
    handle_notify_with_notifiers(
        kind,
        message,
        body,
        sound_config,
        crate::terminal_notify::show_notification,
        crate::platform::show_desktop_notification,
    );
}

pub(super) fn handle_notify_with_notifiers(
    kind: NotifyKind,
    message: &str,
    body: Option<&str>,
    sound_config: &crate::config::SoundConfig,
    mut show_terminal_notification: impl FnMut(&str, Option<&str>) -> io::Result<bool>,
    mut show_system_notification: impl FnMut(&str, Option<&str>) -> io::Result<bool>,
) {
    match kind {
        NotifyKind::Sound => {
            let Some(sound) = sound_from_notify_message(message) else {
                warn!(
                    message = message,
                    "received unknown sound notification from server"
                );
                return;
            };
            if sound_config.enabled {
                crate::sound::play(sound, sound_config);
            }
        }
        NotifyKind::Toast => {
            debug!(
                message = message,
                "received terminal toast notification from server"
            );
            if let Err(err) = show_terminal_notification(message, body) {
                warn!(err = %err, "failed to emit terminal notification");
            }
        }
        NotifyKind::SystemToast => {
            debug!(
                message = message,
                "received system toast notification from server"
            );
            if let Err(err) = show_system_notification(message, body) {
                warn!(err = %err, "failed to emit system notification");
            }
        }
    }
}

pub(super) fn sound_from_notify_message(message: &str) -> Option<crate::sound::Sound> {
    match message {
        "agent done" => Some(crate::sound::Sound::Done),
        "agent attention" => Some(crate::sound::Sound::Request),
        _ => None,
    }
}

/// A stale notification is a local notice, not evidence that the active lease failed.
pub(super) fn show_notification_unavailable(state: &mut super::ClientState, message: String) {
    if let Some(shell) = state.shell.as_mut() {
        shell.receive_endpoint_unavailable(message);
        if let Some(frame) = shell.compose(state.reported_size.0, state.reported_size.1) {
            state.present_frame(frame);
        }
    }
}

pub(super) fn prepare_notification_activation(
    state: &mut super::ClientState,
    pending: &mut Option<crate::platform::NotificationActivation>,
    activation: crate::platform::NotificationActivation,
    switching: bool,
) -> Option<(
    super::endpoint::ClientEndpointId,
    shell::ClientEndpointFocusTarget,
)> {
    if switching {
        // Keep the original boot across handoff, then revalidate before obtaining a fresh lease.
        *pending = Some(activation);
        return None;
    }
    let target = state
        .shell
        .as_ref()
        .ok_or_else(|| "notification requires a client shell".to_owned())
        .and_then(|shell| shell.resolve_notification_activation(&activation));
    match target {
        Ok(target) => Some(target),
        Err(message) => {
            show_notification_unavailable(state, message);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_waiting_for_handoff_revalidates_boot_without_freezing_healthy_client() {
        let mut state = super::super::ClientState::test_new();
        let snapshot: crate::protocol::ClientShellSnapshot =
            serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/endpoint-snapshot-v1.json"
            )))
            .unwrap();
        state
            .shell
            .as_mut()
            .unwrap()
            .set_snapshot(Box::new(snapshot.clone()));
        let activation = crate::platform::NotificationActivation {
            target: crate::api::schema::NotificationTarget {
                machine_endpoint_id: Some("local".into()),
                workspace_id: None,
                tab_id: None,
                pane_id: Some("w1:p1".into()),
            },
            boot_id: Some(snapshot.boot_id.clone()),
        };
        let mut pending = None;
        assert!(prepare_notification_activation(
            &mut state,
            &mut pending,
            activation.clone(),
            true
        )
        .is_none());
        assert_eq!(pending.as_ref(), Some(&activation));
        let mut restarted = snapshot;
        restarted.boot_id = "restarted".into();
        state
            .shell
            .as_mut()
            .unwrap()
            .set_snapshot(Box::new(restarted));
        let queued = pending.take().unwrap();
        assert!(prepare_notification_activation(&mut state, &mut pending, queued, false).is_none());
        assert!(!state.presentation_frozen);
        assert!(state
            .shell
            .as_ref()
            .unwrap()
            .endpoint_is_active(&super::super::endpoint::ClientEndpointId::Local));
        // A later valid click can still prepare navigation after the rejected old click.
        let mut current = activation;
        current.boot_id = Some("restarted".into());
        assert!(
            prepare_notification_activation(&mut state, &mut pending, current, false).is_some()
        );
    }
}
