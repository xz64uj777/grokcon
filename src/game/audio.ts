export type MachineSound = "skid" | "loader" | "excavator" | "dozer" | "truck" | "other";

export function createAudio() {
  let ctx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let osc2: OscillatorNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let engine: GainNode | null = null;
  let muted = false;
  let started = false;
  let hydraulicAt = 0;

  function ac() {
    if (!ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctx();
      osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 42;
      osc2 = ctx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.value = 22;
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 150;
      engine = ctx.createGain();
      engine.gain.value = 0;
      const sub = ctx.createGain();
      sub.gain.value = 0.28;
      osc.connect(filter);
      filter.connect(engine);
      engine.connect(ctx.destination);
      osc2.connect(sub);
      sub.connect(engine);
      osc.start();
      osc2.start();
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

  function noise(dur: number, gain: number, frequency = 180) {
    if (!ctx || muted) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filterN = ctx.createBiquadFilter();
    filterN.type = "bandpass";
    filterN.frequency.value = frequency;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filterN);
    filterN.connect(g);
    g.connect(ctx.destination);
    src.start();
  }

  return {
    unlock() {
      try { ac(); } catch { /* audio is optional */ }
    },
    setMuted(m: boolean) {
      muted = m;
      if (engine && ctx) engine.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    },
    engine(speed: number, throttle: number, machine: MachineSound = "other") {
      if (!started || !ctx || !osc || !osc2 || !engine || !filter || muted) return;
      // Distinct synthesized profiles based on real machine references:
      // compact/high-rev skid steer, broad loader, heavy tracked dozer,
      // excavator idle and low-frequency haul-truck diesel.
      const profile = {
        skid: { base: 38, rev: 1.65, filter: 118, wave: "triangle" as OscillatorType, sub: 0.34 },
        loader: { base: 42, rev: 2.5, filter: 155, wave: "sawtooth" as OscillatorType, sub: 0.3 },
        excavator: { base: 36, rev: 2.0, filter: 125, wave: "triangle" as OscillatorType, sub: 0.36 },
        dozer: { base: 29, rev: 1.8, filter: 110, wave: "sawtooth" as OscillatorType, sub: 0.44 },
        truck: { base: 24, rev: 1.25, filter: 82, wave: "triangle" as OscillatorType, sub: 0.62 },
        other: { base: 39, rev: 2.2, filter: 145, wave: "sawtooth" as OscillatorType, sub: 0.3 },
      }[machine];
      const moving = Math.min(1, Math.abs(speed) / 8);
      const load = Math.min(1, Math.abs(throttle));
      const vol = Math.min(0.052, 0.006 + moving * 0.018 + load * 0.019);
      osc.type = profile.wave;
      engine.gain.setTargetAtTime(vol, ctx.currentTime, 0.12);
      osc.frequency.setTargetAtTime(profile.base + moving * 5 + load * 4 + profile.rev * Math.abs(speed), ctx.currentTime, 0.18);
      osc2.frequency.setTargetAtTime(profile.base * 0.48 + moving * 4, ctx.currentTime, 0.12);
      filter.frequency.setTargetAtTime(profile.filter + load * (machine === "truck" ? 70 : 105) + moving * 35, ctx.currentTime, 0.18);
    },
    hydraulics(machine: MachineSound, lift: number, tilt: number) {
      if (muted || !ctx || !started) return;
      const movement = Math.max(Math.abs(lift), Math.abs(tilt));
      if (movement < 0.18 || ctx.currentTime - hydraulicAt < 0.16) return;
      hydraulicAt = ctx.currentTime;
      const freq = machine === "excavator" ? 620 : machine === "skid" ? 760 : machine === "loader" ? 490 : machine === "dozer" ? 280 : 360;
      tone(freq + movement * 240, 0.12, "sawtooth", machine === "dozer" ? 0.018 : 0.012);
      if (machine === "skid" || machine === "loader" || machine === "excavator") noise(0.08, 0.008, freq);
    },
    dig() {
      try { ac(); noise(0.12, 0.08, 180); } catch { /* ignore */ }
    },
    sell() {
      try {
        ac();
        tone(523, 0.12, "triangle", 0.06);
        tone(784, 0.18, "triangle", 0.045);
      } catch { /* ignore */ }
    },
    stop() {
      try { osc?.stop(); osc2?.stop(); void ctx?.close(); } catch { /* ignore */ }
      ctx = null;
      started = false;
    },
  };
}
