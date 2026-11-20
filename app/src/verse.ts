// 간주 점프 · 1절만 (기획서 F15): 시간 맞춘 가사로 간주와 1절 끝을 어림한다
export type Line = { t: number; text: string; e?: number };

export const GAP = 8; // 줄 시작에서 다음 줄 시작까지 이만큼(초) 넘게 비면 간주
const SUNG = 4; // 끝 시간이 없는 줄을 부르는 데 걸린다고 보는 시간

/** 줄이 끝나는 때: 끝 시간이 있으면 그것, 없으면 시작 + 4초 (다음 줄을 넘지 않게) */
const lineEnd = (lines: Line[], i: number) => Math.min(lines[i].e ?? lines[i].t + SUNG, lines[i + 1]?.t ?? Infinity);

/** 간주 구간 [시작, 끝] 목록. 첫 줄 앞 긴 전주도 넣는다 (진행 바의 노란 구간) */
export function interludes(lines: Line[]): [number, number][] {
  const out: [number, number][] = [];
  if (lines.length && lines[0].t > GAP) out.push([0, lines[0].t]);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i + 1].t - lines[i].t > GAP) out.push([lineEnd(lines, i), lines[i + 1].t]);
  }
  return out;
}

/** 지금(가사 시간 pos)이 간주 중이면 넘어갈 곳(다음 가사 2초 전), 아니면 null */
export function interludeTarget(lines: Line[], pos: number): number | null {
  const gap = interludes(lines).find(([a, b]) => pos >= a && pos < b);
  return gap && gap[1] - 2 - pos > 1 ? gap[1] - 2 : null;
}

/** 1절이 끝나는 때: 곡 길이 25~60% 사이 간주 중 가장 긴 것의 시작 (절 사이 간주가 보통 가장 길다). 못 찾으면 null
 *  (처음엔 "35% 뒤 첫 간주"였는데, 「우주를 줄게」의 1절 끝이 33%라 놓쳤다) */
export function verseEnd(lines: Line[], duration: number): number | null {
  let best = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    const gap = lines[i + 1].t - lines[i].t; // 범위는 줄 시작으로 본다 (끝 시간이 있든 없든 같은 곡이면 같은 답)
    if (gap > GAP && lines[i].t >= duration * 0.25 && lines[i].t <= duration * 0.6 &&
      (best < 0 || gap > lines[best + 1].t - lines[best].t)) best = i;
  }
  return best < 0 ? null : lineEnd(lines, best);
}
