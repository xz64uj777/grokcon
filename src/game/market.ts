/**
 * Ore prices that move once per in-game day. Pure and deterministic:
 * the same seed and day always give the same price board.
 */

export const DAY_SECONDS = 300; // one in-game day = 5 minutes of play
export const MIN_MULT = 0.5;
export const MAX_MULT = 2.0;
/** Selling a big pile at one spot on one day nudges that price down a little. */
export const GLUT_PER_TON = 0.003;
export const MAX_GLUT = 0.25;

export type Market = {
  seed: number;
  day: number;
  /** Today's multiplier per "pad:ore" key. 1 = normal price. */
  mult: Record<string, number>;
  /** Yesterday's multiplier, for the rising / falling arrow. */
  prev: Record<string, number>;
  /** Today's sell-off dip per key. Clears at the start of each day. */
  glut: Record<string, number>;
};

export function marketKey(pad: string, ore: string) {
  return `${pad}:${ore}`;
}

function hash(n: number) {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function keyHash(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h | 0;
}

/** One day's move: a random step that drifts back toward normal. */
export function nextMult(seed: number, day: number, key: string, current: number) {
  const r = hash(seed ^ Math.imul(day + 1, 0x9e3779b1) ^ keyHash(key));
  const step = (r - 0.5) * 0.7; // about ±35% in log terms
  const pull = -Math.log(current) * 0.3; // drift back toward 1.0
  const next = current * Math.exp(step + pull);
  return Math.max(MIN_MULT, Math.min(MAX_MULT, next));
}

export function freshMarket(seed: number, keys: string[]): Market {
  const mult: Record<string, number> = {};
  for (const k of keys) mult[k] = 1;
  return { seed: seed >>> 0, day: 0, mult, prev: { ...mult }, glut: {} };
}

/** Roll the board forward to the day that `seconds` falls in. Returns true when a new day started. */
export function advanceMarket(m: Market, seconds: number, keys: string[]) {
  const day = Math.floor(Math.max(0, seconds) / DAY_SECONDS);
  if (day <= m.day) return false;
  // Never replay more than a few days in one go (long idle tabs or big imports).
  const from = Math.max(m.day, day - 5);
  for (let d = from; d < day; d++) {
    const prev = { ...m.mult };
    for (const k of keys) m.mult[k] = nextMult(m.seed, d + 1, k, m.mult[k] ?? 1);
    m.prev = prev;
  }
  m.day = day;
  m.glut = {};
  return true;
}

export function priceMult(m: Market | undefined, pad: string, ore: string) {
  if (!m) return 1;
  const k = marketKey(pad, ore);
  const base = m.mult[k] ?? 1;
  return Math.max(MIN_MULT * 0.75, base * (1 - (m.glut[k] ?? 0)));
}

export function recordSale(m: Market, pad: string, ore: string, tons: number) {
  const k = marketKey(pad, ore);
  m.glut[k] = Math.min(MAX_GLUT, (m.glut[k] ?? 0) + Math.max(0, tons) * GLUT_PER_TON);
}

export function trend(m: Market, pad: string, ore: string): "up" | "down" | "flat" {
  const k = marketKey(pad, ore);
  const a = m.mult[k] ?? 1;
  const b = m.prev[k] ?? 1;
  if (a > b * 1.02) return "up";
  if (a < b * 0.98) return "down";
  return "flat";
}
