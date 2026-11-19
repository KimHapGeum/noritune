import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { putSettings, type Settings as S } from "./api";

// licenses 폴더의 전문을 모두 보여 준다. 같은 폴더가 설치 파일의 licenses/ 로도 들어간다 (tauri.conf.json)
const LICENSES = import.meta.glob("./licenses/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const NAMES: Record<string, string> = {
  "signalsmith-stretch": "Signalsmith Stretch · 키·속도 엔진",
};

/** 설정 화면. 바꾸면 바로 적용하고 처리기에 저장한다. */
export default function Settings({ settings, onChange, onClose }: {
  settings: S; onChange: (s: S) => void; onClose: () => void;
}) {
  const [version, setVersion] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => void getVersion().then(setVersion).catch(() => {}), []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // 0.4초 동안 더 바꾸지 않으면 저장
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const t = setTimeout(() => putSettings(settings).then(() => setErr("")).catch((e) => setErr(`설정을 저장하지 못했어요: ${e.message}`)), 400);
    return () => clearTimeout(t);
  }, [settings]);

  const delay = settings.lyrics_delay;
  const setDelay = (v: number) => onChange({ ...settings, lyrics_delay: Math.max(-2, Math.min(2, Math.round(v * 100) / 100)) });

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings" role="dialog" aria-label="설정">
        <div className="dialog-head">
          <h2>설정</h2>
          <button aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <section>
            <h3>가사 시간 보정</h3>
            <p className="muted small-p">
              키 엔진 지연(0.12초)과 스피커 지연은 자동으로 맞춰요. 그래도 가사가 노래보다 먼저 나오면 늦추고, 늦게 나오면 앞당기세요.
            </p>
            <div className="ed-shift">
              <button onClick={() => setDelay(delay - 0.05)} disabled={delay <= -2}>0.05초 앞당기기</button>
              <b aria-live="polite">{delay === 0 ? "보정 없음" : `${delay > 0 ? "+" : ""}${delay.toFixed(2)}초`}</b>
              <button onClick={() => setDelay(delay + 0.05)} disabled={delay >= 2}>0.05초 늦추기</button>
            </div>
            <input type="range" min={-1} max={1} step={0.05} value={Math.max(-1, Math.min(1, delay))} aria-label="가사 시간 보정"
              onChange={(e) => setDelay(Number(e.target.value))} />
            {delay !== 0 && <button className="text-btn" onClick={() => setDelay(0)}>보정 없음으로 되돌리기</button>}
          </section>

          <section>
            <h3>재생 화면</h3>
            <label className="check">
              <input type="checkbox" checked={settings.auto_hide} onChange={(e) => onChange({ ...settings, auto_hide: e.target.checked })} />
              부르는 동안 버튼 줄 자동 숨김 (3초 동안 마우스·키보드를 안 쓰면)
            </label>
          </section>

          <section>
            <h3>재생 화면 배경</h3>
            <div className="seg" role="radiogroup" aria-label="기본 배경">
              {([["mv", "유튜브 뮤직비디오"], ["default", "기본 배경화면"], ["custom", "내 배경화면"]] as const).map(([v, label]) => (
                <button key={v} role="radio" aria-checked={settings.bg_mode === v} className={settings.bg_mode === v ? "on" : ""}
                  onClick={() => onChange({ ...settings, bg_mode: v })}>{label}</button>
              ))}
            </div>
            {settings.bg_mode === "mv" && (
              <>
                <p className="muted small-p">곡의 제목과 가수 이름으로 공식 뮤직비디오를 찾아 소리 끄고 반복해서 틀어요. 인터넷이 필요해요.</p>
                <label className="row-label">뮤비를 못 찾으면
                  <select value={settings.bg_mv_fallback} onChange={(e) => onChange({ ...settings, bg_mv_fallback: e.target.value as S["bg_mv_fallback"] })}>
                    <option value="default">기본 배경화면</option>
                    <option value="custom">내 배경화면</option>
                  </select>
                </label>
              </>
            )}
            <h4>내 배경화면</h4>
            <ul className="bg-files">
              {settings.bg_files.map((f, i) => (
                <li key={f}>
                  <span title={f}>{f.split(/[\\/]/).pop()}</span>
                  <button aria-label={`${f.split(/[\\/]/).pop()} 빼기`} onClick={() => onChange({ ...settings, bg_files: settings.bg_files.filter((_, j) => j !== i) })}>✕</button>
                </li>
              ))}
            </ul>
            <button className="text-btn" onClick={async () => {
              const picked = await openFile({ multiple: true, filters: [{ name: "사진·영상", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "mp4", "webm", "mov", "m4v"] }] });
              const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
              if (list.length) onChange({ ...settings, bg_files: [...settings.bg_files, ...list.filter((x) => !settings.bg_files.includes(x))].slice(0, 50) });
            }}>+ 사진·영상 추가</button>
            {settings.bg_files.length > 1 && (
              <label className="row-label">사진 바꾸기
                <select value={settings.bg_interval} onChange={(e) => onChange({ ...settings, bg_interval: Number(e.target.value) as S["bg_interval"] })}>
                  <option value={10}>10초마다</option>
                  <option value={30}>30초마다</option>
                  <option value={0}>곡마다</option>
                </select>
              </label>
            )}
            <label className="row-label">배경 어둡게 <b>{settings.bg_dim}%</b>
              <input type="range" min={0} max={90} step={5} value={settings.bg_dim} onChange={(e) => onChange({ ...settings, bg_dim: Number(e.target.value) })} />
            </label>
          </section>

          <section>
            <h3>정보</h3>
            <p className="muted small-p">Noritune {version && `버전 ${version}`}</p>
            <h4>오픈 소스 라이선스</h4>
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
        </div>
        {err && <div className="error inline" role="alert">{err}</div>}
      </div>
    </div>
  );
}
