/**
 * Site operations added in Round 3: tipping, ramps, scanner and nuggets, ripper,
 * reputation, daily events, screening, tires, night shifts, fuel, records and
 * the safety inspector. Pure rules plus small hooks the sim calls.
 */
import type { GameState, OreId, PadKind, VehicleState } from "@/game/types";
import { gradeAt } from "@/game/terrain";
import { X0, areaOf } from "@/game/river";
import { X1 } from "@/game/mountain";
import * as C from "@/game/career";

export const DAY = 300;

/** Which rounds are switched on. Builds for earlier rounds set this lower. */
let level = 11;
try {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const n = Number(env?.VITE_OPS_LEVEL);
  if (n >= 1 && n <= 11) level = n;
} catch {
  /* node tests */
}
export function setOpsLevel(n: number) {
  level = n;
}
export function on(round: number) {
  return level >= round;
}

export const PRICES = {
  ramp: 9000,
  scanner: 4500,
  ripper: 11000,
  screen: 16000,
  lights: 7500,
  fuelTruck: 38000,
  /** Delivered diesel, used by the fuel truck and the emergency call-out. */
  diesel: 1.35,
  /** Pump price. Driving to a fuel bay skips the call-out. */
  dieselPump: 1.05,
  gas: 0.85,
  callout: 75,
  fine: 1200,
};

export type Event = { kind: "flood" | "double" | "breakdown" | "rockslide"; day: number; ore?: OreId; uid?: string; gap?: number };

export type Ops = {
  ramp: boolean;
  scanner: boolean;
  ripper: boolean;
  screen: boolean;
  lights: boolean;
  fuelTruck: boolean;
  rep: number;
  nuggetDay: Record<string, number>;
  ripped: string[];
  event: Event | null;
  tread: Record<string, number>;
  flat: string[];
  fuel: Record<string, number>;
  records: { bestSale: number; bestDay: number; today: number; tons: number; nuggets: number; tips: number };
  nextInspect: number;
  lastInspect: string;
  photo: boolean;
  /** Money spent on upkeep (tires, fuel, fines). Counts in the save score so a backup from before never looks richer. */
  upkeep: number;
  /** Fuel given on credit after a tow. Paid back from sales. */
  debt: number;
  /** Round 14: machine wear 0..1 by uid, broken-down uids, story step, lot buys today. */
  wear: Record<string, number>;
  broke: string[];
  story: number;
  lotTaken: { day: number; ids: string[] };
  brakeHeat: Record<string, number>;
};

export function freshOps(): Ops {
  return {
    ramp: false,
    scanner: false,
    ripper: false,
    screen: false,
    lights: false,
    fuelTruck: false,
    rep: 0,
    nuggetDay: {},
    ripped: [],
    event: null,
    tread: {},
    flat: [],
    fuel: {},
    records: { bestSale: 0, bestDay: 0, today: 0, tons: 0, nuggets: 0, tips: 0 },
    nextInspect: 4,
    lastInspect: "",
    photo: false,
    upkeep: 0,
    debt: 0,
    wear: {},
    broke: [],
    story: 0,
    lotTaken: { day: -1, ids: [] },
    brakeHeat: {},
  };
}

function n(v: unknown, d: number, lo: number, hi: number) {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}
function numMap(v: unknown, lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isFinite(x)) out[k] = Math.min(hi, Math.max(lo, x));
  return out;
}

/** Reads saved ops. Older saves (no ops) start with nothing bought and full tanks. */
export function readOps(raw: unknown): Ops {
  const o = freshOps();
  if (!raw || typeof raw !== "object") return o;
  const r = raw as Record<string, unknown>;
  for (const k of ["ramp", "scanner", "ripper", "screen", "lights", "fuelTruck", "photo"] as const) o[k] = r[k] === true;
  o.photo = false;
  o.rep = n(r.rep, 0, 0, 100);
  o.nuggetDay = numMap(r.nuggetDay, -1, 1e7);
  o.ripped = Array.isArray(r.ripped) ? r.ripped.filter((x): x is string => typeof x === "string") : [];
  const e = r.event as Record<string, unknown> | null;
  if (e && (e.kind === "flood" || e.kind === "double" || e.kind === "breakdown" || e.kind === "rockslide"))
    o.event = { kind: e.kind, day: n(e.day, 0, 0, 1e7), ore: typeof e.ore === "string" ? (e.ore as OreId) : undefined, uid: typeof e.uid === "string" ? e.uid : undefined, ...(typeof e.gap === "number" ? { gap: Math.floor(n(e.gap, 0, 0, 2)) } : {}) };
  o.tread = numMap(r.tread, 0, 1);
  o.flat = Array.isArray(r.flat) ? r.flat.filter((x): x is string => typeof x === "string") : [];
  o.fuel = numMap(r.fuel, 0, 1);
  const rec = (r.records ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(o.records) as (keyof Ops["records"])[]) o.records[k] = n(rec[k], 0, 0, 1e12);
  o.upkeep = n(r.upkeep, 0, 0, 1e12);
  o.debt = n(r.debt, 0, 0, 1e9);
  o.wear = numMap(r.wear, 0, 1);
  o.broke = Array.isArray(r.broke) ? r.broke.filter((x): x is string => typeof x === "string") : [];
  o.story = Math.floor(n(r.story, 0, 0, C.STORY.length));
  const lt = (r.lotTaken ?? {}) as Record<string, unknown>;
  o.lotTaken = { day: n(lt.day, -1, -1, 1e7), ids: Array.isArray(lt.ids) ? lt.ids.filter((x): x is string => typeof x === "string") : [] };
  o.nextInspect = n(r.nextInspect, 4, 0, 1e7);
  o.brakeHeat = numMap(r.brakeHeat, 0, 1);
  o.lastInspect = typeof r.lastInspect === "string" ? r.lastInspect.slice(0, 120) : "";
  return o;
}

export function ops(state: GameState): Ops {
  const s = state as GameState & { ops?: Ops };
  if (!s.ops) s.ops = freshOps();
  return s.ops;
}

function say(state: GameState, msg: string) {
  state.log.unshift(msg);
  if (state.log.length > 5) state.log.length = 5;
}
const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
function hash(a: number, b: number, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const isPlant = (v: VehicleState) => v.defId === "crusher";
const onWheels = (v: VehicleState) => !isPlant(v) && v.defId !== "dozer" && v.defId !== "excavator";

// ---- Round 1: tipping removed ------------------------------------------------
/** Trucks used to roll on a fast loaded turn, dump the ore, and take damage. They don't anymore. */
export function wouldTip(_v: VehicleState, _yawRate: number, _capacity: number, _ramp: boolean) {
  return false;
}

/** Side slope (rise/run across the machine) a truck can hold while rolling. A full bed lowers it. */
export function sideTipLimit(loadFrac: number) {
  return 0.36 - 0.1 * Math.max(0, Math.min(1, loadFrac));
}
/** Trucks only tip on a side slope, not in a flat turn. */
export function tipsOnSlope(defId: string, side: number, loadFrac: number, speed: number) {
  if (defId !== "truck" && defId !== "heavy") return false;
  return Math.abs(speed) > 1.5 && Math.abs(side) > sideTipLimit(loadFrac);
}

// ---- Round 3 (r13): ripper on a drag control ---------------------------------
/** Seconds of ripping, shank down and moving, to break a hard face. */
export const RIP_SECONDS = 4;
const ripWork = new WeakMap<object, Record<string, number>>();
/**
 * The player's dozer with the shank dragged down (ripper ≥ 0.5) and moving rips the
 * hard face it is working. It drags (60% speed) while the shank is in the ground.
 */
export function ripTick(state: GameState, v: VehicleState, dt: number, face: { id: string; hard: boolean } | null) {
  const o = ops(state);
  if (!on(3) || !o.ripper || v.defId !== "dozer" || (v.ripper ?? 0) < 0.5) return "";
  const cap = 2.2;
  if (Math.abs(v.speed) > cap) v.speed = Math.sign(v.speed) * cap;
  if (Math.abs(v.speed) < 0.3) return "Ripper down. Drive to rip.";
  if (!face || !face.hard) return "Ripping the ground.";
  const work = ripWork.get(state) ?? {};
  ripWork.set(state, work);
  work[face.id] = (work[face.id] ?? 0) + dt;
  if (work[face.id] < RIP_SECONDS) return `Ripping hard rock… ${Math.ceil(RIP_SECONDS - work[face.id])} s`;
  delete work[face.id];
  const d = state.deposits.find((x) => x.id === face.id);
  if (d) d.hard = false;
  if (!o.ripped.includes(face.id)) o.ripped.push(face.id);
  v.damage = Math.min(1, v.damage + 0.03);
  say(state, "Ripped the hard rock. This face now digs at normal speed.");
  return "Face ripped.";
}

// ---- Round 4: reputation ---------------------------------------------------
export const REP_NAMES = ["New", "Local", "Trusted", "Preferred", "Top supplier"];
export function repLevel(rep: number) {
  return Math.min(4, Math.floor(rep / 25));
}
export function contractMult(state: GameState) {
  return on(4) ? 1 + repLevel(ops(state).rep) * 0.1 : 1;
}
export function onContractFilled(state: GameState) {
  if (!on(4)) return;
  const o = ops(state);
  const before = repLevel(o.rep);
  o.rep = Math.min(100, o.rep + 8);
  if (repLevel(o.rep) > before) say(state, `Reputation up: ${REP_NAMES[repLevel(o.rep)]}. Contracts pay ${repLevel(o.rep) * 10}% more.`);
}

// ---- Sale price modifiers (rounds 4, 5, 6) ---------------------------------
export function saleMult(state: GameState, ore: OreId, pad: PadKind) {
  const o = ops(state);
  let m = 1;
  if (on(4)) m *= 1 + repLevel(o.rep) * 0.02;
  if (on(5) && o.event?.kind === "double" && o.event.ore === ore && o.event.day === state.market.day) m *= 2;
  if (on(6) && o.screen && pad === "wash") m *= 1.12;
  if (pad === "wash" || pad === "sluice") m *= C.seasonWash(C.seasonOf(state.market.day));
  if (pad === "mill" && C.seasonOf(state.market.day) === "winter") m *= 0.85;
  return m;
}
export function onSale(state: GameState, net: number, tons: number) {
  const o = ops(state);
  if (o.debt > 0) {
    const pay = Math.min(o.debt, state.cash);
    o.debt -= pay;
    state.cash -= pay;
  }
  const r = o.records;
  r.bestSale = Math.max(r.bestSale, net);
  r.today += net;
  r.bestDay = Math.max(r.bestDay, r.today);
  r.tons += tons;
}

// ---- Round 5: events --------------------------------------------------------
export function rollEvent(seed: number, day: number, valley: boolean, uids: string[], mountain = false): Event | null {
  const r = hash(seed, day, 5);
  if (valley && r < 0.12) return { kind: "flood", day };
  if (r < 0.24) {
    const ores: OreId[] = ["iron", "copper", "silver", "gold"];
    return { kind: "double", day, ore: ores[Math.floor(hash(seed, day, 6) * ores.length)] };
  }
  if (r < 0.33 && uids.length) return { kind: "breakdown", day, uid: uids[Math.floor(hash(seed, day, 7) * uids.length)] };
  if (mountain && r < 0.45) return { kind: "rockslide", day, gap: Math.floor(hash(seed, day, 8) * 3) % 3 };
  return null;
}
export function bridgeClosed(state: GameState) {
  const e = ops(state).event;
  return on(5) && e?.kind === "flood" && e.day === state.market.day;
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Elapsed time of today's flood closure, and how long until the bridge opens. Empty when it is open. */
export function bridgeClock(state: GameState) {
  if (!bridgeClosed(state)) return "";
  const passed = state.seconds % DAY;
  const left = Math.max(0, DAY - passed);
  return `Bridge closed ${clock(passed)} · opens in ${clock(left)}`;
}

// ---- Round 7, 9: tires and fuel ---------------------------------------------
/** Litres in a full tank. The crusher burns none. Pickups, skids and light plants take gas. */
export function tankLitres(v: VehicleState) {
  return ({ pickup: 100, skid: 80, light: 40, dozer: 450, loader: 380, excavator: 400, truck: 300, heavy: 900, lowboy: 600, crusher: 0 } as Record<string, number>)[v.defId] ?? 300;
}
export function fuelKind(id: string): "gas" | "diesel" | "none" {
  if (id === "crusher") return "none";
  if (id === "pickup" || id === "skid" || id === "light") return "gas";
  return "diesel";
}
export function pumpPrice(id: string) {
  return fuelKind(id) === "gas" ? PRICES.gas : PRICES.dieselPump;
}

/** One diesel and gas island on each map, beside the yard. */
export const FUEL_BAYS = [
  { area: "ridge" as const, x: -22, z: 44 },
  { area: "river" as const, x: X0 + 58, z: 36 },
  { area: "mountain" as const, x: X1 - 42, z: 42 },
];
export const PUMP_REACH = 7;

/** Where a low tank should drive. Null if it does not need fuel. The point is the bay, or the machine itself when it is already under the canopy. */
export function fuelAim(state: GameState, v: VehicleState): { x: number; z: number } | null {
  if (!on(9) || tankLitres(v) <= 0) return null;
  if ((ops(state).fuel[v.uid] ?? 1) > 0.34) return null;
  const bay = FUEL_BAYS.find((b) => b.area === areaOf(v.x));
  if (!bay) return null;
  if (Math.hypot(v.x - bay.x, v.z - bay.z) <= PUMP_REACH) return { x: v.x, z: v.z };
  return { x: bay.x, z: bay.z };
}
/** A full tank lasts about one and a half game days of steady work. */
export function burn(v: VehicleState, dt: number) {
  const working = Math.abs(v.speed) > 0.3 || v.busy;
  return working ? dt / (DAY * 1.5) : 0;
}
export function tireCost(v: VehicleState) {
  return ({ pickup: 900, skid: 1400, loader: 6000, truck: 4800, heavy: 9000, lowboy: 7200 } as Record<string, number>)[v.defId] ?? 0;
}
/** Tread lasts about 25 km. Worn tires can go flat. */
export function wear(tread: number, metres: number) {
  return Math.max(0, tread - metres / 25000);
}
export function flatChance(tread: number, metres: number) {
  return tread < 0.25 ? metres * 0.0004 * (1 - tread * 4 + 0.2) : 0;
}

// ---- Round 8: night -------------------------------------------------------------
/** 0 = full day, 1 = full night. The last quarter of each day is night. */
export function nightness(seconds: number) {
  const f = (seconds % DAY) / DAY;
  if (f < 0.7) return 0;
  if (f < 0.75) return (f - 0.7) / 0.05;
  if (f > 0.97) return (1 - f) / 0.03;
  return 1;
}

// ---- Daily hook (rounds 5, 11) -------------------------------------------------
export function newDay(state: GameState) {
  const o = ops(state);
  const day = state.market.day;
  o.records.today = 0;
  if (day % C.SEASON_DAYS === 0) {
    const se = C.seasonOf(day);
    say(state, se === "rain" ? "Rain season: muddy ground, machines run slower." : se === "winter" ? "Winter: the sluice and wash plant half freeze." : "Summer: dry ground, full speed.");
  }
  if (on(5)) {
    const uids = state.vehicles.filter((v) => !isPlant(v) && v.hired).map((v) => v.uid);
    o.event = rollEvent(state.market.seed, day, state.claims.length >= 4 || state.washPlant, uids, state.claims.includes(8));
    if (o.event?.kind === "flood") say(state, "Flood warning: the river is over the bridge deck. Bridge closed today.");
    else if (o.event?.kind === "double" && o.event.ore) say(state, `A buyer is short: ${o.event.ore} pays double today.`);
    else if (o.event?.kind === "breakdown") {
      const v = state.vehicles.find((x) => x.uid === o.event!.uid);
      if (v) {
        v.damage = Math.min(1, v.damage + 0.35);
        say(state, `Breakdown: a crew machine blew a hydraulic hose. Repair it at the office.`);
      }
    }
  }
  if (on(11) && day >= o.nextInspect) inspect(state);
}

export function inspectIssues(state: GameState) {
  const o = ops(state);
  const issues: string[] = [];
  const beat = state.vehicles.filter((v) => !isPlant(v) && v.damage > 0.6).length;
  if (beat) issues.push(`${beat} badly damaged machine${beat > 1 ? "s" : ""}`);
  if (on(7) && o.flat.length) issues.push("running on flats");
  if (on(7) && state.vehicles.some((v) => onWheels(v) && (o.tread[v.uid] ?? 1) < 0.1)) issues.push("bald tires");
  return issues;
}
export function inspect(state: GameState) {
  const o = ops(state);
  const issues = inspectIssues(state);
  o.nextInspect = state.market.day + 3 + Math.floor(hash(state.market.seed, state.market.day, 11) * 3);
  if (!issues.length) {
    o.rep = Math.min(100, o.rep + 5);
    o.lastInspect = `Day ${state.market.day}: passed`;
    say(state, "Safety inspector visited. Clean site, passed. Reputation up.");
  } else {
    const fine = PRICES.fine * issues.length;
    o.upkeep += Math.min(state.cash, fine);
    state.cash = Math.max(0, state.cash - fine);
    o.rep = Math.max(0, o.rep - 5);
    o.lastInspect = `Day ${state.market.day}: fined ${money(fine)} (${issues.join(", ")})`;
    say(state, `Safety inspector fined you ${money(fine)}: ${issues.join(", ")}.`);
  }
}

// ---- Per-frame hook ------------------------------------------------------------
export type Before = Map<string, { x: number; z: number; yaw: number }>;
export function before(state: GameState): Before {
  const m: Before = new Map();
  for (const v of state.vehicles) m.set(v.uid, { x: v.x, z: v.z, yaw: v.yaw });
  return m;
}

export function tick(
  state: GameState,
  prev: Before,
  dt: number,
  capacityOf: (v: VehicleState) => number,
  dropLoad: (v: VehicleState) => void,
  yard: (v: VehicleState) => { x: number; z: number } = (v) => ({ x: v.x, z: v.z }),
) {
  const o = ops(state);
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    const p = prev.get(v.uid);
    if (!p || isPlant(v) || (state.deck ?? []).includes(v.uid)) continue;
    const player = i === state.active && !state.watching;
    let stop = "";
    if (on(9)) {
      const f = (o.fuel[v.uid] ?? 1) - burn(v, dt) * C.wearFuel(o.wear[v.uid] ?? 0) * (o.ramp && v.cargo > 0.3 ? 0.65 : 1);
      o.fuel[v.uid] = Math.max(0, f);
      // The fuel truck is an emergency delivery. The pumps are cheaper, so it only rolls when a tank is nearly dry.
      if (o.fuelTruck && o.fuel[v.uid] < 0.1) {
        const litres = (1 - o.fuel[v.uid]) * tankLitres(v);
        const cost = litres * PRICES.diesel;
        if (state.cash >= cost) {
          state.cash -= cost;
          o.upkeep += cost;
          o.fuel[v.uid] = 1;
        }
      }
      const bay = FUEL_BAYS.find((b) => b.area === areaOf(v.x));
      const atPump = !!bay && Math.hypot(v.x - bay.x, v.z - bay.z) <= PUMP_REACH && Math.abs(v.speed) < 1.2;
      if (atPump && o.fuel[v.uid] < 0.995 && fuelKind(v.defId) !== "none") {
        const room = 0.995 - o.fuel[v.uid];
        const price = pumpPrice(v.defId);
        let litres = Math.min(room, dt * 0.5) * tankLitres(v);
        if (litres * price > state.cash) litres = price > 0 ? state.cash / price : 0;
        if (litres > 0.01) {
          const cost = litres * price;
          state.cash -= cost;
          o.upkeep += cost;
          o.fuel[v.uid] = Math.min(1, o.fuel[v.uid] + litres / tankLitres(v));
          v.status = fuelKind(v.defId) === "gas" ? "At the gas pump" : "At the diesel pump";
        } else if (o.fuel[v.uid] < 0.995) {
          v.status = "No cash for the pump";
        }
      }
      if (o.fuel[v.uid] <= 0 && player && state.cash < refuelCost(state, v)) rescue(state, v, yard(v));
      if (o.fuel[v.uid] <= 0) stop = "Out of fuel";
    }
    if (!o.wear) o.wear = {};
    if (!o.broke) o.broke = [];
    const w = o.wear[v.uid] ?? 0;
    const working = Math.abs(v.speed) > 0.3 || v.busy;
    if (!stop && o.broke.includes(v.uid)) stop = "Broken down";
    if (!stop) {
      const cap = capacityOf(v);
      const hard = (cap > 0 && v.cargo > cap * 0.6) || v.busy;
      o.wear[v.uid] = Math.min(1, w + C.wearRate(hard, working) * dt);
      if (working && Math.random() < C.breakChance(w) * dt) {
        o.broke.push(v.uid);
        stop = "Broken down";
        say(state, `A worn ${v.defId} broke down. Overhaul it at the repair shop.`);
      }
    }
    const moved = Math.hypot(v.x - p.x, v.z - p.z);
    if (!stop && moved > 0) {
      const share = C.wearSpeed(w) * C.seasonSpeed(C.seasonOf(state.market.day));
      if (share < 0.999) {
        v.x = p.x + (v.x - p.x) * share;
        v.z = p.z + (v.z - p.z) * share;
      }
    }
    if (stop) {
      v.x = p.x;
      v.z = p.z;
      v.speed = 0;
      v.status = stop;
      continue;
    }
    if (!o.brakeHeat) o.brakeHeat = {};
    if (v.defId === "truck" || v.defId === "heavy" || v.defId === "lowboy") {
      const g = gradeAt(v.x, v.z, v.yaw);
      const loaded = v.cargo > 0.5 || (v.defId === "lowboy" && (state.deck ?? []).length > 0);
      const prevHeat = o.brakeHeat[v.uid] ?? 0;
      const atPullout = Math.abs(v.x - 512) <= 18 && v.z >= 86 && v.z <= 116 && Math.abs(v.speed) < 1;
      let nextHeat = prevHeat;
      if (loaded && g.along < -0.05 && Math.abs(v.speed) > 1.8) {
        nextHeat = Math.min(1, prevHeat + dt * (0.08 + Math.abs(g.along) * 0.75));
      } else {
        nextHeat = Math.max(0, prevHeat - dt * (atPullout ? 0.45 : 0.08));
        if (atPullout && prevHeat >= 0.35 && nextHeat < 0.35 && player) {
          say(state, "Brakes cooled at the pass summit pull-out.");
        }
      }
      o.brakeHeat[v.uid] = nextHeat;
      if (nextHeat >= 0.75) {
        if (Math.abs(v.speed) > 4.5) v.speed = Math.sign(v.speed) * 4.5;
        v.status = "Hot brakes · pull out or ease off";
      }
    }
    if (moved > 0) {
      const g = gradeAt(v.x, v.z, v.yaw);
      const cap = capacityOf(v);
      if (tipsOnSlope(v.defId, g.side, cap > 0 ? v.cargo / cap : 0, v.speed)) {
        dropLoad(v);
        v.speed = 0;
        v.damage = Math.min(1, v.damage + 0.15);
        v.yaw += Math.sign(g.side) * 0.6; // slewed round as it went over
        o.records.tips += 1;
        v.status = "Tipped on the side slope";
        if (player) say(state, "Truck went over on the side slope. Load lost, cab damaged. Drive straight up and down grades.");
      }
    }
    if (on(7) && onWheels(v) && moved > 0) {
      const t = o.tread[v.uid] ?? 1;
      o.tread[v.uid] = wear(t, moved);
      if (!o.flat.includes(v.uid) && Math.random() < flatChance(t, moved)) {
        o.flat.push(v.uid);
        say(state, "Flat tire! Change the tires before it chews the rim.");
      }
      if (o.flat.includes(v.uid) && Math.abs(v.speed) > 3) {
        v.speed = Math.sign(v.speed) * 3;
        v.status = "Flat tire";
      }
    }
  }
}

// ---- Buttons ---------------------------------------------------------------------
export type OpsButton = { id: string; label: string; detail: string; enabled: boolean };
type Ctx = { nearFace: { id: string; ore: OreId; hard: boolean; tested: boolean } | null; nearIds: string[] };

export function shopButtons(state: GameState): OpsButton[] {
  const o = ops(state);
  const b: OpsButton[] = [];
  const add = (r: number, id: keyof Ops, label: string, price: number, detail: string, extra = true) => {
    if (on(r) && !o[id] && extra) b.push({ id: `buy:${id}`, label: `${label} · ${money(price)}`, detail, enabled: state.cash >= price });
  };
  add(1, "ramp", "Grade haul ramp", PRICES.ramp, "Graded haul. A loaded machine burns about a third less fuel.");
  add(2, "scanner", "Ore scanner", PRICES.scanner, "Scan nearby faces for free and spot gold or silver nuggets.");
  add(3, "ripper", "Dozer ripper", PRICES.ripper, "Rip hard rock with the dozer so it digs at normal speed. No blast needed.");
  add(6, "screen", "Screening deck", PRICES.screen, "Screens gravel before the wash plant. Wash plant pays 12% more.", state.washPlant);
  add(8, "lights", "Work lights", PRICES.lights, "A brighter pool on the machine you are driving. Yard light plants and every machine's own lamps already come on at night.");
  add(9, "fuelTruck", "Fuel truck", PRICES.fuelTruck, "Emergency diesel delivery when a tank is nearly empty. The yard pumps are cheaper, and pickups and skids take gas.");
  return b;
}

export function fieldButtons(state: GameState, ctx: Ctx): OpsButton[] {
  const o = ops(state);
  const v = state.vehicles[state.active];
  const b: OpsButton[] = [];
  if (!v) return b;
  if (on(2) && o.scanner && ctx.nearFace) b.push({ id: "scan", label: "Scan", detail: "", enabled: true });
  if (on(7) && o.flat.includes(v.uid)) b.push({ id: "tires", label: `Tires ${money(tireCost(v))}`, detail: "", enabled: state.cash >= tireCost(v) });
  if (on(9) && !o.fuelTruck && (o.fuel[v.uid] ?? 1) < 0.5) b.push({ id: "fuel", label: `Deliver fuel ${money(refuelCost(state, v))}`, detail: "Comes to you. The yard pumps are cheaper.", enabled: state.cash >= refuelCost(state, v) });
  if (C.isWorker(v)) {
    const w = (o.wear ?? {})[v.uid] ?? 0;
    const broke = (o.broke ?? []).includes(v.uid);
    if (broke || w > 0.25) {
      const c = overhaulPrice(v, w);
      b.push({ id: "overhaul", label: `${broke ? "Fix" : "Overhaul"} ${money(c)}`, detail: "", enabled: state.cash >= c });
    }
  }
  if (on(10)) b.push({ id: "photo", label: "Photo", detail: "", enabled: true });
  return b;
}

let priceOf: (v: VehicleState) => number = () => 20000;
export function setPriceOf(f: (v: VehicleState) => number) {
  priceOf = f;
}
export function overhaulPrice(v: VehicleState, w: number) {
  return C.overhaulCost(priceOf(v), Math.max(w, 0.2));
}

export function refuelCost(state: GameState, v: VehicleState) {
  return Math.round((1 - (ops(state).fuel[v.uid] ?? 1)) * tankLitres(v) * PRICES.diesel + PRICES.callout);
}

export function nuggetValue(seed: number, day: number, faceId: string, ore: OreId) {
  if (ore !== "gold" && ore !== "silver") return 0;
  let h = 0;
  for (const c of faceId) h = (h * 31 + c.charCodeAt(0)) | 0;
  if (hash(seed, day, h) > 0.2) return 0;
  return Math.round((ore === "gold" ? 1200 : 400) + hash(seed, day, h + 1) * (ore === "gold" ? 1800 : 600));
}

export function act(state: GameState, id: string, ctx: Ctx): string {
  const o = ops(state);
  const v = state.vehicles[state.active];
  if (id.startsWith("buy:")) {
    const key = id.slice(4) as keyof typeof PRICES & keyof Ops;
    const price = PRICES[key];
    if (typeof price !== "number" || o[key] === true) return "";
    if (state.cash < price) return "Not enough cash.";
    state.cash -= price;
    (o as Record<string, unknown>)[key] = true;
    return `Bought: ${shopName(key)}.`;
  }
  if (!v) return "";
  if (id === "scan" && o.scanner) {
    let found = 0;
    for (const d of state.deposits) if (ctx.nearIds.includes(d.id)) d.tested = true;
    const f = ctx.nearFace;
    if (f && o.nuggetDay[f.id] !== state.market.day) {
      o.nuggetDay[f.id] = state.market.day;
      found = nuggetValue(state.market.seed, state.market.day, f.id, f.ore);
    }
    if (found) {
      state.cash += found;
      state.lifetime += found;
      o.records.nuggets += 1;
      return `Scanner hit! Dug out a ${f!.ore} nugget worth ${money(found)}.`;
    }
    return "Scan done. Nearby faces are graded. No nuggets here today.";
  }
  if (id === "rip" && o.ripper && ctx.nearFace?.hard) {
    const d = state.deposits.find((x) => x.id === ctx.nearFace!.id);
    if (d) d.hard = false;
    if (!o.ripped.includes(ctx.nearFace.id)) o.ripped.push(ctx.nearFace.id);
    v.damage = Math.min(1, v.damage + 0.03);
    return "Ripped the hard rock. This face now digs at normal speed.";
  }
  if (id === "tires") {
    const c = tireCost(v);
    if (state.cash < c) return "Not enough cash.";
    state.cash -= c;
    o.upkeep += c;
    o.tread[v.uid] = 1;
    o.flat = o.flat.filter((u) => u !== v.uid);
    return `New tires on. ${money(c)}.`;
  }
  if (id === "fuel") {
    const c = refuelCost(state, v);
    if (state.cash < c) return "Not enough cash.";
    state.cash -= c;
    o.upkeep += c;
    o.fuel[v.uid] = 1;
    if (v.status === "Out of fuel") v.status = "";
    return `Tank filled. ${money(c)} with the delivery call-out.`;
  }
  if (id === "overhaul") {
    const c = overhaulPrice(v, o.wear[v.uid] ?? 0);
    if (state.cash < c) return "Not enough cash.";
    state.cash -= c;
    o.upkeep += c;
    o.wear[v.uid] = 0;
    o.broke = o.broke.filter((u) => u !== v.uid);
    if (v.status === "Broken down") v.status = "";
    return `Repair shop overhauled it for ${money(c)}. Like new.`;
  }
  if (id === "photo") {
    o.photo = !o.photo;
    return "";
  }
  return "";
}

/** Broke and dry: free tow to the yard and a quarter tank on credit, paid back from sales. */
export function rescue(state: GameState, v: VehicleState, to: { x: number; z: number }) {
  const o = ops(state);
  v.x = to.x;
  v.z = to.z;
  v.speed = 0;
  o.fuel[v.uid] = 0.25;
  o.flat = o.flat.filter((u) => u !== v.uid);
  o.debt += Math.round(0.25 * tankLitres(v) * PRICES.diesel);
  v.status = "";
  say(state, "Out of fuel and cash: towed to the yard for free with a quarter tank on credit.");
}

function shopName(k: string) {
  return ({ ramp: "graded haul ramp", scanner: "ore scanner", ripper: "dozer ripper", screen: "screening deck", lights: "work lights", fuelTruck: "fuel truck" } as Record<string, string>)[k] ?? k;
}

/** Re-apply ripped faces after a load (faces come back from the map as hard). */
export function applyRipped(state: GameState) {
  const r = new Set(ops(state).ripped);
  for (const d of state.deposits) if (r.has(d.id)) d.hard = false;
}

export function statusLine(state: GameState) {
  const o = ops(state);
  const v = state.vehicles[state.active];
  const parts: string[] = [C.seasonLabel(state.market.day)];
  if (v && C.isWorker(v)) parts.push(o.broke?.includes(v.uid) ? "BROKEN" : `Wear ${Math.round(((o.wear ?? {})[v.uid] ?? 0) * 100)}%`);
  if (on(4)) parts.push(`Rep ${REP_NAMES[repLevel(o.rep)]}`);
  if (on(5) && o.event && o.event.day === state.market.day)
    parts.push(o.event.kind === "flood" ? bridgeClock(state) : o.event.kind === "double" ? `${o.event.ore} pays 2×` : "Breakdown today");
  if (on(8) && nightness(state.seconds) > 0.5) parts.push(o.lights ? "Night shift" : "Night");
  if (v && on(9) && !isPlant(v)) parts.push(`Fuel ${Math.round((o.fuel[v.uid] ?? 1) * 100)}%`);
  if (v && on(7) && onWheels(v)) parts.push(o.flat.includes(v.uid) ? "FLAT" : `Tread ${Math.round((o.tread[v.uid] ?? 1) * 100)}%`);
  return parts.join(" · ");
}

export function recordsLines(state: GameState): string[] {
  if (!on(10)) return [];
  const r = ops(state).records;
  const lines = [
    `Biggest single sale: ${money(r.bestSale)}`,
    `Best day: ${money(r.bestDay)}`,
    `Ore shipped: ${r.tons.toFixed(0)} t`,
    `Nuggets found: ${r.nuggets}`,
    `Trucks rolled: ${r.tips}`,
  ];
  if (on(11) && ops(state).lastInspect) lines.push(`Last inspection: ${ops(state).lastInspect}`);
  return lines;
}
