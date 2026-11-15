//! Tiny launcher for the bundled BabelDOC runtime.
//!
//! The portable Windows package ships an embedded Python + BabelDOC
//! site-packages.  This executable is the stable `babeldoc` entry point the
//! Rust core spawns; it forwards every argument to `babeldoc.main.cli()` in the
//! bundled interpreter and mirrors its exit code.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::process::{exit, Command};

fn main() {
    let exe = match env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("无法定位内置 BabelDOC：{err}");
            exit(2);
        }
    };
    let dir = match exe.parent() {
        Some(dir) => dir.to_path_buf(),
        None => {
            eprintln!("无法定位内置 BabelDOC 目录：{}", exe.display());
            exit(2);
        }
    };
    let python = dir
        .join("runtime")
        .join(if cfg!(windows) { "python.exe" } else { "bin/python3" });
    if !python.exists() {
        eprintln!("内置 BabelDOC 运行时缺失：{}", python.display());
        exit(2);
    }
    let script = dir.join("babeldoc_cli.py");
    if !script.exists() {
        eprintln!("内置 BabelDOC 入口缺失：{}", script.display());
        exit(2);
    }
    let mut command = Command::new(&python);
    command
        .arg(&script)
        .args(env::args_os().skip(1))
        .current_dir(&dir)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Keep Python from opening a console window behind the Electron app.
        command.creation_flags(0x0800_0000);
    }
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(err) => {
            eprintln!("无法启动内置 BabelDOC：{err}");
            exit(2);
        }
    }
}
