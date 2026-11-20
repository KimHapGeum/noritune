import { useEffect, useRef, useState } from "react";
import { audioUrl, autoLyrics, chooseLyrics, getCandidates, searchLyricsAgain, type LyricsCandidate, type Song } from "./api";
import { PauseIcon, PlayIcon, XIcon } from "./icons";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const stamp = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const AUTO = -1; // 목록 맨 밑 "가사 자동 생성"
const TAG: Record<string, string> = { "지금 쓰는 가사": "now", "시간 맞춤": "synced", "글자만": "plain", "라이브": "live", "추천": "rec" };

/** 다른 가사 고르기 (기획서 F4, 시안 11번). 후보가 모두 별로면 맨 밑의 자동 생성을 고른다 */
export default function LyricsChooser({ song, onClose, onChanged, onEdit }: {
  song: Song; onClose: () => void; onChanged: () => void; onEdit: () => void;
}) {
  const [cands, setCands] = useState<LyricsCandidate[] | null>(null);
  const [pick, setPick] = useState<number | null>(song.lyrics?.candidate_id ?? null);
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const curRef = useRef<HTMLDivElement>(null);
  const noVoice = song.mode === "반주 그대로" && !song.stems; // 목소리가 없어 음성 인식을 못 한다
  const using = song.lyrics?.state === "internet" ? song.lyrics.candidate_id : undefined;

  const load = () =>
    getCandidates(song.id)
      .then((c) => {
        setCands(c);
        setPick((p) => p ?? c.find((x) => x.recommended)?.id ?? c.find((x) => x.synced)?.id ?? (noVoice ? null : AUTO));
      })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    audioUrl(song.id, "original").then((u) => audio.current && (audio.current.src = u));
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

  async function apply(thenEdit = false) {
    if (pick === null) return;
    setBusy(true);
    audio.current?.pause();
    try {
      if (pick === AUTO) await autoLyrics(song.id);
      else await chooseLyrics(song.id, pick);
      onChanged();
      if (thenEdit) onEdit();
      else onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const sel = cands?.find((c) => c.id === pick);
  // 노래와 함께 미리 듣기: 첫 가사 2초 앞부터 틀고, 지금 줄을 크게
  function togglePlay() {
    const a = audio.current;
    if (!a || !sel?.lines.length) return;
    if (!a.paused) return a.pause();
    if (a.currentTime < 0.1 || t > (sel.lines[sel.lines.length - 1]?.t ?? 0) + 10) a.currentTime = Math.max(0, sel.lines[0].t - 2);
    a.play().catch((e) => setErr(`소리를 틀지 못했어요: ${e.message}`));
  }
  let cur = -1;
  if (sel && playing) while (cur + 1 < sel.lines.length && sel.lines[cur + 1].t <= t) cur++;
  // 중괄호 필수: 요즘 Chromium의 scrollIntoView는 Promise를 돌려주는데, 그대로 돌려주면 React가 정리 함수로 불러 죽는다
  useEffect(() => { curRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [cur]);

  const tags = (c: LyricsCandidate) => [
    c.id === using && "지금 쓰는 가사",
    c.recommended && "추천",
    /live|라이브/i.test(c.title) && "라이브",
    c.synced ? "시간 맞춤" : "글자만",
  ].filter(Boolean) as string[];

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog chooser" role="dialog" aria-label="가사 후보 고르기">
        <div className="dialog-head">
          <div>
            <h2>다른 가사 고르기</h2>
            <div className="muted small">{song.title} · {song.artist || "가수 모름"} · 곡 길이 {fmt(song.duration)} · 인터넷에서 찾은 후보 {cands?.length ?? 0}개</div>
          </div>
          <button className="icon-btn boxed" aria-label="닫기" onClick={onClose}><XIcon /></button>
        </div>
        <div className="dialog-body">
          <section className="ch-list" aria-label="후보 목록">
            {cands === null && <p className="muted">불러오는 중…</p>}
            {cands?.length === 0 && <p className="muted">인터넷에서 찾은 가사가 없어요. 제목·가수를 고쳐 다시 찾거나 자동 생성을 고르세요.</p>}
            {cands?.map((c) => (
              <button key={c.id} className={`ch-cand${pick === c.id ? " on" : ""}`} aria-pressed={pick === c.id}
                onClick={() => setPick(c.id)} disabled={!c.synced} title={c.synced ? "" : "시간 정보가 없는 가사는 아직 고를 수 없어요"}>
                <span className="ch-top">
                  <b>{c.title}{c.artist && c.artist !== song.artist ? ` · ${c.artist}` : ""}</b>
                  <span className={c.diff !== null && Math.abs(c.diff) <= 3 ? "ok" : "far"}>
                    {c.duration ? fmt(c.duration) : "—"} ({c.diff === null ? "시간 없음" : `${c.diff > 0 ? "+" : c.diff < 0 ? "" : "±"}${c.diff}초`})
                  </span>
                </span>
                <span className="ch-tags">{tags(c).map((x) => <span key={x} className={`tag tag-${TAG[x]}`}>{x}</span>)}</span>
                <span className="muted ell">{c.lines[0] ? `[${stamp(c.lines[0].t)}] ${c.lines[0].text}` : c.plain.split("\n")[0]}</span>
              </button>
            ))}
            <button className={`ch-cand auto${pick === AUTO ? " on" : ""}`} aria-pressed={pick === AUTO} onClick={() => setPick(AUTO)} disabled={noVoice}>
              <b>가사 자동 생성</b>
              <span className="muted">{noVoice ? "목소리가 없는 반주라 만들 수 없어요" : "마음에 드는 후보가 없으면, 노래 속 목소리를 듣고 가사를 만들어요"}</span>
            </button>
            <div className="ch-search">
              <input aria-label="제목" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input aria-label="가수" value={artist} onChange={(e) => setArtist(e.target.value)} />
              <button onClick={searchAgain} disabled={busy}>다시 찾기</button>
            </div>
          </section>
          <section className="ch-preview" aria-label="미리 보기">
            {pick === AUTO ? (
              <div className="ch-auto">
                <b>가사를 자동으로 만들어요</b>
                <p>분리한 목소리를 음성 인식으로 받아 적어 시간까지 맞춰요. 4분 곡에 약 15초 걸려요.<br />낯선 단어나 조용한 부분은 틀릴 수 있어요. 만든 뒤 가사 편집기에서 고칠 수 있어요.</p>
                <div className="ch-warn">곡 목록에는 "인터넷"이 아니라 <b>"자동 생성"</b>으로 표시돼요</div>
                <div className="muted small">목소리가 없는 반주(Inst)만 있는 곡은 만들 수 없어요</div>
              </div>
            ) : sel ? (
              <>
                <div className="ch-play">
                  <button className="ch-playbtn" aria-label="노래와 함께 미리 듣기" onClick={togglePlay}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
                  <span>노래와 함께 들으며 시간이 맞는지 확인하세요</span>
                </div>
                <div className="ch-lines">
                  {sel.lines.map((l, i) => (
                    <div key={i} ref={i === cur ? curRef : undefined} className={`ch-line${i === cur ? " cur" : ""}`}>
                      <span className="ch-t">{stamp(l.t)}</span><span>{l.text}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="muted">왼쪽에서 가사를 고르세요.</p>}
            {err && <div className="error inline" role="alert">{err}</div>}
            <div className="ch-foot">
              {pick === AUTO || pick === null
                ? <button className="sp-btn big" onClick={() => { audio.current?.pause(); onEdit(); }}>직접 쓰기</button>
                : <button className="sp-btn big" onClick={() => apply(true)} disabled={busy}>바꾸고 편집기에서 고치기</button>}
              <button className="primary" onClick={() => apply()} disabled={pick === null || busy}>{pick === AUTO ? "자동 생성으로 만들기" : "이 가사로 바꾸기"}</button>
            </div>
          </section>
        </div>
        <audio ref={audio} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} />
      </div>
    </div>
  );
}
