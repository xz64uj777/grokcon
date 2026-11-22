/** The wash-plant dump line. */

import type { GameState, VehicleState } from "@/game/types";
import type { Control } from "./types.ts";
import { distTo, handsOn, vehicleStats } from "./world.ts";
import { prefersWash } from "./jobs.ts";
import { fillsHaulers } from "./haulers.ts";
import { seek } from "./motion.ts";


export const dumpAnyway = new WeakSet<VehicleState>();

export const plantTicket = new WeakMap<VehicleState, number>();

let plantNo = 1;

function goingToWash(state: GameState, t: VehicleState) {
  if (!t.cargoOre || t.cargo < 0.4 || !prefersWash(state, t.cargoOre, t.x)) return false;
  if (!(t.operator || handsOn(state, t))) return false;
  // A full loader or excavator waiting at the dig is not queued at the plant.
  // A dedicated feeder stays at the hopper and is not waiting to tip on the pad.
  // The sluice and mill have no dump line of this kind; only the wash plant does.
  if (fillsHaulers(t.defId) || t.feederPad) return false;
  const cap = vehicleStats(t).capacity;
  if (cap <= 0) return false;
  // Only machines actually hauling a load in to dump. The old "near the plant"
  // check also pulled in skid steers that were only working nearby.
  return t.cargo >= cap * 0.9 || dumpAnyway.has(t);
}


export function plantLine(state: GameState) {
  const list = state.vehicles.filter((t) => goingToWash(state, t));
  for (const t of list) if (!plantTicket.has(t)) plantTicket.set(t, plantNo++);
  list.sort((a, b) => (plantTicket.get(a) ?? 0) - (plantTicket.get(b) ?? 0));
  return list;
}

/** Only the first machine pulls onto the wash plant. The rest wait in a line to the east. */

/** Only the first machine pulls onto the wash plant. The rest wait in a line to the east. */
export function plantQueue(state: GameState, v: VehicleState, pad: { kind: string; x: number; z: number; r: number } | null): Control | null {
  if (!pad || pad.kind !== "wash" || !goingToWash(state, v)) return null;
  if (!plantTicket.has(v)) plantTicket.set(v, plantNo++);
  const place = plantLine(state).findIndex((t) => t === v);
  if (place <= 0) return null;
  // The east bank is narrow. Keep the queue inside the map and off the pad:
  // first five slots run north, then the line snakes back south in a second lane.
  const eastX = pad.x + pad.r + 14;
  const laneX = eastX - 14;
  const slot = place - 1;
  const firstLaneSlots = 5;
  const second = slot - firstLaneSlots;
  const spot = slot < firstLaneSlots
    ? { x: eastX, z: pad.z + slot * 12 }
    : { x: laneX, z: second <= 3 ? pad.z + 48 - second * 12 : pad.z + 6 - (second - 4) * 12 };
  v.status = `Wash line (${place + 1})`;
  if (distTo(v.x, v.z, spot.x, spot.z) < 3.4) return { throttle: 0, steer: 0, action: false, brake: 1 };
  return seek(v, spot.x, spot.z, 3);
}

/** A mountain bench wall is still between these two points. */
