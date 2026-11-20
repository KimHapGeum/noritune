import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { audioUrl, badMv, bgUrl, findMv, songBgUrl, type Settings, type Song } from "./api";

const isVideo = (path: string) => /\.(mp4|webm|mov|m4v)$/i.test(path);

/** 프로그램에 들어 있는 차분한 배경 (인터넷 필요 없음) */
const DefaultBg = () => <div className="bg-default" aria-hidden />;

/** 내 사진·영상. 여러 장이면 interval초마다 바꾼다 (0: 곡마다 한 장) */
function FilesBg({ urls, interval, seed }: { urls: { url: string; video: boolean }[]; interval: number; seed: number }) {
  const [i, setI] = useState(seed % Math.max(1, urls.length));
  useEffect(() => {
    if (!interval || urls.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % urls.length), interval * 1000);
    return () => clearInterval(t);
  }, [interval, urls.length]);
  const f = urls[i];
  if (!f) return <DefaultBg />;
  return f.video
    ? <video key={f.url} className="bg-media" src={f.url} autoPlay muted loop playsInline />
    : <img key={f.url} className="bg-media" src={f.url} alt="" />;
}

// 유튜브 IFrame API는 한 번만 불러온다
type YTPlayer = { destroy(): void };
type YTNs = { Player: new (el: HTMLElement, o: object) => YTPlayer };
let ytApi: Promise<YTNs> | null = null;
function loadYt(): Promise<YTNs> {
  const w = window as unknown as { YT?: YTNs & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
  return (ytApi ??= new Promise<YTNs>((resolve, reject) => {
    if (w.YT?.loaded) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      ytApi = null; // 인터넷이 돌아오면 다음 곡에서 다시 시도
      reject(new Error("유튜브에 연결하지 못했어요"));
    };
    document.head.appendChild(s);
  }));
}

/** 소리 끈 유튜브 영상을 반복해서 깐다. 틀 수 없으면(퍼가기 금지·인터넷 없음) onFail */
function YoutubeBg({ id, onFail }: { id: string; onFail: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let player: YTPlayer | null = null;
    let done = false;
    const fail = () => !done && ((done = true), onFail(id));
    const timer = setTimeout(fail, 10000); // 10초 안에 안 나오면 포기
    loadYt()
      .then((YT) => {
        if (done || !box.current) return;
        const el = document.createElement("div");
        box.current.replaceChildren(el);
        player = new YT.Player(el, {
          videoId: id,
          // cc_load_policy 0 + unloadModule: 영상 자막이 앱 가사와 겹치지 않게 끈다
          playerVars: { autoplay: 1, mute: 1, controls: 0, loop: 1, playlist: id, rel: 0, playsinline: 1, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0 },
          events: {
            onStateChange: (e: { data: number; target: { unloadModule?: (m: string) => void } }) => {
              e.target.unloadModule?.("captions");
              if (e.data === 1) clearTimeout(timer); // 1: 재생 중
            },
            onError: () => fail(),
          },
        });
      })
      .catch(fail);
    return () => {
      done = true;
      clearTimeout(timer);
      player?.destroy();
    };
  }, [id]);
  return <div ref={box} className="bg-yt" aria-hidden />;
}

/** 사용자가 붙여넣은 유튜브 주소. 틀 수 없으면 기본 배경 */
function OneYoutubeBg({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <DefaultBg /> : <YoutubeBg id={id} onFail={() => setFailed(true)} />;
}

/** 공식 뮤비를 찾아 깐다. 후보를 차례로 시도하고, 모두 안 되면 fallback */
function MvBg({ song, fallback }: { song: Song; fallback: ReactNode }) {
  const [ids, setIds] = useState<string[] | null>(null);
  useEffect(() => void findMv(song.id).then(setIds).catch(() => setIds([])), [song.id]);
  if (ids === null) return <DefaultBg />;
  if (!ids.length) return <>{fallback}</>;
  return (
    <YoutubeBg key={ids[0]} id={ids[0]} onFail={(bad) => {
      setIds((xs) => xs!.filter((x) => x !== bad));
      if (navigator.onLine) badMv(song.id, bad).catch(() => {}); // 인터넷이 없어서 못 튼 것은 빼지 않는다
    }} />
  );
}

/**
 * 노래방 화면 (기획서 F6·F11·F12): 배경 위에 가사.
 * 노래방 영상을 받아 둔 곡은 앱 가사를 끄면 그 영상을 노래에 맞춰 화면 전체에 띄운다 (어둡게 0%).
 */
export default function Stage({ song, settings, heardPos, tempo, playing, lyricsOn, children, top, topProps, bottom }: {
  song: Song; settings: Settings; heardPos: number; tempo: number; playing: boolean; lyricsOn: boolean;
  children: ReactNode; top: ReactNode; topProps?: HTMLAttributes<HTMLDivElement>; bottom?: ReactNode;
}) {
  const p = song.prefs ?? {};
  const karaoke = !!song.video && !lyricsOn;
  const video = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState("");
  const [fileUrls, setFileUrls] = useState<{ url: string; video: boolean }[]>([]);
  const [songFile, setSongFile] = useState("");

  useEffect(() => {
    if (song.video) audioUrl(song.id, "video").then(setVideoSrc);
  }, [song.id, song.video]);
  useEffect(() => {
    Promise.all(settings.bg_files.map((f, i) => bgUrl(i).then((url) => ({ url, video: isVideo(f) })))).then(setFileUrls);
  }, [settings.bg_files.join("|")]);
  useEffect(() => {
    if (p.bg_kind === "file") songBgUrl(song.id).then((u) => setSongFile(`${u}?v=${encodeURIComponent(p.bg_value ?? "")}`));
  }, [song.id, p.bg_kind, p.bg_value]);

  // 노래방 영상은 들리는 노래 위치에 맞춘다. 0.25초 넘게 어긋날 때만 옮겨 끊김을 줄인다
  useEffect(() => {
    const v = video.current;
    if (!karaoke || !v || !v.duration) return;
    v.playbackRate = tempo;
    const target = Math.max(0, Math.min(heardPos, v.duration - 0.05));
    if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [karaoke, heardPos, playing, tempo]);

  const seed = parseInt(song.id.slice(0, 6), 16);
  const custom = fileUrls.length ? <FilesBg urls={fileUrls} interval={settings.bg_interval} seed={seed} /> : <DefaultBg />;
  let bg: ReactNode;
  if (karaoke) bg = <video ref={video} className="bg-media fit" src={videoSrc} muted playsInline preload="auto" />;
  else if (p.bg_kind === "default") bg = <DefaultBg />;
  else if (p.bg_kind === "youtube" && p.bg_value) bg = <OneYoutubeBg key={p.bg_value} id={p.bg_value} />;
  else if (p.bg_kind === "file" && songFile) bg = <FilesBg key={songFile} urls={[{ url: songFile, video: isVideo(p.bg_value ?? "") }]} interval={0} seed={0} />;
  else if (settings.bg_mode === "default") bg = <DefaultBg />;
  else if (settings.bg_mode === "custom") bg = custom;
  else bg = <MvBg key={song.id} song={song} fallback={settings.bg_mv_fallback === "custom" ? custom : <DefaultBg />} />;

  return (
    <div className="stage">
      <div className="stage-bg">{bg}</div>
      <div className="stage-dim" style={{ opacity: karaoke ? 0 : settings.bg_dim / 100 }} />
      {/* 시안 2번: 배경은 화면 전체, 그 위에 머리줄 · 가운데(가사) · 아래(진행 바 · 버튼 줄) */}
      <div className="stage-ui">
        <header className="stage-top" {...topProps}>{top}</header>
        <main className="stage-main">{children}</main>
        {bottom}
      </div>
    </div>
  );
}
