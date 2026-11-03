/**
 * Round 14: machine wear and repairs, a job story, seasons and a used machine lot.
 * State lives inside Ops (saved with it). Pure rules plus small hooks.
 */
import type { GameState, VehicleId, VehicleState } from "@/game/types";

export type Season = "summer" | "rain" | "winter";
export const SEASON_DAYS = 3;
const ORDER: Season[] = ["summer", "rain", "winter"];

export function seasonOf(day: number): Season {
  return ORDER[Math.floor(Math.max(0, day) / SEASON_DAYS) % ORDER.length];
}
export function seasonLabel(day: number) {
  const s = seasonOf(day);
  const left = SEASON_DAYS - (Math.max(0, day) % SEASON_DAYS);
  return `${s === "summer" ? "Summer" : s === "rain" ? "Rain" : "Winter"} ${left}d`;
}
/** Speed share from the season (on top of mud and grade). */
export function seasonSpeed(s: Season) {
  return s === "rain" ? 0.85 : s === "winter" ? 0.92 : 1;
}
/** Wash and sluice output share. Winter half-freezes the water. */
export function seasonWash(s: Season) {
  return s === "winter" ? 0.6 : 1;
}

// ---- Wear ---------------------------------------------------------------------
/** Wear gained per second. Hard use (loaded, working, full throttle) wears ~3x faster. */
export function wearRate(hard: boolean, working: boolean) {
  if (!working) return 0;
  return (hard ? 3 : 1) / (3600 * 3);
}
export function wearSpeed(w: number) {
  return 1 - Math.max(0, w - 0.3) * 0.5; // up to -35% at full wear
}
export function wearFuel(w: number) {
  return 1 + w * 0.6;
}
/** Breakdown chance per second. Nothing below 50% wear. */
export function breakChance(w: number) {
  return w < 0.5 ? 0 : ((w - 0.5) ** 2) * 0.004;
}
export function overhaulCost(price: number, w: number) {
  return Math.round(200 + price * 0.25 * w);
}

// ---- Story --------------------------------------------------------------------
export type Goal = { text: string; pay: number; done: (s: GameState, mountain: boolean) => boolean };
export const STORY: Goal[] = [
  { text: "Job 1: Ship your first load from the ridge.", pay: 500, done: (s) => s.lifetime > 0 },
  { text: "Job 2: Earn $10,000 on the ridge.", pay: 1500, done: (s) => s.lifetime >= 10000 },
  { text: "Job 3: Buy a second claim.", pay: 3000, done: (s) => s.claims.length >= 2 },
  { text: "Job 4: Put in a sluice or wash plant.", pay: 5000, done: (s) => s.sluice || s.washPlant },
  { text: "Job 5: Earn $120,000 to fund the mountain lease.", pay: 10000, done: (s) => s.lifetime >= 120000 },
  { text: "Job 6: Lease the mountain mine.", pay: 25000, done: (_s, m) => m },
];
export function storyText(step: number) {
  return step < STORY.length ? STORY[step].text : "Story done. The mountain is yours.";
}

// ---- Used lot -----------------------------------------------------------------
export type LotItem = { defId: VehicleId; wear: number; price: number };
const LOT_IDS: VehicleId[] = ["skid", "loader", "truck", "excavator", "dozer"] as VehicleId[];
export function lotFor(seed: number, day: number, priceOf: (id: VehicleId) => number): LotItem[] {
  const out: LotItem[] = [];
  for (let k = 0; k < 2; k++) {
    const h = Math.abs(Math.sin(seed * 12.9898 + day * 78.233 + k * 37.719) * 43758.5453) % 1;
    const id = LOT_IDS[Math.floor(h * LOT_IDS.length) % LOT_IDS.length];
    if (out.some((x) => x.defId === id)) continue;
    const wear = 0.45 + ((h * 7) % 1) * 0.35;
    out.push({ defId: id, wear: Math.round(wear * 100) / 100, price: Math.round(priceOf(id) * (1 - wear * 0.75)) });
  }
  return out;
}
/** What the lot pays for a machine on top of a cash sale, less for wear. */
export function tradeValue(resale: number, w: number) {
  return Math.round(resale * (1.1 - w * 0.4));
}

export function isWorker(v: VehicleState) {
  return v.defId !== "crusher" && v.defId !== "lowboy" && !String(v.defId).includes("plant");
}
