// 마이크 (기획서 F13): 마이크 → 음량 → (그대로 + 에코) → 스피커. 키·속도 엔진은 거치지 않는다.
// 곡이 바뀌어도 끊기지 않게 재생기와 따로 자기 AudioContext를 쓴다.
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let gain: GainNode | null = null;
let wet: GainNode | null = null;
let fb: GainNode | null = null;
let meter: AnalyserNode | null = null; // 스피커로 나가는 소리 (하울링 감시)
let input: AnalyserNode | null = null; // 마이크로 들어오는 소리 (설정 화면 막대)
let watch = 0;
let volume = 0.8;
let safety = 1; // 하울링으로 줄인 비율

const HOWL_PEAK = 0.95; // 이 크기를 넘는 소리가
const HOWL_CHECKS = 4; // 50ms씩 4번(0.2초) 이어지면 하울링으로 본다

/** 켠다. 돌려주는 값: 마이크 소리가 스피커로 나오기까지 걸리는 시간(초) */
export async function startMic(deviceId: string, onHowl: () => void): Promise<number> {
  stopMic();
  // 노래 목소리를 그대로 내야 하므로 통화용 처리(에코 제거·잡음 제거·자동 음량)를 끈다
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  ctx = new AudioContext({ latencyHint: "interactive" });
  const src = ctx.createMediaStreamSource(stream);
  gain = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.11;
  const tone = ctx.createBiquadFilter(); // 에코는 고음을 조금 깎아 부드럽게
  tone.type = "lowpass";
  tone.frequency.value = 5000;
  wet = ctx.createGain();
  fb = ctx.createGain();
  meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  input = ctx.createAnalyser();
  input.fftSize = 1024;
  src.connect(input);
  src.connect(gain);
  gain.connect(ctx.destination);
  gain.connect(meter);
  gain.connect(delay).connect(tone).connect(wet).connect(ctx.destination);
  tone.connect(fb).connect(delay);
  safety = 1;
  applyGain();

  // 하울링 방지: 소리가 갑자기 치솟아 이어지면 절반으로 줄인다
  let loud = 0;
  const buf = new Float32Array(meter.fftSize);
  watch = window.setInterval(() => {
    meter!.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const x of buf) peak = Math.max(peak, Math.abs(x));
    loud = peak > HOWL_PEAK ? loud + 1 : 0;
    if (loud >= HOWL_CHECKS && safety > 0.1) {
      safety /= 2;
      applyGain();
      loud = 0;
      onHowl();
    }
  }, 50);
  // 출력 지연(outputLatency)은 소리가 실제로 돌기 시작한 뒤에야 값이 찬다 (막 만든 직후엔 0이라 0.02초로 잘못 나왔다)
  await ctx.resume();
  await new Promise((r) => setTimeout(r, 500));
  if (!ctx) return 0; // 그사이 껐다
  // latency는 크롬(WebView2)이 주는 값인데 TypeScript 타입에는 아직 없다
  const inLatency = (stream.getAudioTracks()[0].getSettings() as MediaTrackSettings & { latency?: number }).latency ?? 0;
  return inLatency + ctx.baseLatency + (ctx.outputLatency || 0);
}

function applyGain() {
  if (gain) gain.gain.value = volume * safety;
}

/** volume 0~150(%), echo 0~100(%) */
export function setMic(vol: number, echo: number) {
  volume = vol / 100;
  safety = 1; // 사용자가 음량을 다시 정하면 하울링으로 줄인 것을 풀어 준다
  applyGain();
  if (wet && fb) {
    wet.gain.value = (echo / 100) * 0.6;
    fb.gain.value = (echo / 100) * 0.45; // 0.5를 넘기면 메아리가 끝없이 커질 수 있다
  }
}

/** 마이크로 들어오는 소리 크기 0~1 (설정 화면의 막대용, 음량과 상관없이) */
export function micLevel(): number {
  if (!input) return 0;
  const buf = new Float32Array(input.fftSize);
  input.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  return peak;
}

export function stopMic() {
  clearInterval(watch);
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = stream = gain = wet = fb = meter = input = null;
}
