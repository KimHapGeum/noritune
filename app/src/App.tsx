import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { addSong, audioUrl, listSongs, type Song } from "./api";
import "./App.css";

const AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "ogg", "opus"];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState<Song | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  const refresh = () => listSongs().then(setSongs).catch((e) => setError(String(e.message ?? e)));

  async function addPaths(paths: string[]) {
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const p of paths) {
      try {
        await addSong(p);
      } catch (e) {
        failed.push(`${p.split(/[\\/]/).pop()}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (failed.length) setError(failed.join("\n"));
    refresh();
  }

  async function pickFiles() {
    const picked = await open({ multiple: true, filters: [{ name: "노래 파일", extensions: AUDIO_EXTS }] });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function play(song: Song) {
    setPlaying(song);
    const el = audio.current!;
    el.src = await audioUrl(song.id);
    el.play().catch((e) => setError(`재생하지 못했어요: ${e.message}`));
  }

  useEffect(() => {
    refresh();
    // 창에 파일을 끌어다 놓으면 곡 추가
    const off = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") setDragging(true);
      else setDragging(false);
      if (e.payload.type === "drop") addPaths(e.payload.paths);
    });
    return () => void off.then((f) => f());
  }, []);

  return (
    <div className={`app${dragging ? " dragging" : ""}`}>
      <header className="top">
        <h1>Noritune</h1>
        <button className="primary" onClick={pickFiles} disabled={busy}>
          {busy ? "추가하는 중…" : "+ 곡 추가"}
        </button>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="알림 닫기" onClick={() => setError("")}>✕</button>
        </div>
      )}

      <main>
        <h2>
          내 노래 <span className="muted">{songs.length}곡</span>
        </h2>
        {songs.length === 0 ? (
          <p className="empty">노래 파일(MP3·WAV·FLAC)을 이 창에 끌어다 놓거나 "곡 추가"를 누르세요.</p>
        ) : (
          <ul className="songs">
            {songs.map((s) => (
              <li key={s.id} className={playing?.id === s.id ? "on" : ""}>
                <button onClick={() => play(s)}>
                  <span className="title">{s.title}</span>
                  <span className="muted">{s.artist || "가수 모름"} · {fmt(s.duration)}</span>
                  <span className="chip">{s.mode}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="player" hidden={!playing}>
        <div>
          <b>{playing?.title}</b> <span className="muted">{playing?.artist}</span>
        </div>
        <audio ref={audio} controls />
      </footer>
    </div>
  );
}
