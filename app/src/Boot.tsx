import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogoMark } from "./icons";

type BootState = { phase: "setup" | "ready" | "failed"; text: string; mb: number };

/** 처리기가 준비될 때까지 보여 주는 화면. 설치판은 처음 켤 때 부품(파이썬·PyTorch)을 받느라 몇 분 걸린다 */
export default function Boot({ children }: { children: ReactNode }) {
  const [b, setB] = useState<BootState>({ phase: "setup", text: "켜는 중", mb: 0 });
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const s = await invoke<BootState>("boot_state").catch(() => null);
      if (stop) return;
      if (s) setB(s);
      if (s?.phase !== "ready") setTimeout(tick, 500);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [b.phase === "failed"]); // 다시 시도하면 다시 물어 간다

  if (b.phase === "ready") return <>{children}</>;
  return (
    <div className="boot" role="status" aria-live="polite">
      <LogoMark size={72} />
      <h1>Noritune</h1>
      <p>{b.phase === "failed" ? "준비하지 못했어요" : b.text}</p>
      {b.phase === "setup" && b.mb > 0 && <p className="muted">{b.mb >= 1000 ? `${(b.mb / 1000).toFixed(1)}GB` : `${b.mb}MB`} 받음 · 앱을 꺼도 다음에 이어서 받아요</p>}
      {b.phase === "setup" && <div className="boot-bar" aria-hidden="true"><span /></div>}
      {b.phase === "failed" && (
        <>
          <p className="boot-err">{b.text}</p>
          <button className="primary" onClick={() => invoke("retry_boot").then(() => setB({ phase: "setup", text: "다시 준비하는 중", mb: 0 }))}>다시 시도</button>
        </>
      )}
    </div>
  );
}
