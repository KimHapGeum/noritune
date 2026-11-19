import { invoke } from "@tauri-apps/api/core";

export const MODES = ["빠른 분리", "고품질 분리", "반주 그대로", "원곡 그대로"] as const;
export type Mode = (typeof MODES)[number];
export type Part = "original" | "instrumental" | "vocals" | "chorus";

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
  stems?: { instrumental: string; vocals: string; chorus?: string };
  gender?: Gender;
  prefs?: Prefs;
};
export type Gender = "male" | "female" | "mixed";
export type Prefs = {
  key?: number; preset?: "orig" | "male" | "female"; tempo?: number;
  guide?: number; chorus?: number; lowpass?: number; verb?: number;
};

let base: Promise<string> | null = null;
/** 처리기 주소. 포트는 Rust가 처리기를 켤 때 받아 둔다. */
const engineUrl = () => (base ??= invoke<number>("engine_port").then((p) => `http://127.0.0.1:${p}`));

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch((await engineUrl()) + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `처리기 오류 (${res.status})`);
  return body as T;
}

export const listSongs = () => call<{ songs: Song[] }>("/songs").then((r) => r.songs);

export const addSong = (path: string, mode: Mode) =>
  call<Song>("/songs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, mode }) });

export type LyricsState = "searching" | "review" | "internet" | "generating" | "auto" | "file" | "none" | "off" | "manual";
export type LyricLine = { t: number; text: string };
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
  lyrics_in_video?: "yes" | "no" | "unknown";
}) => call<Song>("/songs/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 곡마다 기억하는 키·속도·소리 섞기, 원곡 가수 성별 */
export const savePrefs = (id: string, body: Prefs & { gender?: Gender }) =>
  call<Song>(`/songs/${id}/prefs`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 앱 설정 (모든 곡에 같이 쓴다) */
export type Settings = { lyrics_delay: number };
export const getSettings = () => call<Settings>("/settings");
export const putSettings = (body: Settings) =>
  call<Settings>("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 예약 목록 (곡 번호 줄) */
export const getQueue = () => call<{ queue: string[] }>("/queue").then((r) => r.queue);
export const putQueue = (queue: string[]) =>
  call<{ queue: string[] }>("/queue", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue }) });

export const retrySong = (id: string) => call<Song>(`/songs/${id}/retry`, { method: "POST" });

/** 반주 같다고 물어본 곡: keep = 분리 없이 반주로 쓰기, separate = 그래도 분리 */
export const decideSong = (id: string, choice: "keep" | "separate") =>
  call<Song>(`/songs/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }) });

export const audioUrl = async (id: string, part: Part = "original") => `${await engineUrl()}/songs/${id}/audio?part=${part}`;
