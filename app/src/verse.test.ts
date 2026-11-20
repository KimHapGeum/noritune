// 실행: node app/src/verse.test.ts  (Node 24는 TypeScript 타입을 지우고 바로 돌린다)
import assert from "node:assert/strict";
import { interludes, interludeTarget, verseEnd } from "./verse.ts";

const L = (...ts: number[]) => ts.map((t) => ({ t, text: `${t}` }));
const lines = L(15, 19, 23, 27, 60, 64, 68, 72, 105, 109);

assert.equal(interludeTarget(lines, 3), 13); // 전주 (첫 줄까지 15초)
assert.equal(interludeTarget(lines, 14), null); // 첫 줄 2초 전보다 늦으면 넘길 게 없다
assert.equal(interludeTarget(lines, 20), null); // 줄 사이 4초는 간주가 아니다
assert.equal(interludeTarget(lines, 29), null); // 마지막 줄을 아직 부르는 중 (시작 2초 뒤)
assert.equal(interludeTarget(lines, 32), 58); // 27초 줄 다음 33초가 비는 간주
assert.equal(interludeTarget(lines, 110), null); // 마지막 줄 뒤에는 다음 가사가 없다
assert.equal(interludeTarget([], 5), null);

assert.equal(verseEnd(lines, 120), 76); // 30~72초(25~60%)에서 시작하는 간주는 72→105초뿐: 72초 줄 + 4초 (27초 줄은 25% 앞)
assert.equal(verseEnd(L(10, 14, 18), 30), null); // 간주가 없다
// 「우주를 줄게」(215초) 실제 가사: 1절 끝 70.7→79.7초(33%). 45→53초(21%)는 너무 이르고, 뒤쪽 6초 빈칸은 간주가 아니다
// 8초 넘는 빈칸만 남기고, 그 사이는 4초마다 한 줄씩 채운다
const fill = (...pairs: [number, number][]) =>
  pairs.flatMap(([a, b]) => [...Array.from({ length: Math.ceil((b - a) / 4) }, (_, k) => a + 4 * k), b]);
const uju = L(...fill([9.4, 9.4], [21.1, 45.0], [53.2, 70.7], [79.7, 203.6]));
assert.equal(verseEnd(uju, 215), 74.7);
// 끝 시간이 있으면 줄이 끝나는 순간부터 간주 (4초 어림 대신)
const withEnd = [{ t: 10, text: "a", e: 11 }, { t: 25, text: "b", e: 28 }, { t: 30, text: "c" }];
assert.deepEqual(interludes(withEnd), [[0, 10], [11, 25]]);
assert.equal(interludeTarget(withEnd, 11.5), 23); // 11초에 끝났으니 바로 간주 점프
assert.equal(interludeTarget(withEnd, 10.5), null); // 아직 부르는 중
assert.equal(verseEnd(withEnd, 40), 11);
console.log("verse.ts 시험 통과");
