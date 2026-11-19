import { useEffect, useState } from "react";
import { listen, emitTo } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, type Monitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { LyricLine, Settings, Song } from "./api";
import Stage from "./Stage";
import { LyricsView } from "./Player";

/** PC 창 → TV 창으로 보내는 재생 상태 (기획서 F14, 11.6: 재생 상태는 PC 창 한곳에서 관리하고 보기만 나눈다) */
export type TvState = {
  song: Song; settings: Settings; lines: LyricLine[];
  heardPos: number; lyricPos: number; tempo: number; playing: boolean; lyricsOn: boolean; keyLabel: string;
} | null;

export const TV_LABEL = "tv";
const MONITOR_KEY = "noritune.tvMonitor"; // 마지막으로 쓴 TV 모니터 이름 (이 PC에서만)

export const sendTv = (s: TvState) => emitTo(TV_LABEL, "tv-state", s).catch(() => {});

/** PC 창에서: 모니터가 둘 이상인지 보고, TV 창을 열고 닫는다. 모니터가 빠지면 닫는다 */
export function useTv(onError: (m: string) => void) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const check = () => availableMonitors().then(setMonitors).catch(() => {});
    check();
    const t = setInterval(check, 3000);
    return () => clearInterval(t);
  }, []);

  // TV 연결이 끊기면 TV 창을 닫는다 (재생 화면은 PC 창으로 돌아온다)
  const tvName = (() => {
    try {
      return localStorage.getItem(MONITOR_KEY);
    } catch {
      return null;
    }
  })();
  useEffect(() => {
    if (open && monitors.length > 0 && !monitors.some((m) => m.name === tvName)) close();
  }, [monitors]);

  async function show() {
    const here = await currentMonitor(); // PC 창이 있는 모니터
    // 마지막에 쓴 모니터가 있으면 그것, 없으면 PC 창이 없는 첫 모니터
    const tv = monitors.find((m) => m.name === tvName && m.name !== here?.name) ?? monitors.find((m) => m.name !== here?.name);
    if (!tv) return onError("TV(두 번째 모니터)를 찾지 못했어요");
    try {
      localStorage.setItem(MONITOR_KEY, tv.name ?? "");
    } catch {
      /* 기억 못 해도 연다 */
    }
    const w = new WebviewWindow(TV_LABEL, {
      url: "index.html#tv", title: "Noritune TV", decorations: false, focus: false,
      x: tv.position.x / tv.scaleFactor, y: tv.position.y / tv.scaleFactor,
      width: tv.size.width / tv.scaleFactor, height: tv.size.height / tv.scaleFactor,
    });
    w.once("tauri://created", () => {
      w.setFullscreen(true).catch(() => {});
      setOpen(true);
    });
    w.once("tauri://error", (e) => onError(`TV 화면을 열지 못했어요: ${String(e.payload)}`));
    w.once("tauri://destroyed", () => setOpen(false));
  }

  async function close() {
    (await WebviewWindow.getByLabel(TV_LABEL))?.close();
    setOpen(false);
  }

  return { canShow: monitors.length > 1, open, show, close };
}

/** TV 창: 가사·배경·키 표시만, 버튼 없음 */
export function TvView() {
  const [s, setS] = useState<TvState>(null);
  useEffect(() => {
    const off = listen<TvState>("tv-state", (e) => setS(e.payload));
    document.body.style.cursor = "none";
    return () => void off.then((f) => f());
  }, []);
  if (!s) return <div className="tv-wait">Noritune · 곡을 고르면 여기에 노래방 화면이 나와요</div>;
  return (
    <div className="player-wrap full tv">
      <Stage song={s.song} settings={s.settings} heardPos={s.heardPos} tempo={s.tempo} playing={s.playing} lyricsOn={s.lyricsOn}
        top={<><b className="stage-title">{s.song.title} <span className="muted">{s.song.artist}</span></b><b className="tv-key">{s.keyLabel}</b></>}>
        {s.lyricsOn && <LyricsView lines={s.lines} pos={s.lyricPos} state={s.song.lyrics?.state} />}
      </Stage>
    </div>
  );
}
