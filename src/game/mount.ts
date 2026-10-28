import { createAudio } from "@/game/audio";
import { CLAIMS, ORES, PADS, boundsFor, isVehicleId } from "@/game/catalog";
import { BRIDGE, RIVER, areaOf } from "@/game/river";
import { createWorld } from "@/game/render";
import { bookWorth, currentSaveText, loadGame, loadGameBackup, readSaveText, saveGame } from "@/game/save";
import { sticksToCommand, type Stick } from "@/game/controls";
import {
  buildHud,
  buyClaim,
  buySluicePlant,
  buyWashPlant,
  currentArea,
  gateFor,
  goOtherArea,
  haulMachine,
  padOpen,
  buyUpgrade,
  buyVehicle,
  drillTestHole,
  freshGame,
  loadTruck,
  repairVehicle,
  sellVehicle,
  setActive,
  setControlMode,
  shiftGear,
  startBlast,
  step,
  toggleCrew,
} from "@/game/sim";
import type { GameApi, GameState, Input, VehicleId, ViewModel } from "@/game/types";

const PRACTICE_FLEET: VehicleId[] = ["skid", "loader", "excavator", "dozer", "truck"];

/** A throwaway yard with one of every machine. Nothing here is saved. */
function practiceYard(real: GameState): GameState {
  const yard = freshGame("Practice yard");
  yard.cash = 0;
  yard.controlMode = real.controlMode;
  yard.muted = real.muted;
  yard.claims = [1, 2, 3, 4];
  yard.tutorial = { loaded: true, dumped: true, bought: true };
  yard.explosives = 3;
  for (const id of PRACTICE_FLEET) {
    yard.cash += 1_000_000;
    buyVehicle(yard, id);
  }
  yard.cash = 0;
  yard.active = yard.vehicles.findIndex((v) => v.defId === "skid");
  yard.log = ["Practice yard. Try every machine. Nothing here counts or saves."];
  return yard;
}

type Floater = { x: number; y: number; z: number; text: string; life: number };

type Hooks = {
  onHud: (view: ViewModel) => void;
  onApi: (api: GameApi) => void;
  onTogglePanel: () => void;
  onClosePanel: () => void;
};

export function mountGame(host: HTMLElement, hooks: Hooks) {
  const loaded = loadGame();
  let hadSave = loaded != null;
  let booksReady = hadSave;
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
  let lastCameraTap = { time: 0, x: 0, y: 0 };
  let actionBtn = false;
  const sticks: { left: Stick; right: Stick } = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  let parked = false;
  /** While practicing, the real books wait here untouched. */
  let practiceBack: GameState | null = null;
  const books = () => practiceBack ?? state;

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
    hooks.onHud({ ...buildHud(state, hadSave, parked), practice: practiceBack != null, mode: running ? "play" : "title", booksReady, excDrive: parked });
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
    const v = state.vehicles[state.active];
    const realMode = state.controlMode === "real";
    // E is the excavator's swing key in realistic mode, so it only works the tool in simple mode.
    const action = held("Space") || (!realMode && held("KeyE")) || actionBtn;
    if (!realMode || !v) return { throttle, steer, action };
    // Phone only: realistic controls come from the two on-screen sticks.
    const cmd = sticksToCommand(v.defId, sticks.left, sticks.right, parked);
    if (steerOverride != null && cmd.drive.kind === "car") cmd.drive.steer = steerOverride;
    // The twin-stick command owns steering in realistic mode. The legacy single-stick
    // variable above is not updated by TwinStick, so returning it here silently
    // discarded the left joystick's horizontal input for skid steers and loaders.
    const realisticSteer = cmd.drive.kind === "car" ? cmd.drive.steer : steer;
    return { throttle: cmd.drive.kind === "car" ? cmd.drive.throttle : (cmd.drive.left + cmd.drive.right) / 2, steer: realisticSteer, action, cmd };
  }

  const api: GameApi = {
    start(mode, company) {
      if (!booksReady) return;
      if (practiceBack) {
        state = practiceBack;
        practiceBack = null;
      }
      const name = company.trim().slice(0, 24) || "Ridge Ore Co.";
      if (mode === "fresh") {
        state = freshGame(name);
        hadSave = true;
        saveGame(state, true);
      } else if (!hadSave) {
        state = freshGame(name);
        if (!saveGame(books())) {
          const kept = loadGame();
          if (kept) state = kept;
        }
        hadSave = true;
      } else {
        state.company = name;
        saveGame(books());
      }
      running = true;
      keys.clear();
      world.snap();
      audio.unlock();
      push();
    },
    setPanel(open) {
      panelOpen = open;
    },
    buy(id) {
      if (id === "sluice") buySluicePlant(state);
      else if (id === "wash") {
        const msg = buyWashPlant(state);
        if (msg) state.log.unshift(msg);
      }
      else if (isVehicleId(id)) buyVehicle(state, id);
      saveGame(books());
      push();
    },
    buyGround(id) {
      const msg = buyClaim(state, id);
      if (msg) state.log.unshift(msg);
      saveGame(books());
      push();
    },
    upgrade(index, kind) {
      buyUpgrade(state, index, kind);
      saveGame(books());
      push();
    },
    crew(index) {
      toggleCrew(state, index);
      saveGame(books());
      push();
    },
    assignSource(index, claim) {
      const v = state.vehicles[index];
      if (!v || (index !== state.active && !v.operator)) return;
      v.workClaim = claim != null && state.claims.includes(claim) ? claim : null;
      v.status = claim == null ? "Assigned to any leased source" : `Assigned to ${CLAIMS.find((c) => c.id === claim)?.name ?? "source"}`;
      saveGame(books());
      push();
    },
    setHaulSluice(on) {
      state.preferSluice = on && state.sluice;
      state.log.unshift(on ? "Copper and gold haul to the sluice." : "Crew may sell at the crusher.");
      if (state.log.length > 5) state.log.length = 5;
      saveGame(books());
      push();
    },
    drive(index) {
      setActive(state, index);
      world.snap();
      push();
    },
    sell(index) {
      const wasActive = index === state.active;
      sellVehicle(state, index);
      if (wasActive) world.snap();
      saveGame(books());
      push();
    },
    setStick(steer, throttle) {
      stick.steer = steer;
      stick.throttle = throttle;
      // The single drive stick also feeds realistic mode for the claim truck and crusher.
      sticks.left = { x: -steer, y: throttle };
      sticks.right = { x: 0, y: 0 };
    },
    setAction(down) {
      actionBtn = down;
    },
    releaseInput() {
      // Screen changed shape (fold/unfold/rotate): let go of everything cleanly.
      // A drill in progress keeps going as long as the machine sits still.
      stick.steer = 0;
      stick.throttle = 0;
      sticks.left = { x: 0, y: 0 };
      sticks.right = { x: 0, y: 0 };
      actionBtn = false;
    },
    setSticks(left, right) {
      sticks.left = left;
      sticks.right = right;
    },
    shift(dir) {
      const msg = shiftGear(state, dir);
      if (msg) state.log.unshift(msg);
      if (state.log.length > 5) state.log.length = 5;
      push();
    },
    setControlMode(mode) {
      setControlMode(state, mode);
      if (practiceBack) practiceBack.controlMode = mode;
      saveGame(books());
      push();
    },
    toggleExcDrive() {
      parked = !parked;
      state.log.unshift(parked ? "Parking brake on. Left stick slews and works the dipper." : "Parking brake off. Left stick drives.");
      if (state.log.length > 5) state.log.length = 5;
      push();
    },
    testHole() {
      const msg = drillTestHole(state);
      if (msg) state.log.unshift(msg);
      if (state.log.length > 5) state.log.length = 5;
      saveGame(books());
      push();
    },
    blast() {
      const msg = startBlast(state);
      if (msg) state.log.unshift(msg);
      if (state.log.length > 5) state.log.length = 5;
      push();
    },
    repair(index) {
      repairVehicle(state, index);
      saveGame(books());
      push();
    },
    practice(on) {
      if (on && !practiceBack) {
        saveGame(state);
        practiceBack = state;
        state = practiceYard(state);
      } else if (!on && practiceBack) {
        state = practiceBack;
        practiceBack = null;
      }
      world.snap();
      push();
    },
    loadTruck() {
      const msg = loadTruck(state);
      state.log.unshift(msg);
      if (state.log.length > 5) state.log.length = 5;
      saveGame(books());
      push();
    },
    toggleMute() {
      state.muted = !state.muted;
      audio.setMuted(state.muted);
      push();
    },
    haul() {
      const msg = haulMachine(state);
      if (msg) state.log.unshift(msg);
      if (state.log.length > 5) state.log.length = 5;
      world.snap();
      saveGame(books());
      push();
    },
    goOther() {
      const msg = goOtherArea(state);
      if (msg) state.log.unshift(msg);
      world.snap();
      saveGame(books());
      push();
    },
    cycle(dir) {
      if (!state.vehicles.length) return;
      // Next only switches between machines in the area you're in.
      const here = currentArea(state);
      const n = state.vehicles.length;
      let next = state.active;
      for (let k = 1; k <= n; k++) {
        const i = (state.active + dir * k + n * k) % n;
        if (areaOf(state.vehicles[i].x) === here) {
          next = i;
          break;
        }
      }
      setActive(state, next);
      world.snap();
      push();
    },
    downloadBooks() {
      saveGame(books());
      const text = currentSaveText();
      if (!text) return;
      const file = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "ridge-ore-books.json";
      link.click();
      URL.revokeObjectURL(url);
    },
    importBooks(text) {
      const next = readSaveText(text);
      if (!next) return false;
      practiceBack = null;
      state = next;
      hadSave = true;
      running = false;
      saveGame(books());
      world.snap();
      push();
      return true;
    },
  };

  const qa = import.meta.env.DEV || new URLSearchParams(window.location.search).has("qa");
  if (qa) {
    window.__controlsTest = {
      getYaw: () => state.vehicles[state.active]?.yaw ?? 0,
      getSpeed: () => state.vehicles[state.active]?.speed ?? 0,
      getState: () => state,
      renderStats: () => world.stats(),
      setSticks(left: Stick, right: Stick) {
        sticks.left = left;
        sticks.right = right;
      },
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
    const now = performance.now();
    const tapGap = now - lastCameraTap.time;
    const tapDistance = Math.hypot(e.clientX - lastCameraTap.x, e.clientY - lastCameraTap.y);
    if (cameraPointers.size === 0 && tapGap > 0 && tapGap < 320 && tapDistance < 28) {
      world.snap();
      lastCameraTap = { time: 0, x: 0, y: 0 };
    } else if (cameraPointers.size === 0) {
      lastCameraTap = { time: now, x: e.clientX, y: e.clientY };
    }
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
    if (e.code === "KeyL") api.loadTruck();

  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function onBlur() {
    keys.clear();
    actionBtn = false;
    stick.steer = 0;
    stick.throttle = 0;
    sticks.left = { x: 0, y: 0 };
    sticks.right = { x: 0, y: 0 };
  }
  function onHide() {
    if (document.hidden) {
      keys.clear();
      if (running || hadSave) saveGame(books());
      audio.setMuted(true);
    } else if (!state.muted) audio.setMuted(false);
  }
  function onPageHide() {
    if (running || hadSave) saveGame(books());
  }

  host.addEventListener("pointerdown", onCameraPointerDown, { passive: false });
  host.addEventListener("pointermove", onCameraPointerMove, { passive: false });
  host.addEventListener("pointerup", onCameraPointerEnd);
  host.addEventListener("pointercancel", onCameraPointerEnd);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);
  void navigator.storage?.persist?.();
  void loadGameBackup().then((backup) => {
    if (dead) return;
    if (backup && bookWorth(backup) > bookWorth(state) + 20) {
      const untouched = state.seconds < 8 && state.lifetime < 1;
      if (!running || untouched) {
        state = backup;
        hadSave = true;
        if (running) world.snap();
        saveGame(books());
      }
    }
    booksReady = true;
    push();
  });
  window.setTimeout(() => {
    if (dead || booksReady) return;
    booksReady = true;
    push();
  }, 1600);
  const resize = () => {
    world.resize();
    sizeOverlay();
  };
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  window.visualViewport?.addEventListener("resize", resize);
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
    const me = state.vehicles[state.active];
    const area = me ? areaOf(me.x) : "ridge";
    const B = boundsFor(me ? me.x : 0);
    const here = (x: number) => areaOf(x) === area;
    const sx = (x: number) => x0 + ((x - B.minX) / (B.maxX - B.minX)) * m;
    const sz = (z: number) => y0 + ((z - B.minZ) / (B.maxZ - B.minZ)) * m;
    if (area === "river") {
      // River and bridge.
      ctx.fillStyle = "#3d6b80";
      ctx.fillRect(sx(RIVER.x - RIVER.halfWidth), sz(RIVER.minZ), Math.max(2, sx(RIVER.x + RIVER.halfWidth) - sx(RIVER.x - RIVER.halfWidth)), sz(RIVER.maxZ) - sz(RIVER.minZ));
      ctx.fillStyle = "#c9b79a";
      ctx.fillRect(sx(BRIDGE.x - BRIDGE.halfLength), sz(BRIDGE.z) - 1.5, sx(BRIDGE.x + BRIDGE.halfLength) - sx(BRIDGE.x - BRIDGE.halfLength), 3);
    }
    const gate = gateFor(me ? me.x : 0);
    ctx.fillStyle = "#e26a2c";
    if (area === "ridge") ctx.fillRect(sx(gate.x) - 2, sz(gate.z) - 2, 4, 4);
    for (const pad of PADS) {
      if (!padOpen(state, pad.kind) || !here(pad.x)) continue;
      if (pad.kind === "crusher") continue;
      ctx.fillStyle = pad.kind === "reclaim" ? "#e6b325" : "#e26a2c";
      ctx.beginPath();
      ctx.arc(sx(pad.x), sz(pad.z), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const d of state.deposits) {
      if (d.tons < 0.2 && d.regen <= 0) continue;
      if (!here(d.x)) continue;
      ctx.fillStyle = state.claims.includes(d.claim) ? oreHex(d.ore) : "#4a463f";
      ctx.fillRect(sx(d.x) - 2, sz(d.z) - 2, 4, 4);
    }
    for (let i = 0; i < state.vehicles.length; i++) {
      const v = state.vehicles[i];
      if (!here(v.x)) continue;
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
    let sold = false;
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
        if (fx.sales.length) sold = true;
        for (const b of fx.breaks) world.chip(b.ore, b.x, b.z, b.tx, b.tz);
        for (const b of fx.blasts) {
          world.blast(b.x, b.z);
          audio.dig();
          sold = true;
        }
        if (fx.dig) digPulse = true;
        acc -= 1 / 60;
        guard++;
      }
      if (digPulse && digCool <= 0) {
        audio.dig();
        digCool = 0.16;
      }
      if (sold) saveGame(books());
      digCool = Math.max(0, digCool - dt);
      const v = state.vehicles[state.active];
      const soundKind = (id: string | undefined) => id === "skid" || id === "loader" || id === "excavator" || id === "dozer" || id === "truck" || id === "heavy" ? (id === "heavy" ? "truck" : id) : "other";
      audio.engine(v?.speed ?? 0, panelOpen ? 0 : input.throttle, soundKind(v?.defId));
      if (!panelOpen && input.cmd) audio.hydraulics(soundKind(v?.defId), input.cmd.axes.lift, input.cmd.axes.tilt);
      saveT += dt;
      if (saveT > 4) {
        saveGame(books());
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
    if (running) saveGame(books());
    host.removeEventListener("pointerdown", onCameraPointerDown);
    host.removeEventListener("pointermove", onCameraPointerMove);
    host.removeEventListener("pointerup", onCameraPointerEnd);
    host.removeEventListener("pointercancel", onCameraPointerEnd);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", resize);
    window.removeEventListener("orientationchange", resize);
    window.visualViewport?.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onPageHide);
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
      getState?: () => GameState;
      renderStats?: () => { calls: number; triangles: number; dpr: number; cam: [number, number] };
      setSticks?: (left: Stick, right: Stick) => void;
      setSteer?: (v: number) => void;
      setKeys?: (codes: string[]) => void;
    };
  }
}
