import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { addSong, decideSong, getQueue, getSettings, listSongs, putQueue, MODES, retrySong, type Mode, type Settings as AppSettings, type Song } from "./api";
import Settings from "./Settings";
import QueuePanel from "./QueuePanel";
import Player from "./Player";
import YoutubeDialog from "./YoutubeDialog";
import LyricsChooser from "./LyricsChooser";
import LyricsEditor from "./LyricsEditor";
import "./App.css";

const AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "ogg", "opus"];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const busy = (s: Song) =>
  ["queued", "downloading", "checking", "separating"].includes(s.status) ||
  ["searching", "generating"].includes(s.lyrics?.state ?? "");
// 곡 목록 가사 칸: [보이는 글자, 누를 수 있는지, 강조]
const LYRICS_LABEL: Record<string, [string, boolean, string]> = {
  searching: ["찾는 중", false, ""],
  review: ["목록 확인", true, "lyr-review"],
  internet: ["인터넷", true, ""],
  generating: ["만드는 중", false, ""],
  auto: ["자동 생성", true, "lyr-auto"],
  file: ["가사 파일", true, ""],
  none: ["가사 없음", true, "lyr-auto"],
  off: ["영상 가사", false, ""],
  manual: ["직접 입력", true, ""],
};

// 알림을 본(닫거나 확인한) 곡. 이 PC에서만 기억하면 된다
const SEEN_KEY = "noritune.lyricsNoticeSeen";
const loadSeen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
  } catch {
    return [];
  }
};

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode>("빠른 분리");
  // n: 같은 곡을 이어서 불러도 재생기를 새로 띄우도록 매번 바뀌는 번호
  const [playing, setPlaying] = useState<{ song: Song; n: number } | null>(null);
  const play = (song: Song | null) => setPlaying(song && { song, n: Date.now() });
  const [queue, setQueue] = useState<string[]>([]);
  const waiting = useRef(false); // 예약한 곡이 준비되면 바로 틀지 (켜자마자 저장된 예약을 틀지 않도록)
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [lyricsFor, setLyricsFor] = useState<Song | null>(null);
  const [editFor, setEditFor] = useState<Song | null>(null);
  const [lyricsRev, setLyricsRev] = useState(0); // 가사를 바꾸면 재생 화면이 다시 받도록
  const [settings, setSettings] = useState<AppSettings>({ lyrics_delay: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seen, setSeen] = useState(loadSeen);
  const markSeen = (id: string) => {
    const next = [...seen.filter((x) => x !== id), id].slice(-500);
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* 저장이 막혀도 이번 실행 동안은 숨긴다 */
    }
  };
  // 기획서 F5 알림: 자동 생성했거나 못 찾은 가사를 확인하도록
  const notice = songs.find((s) => ["auto", "none"].includes(s.lyrics?.state ?? "") && !seen.includes(s.id));

  const refresh = () => listSongs().then(setSongs).catch((e) => setError(String(e.message ?? e)));

  async function addPaths(paths: string[], m: Mode) {
    setAdding(true);
    setError("");
    const failed: string[] = [];
    for (const p of paths) {
      try {
        await addSong(p, m);
      } catch (e) {
        failed.push(`${p.split(/[\\/]/).pop()}: ${(e as Error).message}`);
      }
    }
    setAdding(false);
    if (failed.length) setError(failed.join("\n"));
    refresh();
  }

  async function pickFiles() {
    const picked = await open({ multiple: true, filters: [{ name: "노래 파일", extensions: AUDIO_EXTS }] });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked], mode);
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function installUpdate() {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdating(false);
      setError(`업데이트하지 못했어요: ${(e as Error).message ?? e}`);
    }
  }

  useEffect(() => {
    refresh();
    getSettings().then(setSettings).catch(() => {});
    getQueue().then(setQueue).catch(() => {});
    // 켤 때 새 버전 확인. 인터넷이 없거나 개발판이면 조용히 넘어간다
    check().then(setUpdate).catch(() => {});
  }, []);

  // 끌어다 놓기는 지금 고른 반주 방식으로 추가한다
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((e) => {
      setDragging(e.payload.type === "enter" || e.payload.type === "over");
      if (e.payload.type === "drop") addPaths(e.payload.paths, mode);
    });
    return () => void off.then((f) => f());
  }, [mode]);

  function changeQueue(q: string[]) {
    setQueue(q);
    putQueue(q).catch((e) => {
      setError(`예약을 저장하지 못했어요: ${e.message}`);
      getQueue().then(setQueue).catch(() => {});
    });
  }

  // 예약: 아무것도 안 부르는 중이고 준비된 곡이면 바로 부른다 (기획서 5장 흐름)
  function reserve(s: Song) {
    if (!playing && s.status === "ready") return play(s);
    if (!playing) waiting.current = true;
    changeQueue([...queue, s.id]);
  }

  // 곡이 끝나거나 건너뛰면: 예약에서 준비된 첫 곡을 꺼내 부른다. 없으면 목록 화면으로
  function playNext() {
    const i = queue.findIndex((id) => songs.find((s) => s.id === id)?.status === "ready");
    if (i < 0) {
      waiting.current = queue.length > 0;
      return play(null);
    }
    play(songs.find((s) => s.id === queue[i])!);
    changeQueue(queue.filter((_, j) => j !== i));
  }

  // 기다리던 예약곡이 준비되면 이어서 부른다
  useEffect(() => {
    if (!playing && waiting.current && queue.some((id) => songs.find((s) => s.id === id)?.status === "ready")) {
      waiting.current = false;
      playNext();
    }
  }, [songs, queue, playing]);

  // 반주를 만드는 곡이 있는 동안 1.5초마다 상태를 새로 받는다
  const anyBusy = songs.some(busy);
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [anyBusy]);

  return (
    <div className={`app${dragging ? " dragging" : ""}`}>
      <header className="top">
        <h1>Noritune</h1>
        <div className="actions">
          <label className="mode">
            반주 만들기
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              {MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>설정</button>
          <button className="ghost" onClick={() => setYtOpen(true)}>유튜브에서 추가</button>
          <button className="primary" onClick={pickFiles} disabled={adding}>
            {adding ? "추가하는 중…" : "+ 곡 추가"}
          </button>
        </div>
      </header>

      {update && (
        <div className="update" role="status">
          새 버전 {update.version}이 있어요.
          <button className="primary" onClick={installUpdate} disabled={updating}>
            {updating ? "받는 중…" : "업데이트"}
          </button>
          <button onClick={() => setUpdate(null)} disabled={updating}>나중에</button>
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="알림 닫기" onClick={() => setError("")}>✕</button>
        </div>
      )}

      {notice && (
        <div className="update" role="status">
          {notice.title} : {notice.lyrics?.state === "auto" ? "자동 생성 가사예요. 틀린 곳이 있을 수 있어요" : "가사를 찾지 못했어요"}
          <button className="primary" onClick={() => {
            markSeen(notice.id);
            if (notice.lyrics?.state === "auto") setEditFor(notice);
            else setLyricsFor(notice);
          }}>{notice.lyrics?.state === "auto" ? "확인하기" : "가사 고르기"}</button>
          <button aria-label="알림 닫기" onClick={() => markSeen(notice.id)}>✕</button>
        </div>
      )}

      <div className="body">
      <main>
        <h2>
          내 노래 <span className="muted">{songs.length}곡</span>
        </h2>
        {songs.length === 0 ? (
          <p className="empty">노래 파일(MP3·WAV·FLAC)을 이 창에 끌어다 놓거나 "곡 추가"를 누르세요.</p>
        ) : (
          <ul className="songs">
            {songs.map((s) => (
              <li key={s.id} className={playing?.song.id === s.id ? "on" : ""}>
                <button className="row" onClick={() => play(s)} disabled={s.status !== "ready"} title="눌러서 바로 부르기">
                  <span>
                    <span className="title">{s.title}</span>
                    <span className="muted"> {s.artist || "가수 모름"} · {fmt(s.duration)}</span>
                  </span>
                  <span className={`chip mode-${MODES.indexOf(s.mode)}`}>{s.mode}</span>
                  <span className="status">
                    {s.status === "ready" && <span className="ok">준비됨</span>}
                    {s.status === "queued" && <span className="muted">기다리는 중</span>}
                    {s.status === "downloading" && (
                      <>
                        유튜브에서 받는 중 {Math.round((s.progress ?? 0) * 100)}%
                        <span className="bar"><span style={{ width: `${(s.progress ?? 0) * 100}%` }} /></span>
                      </>
                    )}
                    {s.status === "checking" && <span className="muted">반주인지 확인하는 중</span>}
                    {s.status === "confirm" && <span className="ask">반주 같아요. 분리할까요?</span>}
                    {s.status === "separating" && (
                      <>
                        반주 만드는 중 {Math.round((s.progress ?? 0) * 100)}%
                        <span className="bar"><span style={{ width: `${(s.progress ?? 0) * 100}%` }} /></span>
                      </>
                    )}
                    {s.status === "failed" && <span className="fail" title={s.error ?? ""}>반주를 만들지 못했어요</span>}
                  </span>
                </button>
                <button className="reserve" onClick={() => reserve(s)} disabled={s.status === "failed"}
                  title={s.status === "ready" ? "예약" : "예약하면 이 곡을 먼저 만들어요"}>
                  예약{queue.includes(s.id) ? ` ${queue.filter((x) => x === s.id).length}` : ""}
                </button>
                {(() => {
                  const [label, clickable, cls] = LYRICS_LABEL[s.lyrics?.state ?? "none"] ?? LYRICS_LABEL.none;
                  return (
                    <button className={`lyr ${cls}`} disabled={!clickable} onClick={() => (["auto", "none"].includes(s.lyrics?.state ?? "none") ? setEditFor(s) : setLyricsFor(s))}
                      title={s.lyrics?.error ?? (clickable ? "눌러서 가사 고르기·고치기" : "")}>
                      {label}
                    </button>
                  );
                })()}
                {s.status === "failed" && (
                  <button className="retry" onClick={() => act(() => retrySong(s.id))}>다시 시도</button>
                )}
                {s.status === "confirm" && (
                  <span className="decide">
                    <button className="primary" onClick={() => act(() => decideSong(s.id, "keep"))}>분리 없이 쓰기</button>
                    <button onClick={() => act(() => decideSong(s.id, "separate"))}>그래도 분리</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      <QueuePanel queue={queue} songs={songs} onChange={changeQueue} />
      </div>

      {playing && <Player key={playing.n} song={playing.song} hasNext={queue.length > 0} onEnded={playNext} lyricsRev={lyricsRev} lyricsDelay={settings.lyrics_delay} onError={setError} onChanged={refresh} />}
      {lyricsFor && (
        <LyricsChooser song={lyricsFor} onClose={() => setLyricsFor(null)}
          onChanged={() => { refresh(); setLyricsRev((r) => r + 1); }}
          onEdit={() => { setEditFor(lyricsFor); setLyricsFor(null); }} />
      )}
      {editFor && (
        <LyricsEditor song={editFor}
          onClose={(saved) => { setEditFor(null); if (saved) { refresh(); setLyricsRev((r) => r + 1); } }}
          onChooseOther={() => { setLyricsFor(editFor); setEditFor(null); }} />
      )}
      {settingsOpen && <Settings settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
      {ytOpen && <YoutubeDialog defaultMode={mode} onClose={() => setYtOpen(false)} onAdded={refresh} />}
    </div>
  );
}
