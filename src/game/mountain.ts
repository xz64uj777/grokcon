/**
 * High mountain mine: the third area. Pure rules (no Three.js) so they can be tested.
 * It sits at X1 in world space, past River Valley, and shares the one world and save.
 * A switchback haul road climbs from the camp (south) to the summit faces (north).
 */
export const X1 = 2000;
export const MOUNTAIN_SPLIT = 1500;
export const MOUNTAIN_BOUNDS = { minX: X1 - 80, maxX: X1 + 80, minZ: -68, maxZ: 66 };
export const MOUNTAIN_CLAIM = 8;
export const MOUNTAIN_CLAIM_PRICE = 150000;
/** Lowboy and escort up the mountain road. */
export const MOUNTAIN_HAUL_FEE = 2500;
export const MOUNTAIN_SPAWNS = [
  { x: X1 - 30, z: 54 },
  { x: X1 - 20, z: 56 },
  { x: X1 - 40, z: 56 },
  { x: X1 - 10, z: 54 },
  { x: X1 - 50, z: 54 },
  { x: X1, z: 56 },
];
/** Ore mill at the camp, where everything from the summit is sold. */
export const MILL = { x: X1 + 52, z: 50, r: 10 };

/** Summit mill pays per ton. Hard-rock gold is milled on site, close to the sluice's $300/t. */
export const MILL_PRICE = { dirt: 10, iron: 80, copper: 175, gold: 285, silver: 150 } as const;

/** Bench walls of the switchback. Each leaves one gap, alternating east and west. */
export const SWITCHBACKS = [
  { z: 30, gapX: X1 + 62 },
  { z: 4, gapX: X1 - 62 },
  { z: -22, gapX: X1 + 62 },
];
export const GAP_HALF = 12;

export function inMountain(x: number) {
  return x > MOUNTAIN_SPLIT;
}

/** Wall segments for collision: each bench wall minus its gap. */
export function switchbackBlocks() {
  const out: { id: string; x: number; z: number; sx: number; sy: number; sz: number; kind: "cliff" }[] = [];
  const minX = MOUNTAIN_BOUNDS.minX;
  const maxX = MOUNTAIN_BOUNDS.maxX;
  SWITCHBACKS.forEach((w, i) => {
    const a = w.gapX - GAP_HALF;
    const b = w.gapX + GAP_HALF;
    const sy = 5 + i * 2;
    if (a > minX) out.push({ id: `bench-${i}-w`, x: (minX + a) / 2, z: w.z, sx: a - minX, sy, sz: 5, kind: "cliff" });
    if (b < maxX) out.push({ id: `bench-${i}-e`, x: (b + maxX) / 2, z: w.z, sx: maxX - b, sy, sz: 5, kind: "cliff" });
  });
  return out;
}

/** Next point on the switchback toward a target: the gap of the first bench wall in the way. */
export function switchbackWaypoint(x: number, z: number, tx: number, tz: number): { x: number; z: number } | null {
  const walls = z > tz ? [...SWITCHBACKS] : [...SWITCHBACKS].reverse();
  for (const w of walls) {
    const between = (z - w.z) * (tz - w.z) < 0;
    if (!between) continue;
    if (Math.abs(x - w.gapX) < GAP_HALF - 3 && Math.abs(z - w.z) < 8) return null; // in the gap: go on through
    return { x: w.gapX, z: w.z + (z > w.z ? 6 : -6) };
  }
  return null;
}

/** Cold slows engines and hydraulics a little; snow (the area's rain) slows them more. */
export function coldFactor(snow: number) {
  return 0.88 - Math.max(0, Math.min(1, snow)) * 0.13;
}

/** Bench level (0 at camp, 3 at the summit) for a point, for the steepness readout. */
export function benchAt(z: number) {
  return SWITCHBACKS.filter((w) => z < w.z).length;
}
