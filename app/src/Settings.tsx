import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ask, open as openFile } from "@tauri-apps/plugin-dialog";
import {
  bgUrl, getStorage, getSystem, moveStorage, openLogs, restartEngine, trimStorage, updateYtdlp,
  type Mode, type Settings as S, type Storage,
} from "./api";
import { micLevel } from "./Mic";
import { BackIcon } from "./icons";

// licenses 폴더의 전문을 모두 보여 준다. 같은 폴더가 설치 파일의 licenses/ 로도 들어간다 (tauri.conf.json)
const LICENSES = import.meta.glob("./licenses/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const NAMES: Record<string, string> = {
  "signalsmith-stretch": "Signalsmith Stretch · 키·속도 엔진",
  ffmpeg: "FFmpeg · 소리 바꾸기 (LGPL)",
  "yt-dlp": "yt-dlp · 유튜브 받기",
  deno: "Deno · 유튜브 받기에 쓰는 JavaScript 실행기",
  uv: "uv · 처음 켤 때 부품 받기",
};
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}GB` : `${Math.round(b / 1024 ** 2)}MB`);
const MENU = ["일반", "반주 만들기", "재생 화면 배경", "가사", "키·소리·마이크", "저장 공간", "업데이트", "정보"] as const;
type Menu = (typeof MENU)[number];
const BG_OPTIONS = [
  { id: "default", title: "기본 배경화면", desc: "프로그램에 들어 있는 차분한 배경이에요. 인터넷이 필요 없어요.", label: "기본 배경" },
  { id: "mv", title: "유튜브에서 뮤비 가져오기", desc: "곡마다 공식 뮤직비디오를 자동으로 찾아 배경으로 틀어요. 기본값이에요.", label: "Official MV" },
  { id: "custom", title: "사용자 설정 배경화면", desc: "내 사진이나 영상 파일을 골라 배경으로 써요.", label: "내 사진·영상" },
] as const;
const MODE_CARDS: { mode: Mode; title: string; desc: string }[] = [
  { mode: "빠른 분리", title: "빠른 분리", desc: "약 1분 · 주 목소리만 빼요. 코러스는 반주에 남아요" },
  { mode: "고품질 분리", title: "고품질 분리", desc: "약 5분 · 가이드 보컬·코러스를 따로 조절할 수 있어요" },
  { mode: "원곡 그대로", title: "원곡 그대로", desc: "분리하지 않고 가수 목소리와 함께 불러요" },
  { mode: "반주 그대로", title: "이미 반주예요", desc: "넣는 파일이 모두 반주(MR)일 때" },
];
const isVideo = (p: string) => /\.(mp4|webm|mov|m4v)$/i.test(p);

/** 설정 (시안 6·10번): 왼쪽 메뉴 + 카드. 바꾸면 바로 적용하고 App이 처리기에 저장한다 */
export default function Settings({ settings, onChange, onClose, micLatency, onChanged, appUpdate, onInstallUpdate }: {
  settings: S; onChange: (s: S) => void; onClose: () => void; micLatency: number | null; onChanged: () => void;
  appUpdate: { version: string } | null; onInstallUpdate: () => void;
}) {
  const [menu, setMenu] = useState<Menu>("재생 화면 배경");
  const [version, setVersion] = useState("");
  const [store, setStore] = useState<Storage | null>(null);
  const [sys, setSys] = useState<Awaited<ReturnType<typeof getSystem>> | null>(null);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const set = (patch: Partial<S>) => onChange({ ...settings, ...patch });

  const loadStore = () => {
    getStorage().then(setStore).catch(() => {});
    getSystem(true).then(setSys).catch(() => {});
  };
  useEffect(loadStore, []);
  useEffect(() => void getVersion().then(setVersion).catch(() => {}), []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest?.("input, select") && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === "audioinput" && x.deviceId !== "default" && x.deviceId !== "communications"))).catch(() => {});
  }, [settings.mic_on]);
  useEffect(() => {
    if (!settings.mic_on) return setLevel(0);
    const t = setInterval(() => setLevel(micLevel()), 100);
    return () => clearInterval(t);
  }, [settings.mic_on]);
  useEffect(() => {
    Promise.all(settings.bg_files.map((_, i) => bgUrl(i))).then(setThumbs).catch(() => {});
  }, [settings.bg_files.join("|")]);

  // 반년 넘게 안 부른 곡의 반주 (시안: "6개월 넘게 안 부른 곡 41곡의 반주 (0.2GB)")
  const cut = new Date(Date.now() - 180 * 86400e3).toISOString();
  const old = store?.songs.filter((s) => s.stems && (s.last_played ?? "") < cut) ?? [];
  const oldBytes = old.reduce((t, s) => t + s.stems_bytes, 0);

  async function trim() {
    const r = await trimStorage(180);
    setMsg(r.songs ? `${r.songs}곡의 반주를 지워 ${size(r.freed)}를 비웠어요. 원곡은 남아 있어요.` : "지울 반주가 없어요.");
    loadStore();
    onChanged();
  }
  async function moveFolder() {
    const dir = await openFile({ directory: true, title: "새 저장 폴더 (빈 폴더)" });
    if (typeof dir !== "string") return;
    if (/onedrive|dropbox|google drive|icloud/i.test(dir) &&
      !(await ask("동기화 폴더예요. 용량이 커서 동기화에 부담이 될 수 있어요. 그래도 옮길까요?", { title: "저장 폴더", kind: "warning" }))) return;
    setMsg("곡을 옮기는 중이에요… 곡이 많으면 몇 분 걸려요");
    try {
      await moveStorage(dir);
      await restartEngine(); // 새 폴더로 처리기를 다시 켠다
      location.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function ytdlp() {
    setMsg("yt-dlp를 업데이트하는 중…");
    try {
      const r = await updateYtdlp();
      setMsg(`yt-dlp: ${r.message || "끝났어요"}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function addBgFiles() {
    const picked = await openFile({ multiple: true, filters: [{ name: "사진·영상", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "mp4", "webm", "mov", "m4v"] }] });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (list.length) set({ bg_files: [...settings.bg_files, ...list.filter((x) => !settings.bg_files.includes(x))].slice(0, 50) });
  }

  const k = store?.kinds;
  // 사용량 막대: 쓰는 양 안에서 원곡·반주·영상이 차지하는 비율 (디스크 전체로 나누면 거의 안 보인다)
  const pct = (b: number) => `${store && store.total ? (b / store.total) * 100 : 0}%`;
  const delay = settings.lyrics_delay;
  const setDelay = (v: number) => set({ lyrics_delay: Math.max(-2, Math.min(2, Math.round(v * 100) / 100)) });

  return (
    <div className="settings-page" role="dialog" aria-label="설정">
      <header className="sp-head">
        <button className="sp-back" aria-label="곡 목록으로" onClick={onClose}><BackIcon /></button>
        <h1>설정</h1>
      </header>
      <div className="sp-body">
        <nav aria-label="설정 메뉴" className="sp-nav">
          {MENU.map((m) => (
            <button key={m} className={menu === m ? "on" : ""} aria-current={menu === m ? "page" : undefined} onClick={() => { setMenu(m); setMsg(""); }}>{m}</button>
          ))}
        </nav>
        <main className="sp-main">
          {msg && <p className="note" role="status">{msg}</p>}

          {menu === "일반" && (
            <section className="sp-card">
              <h2>일반</h2>
              <label className="check big">
                <input type="checkbox" checked={settings.auto_hide} onChange={(e) => set({ auto_hide: e.target.checked })} />
                부르는 동안 버튼 줄 자동 숨김 <span className="muted small">3초 동안 마우스·키보드를 안 쓰면 숨겨요</span>
              </label>
              <button className="sp-btn" onClick={() => { set({ onboarded: false }); onClose(); }}>처음 안내 다시 보기</button>
            </section>
          )}

          {menu === "반주 만들기" && (
            <>
              <div><h2 className="sp-title">반주 만들기</h2><div className="sp-sub">곡을 끌어다 놓거나 곡 추가 창을 열 때 처음 골라 둘 방식이에요.</div></div>
              <section className="sp-card">
                {MODE_CARDS.map((c) => (
                  <label key={c.mode} className={`m-card${settings.default_mode === c.mode ? " on" : ""}`}>
                    <input type="radio" name="dm" checked={settings.default_mode === c.mode} onChange={() => set({ default_mode: c.mode })} />
                    <span><b>{c.title}</b><br /><span className="muted small">{c.desc}</span></span>
                  </label>
                ))}
                <div className="muted small">{sys?.gpu ? `그래픽카드 ${sys.gpu} · 고품질 분리를 쓸 수 있어요` : "NVIDIA 그래픽카드가 없으면 빠른 분리를 추천해요 (CPU라 몇 분 걸려요)"}</div>
              </section>
            </>
          )}

          {menu === "재생 화면 배경" && (
            <>
              <div><h2 className="sp-title">재생 화면 배경</h2><div className="sp-sub">모든 곡에 쓰는 기본 배경이에요. 곡마다 재생 화면에서 따로 바꿀 수도 있어요.</div></div>
              <fieldset className="bg-cards">
                <legend className="sr-only">기본 배경 종류</legend>
                {BG_OPTIONS.map((o) => (
                  <label key={o.id} className={`bg-card${settings.bg_mode === o.id ? " on" : ""}`}>
                    <div className={`bg-thumb t-${o.id}`}>{o.id === "default" && <div className="bg-default" aria-hidden />}<span>{o.label}</span></div>
                    <div className="bg-card-title">
                      <input type="radio" name="bg" checked={settings.bg_mode === o.id} onChange={() => set({ bg_mode: o.id })} />
                      <span>{o.title}</span>
                    </div>
                    <div className="bg-card-desc">{o.desc}</div>
                  </label>
                ))}
              </fieldset>
              {settings.bg_mode === "mv" && (
                <section className="sp-card">
                  <h3>유튜브 뮤직비디오 찾는 방법</h3>
                  <div className="sp-text">곡의 <b>제목과 가수 이름</b>으로 유튜브에서 <b>공식 뮤직비디오(Official MV)</b>를 찾아요. 곡 길이는 보지 않아요. 소리는 끄고 반복해서 틀어요.</div>
                  <div className="sp-example">검색 예: <span>아이유 밤편지 Official MV</span></div>
                  <label className="field">뮤직비디오를 못 찾았을 때
                    <select value={settings.bg_mv_fallback} onChange={(e) => set({ bg_mv_fallback: e.target.value as S["bg_mv_fallback"] })}>
                      <option value="default">기본 배경화면으로 보여 주기</option>
                      <option value="custom">사용자 설정 배경화면으로 보여 주기</option>
                    </select>
                  </label>
                  <div className="muted small">인터넷이 없으면 기본 배경화면으로 바뀌어요</div>
                </section>
              )}
              {(settings.bg_mode === "custom" || settings.bg_mv_fallback === "custom") && (
                <section className="sp-card">
                  <h3>내 배경화면</h3>
                  <div className="bg-grid">
                    {settings.bg_files.map((f, i) => (
                      <div key={f} className="bg-tile" title={f}>
                        {!isVideo(f) && thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span>{isVideo(f) ? "영상" : "사진"} {i + 1}</span>}
                        <button className="bg-del" aria-label={`${f.split(/[\\/]/).pop()} 빼기`} onClick={() => set({ bg_files: settings.bg_files.filter((_, j) => j !== i) })}>✕</button>
                      </div>
                    ))}
                    <button className="bg-add" onClick={addBgFiles}>+ 사진·영상 추가</button>
                  </div>
                  <label className="row-label">사진 바꾸는 간격
                    <select value={settings.bg_interval} onChange={(e) => set({ bg_interval: Number(e.target.value) as S["bg_interval"] })}>
                      <option value={10}>10초</option>
                      <option value={30}>30초</option>
                      <option value={0}>곡마다</option>
                    </select>
                  </label>
                </section>
              )}
              <section className="sp-card">
                <div className="sp-row"><label htmlFor="dim" className="sp-label">배경 어둡게</label><b className="accent">{settings.bg_dim}%</b></div>
                <input id="dim" type="range" min={0} max={90} step={5} value={settings.bg_dim} onChange={(e) => set({ bg_dim: Number(e.target.value) })} />
                <div className="muted small">밝은 배경에서도 가사가 잘 보이도록 어둡게 덮어요</div>
              </section>
            </>
          )}

          {menu === "가사" && (
            <section className="sp-card">
              <h2>가사 시간 보정</h2>
              <div className="sp-text">키 엔진 지연(0.12초)과 스피커 지연은 자동으로 맞춰요. 그래도 가사가 노래보다 먼저 나오면 늦추고, 늦게 나오면 앞당기세요.</div>
              <div className="ed-shift">
                <button onClick={() => setDelay(delay - 0.05)} disabled={delay <= -2}>0.05초 앞당기기</button>
                <b aria-live="polite">{delay === 0 ? "보정 없음" : `${delay > 0 ? "+" : ""}${delay.toFixed(2)}초`}</b>
                <button onClick={() => setDelay(delay + 0.05)} disabled={delay >= 2}>0.05초 늦추기</button>
              </div>
              <input type="range" min={-1} max={1} step={0.05} value={Math.max(-1, Math.min(1, delay))} aria-label="가사 시간 보정" onChange={(e) => setDelay(Number(e.target.value))} />
              {delay !== 0 && <button className="sp-btn" onClick={() => setDelay(0)}>보정 없음으로 되돌리기</button>}
            </section>
          )}

          {menu === "키·소리·마이크" && (
            <><section className="sp-card">
              <h2>프로그램 소리</h2>
              <div className="sp-row"><label htmlFor="volume" className="sp-label">노래 소리 크기 (마이크는 아래에서 따로)</label><b className="accent">{settings.volume}%</b></div>
              <input id="volume" type="range" min={0} max={100} step={5} value={settings.volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
            </section>
            <section className="sp-card">
              <div className="sp-row">
                <h2>마이크</h2>
                <label className="check big">
                  <input type="checkbox" checked={settings.mic_on} onChange={(e) => set({ mic_on: e.target.checked })} />
                  {settings.mic_on ? "켜짐" : "꺼짐"}
                </label>
              </div>
              <div className="sp-text">PC 마이크 소리를 에코와 함께 스피커로 내요. 노래방 앰프·믹서에 마이크를 따로 연결해 쓰면 끄고 쓰세요.</div>
              {settings.mic_on && (
                <>
                  <p className="note">스피커 가까이에서 마이크를 쓰면 삐 소리(하울링)가 날 수 있어요. 소리가 갑자기 커지면 자동으로 줄여요.</p>
                  <label className="field">마이크
                    <select value={settings.mic_device} onChange={(e) => set({ mic_device: e.target.value })}>
                      <option value="">Windows 기본 마이크</option>
                      {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || "이름 없는 마이크"}</option>)}
                    </select>
                  </label>
                  <div className="mic-meter" role="meter" aria-label="마이크 소리 크기" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                    <span style={{ width: `${Math.min(100, level * 100)}%`, background: level > 0.9 ? "#ff6b6b" : "#4cc9f0" }} />
                  </div>
                  <div className="sp-row"><label htmlFor="micvol" className="sp-label">마이크 음량</label><b className="accent">{settings.mic_volume}%</b></div>
                  <input id="micvol" type="range" min={0} max={150} step={5} value={settings.mic_volume} onChange={(e) => set({ mic_volume: Number(e.target.value) })} />
                  <div className="sp-row"><label htmlFor="echo" className="sp-label">에코</label><b className="accent">{settings.mic_echo}%</b></div>
                  <input id="echo" type="range" min={0} max={100} step={5} value={settings.mic_echo} onChange={(e) => set({ mic_echo: Number(e.target.value) })} />
                  {micLatency !== null && (
                    <p className={micLatency > 0.1 ? "note warn" : "muted small"}>
                      마이크 소리가 스피커로 나오기까지 약 {micLatency.toFixed(2)}초 걸려요.{micLatency > 0.1 && " 늦게 들리면 유선 마이크·헤드셋을 쓰거나 외부 믹서를 쓰세요."}
                    </p>
                  )}
                </>
              )}
              <div className="muted small">키·속도와 가이드 보컬·코러스는 재생 화면에서 곡마다 바꾸고, 곡마다 기억해요.</div>
            </section></>
          )}

          {menu === "저장 공간" && (
            <section className="sp-card">
              <h2>저장 공간</h2>
              <div className="sp-row wrap">
                <div className="sp-text">저장 폴더 <span className="hi">{sys?.data_dir ?? "…"}</span></div>
                <button className="sp-btn" onClick={moveFolder}>폴더 바꾸기</button>
              </div>
              {sys?.synced && <p className="note warn">동기화 폴더(OneDrive 등) 안이에요. 용량이 커서 동기화에 부담이 될 수 있어요.</p>}
              {store && k && (
                <div>
                  <div className="sp-row"><span><b>{size(store.total)}</b> 사용 중 · {store.songs.length}곡</span><span className="muted">남은 공간 {sys ? size(sys.free) : "…"}</span></div>
                  <div className="usage" role="img" aria-label={`원곡 ${size(k.original)}, 반주 ${size(k.stems)}, 노래방 영상 ${size(k.video)}`}>
                    <span style={{ width: pct(k.original), background: "#9ed9f2" }} />
                    <span style={{ width: pct(k.stems), background: "var(--accent)" }} />
                    <span style={{ width: pct(k.video), background: "#ffd59e" }} />
                  </div>
                  <div className="legend">
                    <span><i style={{ background: "#9ed9f2" }} /> 원곡 {size(k.original)}</span>
                    <span><i style={{ background: "var(--accent)" }} /> 반주·보컬·코러스 {size(k.stems)}</span>
                    <span><i style={{ background: "#ffd59e" }} /> 노래방 영상 {size(k.video)}</span>
                  </div>
                </div>
              )}
              <div className="sp-trim">
                <div className="sp-text">6개월 넘게 안 부른 곡 {old.length}곡의 반주 ({size(oldBytes)})<br /><span className="muted small">원곡은 남겨서 언제든 다시 만들 수 있어요</span></div>
                <button className="danger-btn" onClick={trim} disabled={!old.length}>반주 지우기</button>
              </div>
            </section>
          )}

          {menu === "업데이트" && (
            <section className="sp-card">
              <h2>업데이트</h2>
              <div className="up-row">
                <div><div className="up-name">Noritune</div><div className="muted">지금 {version}{appUpdate ? ` · 새 버전 ${appUpdate.version}` : ""}</div></div>
                <div className="up-right">
                  <span style={{ color: appUpdate ? "#ffd59e" : "#7ee2a8" }}>{appUpdate ? "새 버전 있음" : "최신"}</span>
                  {appUpdate && <button className="primary small-btn" onClick={onInstallUpdate}>업데이트</button>}
                </div>
              </div>
              <div className="up-row">
                <div><div className="up-name">yt-dlp (유튜브 받기)</div>
                  <div className="muted">{settings.ytdlp_checked > 0 ? `${new Date(settings.ytdlp_checked * 1000).toLocaleDateString("ko-KR")}에 확인함` : "아직 확인 안 함"}</div></div>
                <div className="up-right"><button className="sp-btn" onClick={ytdlp}>지금 업데이트</button></div>
              </div>
              <div className="up-row">
                <div><div className="up-name">분리 모델</div>
                  <div className="muted">빠른 분리 모델 {sys?.models.quick ? "받음" : "안 받음"} · 고품질 모델 {sys?.models.hq ? "받음" : "안 받음"}</div></div>
                <div className="up-right"><span className="muted">필요할 때 받아요</span></div>
              </div>
              <label className="check big">
                <input type="checkbox" checked={settings.ytdlp_auto} onChange={(e) => set({ ytdlp_auto: e.target.checked })} />
                yt-dlp는 일주일마다 자동으로 업데이트
              </label>
              <button className="link-btn" onClick={() => openLogs().catch(() => {})}>로그 폴더 열기 (문제 신고용)</button>
            </section>
          )}

          {menu === "정보" && (
            <section className="sp-card">
              <h2>정보</h2>
              <div className="sp-text">Noritune {version && `버전 ${version}`} · 내 노래를 반주로 만들어 부르는 PC 노래방</div>
              <h3>오픈 소스 라이선스</h3>
              {Object.entries(LICENSES).map(([path, text]) => {
                const id = path.split("/").pop()!.replace(/\.txt$/, "");
                return (
                  <details key={id} className="license">
                    <summary>{NAMES[id] ?? id}</summary>
                    <pre>{text}</pre>
                  </details>
                );
              })}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
