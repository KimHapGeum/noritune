import type { Mode, Settings } from "./api";
import { MODES } from "./api";
import { XIcon } from "./icons";

export const LOWPASS = [0, 12000, 9000, 7000, 5000, 3500]; // 코러스 고음 깎기 단계 (0: 끔)
export const MIX_DEFAULT = { guide: 15, chorus: 50, lowpass: 5000, verb: 20 }; // 기획서 F10 기본값

type Mix = typeof MIX_DEFAULT;

/** 소리 섞기 패널 (기획서 F10·F13, 시안 3번). 재생 화면 오른쪽에 붙는다 */
export default function MixPanel({ mode, separated, hasChorus, mix, onMix, settings, onSettings, onClose }: {
  mode: Mode; separated: boolean; hasChorus: boolean; mix: Mix; onMix: (m: Partial<Mix>) => void;
  settings: Settings; onSettings: (s: Settings) => void; onClose: () => void;
}) {
  const lpIdx = Math.max(0, LOWPASS.indexOf(mix.lowpass));
  const rows = [
    { id: "guide", label: "가이드 보컬", min: 0, max: 100, step: 5, value: mix.guide, text: `${mix.guide}%`, help: "원곡 목소리를 작게 깔아 음을 잡아 줘요", set: (v: number) => onMix({ guide: v }) },
    ...(hasChorus ? [
      { id: "chorus", label: "코러스 음량", min: 0, max: 150, step: 10, value: mix.chorus, text: `${mix.chorus}%`, help: "되살린 코러스를 반주 위에 더해요", set: (v: number) => onMix({ chorus: v }) },
      { id: "lp", label: "코러스 고음 깎기", min: 0, max: 5, step: 1, value: lpIdx, text: lpIdx ? `${LOWPASS[lpIdx] / 1000}kHz 깎기` : "끔", help: "코러스에 남은 휘파람 같은 소리를 줄여요", set: (v: number) => onMix({ lowpass: LOWPASS[v] }) },
      { id: "verb", label: "코러스 울림", min: 0, max: 100, step: 10, value: mix.verb, text: `${mix.verb}%`, help: "소리가 낮아졌다 커지는 경계를 부드럽게 이어요", set: (v: number) => onMix({ verb: v }) },
    ] : []),
  ];

  return (
    <aside className="mix-panel" role="dialog" aria-label="간이 설정">
      <div className="mix-head">
        <h2>간이 설정</h2>
        <button className="icon-btn boxed" aria-label="닫기" onClick={onClose}><XIcon /></button>
      </div>
      <div className="mix-row">
        <div className="mix-label"><label htmlFor="mix-volume">프로그램 소리</label><b>{settings.volume}%</b></div>
        <input id="mix-volume" type="range" min={0} max={100} step={5} value={settings.volume} onChange={(e) => onSettings({ ...settings, volume: Number(e.target.value) })} />
        <div className="muted small">모든 곡에 같이 쓰여요 (마이크는 따로)</div>
      </div>
      <div className="mix-mode"><span className={`chip mode-${MODES.indexOf(mode)}`}>{mode}</span> 아래는 이 곡에만 저장돼요</div>
      {!separated && <p className="muted small-p">반주 그대로·원곡 그대로인 곡은 키·속도만 바꿔요. 곡 메뉴 ⋯에서 반주를 만들면 가이드 보컬을 섞을 수 있어요.</p>}
      {separated && rows.map((r) => (
        <div key={r.id} className="mix-row">
          <div className="mix-label"><label htmlFor={`mix-${r.id}`}>{r.label}</label><b>{r.text}</b></div>
          <input id={`mix-${r.id}`} type="range" min={r.min} max={r.max} step={r.step} value={r.value} onChange={(e) => r.set(Number(e.target.value))} />
          <div className="muted small">{r.help}</div>
        </div>
      ))}
      <section className="mix-mic">
        <div className="mix-label">
          <h3>마이크</h3>
          <label className="check">
            <input type="checkbox" checked={settings.mic_on} onChange={(e) => onSettings({ ...settings, mic_on: e.target.checked })} />
            {settings.mic_on ? "켜짐" : "꺼짐"}
          </label>
        </div>
        {settings.mic_on && (
          <>
            <div className="mix-label"><label htmlFor="mix-micvol">마이크 음량</label><b>{settings.mic_volume}%</b></div>
            <input id="mix-micvol" type="range" min={0} max={150} step={5} value={settings.mic_volume} onChange={(e) => onSettings({ ...settings, mic_volume: Number(e.target.value) })} />
            <div className="mix-label"><label htmlFor="mix-echo">에코</label><b>{settings.mic_echo}%</b></div>
            <input id="mix-echo" type="range" min={0} max={100} step={5} value={settings.mic_echo} onChange={(e) => onSettings({ ...settings, mic_echo: Number(e.target.value) })} />
          </>
        )}
        <div className="muted small">외부 앰프·믹서를 쓰면 꺼 두세요</div>
      </section>
      {separated && <button className="mix-reset" onClick={() => onMix(MIX_DEFAULT)}>기본값으로 되돌리기</button>}
    </aside>
  );
}
