//! Build-time Apple SDK operations live alongside their platform implementation.
use std::{env, fs, path::Path, process::Command};

pub fn build(target: &str, out: &Path) {
    if !target.ends_with("apple-darwin") {
        return;
    }
    let arch = match target {
        "aarch64-apple-darwin" => "arm64",
        "x86_64-apple-darwin" => "x86_64",
        other => panic!("unsupported macOS notification target: {other}"),
    };
    let source = Path::new("src/platform/macos/notifications.m");
    let plist = Path::new("src/platform/macos/Info.plist");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", plist.display());
    let app = out.join("Herdr.app");
    let contents = app.join("Contents");
    let executable = contents.join("MacOS/herdr-notifications");
    fs::create_dir_all(executable.parent().expect("helper directory"))
        .expect("create helper bundle");
    fs::copy(plist, contents.join("Info.plist")).expect("copy helper Info.plist");
    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.15".into());
    let status = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "clang",
            "-arch",
            arch,
            "-fobjc-arc",
            "-fmodules",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-deprecated-declarations",
        ])
        .arg(format!("-mmacosx-version-min={deployment}"))
        .args(["-framework", "AppKit", "-framework", "UserNotifications"])
        .arg(source)
        .arg("-o")
        .arg(&executable)
        .status()
        .expect("Apple SDK clang is required to embed Herdr.app");
    assert!(status.success(), "native Herdr.app compilation failed");
    let status = Command::new("/usr/bin/codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--identifier",
            "dev.herdr.notifications",
        ])
        .arg(&app)
        .status()
        .expect("codesign is required for Herdr.app");
    assert!(status.success(), "native Herdr.app signing failed");
}
