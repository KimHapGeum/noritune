import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { audioUrl, getLyrics, saveLyrics, type Song } from "./api";

type Row = { key: number; t: number; text: string };

const fmtT = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** "01:23.45", "1:23", "83.4" 를 초로. 못 읽으면 null */
export function parseT(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const t = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(t) ? Math.round(t * 100) / 100 : null;
}
let nextKey = 0;
const typing = (e: KeyboardEvent) => (e.target as HTMLElement).closest?.("input, textarea, select") != null;

/**
 * 가사 편집기 (기획서 F5): 줄 글자·시간 고치기, 줄 넣기·지우기, 탭으로 시간 찍기, 전체 시간 옮기기.
 * startAt: 재생 화면에서 열면 지금 부르던 위치. 그 줄부터 보여 주고 찍는다.
 */
export default function LyricsEditor({ song, startAt = 0, onClose, onChooseOther }: {
  song: Song; startAt?: number; onClose: (saved: boolean) => void; onChooseOther?: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tapIdx, setTapIdx] = useState(0); // 다음에 시간을 찍을 줄
  const [cur, setCur] = useState(startAt);
  const [playing, setPlaying] = useState(false);
  const [shift, setShift] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const rowEls = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    // 탭 싱크는 목소리가 들려야 하니 원곡을 튼다
    Promise.all([getLyrics(song.id), audioUrl(song.id, "original")])
      .then(([r, u]) => {
        const rs = r.lines.map((l) => ({ key: nextKey++, ...l }));
        setRows(rs);
        // 지금 부르던 줄에서 열고, 그 줄을 다시 찍을 수 있게 2초 앞에서 튼다
        const i = Math.max(0, rs.filter((l) => l.t <= startAt).length - 1);
        setTapIdx(i);
        if (!audio.current) return;
        audio.current.src = u;
        audio.current.currentTime = rs.length ? Math.max(0, Math.min(startAt, rs[i].t - 2)) : startAt;
      })
      .catch((e) => setErr(e.message));
  }, [song.id]);

  // 열 때 그 줄이 보이도록
  useEffect(() => {
    if (rows) rowEls.current.get(rows[tapIdx]?.key)?.scrollIntoView({ block: "center" });
  }, [rows === null]);

  function edit(fn: (rs: Row[]) => Row[]) {
    setRows((rs) => (rs ? fn(rs) : rs));
    setDirty(true);
  }

  function tap() {
    if (!rows || tapIdx >= rows.length) return;
    const t = Math.round((audio.current?.currentTime ?? 0) * 100) / 100;
    edit((rs) => rs.map((r, i) => (i === tapIdx ? { ...r, t } : r)));
    setTapIdx(tapIdx + 1);
    rowEls.current.get(rows[tapIdx + 1]?.key)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function togglePlay() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch((e) => setErr(`소리를 틀지 못했어요: ${e.message}`));
    else a.pause();
  }

  function playFrom(i: number) {
    const a = audio.current;
    if (!a || !rows) return;
    a.currentTime = Math.max(0, rows[i].t - 1);
    setTapIdx(i);
    a.play().catch(() => {});
  }

  function shiftAll(d: number) {
    edit((rs) => rs.map((r) => ({ ...r, t: Math.max(0, Math.round((r.t + d) * 100) / 100) })));
    setShift((s) => Math.round((s + d) * 10) / 10);
  }

  async function close() {
    if (dirty && !(await ask("저장하지 않은 변경이 있어요. 저장하지 않고 닫을까요?", { title: "가사 편집", kind: "warning" }))) return;
    audio.current?.pause();
    onClose(false);
  }

  async function save() {
    if (!rows) return;
    setBusy(true);
    try {
      await saveLyrics(song.id, rows.map(({ t, text }) => ({ t, text })));
      audio.current?.pause();
      onClose(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  // 스페이스바: 시간 찍기, Esc: 닫기 (글자를 고치는 중에는 그대로 둔다)
  const keys = useRef({ tap, close });
  keys.current = { tap, close };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") return void keys.current.close();
      if (e.code === "Space" && !typing(e)) {
        e.preventDefault();
        keys.current.tap();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  let playingIdx = -1;
  if (rows && playing) while (playingIdx + 1 < rows.length && rows[playingIdx + 1].t <= cur) playingIdx++;
  const duration = audio.current?.duration || song.duration;

  return (
    <div className="backdrop">
      <div className="dialog editor" role="dialog" aria-label="가사 편집">
        <div className="dialog-head">
          <h2>가사 편집 · {song.title} <span className="muted">{song.artist} · {fmt(song.duration)}</span></h2>
          <span className="head-actions">
            {song.lyrics?.state === "auto" && <span className="kind kind-mr">자동 생성 가사 · 틀린 곳이 있을 수 있어요</span>}
            {onChooseOther && <button className="text-btn" onClick={onChooseOther}>다른 가사 고르기</button>}
            <button aria-label="닫기" onClick={close}>✕</button>
          </span>
        </div>
        <div className="dialog-body">
          <section className="ed-lines">
            {rows === null ? <p className="muted">불러오는 중…</p> : (
              <>
                <div className="ed-row ed-headrow muted"><span>시간</span><span>가사</span></div>
                <ol>
                  {rows.map((r, i) => (
                    <li key={r.key} ref={(el) => void (el ? rowEls.current.set(r.key, el) : rowEls.current.delete(r.key))}
                      className={`ed-row${i === playingIdx ? " now" : ""}${i === tapIdx ? " next" : ""}`}>
                      <input key={`${r.key}-${r.t}`} className="ed-t" defaultValue={fmtT(r.t)} aria-label={`${i + 1}번째 줄 시간`}
                        onBlur={(e) => {
                          const t = parseT(e.target.value);
                          if (t === null) e.target.value = fmtT(r.t);
                          else if (t !== r.t) edit((rs) => rs.map((x) => (x.key === r.key ? { ...x, t } : x)));
                        }} />
                      <input className="ed-text" value={r.text} aria-label={`${i + 1}번째 줄 가사`}
                        onChange={(e) => edit((rs) => rs.map((x) => (x.key === r.key ? { ...x, text: e.target.value } : x)))} />
                      <button aria-label={`${i + 1}번째 줄부터 듣기`} title="이 줄부터 듣기" onClick={() => playFrom(i)}>▶</button>
                      <button aria-label={`${i + 1}번째 줄 아래에 줄 넣기`} title="아래에 줄 넣기"
                        onClick={() => edit((rs) => [...rs.slice(0, i + 1), { key: nextKey++, t: r.t + 0.01, text: "" }, ...rs.slice(i + 1)])}>＋</button>
                      <button aria-label={`${i + 1}번째 줄 지우기`} title="줄 지우기"
                        onClick={() => {
                          edit((rs) => rs.filter((x) => x.key !== r.key));
                          if (i < tapIdx) setTapIdx(tapIdx - 1);
                        }}>✕</button>
                    </li>
                  ))}
                </ol>
                <button className="ed-add" onClick={() => edit((rs) => [...rs, { key: nextKey++, t: rs.length ? rs[rs.length - 1].t + 3 : cur, text: "" }])}>
                  ＋ 줄 넣기
                </button>
              </>
            )}
          </section>
          <section className="yt-info ed-side">
            <h3>탭으로 시간 맞추기</h3>
            <p className="muted small">노래를 틀어 두고, 각 줄이 시작될 때 버튼이나 스페이스바를 누르세요.</p>
            <div className="seek">
              <button className="ed-play" onClick={togglePlay} aria-label={playing ? "일시정지" : "재생"}>{playing ? "❚❚" : "▶"}</button>
              <span>{fmt(cur)}</span>
              <input type="range" min={0} max={duration} step={0.1} value={cur} aria-label="재생 위치"
                onChange={(e) => audio.current && (audio.current.currentTime = Number(e.target.value))} />
              <span>{fmt(duration)}</span>
            </div>
            <p className="ed-next">
              <span className="muted">다음에 찍을 줄</span>
              <b>{rows?.[tapIdx]?.text || (rows && tapIdx >= rows.length ? "마지막 줄까지 찍었어요" : "")}</b>
            </p>
            <button className="primary" onClick={tap} disabled={!rows || tapIdx >= rows.length}>지금 시간 찍기 (스페이스바)</button>

            <h3>전체 가사 시간 옮기기</h3>
            <p className="muted small">가사가 노래보다 빠르거나 느릴 때</p>
            <div className="ed-shift">
              <button onClick={() => shiftAll(-0.1)}>0.1초 앞당기기</button>
              <b>{shift > 0 ? "+" : ""}{shift.toFixed(1)}초</b>
              <button onClick={() => shiftAll(0.1)}>0.1초 늦추기</button>
            </div>
          </section>
        </div>
        {err && <div className="error inline" role="alert">{err}</div>}
        <div className="dialog-foot">
          <button onClick={close}>닫기</button>
          <button className="primary" onClick={save} disabled={!rows || busy}>{busy ? "저장하는 중…" : "저장"}</button>
        </div>
        <audio ref={audio} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)} />
      </div>
    </div>
  );
}
