import { BOUNDS, isOreId, isVehicleId } from "@/game/catalog";
import { freshGame } from "@/game/sim";
import type { Deposit, GameState, UpgradeKind, VehicleState } from "@/game/types";

const KEY = "ridge-ore.save";
const BAK = "ridge-ore.save.bak";
const BEST = "ridge-ore.save.best";

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
  state.preferSluice = o.preferSluice !== false;
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
    if (vehicles.length && !vehicles.some((v) => v.defId === "crusher")) {
      vehicles.push({
        uid: "crusher-plant",
        defId: "crusher",
        x: 34,
        z: 36,
        yaw: Math.PI,
        speed: 0,
        cargoOre: null,
        cargo: 0,
        upgrades: { engine: 0, body: 0, hydro: 0 },
        hired: false,
        operator: false,
        status: "",
        stuck: 0,
        unstick: 0,
        bias: 1,
        workClaim: null,
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
    const drop = new Set<string>();
    const loose = state.deposits.filter((d) => d.kind === "pile" && d.id.startsWith("pile-"));
    for (let i = 0; i < loose.length; i++) {
      const a = loose[i];
      if (drop.has(a.id)) continue;
      for (let j = i + 1; j < loose.length; j++) {
        const b = loose[j];
        if (drop.has(b.id) || b.ore !== a.ore) continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) > 18) continue;
        const t = a.tons + b.tons;
        if (t > 0) {
          a.x = (a.x * a.tons + b.x * b.tons) / t;
          a.z = (a.z * a.tons + b.z * b.tons) / t;
        }
        a.tons = t;
        a.max = Math.max(a.max, b.max, t);
        drop.add(b.id);
      }
    }
    if (drop.size) state.deposits = state.deposits.filter((d) => !drop.has(d.id));
  }
  if (o.contract && typeof o.contract === "object") {
    const c = o.contract as Record<string, unknown>;
    if (typeof c.ore === "string" && isOreId(c.ore)) {
      state.contract = {
        ore: c.ore,
        delivered: num(c.delivered, 0, 0, 1e6),
        need: num(c.need, 8, 1, 1e6),
        bonus: num(c.bonus, 0, 0, 1e12),
      };
      state.contractSeq = Math.round(num(o.contractSeq, 0, 0, 1e6));
    }
  }
  if (!state.vehicles.length) return null;
  return state;
}

export function bookWorth(state: GameState) {
  const machines = state.vehicles.filter((v) => v.defId !== "pickup" && v.defId !== "crusher").length;
  return state.seconds + state.lifetime / 10 + state.cash / 50 + machines * 800 + state.claims.length * 400 + (state.sluice ? 2500 : 0);
}

function readRaw(raw: string | null) {
  if (!raw) return null;
  try {
    const state = sanitize(JSON.parse(raw));
    return state ? { state, raw, worth: bookWorth(state) } : null;
  } catch {
    return null;
  }
}

function richer<T extends { worth: number }>(a: T | null, b: T | null) {
  if (!a) return b;
  if (!b) return a;
  return b.worth > a.worth ? b : a;
}

export function loadGame(): GameState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const best = richer(readRaw(localStorage.getItem(KEY)), readRaw(localStorage.getItem(BAK)));
    if (!best) return null;
    memorySave = best.raw;
    memoryWorth = best.worth;
    return best.state;
  } catch {
    return null;
  }
}

function isNewBook(state: GameState) {
  return (
    state.seconds < 8 &&
    state.lifetime < 1 &&
    !state.sluice &&
    state.claims.length <= 1 &&
    state.vehicles.every((v) => v.defId === "pickup" || v.defId === "crusher")
  );
}

export function saveGame(state: GameState, force = false) {
  const json = JSON.stringify(snapshot(state));
  const worth = bookWorth(state);
  memorySave = json;
  if (typeof localStorage !== "undefined") {
    try {
      const current = readRaw(localStorage.getItem(KEY));
      const backup = readRaw(localStorage.getItem(BAK));
      const kept = richer(current, backup);
      if (!force && isNewBook(state) && kept && kept.worth > worth + 25) {
        memorySave = kept.raw;
        memoryWorth = kept.worth;
        return false;
      }
      if (current && current.raw !== json) {
        const bakWorth = backup?.worth ?? -1;
        if (current.worth >= bakWorth) localStorage.setItem(BAK, current.raw);
      }
      localStorage.setItem(KEY, json);
      memoryWorth = worth;
    } catch {
      /* private mode or a full disk — the IndexedDB copy may still land */
    }
  }
  mirrorSave(json, worth, force);
  return true;
}

function snapshot(state: GameState): GameState {
  return {
    ...state,
    vehicles: state.vehicles.map((v) => ({ ...v, speed: 0, busy: false, stuck: 0, unstick: 0 })),
    deposits: state.deposits.map((d) => ({ ...d })),
    tutorial: { ...state.tutorial },
    contract: { ...state.contract },
    log: state.log.slice(0, 5),
    claims: [...state.claims],
  };
}

let memorySave: string | null = null;
let memoryWorth = 0;

export function currentSaveText() {
  return memorySave;
}

export function readSaveText(text: string): GameState | null {
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return null;
  }
}

const IDB_NAME = "ridge-ore";
const IDB_STORE = "kv";

function openBooks(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function mirrorSave(json: string, worth: number, force: boolean) {
  void openBooks().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const bestReq = store.get(BEST);
      bestReq.onsuccess = () => {
        const previous = typeof bestReq.result === "string" ? readRaw(bestReq.result) : null;
        if (force || !previous || worth + 1 >= previous.worth) store.put(json, BEST);
        store.put(json, KEY);
      };
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
    }
  });
}

export function loadGameBackup(): Promise<GameState | null> {
  return openBooks().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(IDB_STORE, "readonly");
          const store = tx.objectStore(IDB_STORE);
          const current = store.get(KEY);
          const best = store.get(BEST);
          let currentRaw: string | null = null;
          let bestRaw: string | null = null;
          let pending = 2;
          const finish = () => {
            pending -= 1;
            if (pending > 0) return;
            db.close();
            const picked = richer(readRaw(currentRaw), readRaw(bestRaw));
            if (picked && picked.worth > memoryWorth) {
              memorySave = picked.raw;
              memoryWorth = picked.worth;
            }
            resolve(picked ? picked.state : null);
          };
          current.onsuccess = () => {
            currentRaw = typeof current.result === "string" ? current.result : null;
            finish();
          };
          best.onsuccess = () => {
            bestRaw = typeof best.result === "string" ? best.result : null;
            finish();
          };
          current.onerror = () => finish();
          best.onerror = () => finish();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}
