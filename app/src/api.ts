import { invoke } from "@tauri-apps/api/core";

export type Song = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  mode: string;
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

export const addSong = (path: string) =>
  call<Song>("/songs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });

export const audioUrl = async (id: string) => `${await engineUrl()}/songs/${id}/audio`;
