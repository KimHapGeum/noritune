import type { Song } from "./api";
import { keyLabel } from "./Player";
import { PlayIcon, ToTopIcon, XIcon } from "./icons";

const making = (s: Song) => ["queued", "downloading", "checking", "separating"].includes(s.status);
const pct = (s: Song) => `${Math.round((s.progress ?? 0) * 100)}%`;
// 예약 줄의 아랫줄: 준비된 곡은 부를 키, 아니면 하는 일 (시안: "아이유 · 남자키 ♯1", "윤하 · 반주 만드는 중")
const sub = (s: Song) =>
  s.status === "ready" ? keyLabel(s.prefs?.key ?? 0, s.prefs?.preset ?? "orig", s.gender)
  : s.status === "failed" ? "만들지 못했어요"
  : s.status === "confirm" ? "분리할지 골라 주세요"
  : s.status === "downloading" ? `받는 중 ${pct(s)}`
  : s.status === "separating" ? `반주 만드는 중 ${pct(s)}`
  : "기다리는 중";

/** 예약 목록 (기획서 F7, 시안 1번 오른쪽). 같은 곡을 두 번 예약할 수 있어 자리(index)로 다룬다 */
export default function QueuePanel({ queue, songs, onChange, onStart, playing }: {
  queue: string[]; songs: Song[]; onChange: (q: string[]) => void; onStart: () => void; playing: boolean;
}) {
  // 자리 번호는 queue 기준으로 둔다 (목록을 아직 못 받은 곡이 있어도 옮기기·취소가 어긋나지 않게)
  const items = queue.flatMap((id, i) => {
    const s = songs.find((x) => x.id === id);
    return s ? [{ s, i }] : [];
  });
  const minutes = Math.round(items.reduce((t, { s }) => t + s.duration, 0) / 60);
  const toFront = (i: number) => onChange([queue[i], ...queue.filter((_, j) => j !== i)]);
  const canStart = !playing && items.some(({ s }) => s.status === "ready");

  const work = songs.filter(making);
  const now = work.find((s) => s.status === "separating" || s.status === "downloading" || s.status === "checking");

  return (
    <aside className="side">
      <section className="card queue" aria-label="예약 목록">
        <div className="card-head">
          <h2>예약 목록</h2>
          {items.length > 0 && <span className="muted">{items.length}곡 · 약 {minutes}분</span>}
        </div>
        {items.length === 0 && <p className="muted queue-empty">곡의 "예약"을 누르면 여기에 줄을 서요.</p>}
        {items.map(({ s, i }, n) => (
          <div key={`${i}-${s.id}`} className={`q-item${n === 0 ? " first" : ""}`}>
            <span className="q-n">{n + 1}</span>
            <span className="q-text">
              <span className="q-title">{s.title}</span>
              <span className="muted">{s.artist || "가수 모름"} · {sub(s)}</span>
            </span>
            <button className="icon-btn" onClick={() => toFront(i)} disabled={i === 0} aria-label={`${s.title} 맨 앞으로`} title="맨 앞으로"><ToTopIcon /></button>
            <button className="icon-btn" onClick={() => onChange(queue.filter((_, j) => j !== i))} aria-label={`${s.title} 예약 취소`} title="예약 취소"><XIcon /></button>
          </div>
        ))}
        <button className="start-btn" onClick={onStart} disabled={!canStart}>
          <PlayIcon /> 노래 시작
        </button>
      </section>

      {work.length > 0 && (
        <section className="card making" aria-label="반주 만드는 중">
          <h2>반주 만드는 중</h2>
          {now ? (
            <>
              <div className="making-line">{now.title} · {now.status === "downloading" ? "유튜브에서 받는 중" : now.status === "checking" ? "반주인지 확인하는 중" : now.mode} · {pct(now)}</div>
              <div className="bar"><span style={{ width: pct(now) }} /></div>
              {now.notice && <div className="notice-line">{now.notice}</div>}
            </>
          ) : <div className="making-line muted">곧 시작해요</div>}
          <div className="muted small">대기 {work.filter((s) => s !== now).length}곡 · 예약한 곡을 먼저 만듭니다</div>
        </section>
      )}
    </aside>
  );
}
