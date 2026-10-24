export function createAudio() {
  let ctx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let engine: GainNode | null = null;
  let muted = false;
  let started = false;

  function ac() {
    if (!ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctx();
      osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 46;
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 160;
      engine = ctx.createGain();
      engine.gain.value = 0;
      osc.connect(filter);
      filter.connect(engine);
      engine.connect(ctx.destination);
      osc.start();
      started = true;
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  function tone(freq: number, dur: number, type: OscillatorType, gain: number) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  function noise(dur: number, gain: number) {
    if (!ctx || muted) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filterN = ctx.createBiquadFilter();
    filterN.type = "bandpass";
    filterN.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filterN);
    filterN.connect(g);
    g.connect(ctx.destination);
    src.start();
  }

  return {
    unlock() {
      try {
        ac();
      } catch {
        /* audio is optional */
      }
    },
    setMuted(m: boolean) {
      muted = m;
      if (engine && ctx) engine.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    },
    engine(speed: number, throttle: number) {
      if (!started || !ctx || !osc || !engine || !filter || muted) return;
      const vol = Math.min(0.045, Math.abs(speed) * 0.0022 + (Math.abs(throttle) > 0.08 ? 0.012 : 0.004));
      engine.gain.setTargetAtTime(vol, ctx.currentTime, 0.08);
      osc.frequency.setTargetAtTime(38 + Math.abs(speed) * 2.4, ctx.currentTime, 0.08);
      filter.frequency.setTargetAtTime(140 + Math.abs(throttle) * 90, ctx.currentTime, 0.08);
    },
    dig() {
      try {
        ac();
        noise(0.12, 0.08);
      } catch {
        /* ignore */
      }
    },
    sell() {
      try {
        ac();
        tone(523, 0.12, "triangle", 0.06);
        tone(784, 0.18, "triangle", 0.045);
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        osc?.stop();
        void ctx?.close();
      } catch {
        /* ignore */
      }
      ctx = null;
      started = false;
    },
  };
}
