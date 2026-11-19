import { useEffect, useState } from "react";
import { autoLyrics, chooseLyrics, getCandidates, searchLyricsAgain, type LyricsCandidate, type Song } from "./api";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const AUTO = -1; // 목록 맨 밑 "가사 자동 생성"

/** 가사 후보 고르기 (기획서 F4). 후보가 모두 별로면 맨 밑의 자동 생성을 고른다. */
export default function LyricsChooser({ song, onClose, onChanged, onEdit }: {
  song: Song; onClose: () => void; onChanged: () => void; onEdit: () => void;
}) {
  const [cands, setCands] = useState<LyricsCandidate[] | null>(null);
  const [pick, setPick] = useState<number | null>(song.lyrics?.candidate_id ?? null);
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const noVoice = song.mode === "반주 그대로" && !song.stems; // 목소리가 없어 음성 인식을 못 한다

  const load = () =>
    getCandidates(song.id)
      .then((c) => {
        setCands(c);
        setPick((p) => p ?? c.find((x) => x.recommended)?.id ?? c.find((x) => x.synced)?.id ?? (noVoice ? null : AUTO));
      })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
  }, []);

  async function searchAgain() {
    setBusy(true);
    setErr("");
    try {
      await searchLyricsAgain(song.id, title, artist);
      // 검색은 뒤에서 하므로 잠깐 기다렸다 다시 불러온다
      await new Promise((r) => setTimeout(r, 4000));
      setPick(null);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  async function apply() {
    if (pick === null) return;
    setBusy(true);
    try {
      if (pick === AUTO) await autoLyrics(song.id);
      else await chooseLyrics(song.id, pick);
      onChanged();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const sel = cands?.find((c) => c.id === pick);

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="가사 고르기">
        <div className="dialog-head">
          <h2>가사 고르기 <span className="muted">{song.title} · 곡 길이 {fmt(song.duration)}</span></h2>
          <button aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="dialog-body">
          <section className="yt-search">
            {cands === null && <p className="muted">불러오는 중…</p>}
            {cands?.length === 0 && <p className="muted">인터넷에서 찾은 가사가 없어요. 제목·가수를 고쳐 다시 찾거나 자동 생성을 고르세요.</p>}
            <ul className="yt-results">
              {cands?.map((c) => (
                <li key={c.id}>
                  <button className={pick === c.id ? "on" : ""} onClick={() => setPick(c.id)} disabled={!c.synced}
                    title={c.synced ? "" : "시간 정보가 없는 가사는 아직 고를 수 없어요"}>
                    <span className="yt-text">
                      <span className="yt-title">{c.title} <span className="muted">· {c.artist}</span></span>
                      <span className="muted">{c.lines[0]?.text ?? c.plain.split("\n")[0]}</span>
                    </span>
                    {c.recommended && <span className="kind kind-karaoke">추천</span>}
                    <span className={`kind ${c.synced ? "kind-inst" : "kind-mr"}`}>{c.synced ? "시간 맞춤" : "글자만"}</span>
                    {c.diff !== null && (
                      <span className={`diff ${Math.abs(c.diff) <= 3 ? "ok" : "far"}`}>{c.diff > 0 ? "+" : ""}{c.diff}초</span>
                    )}
                  </button>
                </li>
              ))}
              <li>
                <button className={`auto-pick${pick === AUTO ? " on" : ""}`} onClick={() => setPick(AUTO)} disabled={noVoice}>
                  <span className="yt-text">
                    <span className="yt-title">가사 자동 생성</span>
                    <span className="muted">{noVoice ? "목소리가 없는 반주라 만들 수 없어요" : "마음에 드는 후보가 없으면, 노래 속 목소리를 듣고 가사를 만들어요"}</span>
                  </span>
                </button>
              </li>
            </ul>
            <div className="yt-query">
              <input aria-label="제목" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input aria-label="가수" value={artist} onChange={(e) => setArtist(e.target.value)} />
              <button onClick={searchAgain} disabled={busy}>다시 찾기</button>
            </div>
          </section>
          <section className="yt-info">
            <h3>미리 보기</h3>
            {pick === AUTO ? (
              <p className="note">
                분리한 목소리를 음성 인식으로 받아 적어 시간까지 맞춰요. 4분 곡에 10초쯤 걸려요.
                낯선 단어나 조용한 부분은 틀릴 수 있어요. 곡 목록에는 "자동 생성"으로 표시돼요.
              </p>
            ) : sel ? (
              <ol className="preview">
                {sel.lines.slice(0, 12).map((l, i) => (
                  <li key={i}><span className="muted">{fmt(l.t)}</span> {l.text}</li>
                ))}
              </ol>
            ) : (
              <p className="muted">왼쪽에서 가사를 고르세요.</p>
            )}
          </section>
        </div>
        {err && <div className="error inline" role="alert">{err}</div>}
        <div className="dialog-foot">
          <button onClick={onEdit} style={{ marginRight: "auto" }}>지금 가사 직접 고치기</button>
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={apply} disabled={pick === null || busy}>
            {pick === AUTO ? "자동 생성으로 만들기" : "이 가사로 바꾸기"}
          </button>
        </div>
      </div>
    </div>
  );
}
