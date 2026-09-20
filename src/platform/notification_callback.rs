//! Owner-only Unix IPC for one originating client, independent of server sockets.
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use super::NotificationActivation;
const MAX_REQUEST: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(750);

pub(crate) struct NotificationCallbackListener {
    directory: PathBuf,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl NotificationCallbackListener {
    pub(crate) fn path(&self) -> PathBuf {
        self.directory.join("callback.sock")
    }
}

impl Drop for NotificationCallbackListener {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = UnixStream::connect(self.path()); // wake the idle blocking accept
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = std::fs::remove_file(self.path());
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub(crate) fn start_notification_callback_listener(
    deliver: impl Fn(NotificationActivation) -> Result<(), String> + Send + 'static,
) -> io::Result<Option<NotificationCallbackListener>> {
    let mut random = [0_u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    // A short path also fits Darwin's small sockaddr_un.sun_path.
    let directory = PathBuf::from("/tmp").join(format!("herdr-notify-{suffix}"));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let mut handle = NotificationCallbackListener {
        directory,
        stopped: stopped.clone(),
        worker: None,
    };
    let listener = UnixListener::bind(handle.path())?;
    std::fs::set_permissions(handle.path(), std::fs::Permissions::from_mode(0o600))?;
    handle.worker = Some(
        std::thread::Builder::new()
            .name("notification-callback".into())
            .spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if stopped.load(Ordering::Acquire) {
                                break;
                            }
                            let result = read_request(&mut stream)
                                .and_then(|request| deliver(request).map_err(io::Error::other));
                            let response = match result {
                                Ok(()) => "queued\n".to_owned(),
                                Err(error) => format!("error: {error}\n"),
                            };
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(error) => {
                            tracing::warn!(%error, "notification callback listener failed");
                            break;
                        }
                    }
                }
            })?,
    );
    Ok(Some(handle))
}

fn read_request(stream: &mut UnixStream) -> io::Result<NotificationActivation> {
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "notification callback timed out",
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete notification callback",
                ))
            }
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > MAX_REQUEST {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "notification callback too large",
                    ));
                }
                if bytes.contains(&b'\n') {
                    return serde_json::from_slice(&bytes)
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(error),
        }
    }
}

fn validate_owner_path(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("callback path has no parent"))?;
    let directory = std::fs::symlink_metadata(parent)?;
    let socket = std::fs::symlink_metadata(path)?;
    use std::os::unix::fs::FileTypeExt;
    let uid = unsafe { libc::geteuid() };
    if !path.is_absolute()
        || !directory.is_dir()
        || !socket.file_type().is_socket()
        || directory.uid() != uid
        || socket.uid() != uid
        || directory.mode() & 0o077 != 0
        || socket.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "notification callback is not owner-only",
        ));
    }
    Ok(())
}

pub(crate) fn send_notification_callback(
    path: &Path,
    request: &NotificationActivation,
) -> io::Result<()> {
    validate_owner_path(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("originating Herdr client unavailable: {error}"),
        )
    })?;
    let mut bytes = serde_json::to_vec(request).map_err(io::Error::other)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REQUEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "notification callback too large",
        ));
    }
    let mut stream = UnixStream::connect(path)?;
    stream.set_write_timeout(Some(REQUEST_TIMEOUT))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(&bytes)?;
    let mut response = String::new();
    stream.take(1024).read_to_string(&mut response)?;
    if response == "queued\n" {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "notification callback rejected: {}",
            response.trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> NotificationActivation {
        NotificationActivation {
            target: crate::api::schema::NotificationTarget {
                machine_endpoint_id: Some("local".into()),
                workspace_id: None,
                tab_id: None,
                pane_id: Some("pane_1".into()),
            },
            boot_id: Some("boot".into()),
        }
    }
    #[test]
    fn callback_is_private_isolated_acknowledged_and_cleaned_up() {
        let (tx, rx) = std::sync::mpsc::channel();
        let first = start_notification_callback_listener(move |value| {
            tx.send(value).map_err(|e| e.to_string())
        })
        .unwrap()
        .unwrap();
        let second = start_notification_callback_listener(|_| Err("wrong client".into()))
            .unwrap()
            .unwrap();
        let path = first.path();
        assert_ne!(path, second.path());
        assert_eq!(
            std::fs::metadata(&first.directory).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        send_notification_callback(&path, &request()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), request());
        assert!(send_notification_callback(&second.path(), &request()).is_err());
        drop(first);
        assert!(!path.exists());
        assert!(send_notification_callback(&path, &request()).is_err());
        assert!(second.path().exists());
    }
    #[test]
    fn callback_rejects_malformed_oversized_and_slow_requests_and_recovers() {
        let listener = start_notification_callback_listener(|_| Ok(()))
            .unwrap()
            .unwrap();
        for payload in [
            b"not json\n".to_vec(),
            vec![b'x'; MAX_REQUEST + 1],
            b"{".to_vec(),
        ] {
            let mut stream = UnixStream::connect(listener.path()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let _ = stream.write_all(&payload);
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            assert!(response.starts_with("error:"), "{response}");
        }
        send_notification_callback(&listener.path(), &request()).unwrap();
        std::fs::set_permissions(listener.path(), std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(send_notification_callback(&listener.path(), &request()).is_err());
    }
}
