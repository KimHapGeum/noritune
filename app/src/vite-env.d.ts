/// <reference types="vite/client" />

declare module "*/SignalsmithStretch.mjs" {
  type StretchNode = AudioWorkletNode & { start(): Promise<void>; schedule(o: { semitones?: number; rate?: number }): Promise<void> };
  const create: (ctx: BaseAudioContext) => Promise<StretchNode>;
  export default create;
}
