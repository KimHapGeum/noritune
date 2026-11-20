import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { addSong, DEFAULT_SETTINGS, decideSong, deleteSong, getSystem, remakeSong, getQueue, markPlayed, savePrefs, getSettings, putSettings, listSongs, putQueue, MODES, retrySong, type Mode, type Settings as AppSettings, type Song } from "./api";
import Settings from "./Settings";
import Onboarding from "./Onboarding";
import { setMic, startMic, stopMic } from "./Mic";
import { sendTv, useTv } from "./Tv";
import { ask } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { resetEngine } from "./api";

// 실패한 까닭 (기획서 8.1): 사용자에게 보여 줄 수 있게 만든 말은 그대로, 아니면 무엇이 안 됐는지만
const failText = (s: Song) =>
  /^(저장 공간|인터넷|유튜브|이 파일|ffmpeg|yt-dlp)/.test(s.error ?? "") ? s.error!.split(":")[0]
  : s.file ? "반주를 만들지 못했어요" : "유튜브에서 받지 못했어요";
import QueuePanel from "./QueuePanel";
import { CheckIcon, GearIcon, LogoMark, NoteIcon, PlusIcon, SearchIcon, TvIcon, WarnIcon } from "./icons";
import Player from "./Player";
import AddSong from "./AddSong";
import LyricsChooser from "./LyricsChooser";
import LyricsEditor from "./LyricsEditor";
import "./App.css";

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
const LYRICS_TIP: Record<string, string> = {
  review: "찾은 가사 후보에서 골라 주세요", internet: "눌러서 다른 가사 고르기", auto: "눌러서 가사 고치기",
  none: "눌러서 가사 쓰기", file: "눌러서 다른 가사 고르기", manual: "눌러서 다른 가사 고르기",
};
const GENDER: Record<string, string> = { male: "남", female: "여", mixed: "혼성" };
// 곡마다 정해진 파스텔 색 (시안의 곡 아이콘)
const TINTS = ["#FFB3C7", "#A8E6F7", "#FFD59E", "#C9BFFF", "#B9F0C8", "#FFC9A8", "#A8C8FF"];
const tint = (id: string) => TINTS[parseInt(id.slice(0, 4), 16) % TINTS.length];

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
  // n: 같은 곡을 이어서 불러도 재생기를 새로 띄우도록 매번 바뀌는 번호
  const [playing, setPlaying] = useState<{ song: Song; n: number } | null>(null);
  const play = (song: Song | null) => {
    setPlaying(song && { song, n: Date.now() });
    if (song) markPlayed(song.id).then(refresh).catch(() => {}); // 부른 횟수 (기획서 F16)
  };
  const [view, setView] = useState<"all" | "ready" | "busy" | "fav" | "most">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"added" | "title" | "artist" | "plays">("added");
  const [queue, setQueue] = useState<string[]>([]);
  const waiting = useRef(false); // 예약한 곡이 준비되면 바로 틀지 (켜자마자 저장된 예약을 틀지 않도록)
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [lyricsFor, setLyricsFor] = useState<Song | null>(null);
  const [editFor, setEditFor] = useState<Song | null>(null);
  const [lyricsRev, setLyricsRev] = useState(0); // 가사를 바꾸면 재생 화면이 다시 받도록
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onStage, setOnStage] = useState(false); // 노래방 화면(PC 전체 화면 또는 TV)이 떠 있는지
  const settingsLoaded = useRef(false);
  const [micLatency, setMicLatency] = useState<number | null>(null);
  const tv = useTv(setError);
  const [menuFor, setMenuFor] = useState<string | null>(null); // ⋯ 메뉴를 연 곡
  const [menuPos, setMenuPos] = useState<{ right: number; top?: number; bottom?: number }>({ right: 0 });
  const [lowDisk, setLowDisk] = useState<number | null>(null); // 남은 공간이 2GB 아래면 GB
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
  const q = query.trim().toLowerCase();
  const shown = songs
    .filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q))
    .filter((s) =>
      view === "fav" ? s.prefs?.favorite
      : view === "most" ? (s.plays ?? 0) > 0
      : view === "ready" ? s.status === "ready"
      : view === "busy" ? s.status !== "ready"
      : true)
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

  // 끌어다 놓기는 설정의 기본 반주 방식으로 바로 추가한다 (곡 추가 창이 열려 있으면 그 창이 받지 않는다)
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((e) => {
      setDragging(e.payload.type === "enter" || e.payload.type === "over");
      if (e.payload.type === "drop") addPaths(e.payload.paths, settings.default_mode);
    });
    return () => void off.then((f) => f());
  }, [settings.default_mode]);

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

  // 다음에 부를 곡 (재생 화면 "다음 곡" 칸)
  const nextSong = queue.map((id) => songs.find((s) => s.id === id)).find((s) => s?.status === "ready") ?? null;

  // 곡 취소: 지금 곡을 멈추고 목록으로. 예약은 그대로 두고 다음 곡을 자동으로 틀지 않는다
  function cancelSong() {
    waiting.current = false;
    play(null);
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

  // 마이크 (기획서 F13): 노래방 화면에서만 쓴다. 설정 화면에서는 소리 크기를 시험해 볼 수 있게 켠다
  const micActive = settings.mic_on && (onStage || settingsOpen);
  useEffect(() => {
    if (!micActive) {
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
  }, [micActive, settings.mic_device]);
  useEffect(() => setMic(settings.mic_volume, settings.mic_echo), [settings.mic_volume, settings.mic_echo]);

  // 남은 저장 공간 (기획서 6장: 2GB 아래로 내려가면 알린다). 곡이 늘거나 줄 때 다시 본다
  useEffect(() => {
    getSystem().then((s) => setLowDisk(s.free < 2 * 1024 ** 3 ? s.free / 1024 ** 3 : null)).catch(() => {});
  }, [songs.length]);

  // ⋯ 메뉴는 바깥을 누르거나 Esc로 닫는다
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest(".song-menu, .more-btn")) setMenuFor(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    // 메뉴가 화면에 고정돼 있어서 목록이 스크롤되면 버튼과 어긋나므로 닫는다
    const shut = () => setMenuFor(null);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [menuFor]);

  async function removeSong(s: Song) {
    setMenuFor(null);
    if (playing?.song.id === s.id) return setError("부르는 중인 곡은 지울 수 없어요. 다른 곡으로 넘기거나 멈춘 뒤에 지워 주세요");
    const yes = await ask(`'${s.title}'을(를) 지울까요?\n받은 원곡·반주·가사가 함께 지워져요. 내 PC의 원본 파일은 그대로 둬요.`,
      { title: "곡 지우기", kind: "warning", okLabel: "지우기", cancelLabel: "취소" });
    if (yes) act(() => deleteSong(s.id).then(() => setQueue((q) => q.filter((x) => x !== s.id))));
  }

  // 처리기가 혼자 죽어서 Rust가 다시 켰다 (기획서 8.1). 하던 분리는 처리기가 처음부터 다시 한다
  useEffect(() => {
    const off = listen<boolean>("engine-restarted", (e) => {
      resetEngine();
      setError(e.payload ? "잠시 문제가 생겨 다시 시작했어요" : "처리기를 다시 켜지 못했어요. 앱을 껐다 켜 주세요");
      refresh();
    });
    return () => void off.then((f) => f());
  }, []);

  // 부르는 곡이 없으면 TV는 기다림 화면
  useEffect(() => {
    if (tv.open && !playing) sendTv(null);
  }, [tv.open, playing]);

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
        <div className="brand"><LogoMark /> Noritune</div>
        <label className="search">
          <SearchIcon />
          <span className="sr-only">곡 검색</span>
          <input type="search" placeholder="제목이나 가수로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="primary" onClick={() => setAddOpen(true)} disabled={adding}>
          <PlusIcon /> {adding ? "추가하는 중…" : "곡 추가"}
        </button>
        {(tv.canShow || tv.open) && (
          <button className="ghost" onClick={tv.open ? tv.close : tv.show}><TvIcon /> {tv.open ? "TV 끄기" : "TV에 띄우기"}</button>
        )}
        <button className="ghost square" aria-label="설정" onClick={() => setSettingsOpen(true)}><GearIcon /></button>
      </header>

      {update && (
        <div className="update" role="status">
          새 버전 {update.version}이 있어요.
          <button className="primary" onClick={installUpdate} disabled={updating}>{updating ? "받는 중…" : "업데이트"}</button>
          <button onClick={() => setUpdate(null)} disabled={updating}>나중에</button>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="알림 닫기" onClick={() => setError("")}>✕</button>
        </div>
      )}
      {lowDisk !== null && (
        <div className="error" role="alert">저장 공간이 부족해요 (남은 공간 {lowDisk.toFixed(1)}GB). 곡을 지우거나 디스크 공간을 비워 주세요.</div>
      )}

      <div className="body">
        <section className="list">
          <div className="list-head">
            <h1>내 노래 <span className="muted">{songs.length}곡</span></h1>
            <div className="pills" role="radiogroup" aria-label="보기">
              {([["all", "전체"], ["ready", "준비됨"], ["busy", "처리 중"], ["fav", "즐겨찾기"], ["most", "많이 부른 곡"]] as const).map(([v, label]) => (
                <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{label}</button>
              ))}
              <label className="sort">정렬
                <select value={view === "most" ? "plays" : sort} disabled={view === "most"} onChange={(e) => setSort(e.target.value as typeof sort)}>
                  <option value="added">추가한 날</option>
                  <option value="title">제목</option>
                  <option value="artist">가수</option>
                  <option value="plays">부른 횟수</option>
                </select>
              </label>
            </div>
          </div>

          {notice && (
            <div className="warn-banner" role="status">
              <WarnIcon />
              <span><b>{notice.title}</b> : {notice.lyrics?.state === "auto" ? "자동 생성 가사예요. 틀린 곳이 있을 수 있어요." : "가사를 찾지 못했어요."}</span>
              <button className="warn-go" onClick={() => {
                markSeen(notice.id);
                if (notice.lyrics?.state === "auto") setEditFor(notice);
                else setLyricsFor(notice);
              }}>{notice.lyrics?.state === "auto" ? "확인하기" : "가사 고르기"}</button>
              <button className="warn-x" aria-label="알림 닫기" onClick={() => markSeen(notice.id)}>✕</button>
            </div>
          )}

          {songs.length === 0 ? (
            <p className="empty">노래 파일(MP3·WAV·FLAC)을 이 창에 끌어다 놓거나 "곡 추가"를 누르세요.</p>
          ) : (
            <div className="table">
              <div className="t-row t-head">
                <div>제목 · 가수</div><div>길이</div><div>반주</div><div>가사</div><div>상태</div><div />
              </div>
              {shown.length === 0 && <div className="list-empty muted">{query ? "찾는 곡이 없어요." : view === "fav" ? "별을 누른 곡이 여기에 모여요." : view === "most" ? "아직 부른 곡이 없어요." : "해당하는 곡이 없어요."}</div>}
              {shown.map((s) => {
                const [label, clickable, cls] = LYRICS_LABEL[s.lyrics?.state ?? "none"] ?? LYRICS_LABEL.none;
                const ready = s.status === "ready";
                return (
                  <div key={s.id} className={`t-row${playing?.song.id === s.id ? " on" : ""}`}
                    onDoubleClick={(e) => ready && !(e.target as HTMLElement).closest("button, a, select") && play(s)}
                    title={ready ? "두 번 누르면 바로 불러요" : undefined}>
                    <div className="t-title">
                      <button className={`star${s.prefs?.favorite ? " on" : ""}`} aria-pressed={!!s.prefs?.favorite}
                        aria-label={s.prefs?.favorite ? "즐겨찾기 빼기" : "즐겨찾기"} onClick={() => act(() => savePrefs(s.id, { favorite: !s.prefs?.favorite }))}>
                        {s.prefs?.favorite ? "★" : "☆"}
                      </button>
                      <span className="tint" style={{ background: tint(s.id) }}><NoteIcon /></span>
                      <span className="t-name">
                        <span className="t-song">{s.title}</span>
                        <span className="muted">{s.artist || "가수 모름"}{s.gender ? ` · ${GENDER[s.gender]}` : ""}{s.plays ? ` · ${s.plays}번 부름` : ""}</span>
                      </span>
                    </div>
                    <div className="t-len">{fmt(s.duration)}</div>
                    <div><span className={`chip mode-${MODES.indexOf(s.mode)}`}>{s.mode}</span></div>
                    <div>
                      {clickable
                        ? <button className={`lyr-link ${cls}`} title={s.lyrics?.error ?? LYRICS_TIP[s.lyrics?.state ?? "none"] ?? ""}
                            onClick={() => (["auto", "none"].includes(s.lyrics?.state ?? "none") ? setEditFor(s) : setLyricsFor(s))}>{label}</button>
                        : <span className="muted">{label}</span>}
                    </div>
                    <div className="t-status">
                      {ready && <span className="ok"><CheckIcon /> 준비됨</span>}
                      {s.status === "queued" && <span className="muted">기다리는 중</span>}
                      {s.status === "checking" && <span className="muted">반주인지 확인하는 중</span>}
                      {(s.status === "downloading" || s.status === "separating") && (
                        <>
                          <div className="t-sub">{s.status === "downloading" ? "유튜브에서 받는 중" : "반주 만드는 중"} {Math.round((s.progress ?? 0) * 100)}%</div>
                          <div className="bar"><span style={{ width: `${(s.progress ?? 0) * 100}%` }} /></div>
                        </>
                      )}
                      {s.status === "confirm" && (
                        <>
                          <div className="t-sub ask">반주 같아요. 분리할까요?</div>
                          <span className="links">
                            <button onClick={() => act(() => decideSong(s.id, "keep"))}>분리 없이 쓰기</button> · <button onClick={() => act(() => decideSong(s.id, "separate"))}>그래도 분리</button>
                          </span>
                        </>
                      )}
                      {s.status === "failed" && (
                        <>
                          <div className="t-sub fail" title={s.error ?? ""}>{failText(s)}</div>
                          <span className="links">
                            <button onClick={() => act(() => retrySong(s.id))}>다시 시도</button>
                            {s.file && s.mode === "고품질 분리" && <> · <button onClick={() => act(() => remakeSong(s.id, "빠른 분리"))}>빠른 분리로</button></>}
                            {s.file && <> · <button onClick={() => act(() => remakeSong(s.id, "원곡 그대로"))}>원곡 그대로 부르기</button></>}
                          </span>
                        </>
                      )}
                      {s.notice && <div className="notice-line">{s.notice}</div>}
                    </div>
                    <div className="t-actions menu-wrap">
                      <button className="reserve" onClick={() => reserve(s)} disabled={s.status === "failed"}
                        title={ready ? "예약 (아무것도 안 부르는 중이면 바로 불러요)" : "예약하면 이 곡을 먼저 만들어요"}>
                        예약{queue.includes(s.id) ? ` ${queue.filter((x) => x === s.id).length}` : ""}
                      </button>
                      <button className="more-btn" aria-label="더보기" aria-expanded={menuFor === s.id}
                        onClick={(e) => {
                          // 목록 상자가 메뉴를 자르지 않게 화면 기준(fixed)으로 띄운다. 아래 공간이 모자라면 위로
                          const r = e.currentTarget.getBoundingClientRect();
                          const right = window.innerWidth - r.right;
                          setMenuPos(window.innerHeight - r.bottom < 300
                            ? { right, bottom: window.innerHeight - r.top + 6 } : { right, top: r.bottom + 6 });
                          setMenuFor(menuFor === s.id ? null : s.id);
                        }}>⋯</button>
                      {menuFor === s.id && (
                        <div className="song-menu" role="menu" style={{ position: "fixed", ...menuPos }}>
                          <button role="menuitem" onClick={() => { setMenuFor(null); setEditFor(s); }}>가사 편집</button>
                          <button role="menuitem" onClick={() => { setMenuFor(null); setLyricsFor(s); }}>다른 가사 고르기</button>
                          {s.file && !["queued", "downloading", "checking", "separating"].includes(s.status) && MODES.filter((m) => m !== s.mode).map((m) => (
                            <button key={m} role="menuitem" onClick={() => { setMenuFor(null); act(() => remakeSong(s.id, m)); }}>
                              {m === "원곡 그대로" || m === "반주 그대로" ? `${m} 쓰기` : `${m.replace(" 분리", "")}로 다시 만들기`}
                            </button>
                          ))}
                          <button role="menuitem" className="danger" onClick={() => removeSong(s)}>목록에서 지우기</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <QueuePanel queue={queue} songs={songs} onChange={changeQueue} onStart={playNext} playing={!!playing} />
      </div>

      {playing && <Player key={playing.n} song={songs.find((s) => s.id === playing.song.id) ?? playing.song} settings={settings}
        onSettings={setSettings} next={nextSong} onEnded={playNext} onCancel={cancelSong} lyricsRev={lyricsRev}
        onError={setError} onChanged={refresh} tv={tv} onStage={setOnStage} />}
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
      {!settings.onboarded && <Onboarding onDone={() => setSettings((s) => ({ ...s, onboarded: true }))} />}
      {settingsOpen && <Settings settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} micLatency={micLatency} onChanged={refresh}
        appUpdate={update} onInstallUpdate={installUpdate} />}
      {addOpen && <AddSong defaultMode={settings.default_mode} onClose={() => setAddOpen(false)} onAdded={refresh} />}
    </div>
  );
}
