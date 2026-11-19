import { useEffect, useState } from "react";
import { getSystem } from "./api";

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)}GB`;

/** 처음 켰을 때 한 번 나오는 4단계 안내 (기획서 F17). 설정에서 다시 볼 수 있다 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [sys, setSys] = useState<{ data_dir: string; free: number; synced: boolean; gpu?: string | null } | null>(null);
  useEffect(() => void getSystem(true).then(setSys).catch(() => {}), []);

  const pages = [
    <>
      <h2>Noritune에 오신 걸 환영해요</h2>
      <p>내 노래 파일이나 유튜브 영상을 반주로 만들어, 가사와 함께 부르는 PC 노래방이에요.</p>
    </>,
    <>
      <h2>PC 확인</h2>
      {!sys ? <p className="muted">확인하는 중…</p> : (
        <ul className="ob-list">
          <li>{sys.gpu ? <>그래픽카드 <b>{sys.gpu}</b> · 고품질 분리를 쓸 수 있어요</> : <>NVIDIA 그래픽카드가 없어요 · <b>빠른 분리</b>를 추천해요 (CPU라 몇 분 걸려요)</>}</li>
          <li>남은 디스크 공간 <b>{gb(sys.free)}</b>{sys.free < 10 * 1024 ** 3 && " · 곡 하나에 20~60MB쯤 써요"}</li>
        </ul>
      )}
    </>,
    <>
      <h2>저장 폴더</h2>
      <p>곡과 반주는 여기에 저장해요.</p>
      <p className="ob-path">{sys?.data_dir ?? "…"}</p>
      {sys?.synced && <p className="note warn">OneDrive 같은 동기화 폴더예요. 용량이 커서 동기화에 부담이 될 수 있어요.</p>}
    </>,
    <>
      <h2>알아 둘 것</h2>
      <ul className="ob-list">
        <li>개인이 혼자 즐기는 용도예요.</li>
        <li>받은 곡과 만든 반주는 다른 사람과 공유하지 마세요 (저작권).</li>
        <li>반주를 만드는 모델은 그 방식을 처음 쓸 때 받아요 (빠른 분리 약 0.9GB, 고품질 약 2.4GB).</li>
      </ul>
    </>,
  ];

  return (
    <div className="backdrop">
      <div className="dialog onboarding" role="dialog" aria-label="처음 안내">
        <div className="ob-body">{pages[step]}</div>
        <div className="dialog-foot">
          <span className="ob-dots" aria-label={`${step + 1} / ${pages.length}`}>
            {pages.map((_, i) => <span key={i} className={i === step ? "on" : ""} />)}
          </span>
          {step > 0 && <button onClick={() => setStep(step - 1)}>이전</button>}
          {step < pages.length - 1
            ? <button className="primary" onClick={() => setStep(step + 1)}>다음</button>
            : <button className="primary" onClick={onDone}>시작하기</button>}
        </div>
      </div>
    </div>
  );
}
