import { useState } from "react";
import { addYoutube, MODES, searchYoutube, type Mode, type YtResult } from "./api";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const KIND_LABEL = { karaoke: "가사 포함 노래방", mr: "MR", inst: "Inst 반주", normal: "" } as const;
const KIND_NOTE = {
  karaoke: "가사가 들어 있는 노래방 영상이에요. 영상을 그대로 띄우고 앱 가사는 숨겨요. 이미 반주라 분리하지 않아요.",
  mr: "MR 영상은 화면에 가사가 나오는 경우가 많아요. 가사가 나오는지 골라 주세요.",
  inst: "Inst 반주라 분리하지 않아요. 영상에 가사가 없어 앱 가사를 띄워요.",
  normal: "",
};

/** 유튜브에서 곡 추가 (기획서 F2, F12) */
export default function YoutubeDialog({ defaultMode, onClose, onAdded }: {
  defaultMode: Mode;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [q, setQ] = useState("");
  const [karaokeOnly, setKaraokeOnly] = useState(true);
  const [results, setResults] = useState<YtResult[]>([]);
  const [pick, setPick] = useState<YtResult | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [answer, setAnswer] = useState<"yes" | "no" | "unknown" | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function find(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await searchYoutube(q, karaokeOnly);
      setResults(r);
      if (r.length) choose(r[0]);
      else setErr("찾은 영상이 없어요");
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  function choose(r: YtResult) {
    setPick(r);
    setTitle(r.guess.title);
    setArtist(r.guess.artist);
    setAnswer("");
  }

  async function add() {
    if (!pick) return;
    setBusy(true);
    try {
      await addYoutube({
        id: pick.id, video_title: pick.title, title, artist, duration: pick.duration, mode,
        ...(pick.kind === "mr" && answer ? { lyrics_in_video: answer } : {}),
      });
      onAdded();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const needAnswer = pick?.kind === "mr" && !answer;

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="유튜브에서 추가">
        <div className="dialog-head">
          <h2>유튜브에서 추가</h2>
          <button aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="dialog-body">
          <section className="yt-search">
            <form onSubmit={find} className="yt-query">
              <input aria-label="유튜브 주소 또는 검색어" placeholder="유튜브 주소 또는 검색어" value={q}
                onChange={(e) => setQ(e.target.value)} autoFocus />
              <button className="primary" disabled={busy || !q.trim()}>{busy && !pick ? "찾는 중…" : "검색"}</button>
            </form>
            <label className="check">
              <input type="checkbox" checked={karaokeOnly} onChange={(e) => setKaraokeOnly(e.target.checked)} />
              노래방·MR만 찾기 <span className="muted">분리 없이 바로 부를 수 있어요</span>
            </label>
            <ul className="yt-results">
              {results.map((r) => (
                <li key={r.id}>
                  <button className={pick?.id === r.id ? "on" : ""} onClick={() => choose(r)}>
                    <img src={r.thumbnail} alt="" width={96} height={54} />
                    <span className="yt-text">
                      <span className="yt-title">{r.title}</span>
                      <span className="muted">{r.channel} · {fmt(r.duration)}</span>
                    </span>
                    {r.kind !== "normal" && <span className={`kind kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="yt-info">
            <h3>곡 정보</h3>
            {!pick ? (
              <p className="muted">왼쪽에서 영상을 고르세요.</p>
            ) : (
              <>
                <label>제목<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                <label>가수<input value={artist} onChange={(e) => setArtist(e.target.value)} /></label>
                {pick.kind === "normal" ? (
                  <label>반주 만들기
                    <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                      {MODES.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </label>
                ) : (
                  <p className="note">{KIND_NOTE[pick.kind]}</p>
                )}
                {pick.kind === "mr" && (
                  <fieldset className="ask-lyrics">
                    <legend>이 영상에 가사가 나오나요?</legend>
                    {([["yes", "예"], ["no", "아니요"], ["unknown", "모르겠어요"]] as const).map(([v, label]) => (
                      <label key={v}>
                        <input type="radio" name="lyr" checked={answer === v} onChange={() => setAnswer(v)} /> {label}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            )}
          </section>
        </div>
        {err && <div className="error inline" role="alert">{err}</div>}
        <div className="dialog-foot">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={add} disabled={!pick || busy || needAnswer || !title.trim()}>추가하기</button>
        </div>
      </div>
    </div>
  );
}
