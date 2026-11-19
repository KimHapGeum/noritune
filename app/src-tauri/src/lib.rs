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

/// 처리기 실행 명령. 배포판은 설치 폴더의 engine/noritune-engine.exe (PyInstaller로 묶은 것),
/// 개발판은 개발 PC의 가상환경 파이썬으로 소스를 바로 실행한다.
fn engine_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let mut cmd = if cfg!(debug_assertions) {
        let engine_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine");
        let python = std::env::var("KARAOKE_ENGINE_PYTHON").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join(".venvs/karaoke-engine/Scripts/python.exe")
        });
        let mut c = Command::new(python);
        c.args(["-m", "karaoke_engine"]).current_dir(engine_dir);
        c
    } else {
        let exe = app
            .path()
            .resource_dir()
            .map_err(|e| format!("설치 폴더를 찾지 못했어요: {e}"))?
            .join("engine")
            .join("noritune-engine.exe");
        Command::new(exe)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 검은 콘솔 창을 띄우지 않는다
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// 처리기를 켜고 `KARAOKE_ENGINE_READY port=<번호>` 줄을 기다린다.
fn start_engine(app: &tauri::AppHandle) -> Result<(Child, u16), String> {
    let mut child = engine_command(app)?
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

/// 마이크(기획서 F13): 웹뷰가 묻기만 하고 답을 받지 못해 getUserMedia가 멈췄다.
/// 우리 화면(tauri.localhost, 개발 서버)에서 온 마이크 요청만 허용하고, 유튜브 배경 같은 다른 곳은 건드리지 않는다
#[cfg(windows)]
fn allow_microphone(app: &tauri::App) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    const OURS: [&str; 3] = ["http://tauri.localhost/", "https://tauri.localhost/", "http://localhost:1420/"];
    let Some(win) = app.get_webview_window("main") else { return };
    let _ = win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = windows_core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && OURS.iter().any(|o| uri.starts_with(o)) {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(windows)]
            allow_microphone(app);
            let (child, port) = start_engine(app.handle())?;
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
