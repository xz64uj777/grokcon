/** The wash-plant dump line. */

import { WASH_PLANT, otherBank } from "@/game/river";
import type { GameState, VehicleState } from "@/game/types";
import type { Control } from "./types.ts";
import { distTo, handsOn } from "./world.ts";
import { prefersWash } from "./jobs.ts";
import { fillsHaulers } from "./haulers.ts";
import { seek } from "./motion.ts";


export const dumpAnyway = new WeakSet<VehicleState>();

export const plantTicket = new WeakMap<VehicleState, number>();

let plantNo = 1;

// Join close to the pad. Keep the ticket farther out so the queue's own
// parking spots do not make trucks lose their place.
const WASH_JOIN_RADIUS = WASH_PLANT.r + 20;
const WASH_WAIT_RADIUS = 60;

function canQueueForWash(state: GameState, t: VehicleState) {
  if (!t.cargoOre || t.cargo <= 0.04 || !prefersWash(state, t.cargoOre, t.x)) return false;
  if (!t.operator || handsOn(state, t) || state.deck?.includes(t.uid)) return false;
  // Loaders and excavators at the dig and dedicated feeders are not in the dump line.
  return !fillsHaulers(t.defId) && !t.feederPad && !otherBank(t.x, WASH_PLANT.x);
}

export function washQueuePlace(state: GameState, v: VehicleState) {
  const distance = distTo(v.x, v.z, WASH_PLANT.x, WASH_PLANT.z);
  if (!canQueueForWash(state, v) || distance > WASH_WAIT_RADIUS) {
    plantTicket.delete(v);
    return -1;
  }

  let ticket = plantTicket.get(v);
  if (ticket === undefined) {
    if (distance > WASH_JOIN_RADIUS) return -1;
    ticket = plantNo++;
    plantTicket.set(v, ticket);
  }

  let place = 0;
  for (const other of state.vehicles) {
    const otherTicket = plantTicket.get(other);
    if (otherTicket === undefined || otherTicket >= ticket) continue;
    if (!canQueueForWash(state, other) || distTo(other.x, other.z, WASH_PLANT.x, WASH_PLANT.z) > WASH_WAIT_RADIUS) {
      plantTicket.delete(other);
    } else {
      place++;
    }
  }
  return place;
}

/** Only the first machine pulls onto the wash plant. The rest wait in a line to the east. */
export function plantQueue(state: GameState, v: VehicleState, pad: { kind: string; x: number; z: number; r: number } | null): Control | null {
  if (!pad || pad.kind !== "wash") return null;
  const place = washQueuePlace(state, v);
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
