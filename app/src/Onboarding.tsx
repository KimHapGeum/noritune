import { useEffect, useState } from "react";
import { getSystem } from "./api";
import { MicIcon } from "./icons";

const gb = (b: number) => `${Math.round(b / 1024 ** 3)}GB`;
const STEPS = ["환영", "PC 확인", "저장 폴더", "알아 둘 것"];

/** 처음 켰을 때 한 번 나오는 4단계 안내 (기획서 F17, 시안 9번). 설정 → 일반에서 다시 볼 수 있다 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [sys, setSys] = useState<Awaited<ReturnType<typeof getSystem>> | null>(null);
  useEffect(() => void getSystem(true).then(setSys).catch(() => {}), []);

  const pages = [
    <>
      <div><h1>Noritune에 오신 걸 환영해요</h1><div className="ob-sub">내 노래 파일이나 유튜브 영상을 반주로 만들어, 가사와 함께 부르는 PC 노래방이에요.</div></div>
      <div className="ob-box"><MicIcon size={36} /><div><b>곡을 넣으면 반주를 만들고 가사를 찾아 줘요</b><div className="ob-desc">키·속도를 내 목소리에 맞추고, 여러 곡을 예약해 이어 부를 수 있어요.</div></div></div>
    </>,
    <>
      <div><h1>PC를 확인했어요</h1><div className="ob-sub">이 PC에 맞는 반주 만들기 방식을 알려 드릴게요.</div></div>
      {!sys ? <p className="muted">확인하는 중…</p> : (
        <>
          <div className={`ob-box${sys.gpu ? " good" : ""}`}>
            <div><b>{sys.gpu ?? "NVIDIA 그래픽카드가 없어요"}</b>
              <div className="ob-desc">{sys.gpu ? "고품질 분리를 쓸 수 있어요. 4분 곡의 반주를 빠른 분리 약 1분, 고품질 약 5분에 만들어요." : "빠른 분리를 추천해요 (CPU). 반주를 만드는 데 몇 분 걸려요."}</div></div>
          </div>
          <div className="ob-box">
            <div><b>디스크 남은 공간 {gb(sys.free)}</b>
              <div className="ob-desc">곡 하나에 약 15MB가 필요해요.{sys.free > 20 * 1024 ** 3 ? " 1,000곡도 넉넉해요." : ""}</div></div>
          </div>
        </>
      )}
    </>,
    <>
      <div><h1>저장 폴더</h1><div className="ob-sub">곡과 반주를 저장할 곳이에요. 설정 → 저장 공간에서 언제든 바꿀 수 있어요.</div></div>
      <div className="ob-box"><div><b className="ob-path">{sys?.data_dir ?? "…"}</b><div className="ob-desc">받은 원곡·반주·가사가 여기에 모여요. 내 PC의 원본 파일은 건드리지 않아요.</div></div></div>
      {sys?.synced && <div className="ob-box warn"><div><b>동기화 폴더예요</b><div className="ob-desc">OneDrive 같은 동기화 폴더는 용량이 커서 동기화에 부담이 될 수 있어요.</div></div></div>}
    </>,
    <>
      <div><h1>알아 둘 것</h1><div className="ob-sub">편하게 쓰시기 전에 이것만 기억해 주세요.</div></div>
      <div className="ob-box"><div><b>개인이 즐기는 용도예요</b><div className="ob-desc">받은 곡과 만든 반주는 다른 사람과 공유하지 마세요 (저작권).</div></div></div>
      <div className="ob-box"><div><b>분리 모델은 처음 쓸 때 받아요</b><div className="ob-desc">빠른 분리 약 0.9GB, 고품질 분리 약 2.4GB. 그 방식을 처음 고를 때 한 번만 받아요.</div></div></div>
    </>,
  ];

  return (
    <div className="onboarding" role="dialog" aria-label="처음 안내">
      <div className="ob-wrap">
        <ol className="ob-steps" aria-label="안내 단계">
          {STEPS.map((label, i) => (
            <li key={label} className={i <= step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
              <div className="ob-bar" /><span className={i === step ? "cur" : ""}>{i + 1}. {label}</span>
            </li>
          ))}
        </ol>
        <div className="ob-card">{pages[step]}</div>
        <div className="ob-foot">
          <button className="ob-prev" onClick={() => setStep(step - 1)} disabled={step === 0}>이전</button>
          {step < STEPS.length - 1
            ? <button className="ob-next" onClick={() => setStep(step + 1)}>다음: {STEPS[step + 1]}</button>
            : <button className="ob-next" onClick={onDone}>시작하기</button>}
        </div>
      </div>
    </div>
  );
}
