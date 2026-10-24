import { BOUNDS, isOreId, isVehicleId } from "@/game/catalog";
import { freshGame } from "@/game/sim";
import type { Deposit, GameState, UpgradeKind, VehicleState } from "@/game/types";

const KEY = "ridge-ore.save";
const BAK = "ridge-ore.save.bak";

function num(v: unknown, fallback: number, min: number, max: number) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function sanitize(raw: unknown): GameState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  const company = typeof o.company === "string" && o.company.trim() ? o.company.trim().slice(0, 24) : "Ridge Ore Co.";
  const state = freshGame(company);
  state.cash = num(o.cash, state.cash, 0, 1e12);
  state.lifetime = num(o.lifetime, 0, 0, 1e12);
  state.seconds = num(o.seconds, 0, 0, 1e9);
  state.sluice = o.sluice === true;
  state.muted = o.muted === true;
  state.pileSeq = Math.round(num(o.pileSeq, 1, 1, 1e7));
  if (Array.isArray(o.claims)) {
    const claims = o.claims.filter((c) => c === 1 || c === 2 || c === 3 || c === 4) as number[];
    state.claims = Array.from(new Set([1, ...claims]));
  }
  const tut = o.tutorial;
  if (tut && typeof tut === "object") {
    const t = tut as Record<string, unknown>;
    state.tutorial = {
      loaded: t.loaded === true,
      dumped: t.dumped === true,
      bought: t.bought === true,
    };
  }
  if (Array.isArray(o.log)) {
    state.log = o.log.filter((m) => typeof m === "string").slice(0, 5) as string[];
  }
  if (Array.isArray(o.vehicles)) {
    const vehicles: VehicleState[] = [];
    for (const item of o.vehicles) {
      if (!item || typeof item !== "object") continue;
      const v = item as Record<string, unknown>;
      if (typeof v.defId !== "string" || !isVehicleId(v.defId)) continue;
      const up = (v.upgrades ?? {}) as Record<string, unknown>;
      const kind = (k: UpgradeKind) => Math.round(num(up[k], 0, 0, 3));
      const ore = typeof v.cargoOre === "string" && isOreId(v.cargoOre) ? v.cargoOre : null;
      vehicles.push({
        uid: typeof v.uid === "string" ? v.uid.slice(0, 40) : `${v.defId}-${vehicles.length}`,
        defId: v.defId,
        x: num(v.x, 0, BOUNDS.minX, BOUNDS.maxX),
        z: num(v.z, 40, BOUNDS.minZ, BOUNDS.maxZ),
        yaw: num(v.yaw, 0, -20, 20),
        speed: 0,
        cargoOre: ore,
        cargo: num(v.cargo, 0, 0, 80),
        upgrades: { engine: kind("engine"), body: kind("body"), hydro: kind("hydro") },
        hired: v.hired === true,
        operator: v.operator === true && v.hired === true,
        status: "",
        stuck: 0,
        unstick: 0,
        bias: 1,
        workClaim: typeof v.workClaim === "number" ? Math.round(num(v.workClaim, 0, 0, 99)) : null,
        busy: false,
      });
    }
    if (vehicles.length) {
      state.vehicles = vehicles;
      state.active = Math.round(num(o.active, 0, 0, vehicles.length - 1));
    }
  }
  if (Array.isArray(o.deposits)) {
    const saved = new Map<string, Record<string, unknown>>();
    for (const item of o.deposits) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.id === "string") saved.set(d.id, d);
    }
    for (const d of state.deposits) {
      const s = saved.get(d.id);
      if (!s) continue;
      d.tons = num(s.tons, d.tons, 0, Math.max(d.max * 3, 2000));
      d.x = num(s.x, d.x, BOUNDS.minX, BOUNDS.maxX);
      d.z = num(s.z, d.z, BOUNDS.minZ, BOUNDS.maxZ);
    }
    for (const s of saved.values()) {
      if (typeof s.id !== "string") continue;
      if (state.deposits.some((d) => d.id === s.id)) continue;
      if (s.kind !== "pile") continue;
      if (typeof s.ore !== "string" || !isOreId(s.ore)) continue;
      const pile: Deposit = {
        id: s.id.slice(0, 40),
        kind: "pile",
        ore: s.ore,
        tons: num(s.tons, 0, 0, 2000),
        max: num(s.max, 1, 0, 2000),
        x: num(s.x, 0, BOUNDS.minX, BOUNDS.maxX),
        z: num(s.z, 0, BOUNDS.minZ, BOUNDS.maxZ),
        regen: 0,
        claim: 1,
        radius: 6,
        sign: "PILE",
      };
      if (pile.tons >= 0.2) state.deposits.push(pile);
    }
  }
  if (!state.vehicles.length) return null;
  return state;
}

export function loadGame(): GameState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return sanitize(JSON.parse(raw));
  } catch {
    try {
      const bak = localStorage.getItem(BAK);
      if (!bak) return null;
      return sanitize(JSON.parse(bak));
    } catch {
      return null;
    }
  }
}

export function saveGame(state: GameState) {
  if (typeof localStorage === "undefined") return false;
  try {
    const prev = localStorage.getItem(KEY);
    if (prev) localStorage.setItem(BAK, prev);
    const copy: GameState = {
      ...state,
      vehicles: state.vehicles.map((v) => ({ ...v, speed: 0, busy: false, stuck: 0, unstick: 0 })),
      deposits: state.deposits.map((d) => ({ ...d })),
      tutorial: { ...state.tutorial },
      log: state.log.slice(0, 5),
      claims: [...state.claims],
    };
    localStorage.setItem(KEY, JSON.stringify(copy));
    return true;
  } catch {
    return false;
  }
}
