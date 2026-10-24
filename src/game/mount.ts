import { createAudio } from "@/game/audio";
import { BOUNDS, CLAIMS, GATE, ORES, PADS, isVehicleId } from "@/game/catalog";
import { createWorld } from "@/game/render";
import { loadGame, saveGame } from "@/game/save";
import { buildHud, buyClaim, buySluicePlant, buyUpgrade, buyVehicle, freshGame, setActive, step, toggleCrew } from "@/game/sim";
import type { GameApi, Input, ViewModel } from "@/game/types";

type Floater = { x: number; y: number; z: number; text: string; life: number };

type Hooks = {
  onHud: (view: ViewModel) => void;
  onApi: (api: GameApi) => void;
  onTogglePanel: () => void;
  onClosePanel: () => void;
};

export function mountGame(host: HTMLElement, hooks: Hooks) {
  const loaded = loadGame();
  const hadSave = loaded != null;
  let state = loaded ?? freshGame("Ridge Ore Co.");
  let running = false;
  let panelOpen = false;
  let dead = false;
  const keys = new Set<string>();
  let injected: Set<string> | null = null;
  let steerOverride: number | null = null;
  const stick = { steer: 0, throttle: 0 };
  const cameraPointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let actionBtn = false;

  const world = createWorld(host);
  const audio = createAudio();
  const overlay = document.createElement("canvas");
  overlay.className = "pointer-events-none absolute inset-0 h-full w-full";
  host.appendChild(overlay);
  const ctx = overlay.getContext("2d");

  const floaters: Floater[] = [];
  let last = performance.now();
  let acc = 0;
  let hudT = 0;
  let saveT = 0;
  let digCool = 0;
  let raf = 0;

  function push() {
    if (dead) return;
    hooks.onHud({ ...buildHud(state, hadSave), mode: running ? "play" : "title" });
  }

  function held(code: string) {
    if (injected) return injected.has(code);
    return keys.has(code);
  }

  function readInput(): Input {
    let throttle = stick.throttle;
    let steer = stick.steer;
    if (held("KeyW") || held("ArrowUp")) throttle += 1;
    if (held("KeyS") || held("ArrowDown")) throttle -= 1;
    if (held("KeyA") || held("ArrowLeft")) steer += 1;
    if (held("KeyD") || held("ArrowRight")) steer -= 1;
    if (steerOverride != null) steer = steerOverride;
    throttle = Math.max(-1, Math.min(1, throttle));
    steer = Math.max(-1, Math.min(1, steer));
    const action = held("Space") || held("KeyE") || actionBtn;
    return { throttle, steer, action };
  }

  const api: GameApi = {
    start(mode, company) {
      const name = company.trim().slice(0, 24) || "Ridge Ore Co.";
      if (mode === "fresh" || !hadSave) state = freshGame(name);
      else state.company = name;
      running = true;
      keys.clear();
      world.snap();
      audio.unlock();
      saveGame(state);
      push();
    },
    setPanel(open) {
      panelOpen = open;
    },
    buy(id) {
      if (id === "sluice") buySluicePlant(state);
      else if (isVehicleId(id)) buyVehicle(state, id);
      saveGame(state);
      push();
    },
    buyGround(id) {
      buyClaim(state, id);
      saveGame(state);
      push();
    },
    upgrade(index, kind) {
      buyUpgrade(state, index, kind);
      saveGame(state);
      push();
    },
    crew(index) {
      toggleCrew(state, index);
      saveGame(state);
      push();
    },
    assignSource(index, claim) {
      const v = state.vehicles[index];
      if (!v || (index !== state.active && !v.operator)) return;
      v.workClaim = claim != null && state.claims.includes(claim) ? claim : null;
      v.status = claim == null ? "Assigned to any leased source" : `Assigned to ${CLAIMS.find((c) => c.id === claim)?.name ?? "source"}`;
      saveGame(state);
      push();
    },
    drive(index) {
      setActive(state, index);
      world.snap();
      push();
    },
    setStick(steer, throttle) {
      stick.steer = steer;
      stick.throttle = throttle;
    },
    setAction(down) {
      actionBtn = down;
    },
    toggleMute() {
      state.muted = !state.muted;
      audio.setMuted(state.muted);
      push();
    },
    cycle(dir) {
      if (!state.vehicles.length) return;
      const next = (state.active + dir + state.vehicles.length) % state.vehicles.length;
      setActive(state, next);
      world.snap();
      push();
    },
  };

  const qa = import.meta.env.DEV || new URLSearchParams(window.location.search).has("qa");
  if (qa) {
    window.__controlsTest = {
      getYaw: () => state.vehicles[state.active]?.yaw ?? 0,
      getSpeed: () => state.vehicles[state.active]?.speed ?? 0,
      setSteer(v: number) {
        steerOverride = v;
      },
      setKeys(codes: string[]) {
        injected = new Set(codes);
      },
    };
  }

  function onCameraPointerDown(e: PointerEvent) {
    if (!running || !(e.target instanceof HTMLCanvasElement)) return;
    cameraPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cameraPointers.size === 2) {
      const pts = [...cameraPointers.values()];
      pinchDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    }
  }
  function onCameraPointerMove(e: PointerEvent) {
    const prev = cameraPointers.get(e.pointerId);
    if (!prev || !(e.target instanceof HTMLCanvasElement)) return;
    const next = { x: e.clientX, y: e.clientY };
    cameraPointers.set(e.pointerId, next);
    if (cameraPointers.size >= 2) {
      const pts = [...cameraPointers.values()];
      const distance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (pinchDistance > 0 && distance > 0) world.zoom(distance / pinchDistance);
      pinchDistance = distance;
    } else {
      world.cameraDrag(next.x - prev.x);
    }
  }
  function onCameraPointerEnd(e: PointerEvent) {
    cameraPointers.delete(e.pointerId);
    if (cameraPointers.size < 2) pinchDistance = 0;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === "Space" || e.code.startsWith("Arrow") || e.code === "Tab") e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (!running) return;
    if (e.code === "Tab") hooks.onTogglePanel();
    if (e.code === "Escape") hooks.onClosePanel();
    if (e.code === "KeyV") api.cycle(1);
    if (e.code === "KeyC") world.cycleCam();
    if (e.code === "KeyM") api.toggleMute();
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function onBlur() {
    keys.clear();
    actionBtn = false;
    stick.steer = 0;
    stick.throttle = 0;
  }
  function onHide() {
    if (document.hidden) {
      keys.clear();
      if (running) saveGame(state);
      audio.setMuted(true);
    } else if (!state.muted) audio.setMuted(false);
  }

  host.addEventListener("pointerdown", onCameraPointerDown, { passive: false });
  host.addEventListener("pointermove", onCameraPointerMove, { passive: false });
  host.addEventListener("pointerup", onCameraPointerEnd);
  host.addEventListener("pointercancel", onCameraPointerEnd);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onHide);
  const resize = () => {
    world.resize();
    sizeOverlay();
  };
  window.addEventListener("resize", resize);
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  function sizeOverlay() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    overlay.width = Math.floor(w * dpr);
    overlay.height = Math.floor(h * dpr);
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeOverlay();

  function drawOverlay(dt: number) {
    if (!ctx) return;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    ctx.clearRect(0, 0, w, h);
    const m = w < 700 ? 96 : 118;
    const x0 = w - m - 12;
    const y0 = 12;
    ctx.fillStyle = "rgba(20,18,16,0.82)";
    ctx.fillRect(x0, y0, m, m);
    ctx.strokeStyle = "#3f382f";
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, m - 1, m - 1);
    const sx = (x: number) => x0 + ((x - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * m;
    const sz = (z: number) => y0 + ((z - BOUNDS.minZ) / (BOUNDS.maxZ - BOUNDS.minZ)) * m;
    ctx.fillStyle = "#e26a2c";
    ctx.fillRect(sx(GATE.x) - 2, sz(GATE.z) - 2, 4, 4);
    for (const pad of PADS) {
      if (pad.kind === "sluice" && !state.sluice) continue;
      ctx.fillStyle = pad.kind === "reclaim" ? "#e6b325" : "#e26a2c";
      ctx.beginPath();
      ctx.arc(sx(pad.x), sz(pad.z), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const d of state.deposits) {
      if (d.tons < 0.2 && d.regen <= 0) continue;
      ctx.fillStyle = state.claims.includes(d.claim) ? oreHex(d.ore) : "#4a463f";
      ctx.fillRect(sx(d.x) - 2, sz(d.z) - 2, 4, 4);
    }
    for (let i = 0; i < state.vehicles.length; i++) {
      const v = state.vehicles[i];
      ctx.fillStyle = i === state.active ? "#f4efe6" : "#a39888";
      ctx.beginPath();
      ctx.arc(sx(v.x), sz(v.z), i === state.active ? 3.5 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    const p = state.vehicles[state.active];
    if (p) {
      const fx = -Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      ctx.strokeStyle = "#f4efe6";
      ctx.beginPath();
      ctx.moveTo(sx(p.x), sz(p.z));
      ctx.lineTo(sx(p.x + fx * 8), sz(p.z + fz * 8));
      ctx.stroke();
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      f.y += dt * 1.4;
      if (f.life <= 0) {
        floaters.splice(i, 1);
        continue;
      }
      const pt = world.project(f.x, f.y, f.z, w, h);
      if (!pt) continue;
      ctx.globalAlpha = Math.min(1, f.life);
      ctx.font = "600 16px Barlow, sans-serif";
      ctx.fillStyle = "#e6b325";
      ctx.fillText(f.text, pt.x, pt.y);
      ctx.globalAlpha = 1;
    }
  }

  function loop(now: number) {
    if (dead) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let digPulse = false;
    if (running) {
      acc += dt;
      let guard = 0;
      const input = readInput();
      while (acc >= 1 / 60 && guard < 5) {
        const fx = step(state, input, 1 / 60, !panelOpen);
        for (const s of fx.sales) {
          floaters.push({ x: s.x, y: 3.4, z: s.z, text: s.text, life: 1.35 });
          if (floaters.length > 8) floaters.shift();
          if (s.player) {
            audio.sell();
            world.kick(0.16);
          }
        }
        if (fx.dig) digPulse = true;
        acc -= 1 / 60;
        guard++;
      }
      if (digPulse && digCool <= 0) {
        audio.dig();
        digCool = 0.16;
      }
      digCool = Math.max(0, digCool - dt);
      const v = state.vehicles[state.active];
      audio.engine(v?.speed ?? 0, panelOpen ? 0 : input.throttle);
      saveT += dt;
      if (saveT > 4) {
        saveGame(state);
        saveT = 0;
      }
    }
    world.sync(state, dt, running);
    drawOverlay(dt);
    hudT += dt;
    if (hudT > 0.12) {
      push();
      hudT = 0;
    }
    raf = requestAnimationFrame(loop);
  }

  hooks.onApi(api);
  push();
  raf = requestAnimationFrame(loop);

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    if (running) saveGame(state);
    host.removeEventListener("pointerdown", onCameraPointerDown);
    host.removeEventListener("pointermove", onCameraPointerMove);
    host.removeEventListener("pointerup", onCameraPointerEnd);
    host.removeEventListener("pointercancel", onCameraPointerEnd);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onHide);
    observer.disconnect();
    audio.stop();
    world.dispose();
    overlay.remove();
    if (qa) delete window.__controlsTest;
  };
}

function oreHex(ore: keyof typeof ORES) {
  const n = ORES[ore].color;
  return `#${n.toString(16).padStart(6, "0")}`;
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setSteer?: (v: number) => void;
      setKeys?: (codes: string[]) => void;
    };
  }
}
