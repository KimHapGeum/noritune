import { useEffect, useRef, useState } from "react";
import { audioUrl, type Part, type Song } from "./api";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 재생기. 분리한 곡은 반주 + 가이드 보컬을 Web Audio로 섞어 틀고, 원곡으로 바꿔 들을 수도 있다.
 * 모든 소리는 gain → out 으로 모인다 (다음 단계에서 out 뒤에 키·속도 엔진을 넣는다).
 */
export default function Player({ song, onError }: { song: Song; onError: (msg: string) => void }) {
  const separated = !!song.stems;
  const hasChorus = !!song.stems?.chorus;
  const [track, setTrack] = useState<"inst" | "orig">(separated ? "inst" : "orig");
  // 기획서 F10 기본값 (시험에서 가장 자연스러웠던 값)
  const [guide, setGuide] = useState(15);
  const [chorus, setChorus] = useState(50);
  const [lowpass, setLowpass] = useState(5000);
  const [verb, setVerb] = useState(20);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [loading, setLoading] = useState(true);

  const ctx = useRef<AudioContext | null>(null);
  const bufs = useRef<Partial<Record<Part, AudioBuffer>>>({});
  const gains = useRef<Partial<Record<Part, GainNode>>>({});
  const srcs = useRef<AudioBufferSourceNode[]>([]);
  // 코러스: gain → 고음 깎기 → (그대로 + 울림) → 스피커. 휘파람 같은 흠과 낮아지는 구간을 가린다
  const chain = useRef<{ input: GainNode; lp: BiquadFilterNode; wet: GainNode } | null>(null);
  const startedAt = useRef(0); // ctx 시간 기준으로 곡 0초였던 때
  const offset = useRef(0); // 멈춰 있을 때의 위치

  const now = () => (playing && ctx.current ? ctx.current.currentTime - startedAt.current : offset.current);
  const duration = bufs.current.instrumental?.duration ?? bufs.current.original?.duration ?? song.duration;

  async function load(part: Part) {
    if (bufs.current[part]) return;
    const c = ctx.current!;
    const data = await (await fetch(await audioUrl(song.id, part))).arrayBuffer();
    bufs.current[part] = await c.decodeAudioData(data);
    const g = c.createGain();
    g.connect(part === "chorus" ? chain.current!.input : c.destination);
    gains.current[part] = g;
  }

  function makeChorusChain(c: AudioContext) {
    const input = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    input.connect(lp).connect(c.destination);
    // 간단한 리버브: 1.8초 동안 작아지는 잡음을 울림 응답으로 쓴다
    const n = Math.floor(c.sampleRate * 1.8);
    const ir = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    }
    const conv = c.createConvolver();
    conv.buffer = ir;
    const wet = c.createGain();
    lp.connect(conv).connect(wet).connect(c.destination);
    chain.current = { input, lp, wet };
  }

  function applyGains() {
    const g = gains.current;
    const inst = track === "inst";
    if (g.instrumental) g.instrumental.gain.value = inst ? 1 : 0;
    if (g.vocals) g.vocals.gain.value = inst ? guide / 100 : 0;
    if (g.chorus) g.chorus.gain.value = inst ? chorus / 100 : 0;
    if (g.original) g.original.gain.value = inst ? 0 : 1;
    if (chain.current) {
      chain.current.lp.frequency.value = lowpass || 22000;
      chain.current.wet.gain.value = (verb / 100) * 1.5;
    }
  }

  function stopSources() {
    srcs.current.forEach((s) => {
      s.onended = null;
      s.stop();
    });
    srcs.current = [];
  }

  function start(at: number) {
    const c = ctx.current!;
    stopSources();
    for (const [part, buf] of Object.entries(bufs.current) as [Part, AudioBuffer][]) {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.connect(gains.current[part]!);
      s.start(0, Math.min(at, buf.duration));
      srcs.current.push(s);
    }
    srcs.current[0].onended = () => {
      setPlaying(false);
      offset.current = 0;
      setPos(0);
    };
    startedAt.current = c.currentTime - at;
    setPlaying(true);
  }

  function pause() {
    offset.current = now();
    stopSources();
    setPlaying(false);
  }

  function seek(t: number) {
    offset.current = t;
    setPos(t);
    if (playing) start(t);
  }

  // 곡이 바뀌면 소리를 새로 불러와 처음부터 튼다
  useEffect(() => {
    const c = new AudioContext();
    ctx.current = c;
    bufs.current = {};
    gains.current = {};
    offset.current = 0;
    setPos(0);
    setTrack(separated ? "inst" : "orig");
    setLoading(true);
    makeChorusChain(c);
    const parts: Part[] = !separated ? ["original"] : hasChorus ? ["instrumental", "vocals", "chorus"] : ["instrumental", "vocals"];
    Promise.all(parts.map(load))
      .then(() => {
        if (ctx.current !== c) return;
        setLoading(false);
        applyGains();
        start(0);
      })
      .catch((e) => onError(`소리를 불러오지 못했어요: ${e.message ?? e}`));
    return () => {
      stopSources();
      c.close();
    };
  }, [song.id]);

  // 원곡으로 바꾸면 그때 원곡을 불러와 같은 위치에서 이어 튼다
  useEffect(() => {
    if (loading) return;
    if (track === "orig" && !bufs.current.original) {
      const at = now();
      load("original")
        .then(() => {
          applyGains();
          if (playing) start(at);
        })
        .catch((e) => onError(`원곡을 불러오지 못했어요: ${e.message ?? e}`));
    } else applyGains();
  }, [track, guide, chorus, lowpass, verb, loading]);

  useEffect(() => {
    const t = setInterval(() => setPos(now()), 250);
    return () => clearInterval(t);
  }, [playing]);

  return (
    <footer className="player">
      <button className="play" onClick={() => (playing ? pause() : start(offset.current))} disabled={loading}
        aria-label={playing ? "일시정지" : "재생"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="now">
        <b>{song.title}</b> <span className="muted">{song.artist}</span>
        <div className="seek">
          <span>{fmt(pos)}</span>
          <input type="range" min={0} max={duration} step={0.1} value={pos} aria-label="재생 위치"
            onChange={(e) => seek(Number(e.target.value))} disabled={loading} />
          <span>{fmt(duration)}</span>
        </div>
      </div>
      {separated && (
        <>
          <div className="toggle" role="group" aria-label="원곡 또는 반주">
            <button aria-pressed={track === "orig"} className={track === "orig" ? "on" : ""} onClick={() => setTrack("orig")}>원곡</button>
            <button aria-pressed={track === "inst"} className={track === "inst" ? "on" : ""} onClick={() => setTrack("inst")}>반주</button>
          </div>
          <label className="guide">
            가이드 보컬 <b>{guide}%</b>
            <input type="range" min={0} max={100} step={5} value={guide} disabled={track === "orig"}
              onChange={(e) => setGuide(Number(e.target.value))} />
          </label>
          {hasChorus && (
            <>
              <label className="guide">
                코러스 <b>{chorus}%</b>
                <input type="range" min={0} max={150} step={10} value={chorus} disabled={track === "orig"}
                  onChange={(e) => setChorus(Number(e.target.value))} />
              </label>
              <details className="more">
                <summary>코러스 다듬기</summary>
                <label>
                  고음 깎기
                  <select value={lowpass} onChange={(e) => setLowpass(Number(e.target.value))}>
                    {[0, 12000, 9000, 7000, 5000, 3500].map((f) => (
                      <option key={f} value={f}>{f ? `${f / 1000}kHz 위` : "끔"}</option>
                    ))}
                  </select>
                </label>
                <label>
                  울림 <b>{verb}%</b>
                  <input type="range" min={0} max={100} step={10} value={verb} onChange={(e) => setVerb(Number(e.target.value))} />
                </label>
              </details>
            </>
          )}
        </>
      )}
      {loading && <span className="muted">불러오는 중…</span>}
    </footer>
  );
}
