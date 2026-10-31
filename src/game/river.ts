/**
 * River Valley: the second area. Pure rules (no Three.js) so they can be tested.
 *
 * The valley sits far east of the ridge in world space (X0), so both areas share
 * one world and one save without overlapping. Anything with x > AREA_SPLIT is
 * in River Valley.
 */

export type AreaId = "ridge" | "river";

export const X0 = 1000;
export const AREA_SPLIT = 500;

export function areaOf(x: number): AreaId {
  return x > AREA_SPLIT ? "river" : "ridge";
}

export const RIVER_BOUNDS = { minX: X0 - 92, maxX: X0 + 92, minZ: -72, maxZ: 70 };

/** River runs north-south through the middle of the valley. */
export const RIVER = { x: X0, halfWidth: 7, minZ: -72, maxZ: 70 };

/** The one bridge across. Deck runs east-west, centred on z = BRIDGE.z. */
export const BRIDGE = { x: X0, z: 8, halfLength: 11, halfWidth: 4.2, limit: 30 };

/** Camp on the east bank, where machines arrive on the lowboy. */
export const RIVER_CAMP = { x: X0 + 46, z: 44 };
export const RIVER_SPAWNS = [
  { x: X0 + 40, z: 46 },
  { x: X0 + 48, z: 50 },
  { x: X0 + 56, z: 46 },
  { x: X0 + 36, z: 54 },
  { x: X0 + 64, z: 52 },
  { x: X0 + 30, z: 46 },
  { x: X0 + 70, z: 44 },
  { x: X0 + 24, z: 52 },
];

/** What it costs to send one machine between the ridge and the valley on the lowboy trailer. */
export const HAUL_FEE = 500;
/** The ridge claim you must own before the valley opens. */
export const UNLOCK_CLAIM = 4;
export const VALLEY_CLAIMS = { bars: 5, quarry: 6 } as const;

/** Share of the crusher price the west-bank buyer pays. Crossing still pays full rail price. */
export const BARGE_RATE = 0.7;

/** Buyer tied up on the west bank. The sell ring is on firm ground; the hull sits in the river. */
export const WEST_BARGE = {
  id: "barge",
  name: "West barge",
  x: X0 - 28,
  z: 16,
  r: 9,
  blurb: "A buyer on the west bank. Pays less than the rail, and the load never crosses the bridge.",
};

export const WASH_PLANT = {
  id: "wash",
  name: "Wash plant",
  price: 38000,
  x: X0 + 58,
  z: 18,
  r: 9,
  blurb: "Trommel and jig on the east bank. River silver pays out here.",
};

/** Machine weights in tonnes, empty. Cargo is added on top. */
export const MACHINE_TONS: Record<string, number> = {
  pickup: 3,
  skid: 4,
  dozer: 21,
  loader: 17,
  truck: 12,
  excavator: 22,
  heavy: 28,
  crusher: 45,
  // Tractor plus empty lowboy trailer.
  lowboy: 16,
};

export function grossTons(defId: string, cargo: number) {
  return (MACHINE_TONS[defId] ?? 10) + Math.max(0, cargo);
}

/** Is (x, z) on the bridge deck or its approach ramps? */
export function onBridge(x: number, z: number, pad = 0) {
  return Math.abs(x - BRIDGE.x) <= BRIDGE.halfLength + pad && Math.abs(z - BRIDGE.z) <= BRIDGE.halfWidth;
}

export function bridgeAllows(defId: string, cargo: number) {
  return grossTons(defId, cargo) <= BRIDGE.limit;
}

/** Biggest load this machine can carry over the bridge. */
export function bridgeMaxLoad(defId: string) {
  return Math.max(0, BRIDGE.limit - (MACHINE_TONS[defId] ?? 10));
}

/** True when the two points are on opposite sides of the valley river. */
export function otherBank(ax: number, bx: number) {
  if (areaOf(ax) !== "river" || areaOf(bx) !== "river") return false;
  const as = Math.sign(ax - RIVER.x);
  const bs = Math.sign(bx - RIVER.x);
  return as !== 0 && bs !== 0 && as !== bs;
}

/**
 * A crossing is worth planning when the bridge will take the load already in the bed,
 * or at least half an empty bed. A heavy haul's 2 t allowance is not a plan.
 */
export function crossingWorth(defId: string, capacity: number, cargo: number) {
  const legal = cargo > 0.2 ? cargo : bridgeMaxLoad(defId);
  if (!bridgeAllows(defId, legal)) return false;
  if (cargo > 0.2) return true;
  if (capacity <= 0) return true;
  return bridgeMaxLoad(defId) >= capacity * 0.5;
}

export function inRiver(x: number, z: number) {
  return Math.abs(x - RIVER.x) < RIVER.halfWidth && !onBridge(x, z);
}

/** Soft ground. Each zone is an ellipse; depth fades to 0 at the edge. */
export type MudZone = { x: number; z: number; rx: number; rz: number; depth: number; flood?: boolean };

export const MUD_ZONES: MudZone[] = [
  // River banks, both sides.
  { x: X0 - 12, z: -30, rx: 7, rz: 34, depth: 0.7 },
  { x: X0 - 12, z: 42, rx: 7, rz: 26, depth: 0.7 },
  { x: X0 + 12, z: -32, rx: 7, rz: 32, depth: 0.7 },
  { x: X0 + 12, z: 44, rx: 6, rz: 22, depth: 0.6 },
  // Low ground that floods when it rains.
  { x: X0 + 30, z: -44, rx: 16, rz: 12, depth: 0.35, flood: true },
  { x: X0 - 40, z: 40, rx: 14, rz: 12, depth: 0.3, flood: true },
];

/**
 * How deep the mud is here, 0 (firm) to 1 (deep). `wet` is 0 (dry) to 1 (soaked):
 * rain makes the banks wider and deeper and floods the low ground.
 */
export function mudDepth(x: number, z: number, wet: number) {
  if (x <= AREA_SPLIT) return 0;
  const w = Math.max(0, Math.min(1, wet));
  let best = 0;
  for (const m of MUD_ZONES) {
    const grow = 1 + w * (m.flood ? 0.5 : 0.6);
    const dx = (x - m.x) / (m.rx * grow);
    const dz = (z - m.z) / (m.rz * grow);
    const r = dx * dx + dz * dz;
    if (r >= 1) continue;
    const base = m.flood ? m.depth * w * 2.2 : m.depth * (1 + w * 0.45);
    best = Math.max(best, Math.min(1, base * (1 - r * 0.6)));
  }
  return best;
}

export const TRACKED = new Set(["dozer", "excavator"]);

/** Lowest speed share any machine keeps in mud, so nothing is ever stuck for good. */
export const MUD_FLOOR = 0.25;

/**
 * Share of top speed a machine keeps on this ground. Wheels sink; tracks float.
 * Deep mud bogs wheeled machines down hard, but never below MUD_FLOOR.
 */
export function mudSpeedFactor(defId: string, depth: number) {
  const d = Math.max(0, Math.min(1, depth));
  if (d <= 0.02) return 1;
  const tracked = TRACKED.has(defId);
  const f = tracked ? 1 - d * 0.3 : 1 - d * 0.62 - (d > 0.75 ? 0.15 : 0);
  return Math.max(MUD_FLOOR, f);
}

export function boggedDown(defId: string, depth: number) {
  return !TRACKED.has(defId) && depth > 0.75;
}

// ---------------------------------------------------------------- weather

export const RAIN_CHANCE = 0.45;
const DAY = 300;

function hash(n: number) {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** The rain spell (if any) for an in-game day: start and end in seconds of that day. */
export function rainSpell(seed: number, day: number) {
  if (day < 1) return null; // the first day is always dry
  const r = hash(seed ^ Math.imul(day + 7, 0x2c1b3c6d));
  if (r > RAIN_CHANCE) return null;
  const start = 30 + hash(seed + day * 31) * 150;
  const length = 60 + hash(seed - day * 17) * 70;
  return { start, end: Math.min(DAY - 5, start + length), heavy: hash(seed + day) > 0.5 };
}

/** Rain intensity 0..1 at a moment in game time. Deterministic from the save's seed, so it needs no saving. */
export function rainAt(seed: number, seconds: number) {
  const day = Math.floor(Math.max(0, seconds) / DAY);
  const t = seconds - day * DAY;
  const s = rainSpell(seed, day);
  if (!s || t < s.start || t > s.end) return 0;
  const ramp = Math.min(1, (t - s.start) / 12, (s.end - t) / 12);
  return Math.max(0, ramp) * (s.heavy ? 1 : 0.6);
}

/** Ground soaks up rain quickly and dries out slowly (about 3 minutes from soaked to dry). */
export function stepWet(wet: number, rain: number, dt: number) {
  const target = rain;
  if (target > wet) return Math.min(1, wet + (target - wet) * Math.min(1, dt * 0.08) + dt * 0.01 * rain);
  return Math.max(0, wet - dt / 180);
}
