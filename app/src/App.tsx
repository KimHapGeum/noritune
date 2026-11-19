import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { addSong, DEFAULT_SETTINGS, decideSong, getQueue, markPlayed, savePrefs, getSettings, putSettings, listSongs, putQueue, MODES, retrySong, type Mode, type Settings as AppSettings, type Song } from "./api";
import Settings from "./Settings";
import { setMic, startMic, stopMic } from "./Mic";
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
  const play = (song: Song | null) => {
    setPlaying(song && { song, n: Date.now() });
    if (song) markPlayed(song.id).then(refresh).catch(() => {}); // 부른 횟수 (기획서 F16)
  };
  const [view, setView] = useState<"all" | "fav" | "most">("all");
  const [sort, setSort] = useState<"added" | "title" | "artist" | "plays">("added");
  const [queue, setQueue] = useState<string[]>([]);
  const waiting = useRef(false); // 예약한 곡이 준비되면 바로 틀지 (켜자마자 저장된 예약을 틀지 않도록)
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [lyricsFor, setLyricsFor] = useState<Song | null>(null);
  const [editFor, setEditFor] = useState<Song | null>(null);
  const [lyricsRev, setLyricsRev] = useState(0); // 가사를 바꾸면 재생 화면이 다시 받도록
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsLoaded = useRef(false);
  const [micLatency, setMicLatency] = useState<number | null>(null);
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
  // 곡 목록 보기·정렬 (기획서 F16). 많이 부른 곡은 부른 횟수 순
  const by = view === "most" ? "plays" : sort;
  const shown = songs
    .filter((s) => (view === "fav" ? s.prefs?.favorite : view === "most" ? (s.plays ?? 0) > 0 : true))
    .sort((a, b) =>
      by === "title" ? a.title.localeCompare(b.title, "ko")
      : by === "artist" ? (a.artist || "힣").localeCompare(b.artist || "힣", "ko")
      : by === "plays" ? (b.plays ?? 0) - (a.plays ?? 0) || (b.last_played ?? "").localeCompare(a.last_played ?? "")
      : (b.added_at ?? "").localeCompare(a.added_at ?? ""));
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
    getSettings().then((s) => {
      setSettings(s);
      settingsLoaded.current = true;
    }).catch(() => {});
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

  // 설정은 0.4초 동안 더 바꾸지 않으면 저장한다 (불러오기 전의 기본값으로 덮어쓰지 않게)
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const t = setTimeout(() => putSettings(settings).catch((e) => setError(`설정을 저장하지 못했어요: ${e.message}`)), 400);
    return () => clearTimeout(t);
  }, [settings]);

  // 마이크 (기획서 F13): 켜 두면 곡 목록에서도 계속 나온다
  useEffect(() => {
    if (!settings.mic_on) {
      stopMic();
      setMicLatency(null);
      return;
    }
    startMic(settings.mic_device, () => setError("마이크 소리가 갑자기 커져서 줄였어요 (하울링 방지). 마이크를 스피커에서 떨어뜨려 주세요."))
      .then((lat) => {
        setMicLatency(lat);
        setMic(settings.mic_volume, settings.mic_echo);
      })
      .catch((e) => {
        setError(`마이크를 켜지 못했어요: ${e.message}`);
        setSettings((s) => ({ ...s, mic_on: false }));
      });
    return () => stopMic();
  }, [settings.mic_on, settings.mic_device]);
  useEffect(() => setMic(settings.mic_volume, settings.mic_echo), [settings.mic_volume, settings.mic_echo]);

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
        <div className="list-head">
          <h2>
            내 노래 <span className="muted">{songs.length}곡</span>
          </h2>
          <div className="seg" role="radiogroup" aria-label="보기">
            {([["all", "전체"], ["fav", "즐겨찾기"], ["most", "많이 부른 곡"]] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
          <label className="row-label">정렬
            <select value={view === "most" ? "plays" : sort} disabled={view === "most"} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="added">추가한 날</option>
              <option value="title">제목</option>
              <option value="artist">가수</option>
              <option value="plays">부른 횟수</option>
            </select>
          </label>
        </div>
        {songs.length === 0 ? (
          <p className="empty">노래 파일(MP3·WAV·FLAC)을 이 창에 끌어다 놓거나 "곡 추가"를 누르세요.</p>
        ) : (
          <ul className="songs">
            {shown.length === 0 && <li className="list-empty muted">{view === "fav" ? "별을 누른 곡이 여기에 모여요." : "아직 부른 곡이 없어요."}</li>}
            {shown.map((s) => (
              <li key={s.id} className={playing?.song.id === s.id ? "on" : ""}>
                <button className={`star${s.prefs?.favorite ? " on" : ""}`} aria-pressed={!!s.prefs?.favorite}
                  aria-label={`${s.title} 즐겨찾기`} onClick={() => act(() => savePrefs(s.id, { favorite: !s.prefs?.favorite }))}>
                  {s.prefs?.favorite ? "★" : "☆"}
                </button>
                <button className="row" onClick={() => play(s)} disabled={s.status !== "ready"} title="눌러서 바로 부르기">
                  <span>
                    <span className="title">{s.title}</span>
                    <span className="muted"> {s.artist || "가수 모름"} · {fmt(s.duration)}{s.plays ? ` · ${s.plays}번 부름` : ""}</span>
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

      {playing && <Player key={playing.n} song={songs.find((s) => s.id === playing.song.id) ?? playing.song} settings={settings} onSettings={setSettings} hasNext={queue.length > 0} onEnded={playNext} lyricsRev={lyricsRev} onError={setError} onChanged={refresh} />}
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
      {settingsOpen && <Settings settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} micLatency={micLatency} />}
      {ytOpen && <YoutubeDialog defaultMode={mode} onClose={() => setYtOpen(false)} onAdded={refresh} />}
    </div>
  );
}
