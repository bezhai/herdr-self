//! The API connection of a hook waiting in `pane.report_agent_request`.
//!
//! The connection hands the report to the app and then only waits: the app
//! decides the request's outcome and sends it back, while this side watches
//! for the hook going away. [`crate::api::end_connection_wait`] settles the
//! race between the two.

use std::sync::atomic::AtomicBool;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;

use crate::api::schema::{Method, PaneReportAgentRequestParams, Request};
use crate::api::server::{
    error_response_json, should_stop_connection, APP_RESPONSE_TIMEOUT, CONNECTION_POLL_INTERVAL,
};
use crate::api::{ApiRequestMessage, ApiRequestSender};
use crate::ipc::LocalStream;

/// Waits for the outcome of a reported agent request. Returns `None` when the
/// hook disconnected or the server stopped before an outcome was delivered.
pub(super) fn wait_for_agent_request(
    request_id: String,
    params: PaneReportAgentRequestParams,
    stream: &mut LocalStream,
    api_tx: &ApiRequestSender,
    running: &Arc<AtomicBool>,
) -> std::io::Result<Option<String>> {
    let waiting = Arc::new(AtomicBool::new(true));
    let (respond_to, response_rx) = std::sync::mpsc::channel();
    if let Err(err) = api_tx.send(ApiRequestMessage {
        request: Request {
            id: request_id.clone(),
            method: Method::PaneReportAgentRequest(params),
        },
        respond_to,
        response_write_complete: None,
        stream_active: Some(Arc::clone(&waiting)),
    }) {
        return Ok(Some(error_response_json(
            request_id,
            "server_unavailable",
            format!("failed to dispatch request: {err}"),
        )));
    }

    loop {
        match response_rx.recv_timeout(CONNECTION_POLL_INTERVAL) {
            Ok(response) => return Ok(Some(response)),
            Err(RecvTimeoutError::Disconnected) => {
                return Ok(Some(error_response_json(
                    request_id,
                    "server_unavailable",
                    "request handling failed: app response channel closed".into(),
                )));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if should_stop_connection(stream, running)? {
            if crate::api::end_connection_wait(&waiting) {
                return Ok(None);
            }
            // The app ended the wait first and is sending the outcome.
            return Ok(response_rx.recv_timeout(APP_RESPONSE_TIMEOUT).ok());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use super::*;
    use crate::api::schema::{
        AgentRequestContent, AgentRequestDecision, AgentRequestKind, ErrorResponse,
        PaneReportAgentRequestParams,
    };
    use crate::api::ApiRequestMessage;
    use crate::ipc::LocalStream;

    fn local_stream_pair(name: &str) -> (LocalStream, LocalStream, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("herdr-{name}-{}-{nanos}", std::process::id()));
        let listener = crate::ipc::bind_local_listener(&path).unwrap();
        let client = crate::ipc::connect_local_stream(&path).unwrap();
        let server = interprocess::local_socket::traits::Listener::accept(&listener).unwrap();
        (client, server, path)
    }

    fn params() -> PaneReportAgentRequestParams {
        PaneReportAgentRequestParams {
            pane_id: "w1:p1".into(),
            source: "herdr:claude".into(),
            agent: "claude".into(),
            agent_session_id: None,
            request: AgentRequestContent {
                kind: AgentRequestKind::Permission,
                tool_name: "Bash".into(),
                description: None,
                input_preview: "ls".into(),
                decisions: vec![AgentRequestDecision::Allow],
                questions: Vec::new(),
            },
            timeout_ms: None,
        }
    }

    const ANSWERED: &str = r#"{"id":"hook","result":{"type":"agent_request_answered","request_id":1,"decision":"allow"}}"#;

    /// Runs the wait on its own thread, as a connection thread would.
    fn spawn_wait(
        server: LocalStream,
        api_tx: crate::api::ApiRequestSender,
        running: Arc<AtomicBool>,
    ) -> std::sync::mpsc::Receiver<std::io::Result<Option<String>>> {
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut server = server;
            let result =
                wait_for_agent_request("hook".into(), params(), &mut server, &api_tx, &running);
            done_tx.send(result).unwrap();
        });
        done_rx
    }

    fn receive_report(
        api_rx: &mut mpsc::UnboundedReceiver<ApiRequestMessage>,
    ) -> (std::sync::mpsc::Sender<String>, Arc<AtomicBool>) {
        let message = api_rx.blocking_recv().unwrap();
        assert_eq!(message.request.id, "hook");
        assert_eq!(
            message.request.method,
            Method::PaneReportAgentRequest(params())
        );
        let waiting = message.stream_active.unwrap();
        assert!(waiting.load(Ordering::Acquire));
        (message.respond_to, waiting)
    }

    #[test]
    fn returns_the_outcome_the_app_delivers() {
        let (api_tx, mut api_rx) = mpsc::unbounded_channel();
        let (_client, server, path) = local_stream_pair("agent-request-answered");
        let done = spawn_wait(server, api_tx, Arc::new(AtomicBool::new(true)));

        let (respond_to, waiting) = receive_report(&mut api_rx);
        std::thread::sleep(Duration::from_millis(250));
        assert!(done.try_recv().is_err(), "the hook waits for an outcome");
        assert!(crate::api::end_connection_wait(&waiting));
        respond_to.send(ANSWERED.into()).unwrap();

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(response.as_deref(), Some(ANSWERED));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stops_waiting_when_the_hook_disconnects() {
        let (api_tx, mut api_rx) = mpsc::unbounded_channel();
        let (client, server, path) = local_stream_pair("agent-request-disconnect");
        let done = spawn_wait(server, api_tx, Arc::new(AtomicBool::new(true)));
        let (_respond_to, waiting) = receive_report(&mut api_rx);

        drop(client);

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(response, None);
        assert!(
            !crate::api::end_connection_wait(&waiting),
            "the connection already ended the wait"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stops_waiting_when_the_server_stops() {
        let (api_tx, mut api_rx) = mpsc::unbounded_channel();
        let (_client, server, path) = local_stream_pair("agent-request-server-stop");
        let running = Arc::new(AtomicBool::new(true));
        let done = spawn_wait(server, api_tx, Arc::clone(&running));
        let (_respond_to, waiting) = receive_report(&mut api_rx);

        running.store(false, Ordering::Relaxed);

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(response, None);
        assert!(!waiting.load(Ordering::Acquire));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn keeps_an_outcome_the_app_claimed_before_the_hook_disconnected() {
        let (api_tx, mut api_rx) = mpsc::unbounded_channel();
        let (client, server, path) = local_stream_pair("agent-request-claimed");
        let done = spawn_wait(server, api_tx, Arc::new(AtomicBool::new(true)));
        let (respond_to, waiting) = receive_report(&mut api_rx);

        assert!(crate::api::end_connection_wait(&waiting));
        drop(client);
        std::thread::sleep(Duration::from_millis(300));
        respond_to.send(ANSWERED.into()).unwrap();

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(response.as_deref(), Some(ANSWERED));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reports_an_unavailable_server() {
        let (api_tx, api_rx) = mpsc::unbounded_channel();
        drop(api_rx);
        let (_client, server, path) = local_stream_pair("agent-request-no-app");
        let done = spawn_wait(server, api_tx, Arc::new(AtomicBool::new(true)));

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let error: ErrorResponse = serde_json::from_str(&response.unwrap()).unwrap();
        assert_eq!(error.id, "hook");
        assert_eq!(error.error.code, "server_unavailable");
        std::fs::remove_file(path).unwrap();

        let (api_tx, mut api_rx) = mpsc::unbounded_channel();
        let (_client, server, path) = local_stream_pair("agent-request-app-gone");
        let done = spawn_wait(server, api_tx, Arc::new(AtomicBool::new(true)));
        let (respond_to, _waiting) = receive_report(&mut api_rx);
        drop(respond_to);

        let response = done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        let error: ErrorResponse = serde_json::from_str(&response.unwrap()).unwrap();
        assert_eq!(error.error.code, "server_unavailable");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_api_server_answers_the_report_on_the_same_connection() {
        let (api_tx, mut api_rx) = mpsc::unbounded_channel::<ApiRequestMessage>();
        let (mut client, server, path) = local_stream_pair("agent-request-route");
        let request = serde_json::json!({
            "id": "hook",
            "method": "pane.report_agent_request",
            "params": serde_json::to_value(params()).unwrap(),
        });
        writeln!(client, "{request}").unwrap();
        client.flush().unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let connection = std::thread::spawn(move || {
            crate::api::server::handle_connection(
                server,
                &api_tx,
                &crate::api::EventHub::default(),
                &running,
                None,
            )
        });

        let (respond_to, waiting) = receive_report(&mut api_rx);
        assert!(crate::api::end_connection_wait(&waiting));
        respond_to.send(ANSWERED.into()).unwrap();

        let mut line = String::new();
        BufReader::new(&mut client).read_line(&mut line).unwrap();
        assert_eq!(line.trim_end(), ANSWERED);
        connection.join().unwrap().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
