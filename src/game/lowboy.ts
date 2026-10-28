/**
 * The north-road lowboy. Space on the deck, not weight.
 * The paid office jump is a separate shortcut.
 */

import { X0 } from "@/game/river";

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

export function onHaulRoad(x: number, z: number) {
  const p = { x, z };
  return inBox(p, HAUL_ROAD) || inBox(p, RIDGE_SPUR) || inBox(p, VALLEY_SPUR);
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
