//! Embedded, per-user LSUIElement sender. No runtime compiler or third-party notifier.
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::platform::NotificationCallback;
const EXECUTABLE: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/Herdr.app/Contents/MacOS/herdr-notifications"
));
const PLIST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/Herdr.app/Contents/Info.plist"));
const RESOURCES: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/Herdr.app/Contents/_CodeSignature/CodeResources"
));

fn private_directory(path: &Path) -> io::Result<()> {
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path)?;
            if !metadata.is_dir()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o077 != 0
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "notification directory is not owner-only",
                ));
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn write_asset(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn asset_matches(path: &Path, bytes: &[u8]) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() })
        && std::fs::read(path).is_ok_and(|actual| actual == bytes)
}

fn install_in(root: &Path) -> io::Result<PathBuf> {
    private_directory(root)?;
    let mut digest = Sha256::new();
    digest.update(EXECUTABLE);
    digest.update(PLIST);
    digest.update(RESOURCES);
    let version = format!("{:x}", digest.finalize());
    let destination = root.join(&version);
    let app = destination.join("Herdr.app");
    if destination.exists() {
        private_directory(&destination)?;
        if asset_matches(&app.join("Contents/MacOS/herdr-notifications"), EXECUTABLE)
            && asset_matches(&app.join("Contents/Info.plist"), PLIST)
            && asset_matches(
                &app.join("Contents/_CodeSignature/CodeResources"),
                RESOURCES,
            )
        {
            return Ok(app);
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "installed Herdr.app does not match embedded assets",
        ));
    }
    let staging = root.join(format!(
        ".install-{}-{}",
        std::process::id(),
        super::unique_timestamp_nanos()
    ));
    private_directory(&staging)?;
    let result = (|| {
        let contents = staging.join("Herdr.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS"))?;
        std::fs::create_dir_all(contents.join("_CodeSignature"))?;
        write_asset(
            &contents.join("MacOS/herdr-notifications"),
            EXECUTABLE,
            0o700,
        )?;
        write_asset(&contents.join("Info.plist"), PLIST, 0o600)?;
        write_asset(
            &contents.join("_CodeSignature/CodeResources"),
            RESOURCES,
            0o600,
        )?;
        match std::fs::rename(&staging, &destination) {
            Ok(()) => Ok(app),
            Err(_) if destination.exists() => install_in(root),
            Err(error) => Err(error),
        }
    })();
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn installation_root() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME unavailable"))?;
    let support = PathBuf::from(home).join("Library/Application Support");
    std::fs::create_dir_all(&support)?;
    let root = support.join("Herdr Notifications");
    private_directory(&root)?;
    Ok(root)
}

pub(super) fn show(
    title: &str,
    body: Option<&str>,
    callback: Option<&NotificationCallback>,
) -> io::Result<bool> {
    let root = installation_root()?;
    let app = install_in(&root)?;
    let requests = root.join("requests");
    private_directory(&requests)?;
    // Clean abandoned open-file requests after failed or interrupted desktop launches.
    if let Ok(entries) = std::fs::read_dir(&requests) {
        for entry in entries.flatten() {
            if entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let executable = std::env::current_exe()?;
    let mut request = serde_json::json!({
        "title": title, "body": body.unwrap_or_default(),
        "executable": executable,
        "socket": callback.map(|callback| &callback.socket),
        "activation": callback.map(|callback| serde_json::to_string(&callback.activation)).transpose().map_err(io::Error::other)?,
        "terminal_bundle": super::detected_terminal_bundle_identifier(),
    });
    if let Some(fields) = request.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    let bytes = serde_json::to_vec(&request).map_err(io::Error::other)?;
    if bytes.len() > 65536 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "notification request too large",
        ));
    }
    let path = requests.join(format!(
        "{}-{}.json",
        std::process::id(),
        super::unique_timestamp_nanos()
    ));
    write_asset(&path, &bytes, 0o600)?;
    let mut command = std::process::Command::new("/usr/bin/open");
    command.arg("-g").arg("-a").arg(app).arg(&path);
    let result = super::run_notification_command(command);
    if !matches!(result, Ok(true)) {
        let _ = std::fs::remove_file(&path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn embedded_bundle_installs_idempotently_and_rejects_tampering() {
        let root = std::env::temp_dir().join(format!(
            "herdr-native-test-{}-{}",
            std::process::id(),
            super::super::unique_timestamp_nanos()
        ));
        let app = install_in(&root).unwrap();
        assert_eq!(install_in(&root).unwrap(), app);
        let status = std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(&app)
            .status()
            .unwrap();
        assert!(status.success());
        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap();
        assert!(plist.contains("dev.herdr.notifications"));
        assert!(plist.contains("<key>LSUIElement</key><true/>"));
        std::fs::write(app.join("Contents/Info.plist"), "tampered").unwrap();
        assert!(install_in(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_private_directory_rejects_symlinks_and_shared_permissions() {
        let root = std::env::temp_dir().join(format!(
            "herdr-private-test-{}-{}",
            std::process::id(),
            super::super::unique_timestamp_nanos()
        ));
        private_directory(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_directory(&root).is_err());
        let link = root.with_extension("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert!(private_directory(&link).is_err());
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
