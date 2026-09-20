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

Use repository `just` recipes and run the complete `just check` gate. The
repository pins Rust 1.96.1; prepend `$HOME/.cargo/bin` so the Homebrew Rust 1.86
does not override rustup. Use Zig 0.16.0 and the Windows SDK configured by
`just setup-windows-cross`. Do not change dependency versions or skip checks to
work around unavailable tooling. Record exact results below.

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

Implemented in this branch (validation results are recorded below):

- JSON-only `NotificationTarget` and `notification.targeted.v1`. Hello advertises
  optional `notification_codecs`; welcome selects optional `notification_codec`.
  The server records negotiation per connection and sends exactly one new JSON
  control or original semantic event. Core generation remains 1, private protocol
  remains 22, and frozen `wire.rs` types and generation-1 fixtures are unchanged.
- Ordinary `notification.show` accepts optional target; the separately advertised
  `notification.show_targeted` requires one. Required-target calls reject a server
  with no negotiated client instead of falsely reporting delivery. The new
  method has a separate shape digest; the published fixture is not rewritten.
- Client policy binds machine identity to the actual source connection and keeps
  target/boot identity through delayed effects. System titles include agent event
  and the saved machine label (local hostname for Local).
- Each Unix client owns a random private directory and callback socket (0700 and
  0600). Requests are bounded to 16 KiB and a 750 ms total read deadline. ACK means
  **queued**, not successful focus. A bounded client queue handles callbacks;
  listener shutdown removes only its own socket/directory. Windows and fallback
  reject the hidden callback command while retaining their existing senders.
- Clicks select pane > tab > workspace, reject deleted most-specific targets,
  unknown/offline machines and stale server boots, and enter the existing endpoint
  activation transaction. A click during handoff waits with its original boot ID
  and is revalidated before taking a fresh lease. An invalid click shows a local
  notice without freezing a healthy active presentation.
- Native sources are under `src/platform/macos/`. The build compiles for the Rust
  target architecture and ad-hoc signs an LSUIElement `Herdr.app` with bundle ID
  `dev.herdr.notifications`. Binary, plist and signature resources are embedded.
  At runtime they are verified and installed atomically under a content-addressed
  per-user `~/Library/Application Support/Herdr Notifications/` directory.
  Private JSON request files go through LaunchServices, and UNUserNotificationCenter
  stores structured callback data for subsequent clicks. Delivery process launch
  runs in a bounded background worker, not the render loop.
- No runtime compiler or new Rust dependency. No AppleScript notification fallback
  or bundle spoofing. An installed terminal-notifier is only a fallback for native
  installation/launch failure; its callback arguments are shell quoted. Linux,
  Windows and unsupported-platform senders retain their existing behavior.

Validation completed on 2026-09-20:

- **Full `just check`: PASS, exit 0.** Rust/Nextest: 3,488 passed, 6 ignored by
  the repository's default configuration. Maintenance Python tests: 141 passed;
  hot-path architecture tests: 6 passed. Bun workflow/integration tests: 5 + 18
  + 8 + 13 passed. Windows target Clippy passed. Documentation contracts: 7 passed.
  Frozen generation-1 wire/fixture tests and the separately frozen new-method
  shape digest passed without changing any existing fixture.
- macOS Clippy passes with `-D warnings`. The native Objective-C helper builds for
  arm64 and x86_64 with Apple SDK `-Wall -Wextra -Werror`. The debug Herdr binary
  links successfully (arm64). Tests install the embedded bundle, verify its ad-hoc
  signature with `codesign --verify --strict`, reject tampered files and verify
  private directory permissions.
- Notification tests cover source binding between two saved SSH endpoints with
  colliding pane IDs, delayed effects, old-server defaults, mixed new/old clients,
  required-target rejection and endpoint-method dispatch, stale/absent targets,
  queued clicks across a boot change, non-freezing notices, private callback IPC,
  size/time limits, cleanup, multiple listeners and hostile callback text.
- Direct execution of the built binary's hidden callback command against an absent
  socket returns a readable originating-client-unavailable error without starting
  a TUI or contacting a server.
- Validation tooling: Rust 1.96.1 via rustup, Zig 0.16.0, Bun 1.3.14 (the repository
  CI version), and cargo-nextest. The initial PATH selected Homebrew Rust 1.86;
  the initial Bun 1.2.19 lacked `Bun.YAML`. Both were corrected in the validation
  command environment, without changing dependencies or test scripts. The user
  accepted the Windows SDK license. Zig's host-tool build also needed a local
  SDK overlay: `~/.local/share/herdr/windows-cross/usr` points to the Apple SDK's
  `usr` directory so macOS build tools resolve libSystem while the cross target
  keeps using Microsoft's SDK. No repository cross-build code was changed.
- Full successful invocation (tool downloads are local, outside this repository):

  ```sh
  env PATH="/tmp/herdr-notification-tools/node_modules/.bin:$HOME/.cargo/bin:$PATH" \
    ZIG=/tmp/zig-aarch64-macos-0.16.0/zig just check
  ```

  Log: `/tmp/herdr-notifications-check-final.log`. The user narrowed acceptance to
  personal macOS use; no additional Linux/Windows desktop qualification is claimed.

Interactive desktop validation remains **unverified**. Successful compilation,
ad-hoc signature verification, bundle installation tests and API/IPC unit tests
cannot certify a visible banner, macOS permission UX, or cold-launch response.

Additional manual acceptance details:

- In the macOS trials above, remove terminal-notifier from the test client's PATH
  and verify the sender remains Herdr. Check System Settings > Notifications >
  Herdr and test both permission grant and denial. Inspect Console for `Herdr
  notification` errors when scheduling fails; an API `shown:true` only means the
  event was queued to an eligible client.
- After delivery, terminate only the test helper process, then click the retained
  Notification Center entry. Verify the helper cold-launches, invokes the original
  binary's hidden callback command, and focuses the originating client's target.
- Run two clients and two saved SSH endpoints with colliding pane IDs. Click during
  an existing endpoint switch, then repeat after restarting the notification's
  server while the click waits. The stale click must show a notice, leave the
  healthy active client usable and never select a reused ID.
- Build a second helper revision while the first version is running and still has
  delivered notifications. Verify new requests reach a functional helper and old
  notification clicks still resolve through their stored socket/executable. Same
  bundle-ID selection across content-addressed installs is a LaunchServices
  lifecycle case that still needs desktop verification.
- Exit the originating client and click its retained notification. The callback
  must report unavailable; it must not attach a different client, launch a hidden
  TUI, or create arbitrary terminal tabs. Raising the existing terminal is best
  effort and does not promise exact terminal-window selection.
- Linux/Windows desktop delivery is outside this personal macOS acceptance scope.
  Their existing senders are unchanged; the repository check still contains its
  standard Windows compilation gate.

## Changed files

This implementation touches 41 files; no frozen fixtures, dependency manifests,
release-channel metadata or published documentation are changed.

- `NOTIFICATIONS_PLAN.md`
- `build.rs`
- `docs/next/api/herdr-api.schema.json`
- `docs/next/website/src/content/docs/configuration.mdx`
- `docs/next/website/src/content/docs/ja/configuration.mdx`
- `docs/next/website/src/content/docs/ja/socket-api.mdx`
- `docs/next/website/src/content/docs/socket-api.mdx`
- `docs/next/website/src/content/docs/zh-cn/configuration.mdx`
- `docs/next/website/src/content/docs/zh-cn/socket-api.mdx`
- `src/api/mod.rs`
- `src/api/schema.rs`
- `src/api/schema/common.rs`
- `src/api/schema/tests.rs`
- `src/api/server.rs`
- `src/app/api.rs`
- `src/app/mod.rs`
- `src/cli/notification.rs`
- `src/client/endpoint/control.rs`
- `src/client/events.rs`
- `src/client/handshake.rs`
- `src/client/mod.rs`
- `src/client/notifications.rs`
- `src/client/shell/notification_policy.rs`
- `src/client/shell/state.rs`
- `src/client/shell/tests/endpoints.rs`
- `src/main.rs`
- `src/platform/macos.rs`
- `src/platform/macos/Info.plist`
- `src/platform/macos/build_notifications.rs`
- `src/platform/macos/native_notifications.rs`
- `src/platform/macos/notifications.m`
- `src/platform/mod.rs`
- `src/platform/notification_callback.rs`
- `src/protocol/endpoint.rs`
- `src/server/client_commands.rs`
- `src/server/client_transport.rs`
- `src/server/clients.rs`
- `src/server/headless.rs`
- `src/server/headless/notifications.rs`
- `src/server/headless/tests/mod.rs`
- `src/server/headless/tests/surface_interest.rs`
