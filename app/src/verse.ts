// 간주 점프 · 1절만 (기획서 F15): 시간 맞춘 가사로 간주와 1절 끝을 어림한다
export type Line = { t: number; text: string };

export const GAP = 8; // 다음 줄까지 이만큼(초) 넘게 비면 간주
const SUNG = 4; // 한 줄을 부르는 데 걸린다고 보는 시간 (줄 끝 시간이 없어서)

/** 지금(가사 시간 pos)이 간주 중이면 넘어갈 곳(다음 가사 2초 전), 아니면 null. 첫 줄 앞 긴 전주도 간주로 본다 */
export function interludeTarget(lines: Line[], pos: number): number | null {
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
  const next = lines[i + 1];
  if (!next) return null;
  const from = i < 0 ? 0 : lines[i].t;
  const inGap = next.t - from > GAP && (i < 0 || pos - from >= SUNG);
  return inGap && next.t - 2 - pos > 1 ? next.t - 2 : null;
}

/** 1절이 끝나는 때: 곡 길이 25~60% 사이 간주 중 가장 긴 것의 시작 (절 사이 간주가 보통 가장 길다). 못 찾으면 null
 *  (처음엔 "35% 뒤 첫 간주"였는데, 「우주를 줄게」의 1절 끝이 33%라 놓쳤다) */
export function verseEnd(lines: Line[], duration: number): number | null {
  let best = -1;
  let bestGap = GAP;
  for (let i = 0; i + 1 < lines.length; i++) {
    const gap = lines[i + 1].t - lines[i].t;
    if (lines[i].t >= duration * 0.25 && lines[i].t <= duration * 0.6 && gap > bestGap) [best, bestGap] = [i, gap];
  }
  return best < 0 ? null : lines[best].t + SUNG;
}
