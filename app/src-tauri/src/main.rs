// 검은 콘솔 창을 띄우지 않는다. 개발판도 바탕화면 바로가기로 매일 쓰므로 항상 끈다
// (처리기 기록은 KARAOKE_ENGINE_LOG 파일로 본다)
#![windows_subsystem = "windows"]

fn main() {
    app_lib::run()
}
