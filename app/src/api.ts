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
  status: "ready" | "queued" | "checking" | "confirm" | "separating" | "failed";
  progress?: number;
  error?: string | null;
  stems?: { instrumental: string; vocals: string; chorus?: string };
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

export const retrySong = (id: string) => call<Song>(`/songs/${id}/retry`, { method: "POST" });

/** 반주 같다고 물어본 곡: keep = 분리 없이 반주로 쓰기, separate = 그래도 분리 */
export const decideSong = (id: string, choice: "keep" | "separate") =>
  call<Song>(`/songs/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }) });

export const audioUrl = async (id: string, part: Part = "original") => `${await engineUrl()}/songs/${id}/audio?part=${part}`;
