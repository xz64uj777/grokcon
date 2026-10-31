/**
 * The north-road lowboy. Space on the deck, not weight.
 * The paid office jump is a separate shortcut.
 */

import { X0, areaOf, type AreaId } from "@/game/river";

export const DECK_SPOTS = 3;

/** How much of the three-spot deck a machine takes. null = it does not fit. */
export function deckSpots(defId: string): number | null {
  if (defId === "pickup" || defId === "skid") return 1;
  if (defId === "dozer" || defId === "loader") return 2;
  if (defId === "truck" || defId === "excavator" || defId === "heavy") return 3;
  return null;
}

export function spotsUsed(ids: string[]) {
  return ids.reduce((n, id) => n + (deckSpots(id) ?? DECK_SPOTS), 0);
}

/** "" if it fits. Otherwise the reason it does not. */
export function deckFit(loaded: string[], next: string) {
  const spots = deckSpots(next);
  if (spots == null) return "That machine does not fit on the lowboy.";
  if (loaded.length >= 2) return "The deck already has two machines.";
  if (spotsUsed(loaded) + spots > DECK_SPOTS) return "Not enough deck left for that machine.";
  return "";
}

/** Main east-west run, north of both yards. */
export const HAUL_ROAD = { minX: -20, maxX: X0 + 78, minZ: 86, maxZ: 108 };

/** North gate out of the ridge yard. */
export const RIDGE_SPUR = { minX: -16, maxX: 16, minZ: 58, maxZ: 108 };

/** Drop into the valley camp. Does not cross the river. */
export const VALLEY_SPUR = { minX: X0 + 24, maxX: X0 + 64, minZ: 48, maxZ: 108 };

export const RIDGE_YARD = { minX: -40, maxX: 36, minZ: 28, maxZ: 66 };
export const VALLEY_CAMP = { x: X0 + 46, z: 44, r: 24 };

type Point = { x: number; z: number };

function inBox(p: Point, b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
}

/** A hill footprint (center plus radii) sitting on the marked north road. */
export function hillBlocksRoad(x: number, z: number, rx: number, rz: number) {
  const boxes = [HAUL_ROAD, RIDGE_SPUR, VALLEY_SPUR];
  return boxes.some((b) => x + rx > b.minX - 8 && x - rx < b.maxX + 8 && z + rz > b.minZ - 4 && z - rz < b.maxZ + 6);
}

export type PassPeak = { x: number; z: number; r: number; h: number };

/** Mountains on both sides of the marked road. Feet stay off the gravel. */
export function passPeaks(): PassPeak[] {
  const peaks: PassPeak[] = [];
  const north = HAUL_ROAD.maxZ + 28;
  const south = HAUL_ROAD.minZ - 28;
  for (let i = 0, x = 60; x < HAUL_ROAD.maxX - 80; i++, x += 48) {
    const wobble = (i % 3) * 6;
    const nr = 22 + (i % 4) * 4;
    const sr = 20 + ((i + 1) % 4) * 4;
    peaks.push({ x, z: north + nr * 0.35 + wobble, r: nr, h: 16 + (i % 5) * 3 });
    peaks.push({ x: x + 18, z: south - sr * 0.35 - wobble, r: sr, h: 14 + ((i + 2) % 5) * 3 });
  }
  return peaks.filter((peak) => !hillBlocksRoad(peak.x, peak.z, peak.r * 0.85, peak.r * 0.85));
}

export function onHaulRoad(x: number, z: number) {
  const p = { x, z };
  return inBox(p, HAUL_ROAD) || inBox(p, RIDGE_SPUR) || inBox(p, VALLEY_SPUR);
}

/** Where the pass turns off the ridge and drops into the valley camp. */
export const VALLEY_GATE_X = X0 + 24;
/** High point of the north road, halfway between the ridge yard and the valley gate. */
export const PASS_SUMMIT_X = Math.round(VALLEY_GATE_X / 2);

/**
 * Which map a machine counts as being on. The pass belongs to the ridge until
 * it reaches the valley gate, so the office and shop do not flip halfway along
 * an empty gravel road.
 */
export function areaIn(x: number, z: number): AreaId {
  if (onHaulRoad(x, z)) return x >= VALLEY_GATE_X ? "river" : "ridge";
  return areaOf(x);
}

export function inDropYard(x: number, z: number) {
  if (inBox({ x, z }, RIDGE_YARD)) return true;
  return Math.hypot(x - VALLEY_CAMP.x, z - VALLEY_CAMP.z) <= VALLEY_CAMP.r;
}

/** Keep a non-lowboy out of the north gate. Returns true if it was pushed back. */
export function blockRoadGate(defId: string, x: number, z: number) {
  if (defId === "lowboy") return false;
  if (inBox({ x, z }, RIDGE_SPUR) && z > 64) return true;
  if (inBox({ x, z }, VALLEY_SPUR) && z > 70) return true;
  if (inBox({ x, z }, HAUL_ROAD)) return true;
  return false;
}

/** Fifth wheel, in the tractor's local space. Forward is -Z, so this sits behind the cab. */
export const HITCH_Z = -0.95;
/** Trailer axle group, measured back from the hitch along the deck. */
export const AXLE_BACK = 7.4;
/** How far the trailer can swing off the cab before it stops articulating. */
const MAX_ARTICULATION = 1.15;
/** Height a machine's root sits at when it is strapped to the deck. */
export const DECK_Y = 0.74;

export function hitchPoint(x: number, z: number, yaw: number) {
  return { x: x + Math.sin(yaw) * HITCH_Z, z: z + Math.cos(yaw) * HITCH_Z };
}

/**
 * Pull the trailer from the fifth wheel. The axle does not slide sideways,
 * so the deck yaws around the hitch instead of staying locked to the cab.
 */
export function stepHitch(x: number, z: number, yaw: number, axleX: number | undefined, axleZ: number | undefined) {
  const h = hitchPoint(x, z, yaw);
  const ax = axleX;
  const az = axleZ;
  if (ax == null || az == null || Math.hypot(ax - h.x, az - h.z) > AXLE_BACK * 1.8) {
    return {
      trailerYaw: yaw,
      axleX: h.x + Math.sin(yaw) * AXLE_BACK,
      axleZ: h.z + Math.cos(yaw) * AXLE_BACK,
    };
  }
  const bearing = Math.atan2(ax - h.x, az - h.z);
  const delta = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw));
  const nextYaw = yaw + Math.max(-MAX_ARTICULATION, Math.min(MAX_ARTICULATION, delta));
  return {
    trailerYaw: nextYaw,
    axleX: h.x + Math.sin(nextYaw) * AXLE_BACK,
    axleZ: h.z + Math.cos(nextYaw) * AXLE_BACK,
  };
}
