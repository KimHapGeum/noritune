import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
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
