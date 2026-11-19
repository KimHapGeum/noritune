import type { Song } from "./api";

const state = (s: Song) =>
  s.status === "ready" ? "준비됨"
  : s.status === "failed" ? "만들지 못했어요"
  : s.status === "confirm" ? "분리할지 골라 주세요"
  : ["downloading", "separating"].includes(s.status) ? `만드는 중 ${Math.round((s.progress ?? 0) * 100)}%`
  : "기다리는 중";

/** 예약 목록 (기획서 F7). 순서 바꾸기·맨 앞으로(우선 예약)·취소. 같은 곡을 두 번 예약할 수 있어 자리(index)로 다룬다. */
export default function QueuePanel({ queue, songs, onChange }: {
  queue: string[]; songs: Song[]; onChange: (q: string[]) => void;
}) {
  // 자리 번호는 queue 기준으로 둔다 (목록을 아직 못 받은 곡이 있어도 옮기기·취소가 어긋나지 않게)
  const items = queue.flatMap((id, i) => {
    const s = songs.find((x) => x.id === id);
    return s ? [{ s, i }] : [];
  });
  const minutes = Math.round(items.reduce((t, { s }) => t + s.duration, 0) / 60);
  const move = (i: number, to: number) => {
    const q = [...queue];
    const [x] = q.splice(i, 1);
    q.splice(to, 0, x);
    onChange(q);
  };

  return (
    <aside className="queue" aria-label="예약 목록">
      <div className="queue-head">
        <h2>예약 목록</h2>
        {items.length > 0 && <span className="muted">{items.length}곡 · 약 {minutes}분</span>}
      </div>
      {items.length === 0 ? (
        <p className="muted queue-empty">곡 옆의 "예약"을 누르면 여기에 줄을 서요. 예약한 곡을 먼저 만듭니다.</p>
      ) : (
        <ol>
          {items.map(({ s, i }, n) => (
            <li key={`${i}-${s.id}`}>
              <span className="queue-n">{n + 1}</span>
              <span className="queue-text">
                <span className="title">{s.title}</span>
                <span className={`muted${s.status === "ready" ? "" : " queue-wait"}`}>{s.artist || "가수 모름"} · {state(s)}</span>
              </span>
              <span className="queue-btns">
                <button onClick={() => move(i, 0)} disabled={i === 0} aria-label={`${s.title} 맨 앞으로`} title="맨 앞으로">⤒</button>
                <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${s.title} 한 칸 앞으로`} title="한 칸 앞으로">↑</button>
                <button onClick={() => move(i, i + 1)} disabled={i === queue.length - 1} aria-label={`${s.title} 한 칸 뒤로`} title="한 칸 뒤로">↓</button>
                <button onClick={() => onChange(queue.filter((_, j) => j !== i))} aria-label={`${s.title} 예약 취소`} title="예약 취소">✕</button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
