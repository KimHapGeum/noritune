use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};

/// 파이썬 처리기 프로세스와 그 포트
struct Engine {
    child: Mutex<Option<Child>>,
    port: u16,
}

#[tauri::command]
fn engine_port(engine: tauri::State<Engine>) -> u16 {
    engine.port
}

/// 개발용 처리기 실행 명령.
/// shortcut: 개발 PC의 가상환경 파이썬을 직접 부른다. 배포판을 만들 때 PyInstaller로 묶은 sidecar 실행으로 바꾼다.
fn engine_command() -> Command {
    let engine_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine");
    let python = std::env::var("KARAOKE_ENGINE_PYTHON").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
            .join(".venvs/karaoke-engine/Scripts/python.exe")
    });
    let mut cmd = Command::new(python);
    cmd.args(["-m", "karaoke_engine"]).current_dir(engine_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 검은 콘솔 창을 띄우지 않는다
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 처리기를 켜고 `KARAOKE_ENGINE_READY port=<번호>` 줄을 기다린다.
fn start_engine() -> Result<(Child, u16), String> {
    let mut child = engine_command()
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("처리기를 켜지 못했어요: {e}"))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(p) = line.strip_prefix("KARAOKE_ENGINE_READY port=") {
                let _ = tx.send(p.trim().parse::<u16>().ok());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Some(port)) => Ok((child, port)),
        _ => {
            let _ = child.kill();
            Err("처리기가 20초 안에 준비되지 않았어요".into())
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (child, port) = start_engine()?;
            app.manage(Engine { child: Mutex::new(Some(child)), port });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_port])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // 앱을 끌 때 처리기도 반드시 끈다
        if let RunEvent::Exit = event {
            if let Some(engine) = handle.try_state::<Engine>() {
                if let Some(mut child) = engine.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
