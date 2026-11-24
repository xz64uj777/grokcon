import { PRICES as OPS_PRICES, applyRipped, readOps } from "@/game/ops";
import { CLAIMS, DEFS, SLUICE, boundsFor, isOreId, isVehicleId, upgradeCost } from "@/game/catalog";
import { onHaulRoad } from "@/game/lowboy";
import { WASH_PLANT, areaOf } from "@/game/river";
import { homeTool, type ToolState } from "@/game/controls";
import { DAY_SECONDS, freshMarket, type Market } from "@/game/market";
import { MARKET_KEYS, ensureLowboy, freshGame, homeClaim } from "@/game/sim";
import type { Deposit, GameState, UpgradeKind, VehicleState } from "@/game/types";

/** Current save format. Version 1 saves (before realistic controls) are upgraded on load. */
export const SAVE_VERSION = 4;

const KEY = "ridge-ore.save";
const BAK = "ridge-ore.save.bak";
const BEST = "ridge-ore.save.best";

function num(v: unknown, fallback: number, min: number, max: number) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Clamp a saved x/z into whichever area (ridge or valley) the x falls in. */
function posX(raw: unknown, fallback: number) {
  if (typeof raw === "number" && raw > 120 && raw < 880) return num(raw, fallback, -20, 1100);
  const b = boundsFor(typeof raw === "number" && Number.isFinite(raw) ? raw : fallback);
  return num(raw, fallback, b.minX, b.maxX);
}
function posZ(raw: unknown, rawX: unknown, fallback: number) {
  if (typeof raw === "number" && typeof rawX === "number" && onHaulRoad(rawX, raw)) return num(raw, fallback, 48, 112);
  if (typeof rawX === "number" && rawX > 120 && rawX < 880) return num(raw, fallback, 80, 112);
  const b = boundsFor(typeof rawX === "number" && Number.isFinite(rawX) ? rawX : 0);
  return num(raw, fallback, b.minZ, b.maxZ);
}

function sanitize(raw: unknown): GameState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 && o.version !== 2 && o.version !== 3 && o.version !== 4) return null;
  // Older versions have the same career and fleet fields. Only newer optional
  // mechanics get defaults, so a truncated file cannot turn into a new claim.
  if (typeof o.company !== "string" || !o.company.trim() ||
      ![o.cash, o.lifetime, o.seconds].every(Number.isFinite) ||
      !Array.isArray(o.vehicles) || !Array.isArray(o.deposits) ||
      !o.deposits.some((d) => d && typeof d.id === "string" && Number.isFinite(d.tons))) return null;
  const v2 = o.version === 2 || o.version === 3 || o.version === 4;
  const company = typeof o.company === "string" && o.company.trim() ? o.company.trim().slice(0, 24) : "Ridge Ore Co.";
  const state = freshGame(company);
  // Earlier saves have no revision; they are upgraded on their next write.
  state.saveRevision = Math.floor(num(o.saveRevision, 0, 0, Number.MAX_SAFE_INTEGER - 2));
  state.cash = num(o.cash, state.cash, 0, 1e12);
  state.lifetime = num(o.lifetime, 0, 0, 1e12);
  state.seconds = num(o.seconds, 0, 0, 1e9);
  state.sluice = o.sluice === true;
  state.preferSluice = o.preferSluice !== false;
  if (o.feedLimit === 1 || o.feedLimit === 2 || o.feedLimit === "all") state.feedLimit = o.feedLimit;
  // Version 3 (River Valley): new fields default to "not bought yet" and dry ground.
  state.washPlant = o.washPlant === true;
  state.wet = num(o.wet, 0, 0, 1);
  state.muted = o.muted === true;
  state.watching = o.watching === true;
  state.pileSeq = Math.round(num(o.pileSeq, 1, 1, 1e7));
  state.controlMode = o.controlMode === "simple" ? "simple" : "real";
  state.explosives = Math.round(num(o.explosives, 0, 0, 99));
  state.market = readMarket(o.market, state.seconds);
  if (Array.isArray(o.claims)) {
    const claims = o.claims.filter((c) => c === 1 || c === 2 || c === 3 || c === 4 || c === 5 || c === 6 || c === 7 || c === 8) as number[];
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
      if (typeof v.defId !== "string" || !isVehicleId(v.defId) || !Number.isFinite(v.x) || !Number.isFinite(v.z)) continue;
      const up = (v.upgrades ?? {}) as Record<string, unknown>;
      const kind = (k: UpgradeKind) => Math.round(num(up[k], 0, 0, 3));
      const ore = typeof v.cargoOre === "string" && isOreId(v.cargoOre) ? v.cargoOre : null;
      vehicles.push({
        uid: typeof v.uid === "string" ? v.uid.slice(0, 40) : `${v.defId}-${vehicles.length}`,
        defId: v.defId,
        cargoPurity: num(v.cargoPurity, 1, 0.3, 1),
        damage: num(v.damage, 0, 0, 1),
        tool: readTool(v.tool, v.defId),
        manual: false,
        x: posX(v.x, 0),
        z: posZ(v.z, v.x, 40),
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
        workFace: typeof v.workFace === "string" && v.workFace.length < 40 ? v.workFace : null,
        crewId: typeof v.crewId === "number" && Number.isFinite(v.crewId) ? Math.round(num(v.crewId, 0, 1, 20)) : null,
        feederPad: v.feederPad === "sluice" || v.feederPad === "wash" ? v.feederPad : null,
        busy: false,
        ...(v.defId === "lowboy" && typeof v.trailerYaw === "number" && typeof v.axleX === "number" && typeof v.axleZ === "number"
          ? { trailerYaw: num(v.trailerYaw, 0, -40, 40), axleX: posX(v.axleX, 0), axleZ: posZ(v.axleZ, v.axleX, 96) }
          : {}),
      });
    }
    if (vehicles.length === 0) return null;
    if (!vehicles.some((v) => v.defId === "crusher")) {
      vehicles.push({
        uid: "crusher-plant",
        defId: "crusher",
        x: 34,
        z: 36,
        yaw: Math.PI,
        speed: 0,
        cargoOre: null,
        cargo: 0,
        cargoPurity: 1,
        damage: 0,
        tool: homeTool("crusher"),
        manual: false,
        upgrades: { engine: 0, body: 0, hydro: 0 },
        hired: false,
        operator: false,
        status: "",
        stuck: 0,
        unstick: 0,
        bias: 1,
        workClaim: null,
        workFace: null,
        crewId: null,
        feederPad: null,
        busy: false,
      });
    }
    if (vehicles.length) {
      state.vehicles = vehicles;
      state.active = Math.round(num(o.active, 0, 0, vehicles.length - 1));
    }
  }
  const PAD_KINDS = ["crusher", "reclaim", "sluice", "loadout", "wash", "barge", "mill"];
  const crews: GameState["crews"] = [];
  if (Array.isArray(o.crews)) {
    const seen = new Set<number>();
    for (const item of o.crews) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const id = Math.round(num(c.id, 0, 1, 20));
      if (id < 1 || seen.has(id)) continue;
      seen.add(id);
      const sourceId = typeof c.sourceId === "string" && c.sourceId.length > 0 && c.sourceId.length < 40 ? c.sourceId : null;
      const destKind = typeof c.destKind === "string" && PAD_KINDS.includes(c.destKind) ? (c.destKind as GameState["crews"][number]["destKind"]) : null;
      crews.push({ id, sourceId, destKind });
    }
  }
  for (const v of state.vehicles) {
    if (v.crewId == null) continue;
    if (!crews.some((c) => c.id === v.crewId)) crews.push({ id: v.crewId, sourceId: null, destKind: null });
  }
  crews.sort((a, b) => a.id - b.id);
  state.crews = crews;
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
      // Faces never move between areas.
      if (areaOf(typeof s.x === "number" ? s.x : d.x) === areaOf(d.x)) {
        d.x = posX(s.x, d.x);
        d.z = posZ(s.z, s.x, d.z);
      }
      d.purity = num(s.purity, d.purity, 0.3, 1);
      if (v2) {
        d.overburden = num(s.overburden, d.overburden, 0, 500);
        d.stress = num(s.stress, 0, 0, 0.99);
        d.bench = Math.round(num(s.bench, 1, 1, 999));
        d.benchProgress = num(s.benchProgress, 0, 0, 1000);
        d.tested = s.tested === true;
        d.lastBlastDay = Math.round(num(s.lastBlastDay, -1, -1, 1e7));
      } else if (d.kind === "vein") {
        // Old books: these faces were already opened up, so the top is clear.
        d.overburden = 0;
      }
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
        x: posX(s.x, 0),
        z: posZ(s.z, s.x, 0),
        regen: 0,
        claim: CLAIMS.find((claim) => claim.id === s.claim)?.id ?? homeClaim(areaOf(typeof s.x === "number" ? s.x : 0)),
        radius: 6,
        sign: s.id.startsWith("feed-") ? "FEED" : "PILE",
        purity: num(s.purity, 1, 0.3, 1),
        overburden: 0,
        grade: 1,
        stress: 0,
        bench: 1,
        benchProgress: 0,
        hard: false,
        tested: true,
        lastBlastDay: -1,
        paidTons: num(s.paidTons, 0, 0, 2000),
      };
      if (pile.tons >= 0.2) state.deposits.push(pile);
    }
    // Each loose pile comes back on its own (no merging), so heaps keep their size and shape.
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
  const live = new Set(state.vehicles.map((v) => v.uid));
  state.deck = Array.isArray(o.deck) ? o.deck.filter((id): id is string => typeof id === "string" && live.has(id)).slice(0, 2) : [];
  ensureLowboy(state);
  // Version 4: site operations. Older saves start with nothing bought and full tanks.
  state.ops = readOps(o.ops);
  applyRipped(state);
  return state;
}

function readTool(raw: unknown, defId: string): ToolState {
  const home = homeTool(defId);
  if (!raw || typeof raw !== "object") return home;
  const t = raw as Record<string, unknown>;
  const gear = t.gear === -1 || t.gear === 0 || t.gear === 1 ? t.gear : home.gear;
  return {
    lift: num(t.lift, home.lift, 0, 1),
    tilt: num(t.tilt, home.tilt, -1, 1),
    swing: num(t.swing, home.swing, -Math.PI, Math.PI),
    reach: num(t.reach, home.reach, 0, 1),
    gear,
  };
}

function readMarket(raw: unknown, seconds: number): Market {
  const day = Math.floor(seconds / DAY_SECONDS);
  const fallback = () => {
    const m = freshMarket(Math.floor(Math.random() * 0xffffffff), MARKET_KEYS);
    // Start the board on today so an old save does not replay a pile of days at once.
    m.day = day;
    return m;
  };
  if (!raw || typeof raw !== "object") return fallback();
  const m = raw as Record<string, unknown>;
  if (typeof m.seed !== "number") return fallback();
  const out = freshMarket(m.seed, MARKET_KEYS);
  out.day = Math.round(num(m.day, day, 0, 1e7));
  const copy = (src: unknown, dst: Record<string, number>, lo: number, hi: number) => {
    if (!src || typeof src !== "object") return;
    for (const k of MARKET_KEYS) {
      const val = (src as Record<string, unknown>)[k];
      if (typeof val === "number" && Number.isFinite(val)) dst[k] = Math.min(hi, Math.max(lo, val));
    }
  };
  copy(m.mult, out.mult, 0.5, 2);
  copy(m.prev, out.prev, 0.5, 2);
  copy(m.glut, out.glut, 0, 0.25);
  return out;
}

export function bookWorth(state: GameState) {
  const machines = state.vehicles.filter((v) => v.defId !== "pickup" && v.defId !== "crusher").length;
  // Bought assets count at what they cost, on the same scale as cash, so spending
  // money on something never makes an older backup look richer.
  let assets = (state.sluice ? SLUICE.price : 0) + (state.washPlant ? WASH_PLANT.price : 0);
  const o = state.ops;
  if (o) assets += o.upkeep ?? 0;
  if (o) for (const k of ["ramp", "scanner", "ripper", "screen", "lights", "fuelTruck"] as const) if (o[k]) assets += OPS_PRICES[k];
  for (const id of state.claims) assets += CLAIMS.find((c) => c.id === id)?.price ?? 0;
  for (const v of state.vehicles) {
    assets += DEFS[v.defId]?.price ?? 0;
    for (const kind of ["engine", "body", "hydro"] as const) {
      for (let level = 0; level < (v.upgrades?.[kind] ?? 0); level++) assets += upgradeCost(v.defId, kind, level) ?? 0;
    }
  }
  return state.seconds + state.lifetime / 10 + (state.cash + assets) / 50 + machines * 800 + state.claims.length * 400 + (state.sluice ? 2500 : 0) + (state.washPlant ? 2500 : 0);
}

type SaveEntry = { state: GameState; raw: string; revision: number };
type SaveWrite = { raw: string; revision: number; previous: SaveEntry | null };
type SaveResult = "saved" | "conflict" | "unavailable";

function readRaw(raw: unknown): SaveEntry | null {
  if (typeof raw !== "string") return null;
  const state = readSaveText(raw);
  return state ? { state, raw, revision: state.saveRevision ?? 0 } : null;
}

function readLocalBooks() {
  try {
    return readRaw(localStorage.getItem(KEY)) ?? readRaw(localStorage.getItem(BAK));
  } catch {
    return null;
  }
}

export function loadGame(): GameState | null {
  return readLocalBooks()?.state ?? null;
}

function newer(a: SaveEntry | null, b: SaveEntry | null) {
  return a && (!b || a.revision >= b.revision) ? a : b;
}

function prepareWrite(draft: GameState, base: number, previous: SaveEntry | null): SaveWrite {
  const revision = Math.max(Date.now(), base) + 1;
  return { revision, raw: JSON.stringify({ ...draft, saveRevision: revision }), previous };
}

function writeLocal(write: SaveWrite, base: number, resetHistory: boolean) {
  try {
    if ((readLocalBooks()?.revision ?? -1) > base) return false;
    if (!resetHistory && write.previous) localStorage.setItem(BAK, write.previous.raw);
    localStorage.setItem(KEY, write.raw);
  } catch {
    return false;
  }
  if (resetHistory) {
    try {
      localStorage.removeItem(BAK);
    } catch {
      // The new current save has already been written.
    }
  }
  return true;
}

// Capture each request now, but use the session's last committed revision when
// the request runs. This keeps overlapping saves from the same tab in order.
let pendingWrites: Promise<unknown> = Promise.resolve();

export function saveGame(state: GameState, resetHistory = false, baseState = state): Promise<SaveResult> {
  const draft = snapshot(state);
  const task = pendingWrites.then(async (): Promise<SaveResult> => {
    const base = baseState.saveRevision ?? -1;
    const save = async (): Promise<SaveResult> => {
      const db = await openBooks();
      const indexed = db && await writeIndexedBooks(db, draft, base, resetHistory);
      if (indexed === "conflict") return indexed;
      if (indexed) {
        writeLocal(indexed, base, resetHistory);
        state.saveRevision = indexed.revision;
        return "saved";
      }

      const current = readLocalBooks();
      if ((current?.revision ?? -1) > base) return "conflict";
      const write = prepareWrite(draft, base, current);
      if (!writeLocal(write, base, resetHistory)) return "unavailable";
      state.saveRevision = write.revision;
      return "saved";
    };

    // The Web Lock also covers localStorage fallback in browsers that support
    // it. IndexedDB's read-write transaction serializes its own fallback check.
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(KEY, save) : save();
  }).catch((): SaveResult => "unavailable");
  pendingWrites = task;
  return task;
}

function snapshot(state: GameState): GameState {
  return {
    ...state,
    version: SAVE_VERSION,
    // A blast in progress is not saved. Its charge goes back in the box.
    blast: null,
    // Paid blasts in progress are refunded in the saved books.
    explosives: state.explosives + (state.blast && state.blast.paid === 0 ? 1 : 0),
    cash: state.cash + (state.blast ? state.blast.paid : 0),
    market: { ...state.market, mult: { ...state.market.mult }, prev: { ...state.market.prev }, glut: { ...state.market.glut } },
    vehicles: state.vehicles.map((v) => ({ ...v, tool: { ...v.tool }, speed: 0, busy: false, stuck: 0, unstick: 0, manual: false })),
    deposits: state.deposits.map((d) => ({ ...d, lastBlastDay: state.blast && state.blast.deposit === d.id ? -1 : d.lastBlastDay })),
    tutorial: { ...state.tutorial },
    contract: { ...state.contract },
    log: state.log.slice(0, 5),
    claims: [...state.claims],
    crews: state.crews.map((crew) => ({ ...crew })),
    deck: [...state.deck],
    ops: JSON.parse(JSON.stringify({ ...state.ops, photo: false })),
  };
}

export function exportSave(state: GameState) {
  return JSON.stringify(snapshot(state));
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
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      let blocked = false;
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        if (blocked) req.result.close();
        else resolve(req.result);
      };
      req.onblocked = () => {
        blocked = true;
        resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readIndexedBooks(store: IDBObjectStore, receive: (entry: SaveEntry | null) => void) {
  const current = store.get(KEY);
  const backup = store.get(BEST);
  backup.onsuccess = () => receive(readRaw(current.result) ?? readRaw(backup.result));
}

function writeIndexedBooks(db: IDBDatabase, draft: GameState, base: number, resetHistory: boolean) {
  return new Promise<SaveWrite | "conflict" | null>((resolve) => {
    let result: SaveWrite | "conflict" | null = null;
    function finish(value: typeof result) {
      db.close();
      resolve(value);
    }
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      tx.oncomplete = () => finish(result);
      tx.onabort = () => finish(result === "conflict" ? result : null);
      readIndexedBooks(store, (indexed) => {
        const current = newer(readLocalBooks(), indexed);
        if ((current?.revision ?? -1) > base) {
          result = "conflict";
          return;
        }
        const write = prepareWrite(draft, base, current);
        store.put(write.raw, KEY);
        store.put(!resetHistory && current ? current.raw : write.raw, BEST);
        result = write;
      });
    } catch {
      finish(null);
    }
  });
}

export async function loadGameBackup(): Promise<GameState | null> {
  const db = await openBooks();
  if (!db) return null;
  return new Promise((resolve) => {
    let state: GameState | null = null;
    const finish = (value: GameState | null) => {
      db.close();
      resolve(value);
    };
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      tx.oncomplete = () => finish(state);
      tx.onabort = () => finish(null);
      readIndexedBooks(tx.objectStore(IDB_STORE), (entry) => { state = entry?.state ?? null; });
    } catch {
      finish(null);
    }
  });
}
