import { useEffect, useRef, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { audioUrl, getLyrics, savePrefs, type Gender, type LyricLine, type Part, type Prefs, type Settings, type Song } from "./api";
import Stage from "./Stage";
import { interludeTarget, verseEnd } from "./verse";
import { sendTv } from "./Tv";
import LyricsEditor from "./LyricsEditor";
import SignalsmithStretch from "./vendor/SignalsmithStretch.mjs";

/** 지금 부르는 줄(크게, 부른 만큼 색이 차오름)과 다음 줄을 보여 준다. */
export function LyricsView({ lines, pos, state }: { lines: LyricLine[]; pos: number; state?: string }) {
  if (!lines.length) {
    const msg = state === "searching" || state === "off" ? "가사를 찾는 중이에요" : state === "generating" ? "가사를 만드는 중이에요" : "가사가 없어요";
    return <div className="lyrics-view empty">{msg}</div>;
  }
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
  const cur = lines[i];
  const next = lines[i + 1];
  // 다음 줄 시작까지의 90% 동안 부른다고 보고 색을 채운다
  const span = next ? (next.t - (cur?.t ?? 0)) * 0.9 : 4;
  const fill = cur ? Math.min(1, (pos - cur.t) / Math.max(span, 0.5)) : 0;
  return (
    <div className="lyrics-view" aria-live="polite">
      <p className="lyr-prev">{lines[i - 1]?.text ?? ""}</p>
      <p className="lyr-cur">
        {cur ? (
          <span className="sung" style={{ backgroundSize: `${fill * 100}% 100%` }}>{cur.text}</span>
        ) : (
          <span className="muted">♪</span>
        )}
      </p>
      <p className="lyr-next">{(cur ? next : lines[0])?.text ?? ""}</p>
    </div>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
type Preset = NonNullable<Prefs["preset"]>;

/** 프리셋이 원키에서 몇 키 옮기는지 (기획서 F8): 여자 노래의 남자키 -5, 남자 노래의 여자키 +5, 같은 성별·혼성은 0 */
export function presetOffset(preset: Preset, gender?: Gender): number {
  if (preset === "male" && gender === "female") return -5;
  if (preset === "female" && gender === "male") return 5;
  return 0;
}

/** `원키`, `♯2`, `♭3`, `남자키`, `남자키 ♯1` */
export function keyLabel(key: number, preset: Preset, gender?: Gender): string {
  const off = presetOffset(preset, gender);
  const name = off === 0 ? "" : preset === "male" ? "남자키" : "여자키";
  const d = key - off;
  const sym = d > 0 ? `♯${d}` : d < 0 ? `♭${-d}` : "";
  return name ? (sym ? `${name} ${sym}` : name) : sym || "원키";
}

const QUIET_KEYS = ["ArrowUp", "ArrowDown", "+", "-", "0", "j", "J"];
const typingIn = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest?.("input, textarea, select, [role=dialog]");

/**
 * 재생기. 분리한 곡은 반주 + 가이드 보컬 + 코러스를 Web Audio로 섞는다.
 * 모든 소리 → bus → Signalsmith Stretch(키) → 스피커. 속도는 재생 속도로 바꾸고, 그만큼 바뀐 음높이를 키 엔진이 되돌린다.
 */
// shortcut: 키 엔진(Signalsmith 기본 설정) 지연을 2026-11-20 앱에서 잰 값(키와 상관없이 0.12초). 엔진 설정을 바꾸면 다시 잰다
const ENGINE_LATENCY = 0.12;

export default function Player({ song, settings, onSettings, lyricsRev, hasNext, onEnded, onError, onChanged, tv }: {
  song: Song; settings: Settings; onSettings: (s: Settings) => void; lyricsRev: number; hasNext: boolean; onEnded: () => void;
  tv: { canShow: boolean; open: boolean; show: () => void; close: () => void };
  onError: (msg: string) => void; onChanged: () => void;
}) {
  const separated = !!song.stems;
  const hasChorus = !!song.stems?.chorus;
  const p = song.prefs ?? {};
  const [track, setTrack] = useState<"inst" | "orig">(separated ? "inst" : "orig");
  // 기획서 F10 기본값 (시험에서 가장 자연스러웠던 값). 곡마다 마지막 설정을 기억한다
  const [guide, setGuide] = useState(p.guide ?? 15);
  const [chorus, setChorus] = useState(p.chorus ?? 50);
  const [lowpass, setLowpass] = useState(p.lowpass ?? 5000);
  const [verb, setVerb] = useState(p.verb ?? 20);
  const [key, setKey] = useState(p.key ?? 0);
  const [preset, setPreset] = useState<Preset>(p.preset ?? "orig");
  const [tempo, setTempo] = useState(p.tempo ?? 1);
  const [gender, setGender] = useState<Gender | undefined>(song.gender);
  const [askGender, setAskGender] = useState<Preset | null>(null); // 성별을 몰라 물어보는 중인 프리셋
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [editing, setEditing] = useState<{ at: number; resume: boolean } | null>(null);
  const [rev, setRev] = useState(0);
  const [latency, setLatency] = useState(0); // 소리가 실제로 들리기까지 (키 엔진 + 스피커)
  // 앱 가사: 곡마다 기억 (기획서 F12). 처음엔 노래방 영상이면 끔
  const [lyricsOn, setLyricsOn] = useState(p.lyrics ?? song.app_lyrics !== false);
  const [stageOpen, setStageOpen] = useState(true);
  const [bgOpen, setBgOpen] = useState(false);
  const [verseOnly, setVerseOnly] = useState(false); // 1절만 (기획서 F15)
  const fading = useRef(false);
  // 버튼 줄 자동 숨김 (기획서 F6)
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState("");
  const fromKeyboard = useRef(false);
  const [bgUrlText, setBgUrlText] = useState(p.bg_kind === "youtube" ? `https://youtu.be/${p.bg_value}` : "");

  // 가사는 곡을 고를 때와, 가사를 고르거나 만들어 상태가 바뀔 때 다시 받는다
  useEffect(() => {
    getLyrics(song.id).then((r) => setLyrics(r.lines)).catch(() => setLyrics([]));
  }, [song.id, song.lyrics?.state, song.lyrics?.candidate_id, lyricsRev, rev]);

  const ctx = useRef<AudioContext | null>(null);
  const bufs = useRef<Partial<Record<Part, AudioBuffer>>>({});
  const gains = useRef<Partial<Record<Part, GainNode>>>({});
  const srcs = useRef<AudioBufferSourceNode[]>([]);
  const bus = useRef<GainNode | null>(null);
  const stretch = useRef<Awaited<ReturnType<typeof SignalsmithStretch>> | null>(null);
  // 코러스: gain → 고음 깎기 → (그대로 + 울림) → bus. 휘파람 같은 흠과 낮아지는 구간을 가린다
  const chain = useRef<{ input: GainNode; lp: BiquadFilterNode; wet: GainNode } | null>(null);
  const base = useRef(0); // 재생을 시작(또는 속도를 바꾼) 때의 곡 위치
  const startedAt = useRef(0); // 그때의 ctx 시간
  const rate = useRef(tempo); // 지금 소리에 걸린 속도
  const offset = useRef(0); // 멈춰 있을 때의 위치
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  const now = () => (playing && ctx.current ? base.current + (ctx.current.currentTime - startedAt.current) * rate.current : offset.current);
  const duration = bufs.current.instrumental?.duration ?? bufs.current.original?.duration ?? song.duration;

  async function load(part: Part) {
    if (bufs.current[part]) return;
    const c = ctx.current!;
    const data = await (await fetch(await audioUrl(song.id, part))).arrayBuffer();
    bufs.current[part] = await c.decodeAudioData(data);
    const g = c.createGain();
    g.connect(part === "chorus" ? chain.current!.input : bus.current!);
    gains.current[part] = g;
  }

  function makeChorusChain(c: AudioContext, out: AudioNode) {
    const input = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    input.connect(lp).connect(out);
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
    lp.connect(conv).connect(wet).connect(out);
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

  // 재생 속도만큼 올라간(내려간) 음을 되돌리고 원하는 키를 더한다
  const applyPitch = () => void stretch.current?.schedule({ semitones: key - 12 * Math.log2(tempo) });

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
      s.playbackRate.value = rate.current;
      s.connect(gains.current[part]!);
      s.start(0, Math.min(at, buf.duration));
      srcs.current.push(s);
    }
    srcs.current[0].onended = () => {
      setPlaying(false);
      offset.current = 0;
      setPos(0);
      endedRef.current(); // 예약한 다음 곡으로
    };
    base.current = at;
    startedAt.current = c.currentTime;
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
    bus.current = c.createGain();
    makeChorusChain(c, bus.current);
    const engine = SignalsmithStretch(c)
      .then(async (node) => {
        bus.current!.connect(node).connect(c.destination);
        await node.start();
        stretch.current = node;
      })
      .catch((e) => {
        bus.current!.connect(c.destination); // 키·속도 없이라도 부를 수 있게
        onError(`키·속도 조절을 켜지 못했어요: ${e?.message ?? e}`);
      });
    const parts: Part[] = !separated ? ["original"] : hasChorus ? ["instrumental", "vocals", "chorus"] : ["instrumental", "vocals"];
    Promise.all([engine, ...parts.map(load)])
      .then(() => {
        if (ctx.current !== c) return;
        setLoading(false);
        applyGains();
        applyPitch();
        start(0);
        setLatency((stretch.current ? ENGINE_LATENCY : 0) + (c.outputLatency || c.baseLatency || 0));
      })
      .catch((e) => onError(`소리를 불러오지 못했어요: ${e.message ?? e}`));
    return () => {
      stopSources();
      stretch.current = null;
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

  // 속도를 바꾸면 위치 계산 기준을 지금으로 옮기고 소리의 재생 속도를 바꾼다. 멈추거나 처음으로 가지 않는다
  useEffect(() => {
    if (playing && ctx.current) {
      base.current = now();
      startedAt.current = ctx.current.currentTime;
    }
    rate.current = tempo;
    srcs.current.forEach((s) => (s.playbackRate.value = tempo));
    applyPitch();
  }, [tempo]);
  useEffect(applyPitch, [key]);

  // 키·속도·소리 섞기를 곡마다 기억한다 (0.6초 동안 더 바꾸지 않으면 저장)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const t = setTimeout(() => savePrefs(song.id, { key, preset, tempo, guide, chorus, lowpass, verb }).then(onChanged).catch(() => {}), 600);
    return () => clearTimeout(t);
  }, [key, preset, tempo, guide, chorus, lowpass, verb]);

  useEffect(() => {
    const t = setInterval(() => setPos(now()), 100);
    return () => clearInterval(t);
  }, [playing]);

  const changeKey = (d: number) => setKey((k) => Math.max(-6, Math.min(6, k + d)));
  function choosePreset(pr: Preset, g = gender) {
    if (pr !== "orig" && !g) return setAskGender(pr);
    const off = presetOffset(pr, g);
    setPreset(off === 0 ? "orig" : pr);
    setKey(off);
  }
  function answerGender(g: Gender) {
    setGender(g);
    savePrefs(song.id, { gender: g }).then(onChanged).catch(() => {});
    const pr = askGender!;
    setAskGender(null);
    choosePreset(pr, g);
  }

  // 가사 고치기 (기획서 F5): 멈추고 지금 줄에서 편집기를 연다. 닫으면 그 위치에서 이어 부른다
  function openEditor() {
    const resume = playing;
    if (playing) pause();
    setEditing({ at: offset.current, resume });
  }

  // 단축키: 키 올림 ↑/+, 내림 ↓/-, 원키 0, 가사 고치기 E
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (editing || loading || e.ctrlKey || e.altKey || e.metaKey || typingIn(e)) return;
    if (e.key === "ArrowUp" || e.key === "+") changeKey(1);
    else if (e.key === "ArrowDown" || e.key === "-") changeKey(-1);
    else if (e.key === "0") choosePreset("orig");
    else if ((e.key === "j" || e.key === "J") && jumpTo !== null) jump();
    else if (e.key === "Home") seek(0);
    else if ((e.key === "e" || e.key === "E") && lyricsOn) openEditor();
    else return;
    fromKeyboard.current = true;
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  function toggleLyrics() {
    const on = !lyricsOn;
    setLyricsOn(on);
    savePrefs(song.id, { lyrics: on }).then(onChanged).catch(() => {});
  }

  async function setBg(kind: NonNullable<Prefs["bg_kind"]>, value?: string) {
    try {
      await savePrefs(song.id, { bg_kind: kind, bg_value: value ?? null });
      onChanged();
      setBgOpen(false);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function pickBgFile() {
    const f = await openFile({ filters: [{ name: "사진·영상", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "mp4", "webm", "mov", "m4v"] }] });
    if (typeof f === "string") setBg("file", f);
  }

  // 들리는 소리 위치: 들리기까지의 지연(곡 시간으로는 속도만큼)을 뺀다. 가사는 사용자 보정도 뺀다
  const heard = Math.max(0, pos - latency * tempo);
  const lyricPos = Math.max(0, heard - settings.lyrics_delay);
  const toSongTime = (t: number) => t + settings.lyrics_delay + latency * tempo; // 가사 시간 → 곡 위치
  const bgKind = p.bg_kind ?? "auto";

  // 간주 점프 · 1절만 (기획서 F15): 가사가 켜져 있고 시간 맞춘 가사가 있을 때만
  const useLyrics = lyricsOn && lyrics.length > 0;
  const jumpTo = useLyrics ? interludeTarget(lyrics, lyricPos) : null;
  const verseAt = useLyrics ? verseEnd(lyrics, duration) : null;
  function jump() {
    if (jumpTo === null) return;
    seek(toSongTime(jumpTo));
    showToast("간주 점프");
  }
  useEffect(() => {
    if (!verseOnly || verseAt === null || !playing || fading.current || lyricPos < verseAt) return;
    // 1절 끝: 3초 동안 소리를 줄이며 끝내고 다음 곡으로
    fading.current = true;
    const g = bus.current!.gain;
    const t = ctx.current!.currentTime;
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 3);
    setTimeout(() => {
      stopSources();
      setPlaying(false);
      endedRef.current();
    }, 3000);
  }, [lyricPos, verseOnly, verseAt, playing]);

  function showToast(text: string) {
    setToast(text);
  }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!fromKeyboard.current) return;
    fromKeyboard.current = false;
    showToast(keyLabel(key, preset, gender));
  }, [key, preset]);

  // 3초 동안 마우스·키보드 입력이 없으면 버튼 줄을 숨긴다. 막는 것이 풀리면 다시 3초를 센다
  useEffect(() => {
    let t = 0;
    const poke = (e?: Event) => {
      // 키·간주 단축키는 버튼 줄을 숨긴 채 구석 표시만 띄운다 (기획서 F6)
      if (e instanceof KeyboardEvent && QUIET_KEYS.includes(e.key)) return;
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 3000);
    };
    poke();
    const evs = ["mousemove", "mousedown", "keydown", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, poke));
    return () => {
      clearTimeout(t);
      evs.forEach((e) => window.removeEventListener(e, poke));
    };
  }, [playing, bgOpen, askGender, editing, hover, moreOpen, stageOpen]);
  // TV 화면 (기획서 F14): TV에 띄우는 동안 PC 창은 조작 화면만 두고, 재생 상태를 TV 창으로 보낸다
  useEffect(() => setStageOpen(!tv.open), [tv.open]);
  useEffect(() => {
    if (!tv.open) return;
    sendTv({ song, settings, lines: lyrics, heardPos: heard, lyricPos, tempo, playing, lyricsOn, keyLabel: keyLabel(key, preset, gender) });
  }, [tv.open, pos, playing, tempo, lyricsOn, lyrics, key, preset, song, settings]);
  const hideUi = idle && settings.auto_hide && playing && stageOpen && !bgOpen && !askGender && !editing && !hover && !moreOpen;
  const barHover = { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) };

  return (
    <div className={`player-wrap${stageOpen ? " full" : ""}${hideUi ? " idle" : ""}`}>
    {stageOpen && (
      <Stage song={song} settings={settings} heardPos={heard} tempo={tempo} playing={playing} lyricsOn={lyricsOn}
        topProps={barHover}
        top={
          <>
            <button onClick={() => setStageOpen(false)} aria-label="곡 목록으로">← 곡 목록</button>
            <b className="stage-title">{song.title} <span className="muted">{song.artist}</span></b>
            <button onClick={toggleLyrics} aria-pressed={lyricsOn} className={lyricsOn ? "on" : ""}
              title={song.video ? "가사를 끄면 노래방 영상이 화면 전체에 나와요" : ""}>가사 {lyricsOn ? "켬" : "끔"}</button>
            {lyricsOn && <button onClick={openEditor} disabled={loading} title="단축키 E">가사 고치기</button>}
            <button onClick={() => setVerseOnly((v) => !v)} aria-pressed={verseOnly} className={verseOnly ? "on" : ""} disabled={verseAt === null}
              title={verseAt === null ? "가사가 없거나 꺼져 있으면 1절 끝을 알 수 없어요" : `1절 끝(${fmt(verseAt)})에서 줄이며 끝내요`}>1절만</button>
            {!(song.video && !lyricsOn) && <button onClick={() => setBgOpen((o) => !o)} aria-expanded={bgOpen}>배경 바꾸기</button>}
            {bgOpen && (
              <div className="bg-pop" role="group" aria-label="이 곡의 배경">
                {([["auto", "설정 따르기"], ["default", "기본 배경화면"]] as const).map(([k, label]) => (
                  <button key={k} className={bgKind === k ? "on" : ""} onClick={() => setBg(k)}>{label}</button>
                ))}
                <div className="bg-url">
                  <input value={bgUrlText} onChange={(e) => setBgUrlText(e.target.value)} placeholder="유튜브 주소 붙여넣기" aria-label="배경 유튜브 주소" />
                  <button className={bgKind === "youtube" ? "on" : ""} onClick={() => setBg("youtube", bgUrlText)} disabled={!bgUrlText.trim()}>이 영상</button>
                </div>
                <button className={bgKind === "file" ? "on" : ""} onClick={pickBgFile}>내 사진·영상 고르기…</button>
              </div>
            )}
          </>
        }>
        {jumpTo !== null && <button className="jump" onClick={jump} title="단축키 J">간주 점프 ▸▸</button>}
        {lyricsOn && <LyricsView lines={lyrics} pos={lyricPos} state={song.lyrics?.state} />}
      </Stage>
    )}
    {toast && hideUi && <div className="toast" role="status">{toast}</div>}
    {editing && (
      <LyricsEditor song={song} startAt={editing.at}
        onClose={(saved) => {
          if (saved) setRev((r) => r + 1);
          if (editing.resume) start(offset.current);
          setEditing(null);
        }} />
    )}
    <footer className="player" {...barHover}>
      <div className="ctl-group" role="group" aria-label="키 조절">
        <div className="stepper">
          <button onClick={() => changeKey(-1)} disabled={key <= -6} aria-label="키 내림" title="↓ 또는 -">−</button>
          <b className="stepper-val" aria-live="polite">{keyLabel(key, preset, gender)}</b>
          <button onClick={() => changeKey(1)} disabled={key >= 6} aria-label="키 올림" title="↑ 또는 +">+</button>
        </div>
        <div className="presets">
          {(["orig", "male", "female"] as const).map((pr) => (
            <button key={pr} onClick={() => choosePreset(pr)} title={pr === "orig" ? "단축키 0" : ""}
              className={preset === pr && (pr !== "orig" || key === 0) ? "on" : ""}>
              {pr === "orig" ? "원키" : pr === "male" ? "남자키" : "여자키"}
            </button>
          ))}
        </div>
        {askGender && (
          <div className="ask-gender" role="group" aria-label="원곡 가수 성별">
            <span>원곡 가수는요?</span>
            <button onClick={() => answerGender("male")}>남자</button>
            <button onClick={() => answerGender("female")}>여자</button>
            <button onClick={() => answerGender("mixed")}>혼성</button>
            <button className="muted" onClick={() => setAskGender(null)} aria-label="취소">✕</button>
          </div>
        )}
      </div>
      <button className="next" onClick={() => seek(0)} disabled={loading} aria-label="처음부터" title="처음부터 (Home)">⏮</button>
      <button className="play" onClick={() => (playing ? pause() : start(offset.current))} disabled={loading}
        aria-label={playing ? "일시정지" : "재생"}>
        {playing ? "❚❚" : "▶"}
      </button>
      {!stageOpen && !tv.open && <button className="next" onClick={() => setStageOpen(true)} title="노래방 화면 보기">노래방 화면</button>}
      {tv.open ? <button className="next" onClick={tv.close}>TV 끄기</button>
        : tv.canShow && <button className="next" onClick={tv.show} title="두 번째 모니터에 노래방 화면 띄우기">TV에 띄우기</button>}
      {hasNext && <button className="next" onClick={onEnded} aria-label="다음 곡" title="다음 예약곡으로">⏭</button>}
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
              <details className="more" onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
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
      {settings.mic_on && (
        <details className="more" onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
          <summary>마이크</summary>
          <label>음량 <b>{settings.mic_volume}%</b>
            <input type="range" min={0} max={150} step={5} value={settings.mic_volume} onChange={(e) => onSettings({ ...settings, mic_volume: Number(e.target.value) })} />
          </label>
          <label>에코 <b>{settings.mic_echo}%</b>
            <input type="range" min={0} max={100} step={5} value={settings.mic_echo} onChange={(e) => onSettings({ ...settings, mic_echo: Number(e.target.value) })} />
          </label>
        </details>
      )}
      {loading && <span className="muted">불러오는 중…</span>}
      <div className="ctl-group" role="group" aria-label="속도 조절">
        <div className="stepper">
          <button onClick={() => setTempo((t) => Math.max(0.7, Math.round((t - 0.05) * 100) / 100))} disabled={tempo <= 0.7} aria-label="속도 내림">−</button>
          <b className="stepper-val">{tempo === 1 ? "원래 속도" : `${tempo.toFixed(2)}배`}</b>
          <button onClick={() => setTempo((t) => Math.min(1.3, Math.round((t + 0.05) * 100) / 100))} disabled={tempo >= 1.3} aria-label="속도 올림">+</button>
        </div>
        <div className="presets">
          <button onClick={() => setTempo(1)} className={tempo === 1 ? "on" : ""}>원래 속도</button>
        </div>
      </div>
    </footer>
    </div>
  );
}
