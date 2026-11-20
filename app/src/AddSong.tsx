import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { addSong, addYoutube, previewLyrics, probeFile, searchYoutube, type Gender, type LyricsCandidate, type Mode, type YtResult } from "./api";
import { XIcon } from "./icons";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "ogg", "opus"];
const KIND_TAG = { karaoke: "가사 포함", mr: "MR", inst: "Inst", normal: "" } as const;
const KIND_NOTE = {
  karaoke: "가사가 들어 있는 노래방 영상이에요. 영상을 그대로 띄우고 앱 가사는 숨겨요.",
  mr: "MR 영상은 화면에 가사가 나오는 경우가 많아요. 가사가 나오는지 골라 주세요.",
  inst: "Inst 반주라 \"이미 반주예요\"로 골라 뒀어요. 영상에 가사가 없어 앱 가사를 띄워요.",
  normal: "",
};
// 반주 만들기 카드 (시안 4번). 화면에는 "이미 반주예요"로 보이는 것이 처리기의 "반주 그대로"
const MODE_CARDS: { mode: Mode; title: string; desc: string }[] = [
  { mode: "반주 그대로", title: "이미 반주예요", desc: "분리하지 않아요 · 바로 준비" },
  { mode: "원곡 그대로", title: "원곡 그대로 부르기", desc: "가수 목소리와 함께 · 바로 준비 · 반주는 나중에 만들 수 있어요" },
  { mode: "빠른 분리", title: "빠른 분리", desc: "약 1분 · 코러스는 반주에 남아요" },
  { mode: "고품질 분리", title: "고품질 분리", desc: "약 5분 · 가이드 보컬·코러스 조절 가능" },
];
const GENDERS: [Gender | "", string][] = [["male", "남"], ["female", "여"], ["mixed", "혼성"], ["", "모름"]];
const AUTO = -1; // 가사 자동 생성

/** 곡 추가 (기획서 F1·F2·F4·F8, 시안 4번): 내 파일 또는 유튜브, 곡 정보·원곡 가수·반주 방식·가사를 한 번에 */
export default function AddSong({ defaultMode, onClose, onAdded }: { defaultMode: Mode; onClose: () => void; onAdded: () => void }) {
  const [tab, setTab] = useState<"file" | "youtube">("youtube");
  // 유튜브
  const [q, setQ] = useState("");
  const [karaokeOnly, setKaraokeOnly] = useState(true);
  const [results, setResults] = useState<YtResult[]>([]);
  const [pick, setPick] = useState<YtResult | null>(null);
  const [answer, setAnswer] = useState<"yes" | "no" | "unknown" | "">("");
  // 내 파일
  const [files, setFiles] = useState<string[]>([]);
  const [fileDur, setFileDur] = useState(0);
  // 곡 정보
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [cands, setCands] = useState<LyricsCandidate[] | null>(null);
  const [lyr, setLyr] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const kind = tab === "youtube" ? pick?.kind ?? "normal" : "normal";
  const fixedMode = kind !== "normal"; // 노래방·MR·Inst 영상은 이미 반주
  const effMode: Mode = fixedMode ? "반주 그대로" : mode;
  const appLyrics = kind !== "karaoke" && !(kind === "mr" && answer === "yes");
  const noVoice = effMode === "반주 그대로"; // 목소리가 없으면 자동 생성 불가
  const ready = tab === "youtube" ? !!pick : files.length > 0;
  const single = tab === "youtube" || files.length === 1;
  const duration = tab === "youtube" ? pick?.duration ?? 0 : fileDur;

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

  async function pickFiles() {
    const picked = await open({ multiple: true, filters: [{ name: "노래 파일", extensions: AUDIO_EXTS }] });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!list.length) return;
    setFiles(list);
    setErr("");
    if (list.length === 1) {
      try {
        const info = await probeFile(list[0]);
        setTitle(info.title);
        setArtist(info.artist);
        setFileDur(info.duration);
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  }

  // 제목·가수가 바뀌면 0.6초 뒤 가사 후보를 다시 찾는다 (위 3개, 추천을 미리 고른다)
  useEffect(() => {
    if (!single || !appLyrics || !title.trim()) return setCands(null);
    setCands(null);
    const t = setTimeout(() => {
      previewLyrics(title, artist, duration).then((c) => {
        setCands(c);
        const rec = c.find((x) => x.recommended) ?? c.find((x) => x.synced);
        setLyr(rec ? rec.id : null);
      }).catch(() => setCands([]));
    }, 600);
    return () => clearTimeout(t);
  }, [title, artist, duration, single, appLyrics]);
  useEffect(() => {
    if (noVoice && lyr === AUTO) setLyr(null);
  }, [noVoice]);

  async function add() {
    setBusy(true);
    setErr("");
    const extra = { gender: gender || undefined, lyrics_pick: lyr ?? undefined };
    try {
      if (tab === "youtube" && pick) {
        await addYoutube({ id: pick.id, video_title: pick.title, title, artist, duration: pick.duration, mode: effMode,
          ...(kind === "mr" && answer ? { lyrics_in_video: answer } : {}), ...extra });
      } else {
        const failed: string[] = [];
        for (const f of files) {
          try {
            await addSong(f, effMode, single ? { title, artist, ...extra } : { gender: extra.gender });
          } catch (e) {
            failed.push(`${f.split(/[\\/]/).pop()}: ${(e as Error).message}`);
          }
        }
        if (failed.length) throw new Error(failed.join("\n"));
      }
      onAdded();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog add-song" role="dialog" aria-label="곡 추가">
        <div className="dialog-head">
          <h2>곡 추가</h2>
          <button className="icon-btn boxed" aria-label="닫기" onClick={onClose}><XIcon /></button>
        </div>
        <div className="dialog-body">
          <section className="as-left">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "file"} className={tab === "file" ? "on" : ""} onClick={() => setTab("file")}>내 파일</button>
              <button role="tab" aria-selected={tab === "youtube"} className={tab === "youtube" ? "on" : ""} onClick={() => setTab("youtube")}>유튜브</button>
            </div>
            {tab === "youtube" ? (
              <>
                <form onSubmit={find} className="as-search">
                  <label className="as-input">
                    <span className="sr-only">유튜브 주소 또는 검색어</span>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="유튜브 주소 또는 검색어" autoFocus />
                  </label>
                  <button className="as-btn" disabled={busy || !q.trim()}>{busy && !pick ? "찾는 중…" : "검색"}</button>
                </form>
                <label className="check big">
                  <input type="checkbox" checked={karaokeOnly} onChange={(e) => setKaraokeOnly(e.target.checked)} />
                  노래방·MR만 찾기 <span className="muted small">분리 없이 바로 부를 수 있어요</span>
                </label>
                <div className="as-results">
                  {results.map((r) => (
                    <label key={r.id} className={`as-result${pick?.id === r.id ? " on" : ""}`}>
                      <input type="radio" name="pick" checked={pick?.id === r.id} onChange={() => choose(r)} />
                      <img src={r.thumbnail} alt="" width={96} height={54} />
                      <span className="as-rtext">
                        <b>{r.title}</b>
                        <span className="muted small">{r.channel} · {fmt(r.duration)}</span>
                      </span>
                      {r.kind !== "normal" && <span className={`kind kind-${r.kind}`}>{KIND_TAG[r.kind]}</span>}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <>
                <button className="as-drop" onClick={pickFiles}>
                  <b>노래 파일 고르기…</b>
                  <span className="muted small">MP3·WAV·FLAC·M4A · 여러 개를 한꺼번에 골라도 돼요</span>
                </button>
                {files.length > 0 && (
                  <ul className="as-files">
                    {files.map((f) => <li key={f}>{f.split(/[\\/]/).pop()}</li>)}
                  </ul>
                )}
              </>
            )}
            <div className="muted small">MP3·WAV·FLAC 파일은 이 창이나 곡 목록에 끌어다 놓아도 돼요</div>
          </section>

          <section className="as-right">
            <h3>곡 정보</h3>
            {!ready ? <p className="muted">{tab === "youtube" ? "왼쪽에서 영상을 찾아 고르세요." : "왼쪽에서 노래 파일을 고르세요."}</p> : (
              <>
                {single ? (
                  <>
                    <label className="field">제목<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                    <label className="field">가수<input value={artist} onChange={(e) => setArtist(e.target.value)} /></label>
                  </>
                ) : <p className="muted small">{files.length}곡: 제목·가수는 파일 정보로 넣어요</p>}
                <fieldset className="fs">
                  <legend>원곡 가수 (남자키·여자키 기준)</legend>
                  <div className="g-grid">
                    {GENDERS.map(([v, label]) => (
                      <label key={label} className={`g-opt${gender === v ? " on" : ""}`}>
                        <input type="radio" name="g" checked={gender === v} onChange={() => setGender(v)} />{label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="fs">
                  <legend>반주 만들기</legend>
                  {MODE_CARDS.map((c) => (
                    <label key={c.mode} className={`m-card${effMode === c.mode ? " on" : ""}${fixedMode && c.mode !== "반주 그대로" ? " dim" : ""}`}>
                      <input type="radio" name="m" checked={effMode === c.mode} disabled={fixedMode} onChange={() => setMode(c.mode)} />
                      <span><b>{c.title}</b>{c.mode === defaultMode && <span className="m-default"> 기본</span>}<br /><span className="muted small">{c.desc}</span></span>
                    </label>
                  ))}
                  {fixedMode && <div className="as-note">{KIND_NOTE[kind]}</div>}
                  {kind === "mr" && (
                    <div className="ask-lyrics" role="radiogroup" aria-label="이 영상에 가사가 나오나요?">
                      <span>이 영상에 가사가 나오나요?</span>
                      {([["yes", "예"], ["no", "아니요"], ["unknown", "모르겠어요"]] as const).map(([v, label]) => (
                        <label key={v}><input type="radio" name="ans" checked={answer === v} onChange={() => setAnswer(v)} /> {label}</label>
                      ))}
                    </div>
                  )}
                </fieldset>
                {single && (
                  <fieldset className="fs">
                    <legend>가사 <span className="muted">· 제목·가수로 찾은 후보 3개</span></legend>
                    {!appLyrics ? <div className="as-note">영상에 가사가 있어 앱 가사를 찾지 않아요</div>
                      : cands === null ? <p className="muted small">찾는 중…</p> : (
                        <>
                          {cands.length === 0 && <p className="muted small">후보를 못 찾았어요. 추가한 뒤 자동 생성하거나 직접 쓸 수 있어요.</p>}
                          {cands.slice(0, 3).map((c) => (
                            <label key={c.id} className={`l-card${lyr === c.id ? " on" : ""}${c.synced ? "" : " dim"}`}>
                              <input type="radio" name="lyr" checked={lyr === c.id} disabled={!c.synced} onChange={() => setLyr(c.id)} />
                              <span className="l-text">
                                <span className="l-top"><b>{c.title} · {c.synced ? "시간 맞춤" : "글자만"}{c.recommended ? " (추천)" : ""}</b>
                                  <span className={c.diff !== null && Math.abs(c.diff) <= 3 ? "ok" : "far"}>{c.diff === null ? "시간 없음" : `${c.diff > 0 ? "+" : ""}${c.diff}초`}</span></span>
                                <span className="muted small ell">{c.lines[0]?.text ?? c.plain.split("\n")[0]}</span>
                              </span>
                            </label>
                          ))}
                          <label className={`l-card auto${lyr === AUTO ? " on" : ""}${noVoice ? " dim" : ""}`}>
                            <input type="radio" name="lyr" checked={lyr === AUTO} disabled={noVoice} onChange={() => setLyr(AUTO)} />
                            <span><b>가사 자동 생성</b><span className="muted small" style={{ display: "block" }}>{noVoice ? "목소리가 없는 반주라 만들 수 없어요" : "곡이 준비되면 노래 속 목소리를 듣고 만들어요"}</span></span>
                          </label>
                          <div className="muted small">제목·가수를 고치면 다시 찾아요</div>
                        </>
                      )}
                  </fieldset>
                )}
              </>
            )}
          </section>
        </div>
        {err && <div className="error inline" role="alert">{err}</div>}
        <div className="dialog-foot">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={add} disabled={!ready || busy || (kind === "mr" && !answer) || (single && !title.trim())}>
            {busy ? "추가하는 중…" : "추가하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
