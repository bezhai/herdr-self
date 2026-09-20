# macOS notifications: identity and navigation

## Findings and boundaries

The working branch is `mac-native-notifications`. This is a custom fork; no push,
PR, release, or unrelated branch integration is part of this work.

`HeadlessServer::forward_semantic_agent_transition` in
`src/server/headless/notifications.rs` generates attention/completion events.
It already knows and fills public workspace, tab and pane IDs. It does **not**
know a client's saved SSH profile ID: two clients can name the same server
differently. `client/mod.rs` receives each event with its authenticated connection's
`ClientEndpointId`. The coordinates are currently lost when notification policy
creates a System effect containing only title/body.

`herdr-client.sock` is owned by the **server**, accepting binary TUI attachment
handshakes, not JSON commands for a running client. Sending a fake attach would
affect foreground-client and geometry state. Use a separate, per-client callback
socket; final pane focus still uses the existing shared server API. A callback
must identify the originating client, not an arbitrary client attached elsewhere.

`ServerMessage`, `Notify`, and `SemanticNotification` are frozen generation-1
bincode contracts. Adding even optional fields breaks that contract. Keep their
bytes, tags and fixtures unchanged. Read-only design roundtable confirmed these
constraints and the existing endpoint activation/rollback path.

## Protocol and client design

Introduce JSON `NotificationTarget` with optional `machine_endpoint_id`,
`workspace_id`, `tab_id`, `pane_id`. Negotiate an optional targeted-notification
codec in endpoint hello. New servers send a named `EndpointControl` JSON envelope
with event and optional target only to opted-in clients; other clients receive
the exact legacy semantic notification. New clients also accept old servers.

Server targets contain all server-known public IDs. The receiving client binds
the machine ID to the actual source connection (`local` or `ssh:<saved-profile-id>`),
never trusting a remote server to name a different endpoint. System title includes
the agent event and endpoint display name. Target travels through delayed
notification policy into the system effect. Terminal toast and sound stay intact.

Keep ordinary `notification.show` working. Optional JSON target is additive;
advertise a separate targeted method for callers that require target support, so
an old server cannot silently ignore a required target and claim success.

Callback payloads contain only data. A per-client, owner-only Unix socket in a
private directory identifies the originating TUI instance. Bound request size,
read timeout, acknowledgement, cleanup and unknown endpoint rejection are required.
Use the existing `ActivateEndpoint` transaction and most-specific pane/tab/workspace
focus; do not mutate shell identity or bypass surface-interest negotiation.
Callbacks carry a server boot ID when available, preventing old notifications
from focusing a reused public pane ID after server restart.

## Native sender selection

Use a tiny Objective-C AppKit/UserNotifications application built with the Apple
SDK, embedded in the macOS Rust executable and installed per user as `Herdr.app`.
Its stable bundle ID is `dev.herdr.notifications`, display name `Herdr`, and it is
an LSUIElement app. No brew, runtime Swift compiler, new Rust crate, AppleScript
notification, or impersonation of another application's bundle is needed.

Build the helper for the Rust target architecture. AppKit's open-file delegate
accepts private JSON requests through LaunchServices, including when already
running. `UNUserNotificationCenter` requests permission and schedules notifications;
its response delegate launches the exact originating herdr executable with a
hidden callback command and structured arguments (no shell interpretation).
The helper remains available to receive clicks; LaunchServices cold launch must
be checked manually. Notification delivery is asynchronous: successful scheduling
does not establish that Focus settings allowed a visible banner.

The existing terminal-notifier can remain a fallback for native installation or
launch failure, using a safely quoted `-execute` callback. Do not use `-sender`
spoofing: upstream documents incompatibility with click actions. Remove the
osascript notification fallback that labels notifications Script Editor.

Sources inspected:
- Apple notification center and delegate contracts:
  https://developer.apple.com/documentation/usernotifications/unusernotificationcenter
  https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate
- terminal-notifier bundle/click behavior:
  https://github.com/julienXX/terminal-notifier

## Click sequence and absent-client behavior

1. Server emits semantic event with public coordinates.
2. Client binds endpoint identity/boot ID, applies notification policy, and sends
   title/body plus callback data to the native helper.
3. User clicks; helper starts the original herdr executable in callback mode.
4. Callback connects only to its originating TUI's socket; listener queues the
   request; the UI loop validates endpoint/boot identity and requests activation.
5. Existing navigation switches endpoint, requests its surface and focuses the
   most-specific public target. Missing/offline targets produce a client-local
   notice without disconnecting other machines. Activate the host terminal.
6. If the originating client has exited, return a clear unavailable error. A new
   process launched by Notification Center has no terminal/PTY; bare `herdr`
   cannot create a usable TUI there. Opening arbitrary terminal tabs would require
   terminal-specific scripting and could select the wrong saved-machine catalog
   or session. For this iteration, bringing the known terminal forward is the
   best effort; do not spawn a detached, invisible TUI or reroute to another client.

## Risk and verification plan

This touches protocol, client input projection and native lifecycle, so it is
release-risk. Preserve frozen wire tests, existing notification policy tests,
endpoint activation/rollback tests, and add characterization of new JSON
negotiation, legacy fallback, source binding, absent/unknown targets, stale boot
IDs, callback framing and hostile text. No per-byte, pane-layout or render-loop
work is added. Notification IPC runs off the render thread.

Use repository `just` recipes when available and run requested `cargo build` and
`cargo test` with the lockfile. Initial offline build cannot resolve `bincode`;
the repository pins Rust 1.96.1 (not the PATH Rust 1.86). Do not change dependency
versions to work around unavailable cache/network. Record exact results below.

Manual macOS checks (use an isolated test session, never stop a real session):
1. Build this branch; launch its binary in a terminal with system notification
   delivery selected and delay zero. Permit notifications for Herdr when asked.
2. In a background pane start an agent and ask it to perform an operation that
   requires its normal approval. Verify blocked/needs-attention state with
   `herdr agent get <agent>` and detection evidence with
   `herdr agent read <agent> --source detection --format text`.
3. Verify banner sender is Herdr with terminal-notifier absent from PATH. Title
   identifies agent and machine. Click: correct workspace, tab and pane focused.
4. Repeat with completion, with delayed notifications, and with terminal toast
   and sound separately. Already-visible/seen completions retain their policy.
5. Connect two saved SSH machines with colliding pane IDs. Trigger a notification
   on B while viewing A, click, and verify B alone is focused. Repeat while an
   endpoint switch is in progress, and with another TUI attached simultaneously.
6. Delete target pane, disconnect machine, restart server, and exit originating
   TUI in separate trials before clicking. No fallback to an unrelated pane or
   machine; show/log an unavailable outcome. Reopen the client manually if absent.
7. Test notification click after closing the helper process, permission denial,
   notifications disabled in System Settings, and helper upgrade/relaunch.
8. Ordinary plugin `notification.show` still displays title/body, position and
   sound. Targeted method focuses its supplied pane; legacy server/client pairs
   continue displaying a single notification without protocol disconnection.

## Implementation and validation record

Pending implementation. GUI notification delivery/cold-start permission behavior
must be reviewed on an interactive macOS desktop; unit tests cannot certify it.
