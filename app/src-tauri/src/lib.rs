use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

/// 파이썬 처리기 프로세스와 그 포트. 처리기가 죽거나 저장 폴더를 바꾸면 새로 켜므로 바뀔 수 있다
struct Engine {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
    busy: AtomicBool, // 일부러 다시 켜거나 끄는 중 (지켜보기가 죽은 것으로 착각하지 않게)
    boot: Mutex<Boot>,
    setup: Mutex<Option<Child>>, // 부품을 받는 uv (앱을 끄면 같이 끈다)
}

/// 켜지는 단계. 화면이 boot_state로 물어 가서 준비 화면을 보여 준다
#[derive(Clone, serde::Serialize)]
struct Boot {
    phase: &'static str, // "setup" | "ready" | "failed"
    text: String,
    mb: u64, // 지금까지 받은 양
}

#[tauri::command]
fn boot_state(engine: tauri::State<Engine>) -> Boot {
    engine.boot.lock().unwrap().clone()
}

/// 준비에 실패했을 때 "다시 시도"
#[tauri::command]
fn retry_boot(app: tauri::AppHandle, engine: tauri::State<Engine>) {
    let mut b = engine.boot.lock().unwrap();
    if b.phase == "failed" {
        *b = Boot { phase: "setup", text: "다시 준비하는 중".into(), mb: 0 };
        std::thread::spawn(move || boot(&app));
    }
}

fn set_boot(app: &tauri::AppHandle, phase: &'static str, text: &str) {
    let e = app.state::<Engine>();
    let mut b = e.boot.lock().unwrap();
    b.phase = phase;
    b.text = text.into();
}

/// 부품 준비(설치판만) → 처리기 켜기. 창은 먼저 뜨고 이 일은 따로 돈다
fn boot(app: &tauri::AppHandle) {
    let e = app.state::<Engine>();
    e.busy.store(true, Ordering::SeqCst);
    let result = if cfg!(debug_assertions) { Ok(()) } else { prepare_runtime(app) }.and_then(|_| {
        set_boot(app, "setup", "처리기를 켜는 중");
        start_engine(app)
    });
    match result {
        Ok((child, port)) => {
            *e.child.lock().unwrap() = Some(child);
            *e.port.lock().unwrap() = port;
            set_boot(app, "ready", "");
        }
        Err(msg) => set_boot(app, "failed", &msg),
    }
    e.busy.store(false, Ordering::SeqCst);
}

fn local_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Noritune")
}

fn resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map_err(|e| format!("설치 폴더를 찾지 못했어요: {e}"))
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 검은 콘솔 창을 띄우지 않는다
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

/// NVIDIA 드라이버가 CUDA 12.8 이상을 지원하면 GPU용 PyTorch(cu128)를 받는다
fn has_cuda() -> bool {
    // 표 모양 출력은 드라이버마다 바뀐다 ("CUDA Version" → "CUDA UMD Version"). 드라이버 번호만 묻는다
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=driver_version", "--format=csv,noheader"]);
    no_window(&mut cmd);
    let Ok(out) = cmd.output() else { return false };
    out.status.success() && cuda_ok(&String::from_utf8_lossy(&out.stdout))
}

/// CUDA 12.8을 쓰려면 Windows 드라이버 570.65 이상 (GPU가 여럿이면 첫 줄)
fn cuda_ok(driver_version: &str) -> bool {
    let ver: Vec<u32> = driver_version.lines().next().unwrap_or("").trim().split('.').filter_map(|x| x.parse().ok()).collect();
    matches!(ver.as_slice(), [maj, min, ..] if (*maj, *min) >= (570, 65))
}

fn dir_mb(dir: &std::path::Path) -> u64 {
    fn walk(d: &std::path::Path) -> u64 {
        std::fs::read_dir(d)
            .map(|rd| {
                rd.flatten()
                    .map(|e| match e.file_type() {
                        Ok(t) if t.is_dir() => walk(&e.path()),
                        _ => e.metadata().map(|m| m.len()).unwrap_or(0),
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
    walk(dir) / 1_000_000
}

/// 설치판: 처리기 실행 환경(파이썬 + PyTorch 등)을 uv로 %LOCALAPPDATA%\Noritune\runtime 에 만든다.
/// 설치 파일 한계(2GB) 때문에 PyTorch는 넣지 않고 처음 켤 때 PC에 맞는 것을 받는다. 새 버전에서 uv.lock이 바뀌면 바뀐 것만 받는다
fn prepare_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    use std::hash::{Hash, Hasher};
    let local = local_dir();
    let runtime = local.join("runtime");
    let res = resource_dir(app)?;
    let engine_dir = res.join("engine");
    let lock = std::fs::read(engine_dir.join("uv.lock")).map_err(|e| format!("설치 파일이 손상됐어요 (uv.lock): {e}"))?;
    let extra = if has_cuda() { "cu128" } else { "cpu" };
    let mut h = std::collections::hash_map::DefaultHasher::new();
    lock.hash(&mut h);
    let stamp = format!("{extra} {:x}", h.finish());
    let marker = runtime.join("noritune-ready.txt");
    let old = std::fs::read_to_string(&marker).ok();
    if old.as_deref() == Some(stamp.as_str()) && runtime.join("Scripts").join("python.exe").exists() {
        return Ok(());
    }
    // 받는 양과 풀어 놓은 크기가 다르다 (cu128: 받기 약 3GB → 디스크 7.8GB, 2026-11-20 실측)
    let what = if extra == "cu128" { "그래픽카드용 부품을 받는 중이에요 (약 3GB 받기 · 디스크 약 8GB, 처음 한 번만)" } else { "부품을 받는 중이에요 (약 1GB 받기, 처음 한 번만)" };
    set_boot(app, "setup", if old.is_some() { "새 버전에 맞게 부품을 고치는 중이에요" } else { what });

    let cache = local.join("uv-cache");
    let mut cmd = Command::new(res.join("bin").join("uv.exe"));
    cmd.args(["sync", "--frozen", "--no-dev", "--no-install-project", "--extra", extra, "--python", "3.12", "--python-preference", "only-managed"])
        .current_dir(&engine_dir)
        .env("UV_PROJECT_ENVIRONMENT", &runtime)
        .env("UV_PYTHON_INSTALL_DIR", local.join("python"))
        .env("UV_CACHE_DIR", &cache)
        .env("UV_LINK_MODE", "copy") // 다 받은 뒤 캐시를 지워도 되게 (안 그러면 같은 파일이 두 벌)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("부품 받기를 시작하지 못했어요: {e}"))?;
    let stderr = child.stderr.take().expect("stderr piped");
    let last = std::sync::Arc::new(Mutex::new(String::new()));
    let last2 = last.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                *last2.lock().unwrap() = line.trim().to_string();
            }
        }
    });
    let e = app.state::<Engine>();
    *e.setup.lock().unwrap() = Some(child);
    let status = loop {
        std::thread::sleep(Duration::from_millis(1000));
        let mb = dir_mb(&cache) + dir_mb(&local.join("python"));
        e.boot.lock().unwrap().mb = mb;
        let mut guard = e.setup.lock().unwrap();
        let Some(c) = guard.as_mut() else { return Err("앱을 끄는 중이에요".into()) };
        if let Ok(Some(st)) = c.try_wait() {
            guard.take();
            break st;
        }
    };
    let _ = std::fs::remove_dir_all(&cache);
    if !status.success() {
        let why = last.lock().unwrap().clone();
        return Err(format!("부품을 받지 못했어요. 인터넷 연결과 남은 디스크 공간을 확인하고 다시 시도해 주세요. ({why})"));
    }
    std::fs::write(&marker, stamp).map_err(|e| format!("준비를 마치지 못했어요: {e}"))?;
    Ok(())
}

#[tauri::command]
fn engine_port(engine: tauri::State<Engine>) -> u16 {
    *engine.port.lock().unwrap()
}

/// 처리기를 끄고 새로 켠다 (저장 폴더를 바꾼 뒤). 새 포트를 돌려준다
#[tauri::command]
fn restart_engine(app: tauri::AppHandle, engine: tauri::State<Engine>) -> Result<u16, String> {
    engine.busy.store(true, Ordering::SeqCst);
    let result = respawn(&app, &engine);
    engine.busy.store(false, Ordering::SeqCst);
    result
}

/// 자식까지 끈다. 가상환경 python.exe는 진짜 파이썬을 따로 띄우는 껍데기라 Child::kill로는 껍데기만 꺼졌다
fn kill_tree(child: &mut Child) {
    let mut c = Command::new("taskkill");
    c.args(["/T", "/F", "/PID", &child.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    no_window(&mut c);
    let _ = c.status();
    let _ = child.kill();
    let _ = child.wait();
}

fn respawn(app: &tauri::AppHandle, engine: &Engine) -> Result<u16, String> {
    if let Some(mut old) = engine.child.lock().unwrap().take() {
        kill_tree(&mut old);
    }
    let (child, port) = start_engine(app)?;
    *engine.child.lock().unwrap() = Some(child);
    *engine.port.lock().unwrap() = port;
    Ok(port)
}

/// 처리기가 혼자 죽으면 다시 켜고 화면에 알린다 (기획서 8.1 "처리기가 멈춤")
fn watch_engine(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let Some(engine) = app.try_state::<Engine>() else { continue };
        if engine.busy.load(Ordering::SeqCst) {
            continue;
        }
        let died = matches!(engine.child.lock().unwrap().as_mut().map(|c| c.try_wait()), Some(Ok(Some(_))));
        if died {
            engine.busy.store(true, Ordering::SeqCst);
            let result = respawn(&app, &engine);
            engine.busy.store(false, Ordering::SeqCst);
            let _ = app.emit("engine-restarted", result.is_ok());
        }
    });
}

/// 처리기 실행 명령. 설치판은 처음 켤 때 만든 runtime 파이썬으로 설치 폴더의 engine 소스를 실행하고,
/// 함께 넣은 ffmpeg·yt-dlp·deno(bin)를 PATH 앞에 둔다. 개발판은 개발 PC의 가상환경 파이썬과 PATH를 쓴다.
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
        let res = resource_dir(app)?;
        let path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(std::iter::once(res.join("bin")).chain(std::env::split_paths(&path))).map_err(|e| e.to_string())?;
        let mut c = Command::new(local_dir().join("runtime").join("Scripts").join("python.exe"));
        c.args(["-m", "karaoke_engine"]).current_dir(res.join("engine")).env("PATH", path);
        c
    };
    no_window(&mut cmd);
    Ok(cmd)
}

/// 처리기를 켜고 `KARAOKE_ENGINE_READY port=<번호>` 줄을 기다린다.
fn start_engine(app: &tauri::AppHandle) -> Result<(Child, u16), String> {
    // 처리기는 이 앱이 꺼지면(강제 종료 포함) 따라 꺼진다 (__main__.py)
    let mut child = engine_command(app)?
        .env("NORITUNE_APP_PID", std::process::id().to_string())
        .stdin(Stdio::null())
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
    // 설치 직후 첫 실행은 PyTorch를 처음 읽고 백신 검사도 겹쳐 오래 걸린다
    match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(Some(port)) => Ok((child, port)),
        _ => {
            kill_tree(&mut child);
            Err("처리기가 90초 안에 준비되지 않았어요".into())
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
            app.manage(Engine {
                child: Mutex::new(None),
                port: Mutex::new(0),
                busy: AtomicBool::new(true),
                boot: Mutex::new(Boot { phase: "setup", text: "켜는 중".into(), mb: 0 }),
                setup: Mutex::new(None),
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || boot(&handle));
            watch_engine(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_port, restart_engine, boot_state, retry_boot])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // 앱을 끌 때 처리기도 반드시 끈다
        if let RunEvent::Exit = event {
            if let Some(engine) = handle.try_state::<Engine>() {
                engine.busy.store(true, Ordering::SeqCst);
                if let Some(mut uv) = engine.setup.lock().unwrap().take() {
                    kill_tree(&mut uv);
                }
                if let Some(mut child) = engine.child.lock().unwrap().take() {
                    kill_tree(&mut child);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn cuda_from_driver_version() {
        assert!(super::cuda_ok("610.88"));
        assert!(super::cuda_ok("570.65\n560.10"));
        assert!(!super::cuda_ok("566.36"));
        assert!(!super::cuda_ok("570.10"));
        assert!(!super::cuda_ok(""));
    }
}
