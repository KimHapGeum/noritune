import { invoke } from "@tauri-apps/api/core";

export const MODES = ["빠른 분리", "고품질 분리", "반주 그대로", "원곡 그대로"] as const;
export type Mode = (typeof MODES)[number];
export type Part = "original" | "instrumental" | "vocals" | "chorus" | "video";

export type Song = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  mode: Mode;
  status: "ready" | "queued" | "downloading" | "checking" | "confirm" | "separating" | "failed";
  app_lyrics?: boolean;
  lyrics?: { state: LyricsState; candidate_id?: number | null; error?: string };
  video?: string | null;
  progress?: number;
  error?: string | null;
  notice?: string | null; // 하는 중에 알릴 말 (CPU로 바꿔 만들어요 등)
  file?: string | null; // 받은 원곡 (유튜브 곡은 받기 전엔 없다)
  stems?: { instrumental: string; vocals: string; chorus?: string };
  gender?: Gender;
  prefs?: Prefs;
  added_at?: string;
  plays?: number; // 부른 횟수
  last_played?: string;
};
export type Gender = "male" | "female" | "mixed";
export type Prefs = {
  key?: number; preset?: "orig" | "male" | "female"; tempo?: number;
  guide?: number; chorus?: number; lowpass?: number; verb?: number;
  lyrics?: boolean; // 이 곡에서 앱 가사를 켤지
  favorite?: boolean; // 즐겨찾기
  bg_kind?: "auto" | "default" | "youtube" | "file"; bg_value?: string | null; // 이 곡만의 배경
};

let base: Promise<string> | null = null;
/** 처리기 주소. 포트는 Rust가 처리기를 켤 때 받아 둔다. */
const engineUrl = () => (base ??= invoke<number>("engine_port").then((p) => `http://127.0.0.1:${p}`));
/** 처리기를 다시 켜면 포트가 바뀌므로 다음 요청 때 새로 묻는다 */
export const resetEngine = () => void (base = null);
export const restartEngine = () => invoke<number>("restart_engine").then(resetEngine);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch((await engineUrl()) + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `처리기 오류 (${res.status})`);
  return body as T;
}

export const listSongs = () => call<{ songs: Song[] }>("/songs").then((r) => r.songs);

/** lyrics_pick: 곡 추가 화면에서 고른 가사 후보 번호, -1이면 곡이 준비되면 자동 생성 */
export type AddExtra = { title?: string; artist?: string; gender?: Gender; lyrics_pick?: number };
export const addSong = (path: string, mode: Mode, extra: AddExtra = {}) =>
  call<Song>("/songs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, mode, ...extra }) });
export const probeFile = (path: string) => call<{ title: string; artist: string; duration: number }>(`/probe?path=${encodeURIComponent(path)}`);
export const previewLyrics = (title: string, artist: string, duration: number) =>
  call<{ candidates: LyricsCandidate[] }>(`/lyrics/search?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&duration=${duration}`).then((r) => r.candidates);

export type LyricsState = "searching" | "review" | "internet" | "generating" | "auto" | "file" | "none" | "off" | "manual";
export type LyricLine = { t: number; text: string; e?: number }; // e: 줄이 끝나는 때 (없으면 다음 줄까지)
export type LyricsCandidate = {
  id: number; title: string; artist: string; album: string; duration: number; diff: number | null;
  synced: boolean; lines: LyricLine[]; plain: string; recommended: boolean;
};

const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const getLyrics = (id: string) => call<{ state: LyricsState; lines: LyricLine[] }>(`/songs/${id}/lyrics`);
export const getCandidates = (id: string) => call<{ candidates: LyricsCandidate[] }>(`/songs/${id}/lyrics/candidates`).then((r) => r.candidates);
export const chooseLyrics = (id: string, candidateId: number) => post<Song>(`/songs/${id}/lyrics/choose`, { candidate_id: candidateId });
export const autoLyrics = (id: string) => post<Song>(`/songs/${id}/lyrics/auto`);
export const saveLyrics = (id: string, lines: LyricLine[]) =>
  call<Song>(`/songs/${id}/lyrics`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines }) });
export const searchLyricsAgain = (id: string, title: string, artist: string) => post<Song>(`/songs/${id}/lyrics/search`, { title, artist });

export type YtResult = {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  kind: "karaoke" | "mr" | "inst" | "normal";
  guess: { title: string; artist: string };
};

export const searchYoutube = (q: string, karaokeOnly: boolean) =>
  call<{ results: YtResult[] }>(`/youtube/search?q=${encodeURIComponent(q)}&karaoke_only=${karaokeOnly}`).then((r) => r.results);

export const addYoutube = (body: {
  id: string; video_title: string; title: string; artist: string; duration: number; mode: Mode;
  lyrics_in_video?: "yes" | "no" | "unknown"; gender?: Gender; lyrics_pick?: number;
}) => call<Song>("/songs/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 곡마다 기억하는 키·속도·소리 섞기, 원곡 가수 성별 */
export const savePrefs = (id: string, body: Prefs & { gender?: Gender }) =>
  call<Song>(`/songs/${id}/prefs`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 앱 설정 (모든 곡에 같이 쓴다) */
export type Settings = {
  lyrics_delay: number;
  bg_mode: "default" | "mv" | "custom"; bg_mv_fallback: "default" | "custom";
  bg_files: string[]; bg_interval: 10 | 30 | 0; bg_dim: number;
  auto_hide: boolean;
  volume: number;
  mic_on: boolean; mic_device: string; mic_volume: number; mic_echo: number;
  onboarded: boolean; ytdlp_checked: number;
  default_mode: Mode; ytdlp_auto: boolean;
};
export const DEFAULT_SETTINGS: Settings = { lyrics_delay: 0, bg_mode: "mv", bg_mv_fallback: "default", bg_files: [], bg_interval: 10, bg_dim: 55, auto_hide: true,
  volume: 100, mic_on: false, mic_device: "", mic_volume: 80, mic_echo: 30, onboarded: true, ytdlp_checked: 0, default_mode: "빠른 분리", ytdlp_auto: true };
/** 공식 뮤비 후보 (좋은 순). badMv: 틀 수 없던 것을 뺀다 */
export const findMv = (id: string) => call<{ ids: string[] }>(`/songs/${id}/mv`).then((r) => r.ids);
export const badMv = (id: string, vid: string) => post<{ ids: string[] }>(`/songs/${id}/mv/bad`, { queue: [vid] });
export const bgUrl = async (i: number) => `${await engineUrl()}/background/${i}`;
export const songBgUrl = async (id: string) => `${await engineUrl()}/songs/${id}/background`;
export const getSettings = () => call<Settings>("/settings");
export const putSettings = (body: Settings) =>
  call<Settings>("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 예약 목록 (곡 번호 줄) */
export const getQueue = () => call<{ queue: string[] }>("/queue").then((r) => r.queue);
export const putQueue = (queue: string[]) =>
  call<{ queue: string[] }>("/queue", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue }) });

export const markPlayed = (id: string) => post<Song>(`/songs/${id}/played`);

export const deleteSong = (id: string) => call<{ ok: boolean }>(`/songs/${id}`, { method: "DELETE" });
export const remakeSong = (id: string, mode: Mode) => post<Song>(`/songs/${id}/remake`, { mode });
export const getSystem = (withGpu = false) =>
  call<{ data_dir: string; free: number; synced: boolean; gpu?: string | null; models: { quick: boolean; hq: boolean } }>(`/system${withGpu ? "?with_gpu=true" : ""}`);
export type StorageSong = { id: string; title: string; artist: string; bytes: number; stems_bytes: number; stems: boolean; last_played?: string };
export type Storage = { total: number; kinds: { original: number; stems: number; video: number }; songs: StorageSong[] };
export const getStorage = () => call<Storage>("/storage");
export const trimStorage = (days: number) => post<{ songs: number; freed: number }>("/storage/trim", { days });
export const moveStorage = (path: string) => post<{ data_dir: string; restart: boolean }>("/storage/move", { path });
export const updateYtdlp = () => post<{ message: string }>("/ytdlp/update");
export const openLogs = () => post<{ path: string }>("/logs/open");

export const retrySong = (id: string) => call<Song>(`/songs/${id}/retry`, { method: "POST" });

/** 반주 같다고 물어본 곡: keep = 분리 없이 반주로 쓰기, separate = 그래도 분리 */
export const decideSong = (id: string, choice: "keep" | "separate") =>
  call<Song>(`/songs/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }) });

export const audioUrl = async (id: string, part: Part = "original") => `${await engineUrl()}/songs/${id}/audio?part=${part}`;
