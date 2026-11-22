/** Routing, steering, collisions, the bridge scale, and the lowboy deck. */

import * as Ops from "@/game/ops";
import { climbFactor, gradeAt, rollAccel } from "@/game/terrain";
import { pileFootprint } from "@/game/piles";
import { X1, switchbackWaypoint } from "@/game/mountain";
import { BLOCKS, DEFS, GATE, inPit, boundsFor } from "@/game/catalog";
import { BRIDGE, X0, areaOf, bridgeMaxLoad, grossTons, MACHINE_TONS, inRiver, onBridge, bridgeLane } from "@/game/river";
import { tankMotion } from "@/game/controls";
import { HITCH_Z, MOUNTAIN_GATE_X, blockRoadGate, deckFit, onHaulRoad, onMountainRoad, stepHitch } from "@/game/lowboy";
import type { AreaId } from "@/game/river";
import type { GameState, VehicleState } from "@/game/types";
import type { Control } from "./types.ts";
import { areaName, clamp, distTo, hypot, log, mountainOpen, orderArea, vehicleStats, yardPad } from "./world.ts";
import { approachLatch, pileJob } from "./jobs.ts";
import { fillsHaulers, lineTicket } from "./haulers.ts";
import { bayCommit, bayReady, standLatch, truckSpot } from "./bay.ts";
import { dumpAnyway } from "./plants.ts";
import { teamHasTruck } from "./crew.ts";
import { uncouple } from "./office.ts";

/** A mountain bench wall is still between these two points. */
export function benchBetween(x: number, z: number, tx: number, tz: number) {
  return areaOf(x) === "mountain" && switchbackWaypoint(x, z, tx, tz) != null;
}


export function routeTo(v: VehicleState, tx: number, tz: number) {
  if (areaOf(v.x) === "river") return routeRiver(v, tx, tz);
  if (areaOf(v.x) === "mountain") {
    const w = switchbackWaypoint(v.x, v.z, tx, tz);
    return w ?? { x: tx, z: tz };
  }
  if (inPit(v.x, v.z) !== inPit(tx, tz)) {
    // The yard side of the gate is still outside the pit. Turning back for the
    // gate there made crew pace a figure-8 and never reach the iron pile.
    // Only the real opening counts. The old wide slot let a skid west of the
    // yard wall turn early and stick on that wall on the way back from the sluice.
    const inGap = v.x > -20 && v.x < 8 && v.z > 0 && v.z < GATE.z + 6;
    if (!(inGap || distTo(v.x, v.z, GATE.x, GATE.z) <= 9)) return GATE;
  }
  // Gold creek and the sluice are west of the yard wall. A straight line from
  // the gate clips that wall and leaves the skid steers stuck on it.
  // Gold creek and the sluice are west of the yard wall. The southwest wall
  // covers x -55 to -25, z 5 to 12. Cross north of it, never through it.
  // Already in the west pocket past the gravel: climb back to the open stand first.
  if (v.x < -80 && areaOf(v.x) === "ridge") return { x: -74, z: Math.max(v.z, 18) };
  if ((tx < -58 && v.x > -66) || (v.x < -66 && tx > v.x + 6)) {
    if (v.x < -24 && v.x > -58 && v.z < 18) return { x: -14, z: Math.min(v.z, 2) };
    // The squeeze between the west pit wall and the southwest yard wall traps
    // machines heading to the sluice or the creek. Climb out on the open gold side.
    if (v.z < 18 && v.x <= -52 && v.x >= -66) return { x: -74, z: 24 };
    if (v.x < -80) return { x: -74, z: Math.max(v.z, 18) };
    if (v.z < 18) return { x: Math.max(v.x, -16), z: 24 };
    if (v.x < -66 && tx > -66) return { x: -60, z: 24 };
    if (v.x > -68 && tx < -58) return { x: -74, z: 24 };
    return { x: tx, z: tz };
  }
  return { x: tx, z: tz };
}

/** In the valley the only way over the river is the bridge, and the only way past the west cliff is the quarry gap. */

/** In the valley the only way over the river is the bridge, and the only way past the west cliff is the quarry gap. */
function routeRiver(v: VehicleState, tx: number, tz: number) {
  const gap = valleyGap(v.x, v.z, tx, tz);
  if (gap) return gap;
  const side = Math.sign(v.x - BRIDGE.x);
  const goal = Math.sign(tx - BRIDGE.x);
  if (goal === 0 || (side !== 0 && side === goal)) return { x: tx, z: tz };
  // The heavy haul never starts a crossing. It sells on the bank it is already on.
  if (v.defId === "heavy" && !onBridge(v.x, v.z, 1)) return { x: v.x, z: v.z };
  const exitX = BRIDGE.x + (goal || -side || 1) * (BRIDGE.halfLength + 6);
  const exit = { x: exitX, z: BRIDGE.z };
  // Once you're on the crossing, finish it. Sliding off the planks used to
  // aim a skid or a truck back at the ramp, so they danced and never got over.
  const crossing =
    Math.abs(v.x - BRIDGE.x) <= BRIDGE.halfLength + 2 && Math.abs(v.z - BRIDGE.z) <= BRIDGE.halfWidth + 6;
  if (crossing || side === 0) return exit;
  const near = { x: BRIDGE.x + side * (BRIDGE.halfLength + 5), z: BRIDGE.z };
  if (Math.abs(v.z - BRIDGE.z) > 1.6 || Math.abs(v.x - near.x) > 4) return near;
  return exit;
}

/** West cliff, with a cut at the quarry. There is no road behind that wall, only a gap in front of the quarry. */

/** West cliff, with a cut at the quarry. There is no road behind that wall, only a gap in front of the quarry. */
function valleyGap(x: number, z: number, tx: number, tz: number): { x: number; z: number } | null {
  const wallEast = X0 - 78;
  const inGap = (zz: number) => zz >= -16 && zz <= 2;
  if (x >= wallEast && tx >= wallEast) return null;
  if (x < wallEast) {
    if (!inGap(z)) return null;
    return { x: wallEast + 8, z: -7 };
  }
  return { x: wallEast + 8, z: Math.max(-14, Math.min(0, tz)) };
}


export function behindWestCliff(x: number, z: number) {
  if (onHaulRoad(x, z) || areaOf(x) !== "river") return false;
  // Only the quarry wall and the dead pocket behind it. The north road and the open west bank are not this.
  if (x > X0 - 78 || x < X0 - 98) return false;
  if (z >= -16 && z <= 2) return false;
  return true;
}


export function seek(v: VehicleState, tx: number, tz: number, arrive: number): Control {
  const routed = routeTo(v, tx, tz);
  const via = Math.hypot(routed.x - tx, routed.z - tz) > 3;
  const dx = routed.x - v.x;
  const dz = routed.z - v.z;
  const d = Math.hypot(dx, dz) || 0.0001;
  if (via && d < 1.5) return { throttle: 0, steer: 0, action: false, brake: 1 };
  const desired = Math.atan2(-dx, -dz);
  const diff = Math.atan2(Math.sin(desired - v.yaw), Math.cos(desired - v.yaw));
  // Close in, keep moving. Stopping to spin is what made a skid do 360s beside a face.
  const near = d < arrive + 7;
  const steer = clamp(diff / (near ? 2.2 : Math.max(0.9, vehicleStats(v).turn * 0.5)), -1, 1);
  let throttle = 1;
  let brake = 0;
  if (Math.abs(diff) > 1.15 && !near) {
    throttle = 0;
    brake = 0.55;
  } else if (Math.abs(diff) > 0.5) {
    throttle = near ? 0.34 : 0.22;
  }
  if (d < arrive + 6) throttle = Math.min(throttle, near ? 0.4 : 0.55);
  if (d < arrive) {
    if (via) return { throttle: 0.55, steer: clamp(diff, -1, 1), action: false, brake: 0 };
    if (Math.abs(diff) > 1.4) return { throttle: 0.2, steer: clamp(diff, -1, 1), action: false, brake: 0 };
    return { throttle: 0, steer: 0, action: true, brake: 1 };
  }
  return { throttle, steer, action: false, brake };
}

/** Another machine in front, and which side of the nose it is on. */

/** Another machine in front, and which side of the nose it is on. */
export function machineAhead(state: GameState, v: VehicleState) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = -fz;
  const rz = fx;
  let best: { gap: number; side: number } | null = null;
  for (const o of state.vehicles) {
    if (o === v || aboard(o)) continue;
    if (areaOf(o.x) !== areaOf(v.x)) continue;
    const dx = o.x - v.x;
    const dz = o.z - v.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const gap = dist - vehicleStats(v).radius - vehicleStats(o).radius;
    if (gap > 8) continue;
    if ((dx * fx + dz * fz) / dist < 0.2) continue;
    const side = dx * rx + dz * rz;
    if (!best || gap < best.gap) best = { gap, side };
  }
  return best;
}

/** Waits that are part of the job, not a stall. */

/** Waits that are part of the job, not a stall. */
const PATIENT = /^(Bridge flooded|In line|At the|Needs a pile|Feeding|Working|Lights|Light plant|Plant|Out of fuel|Wash line|Towed|Dumping|Scooping|Pushing|Backing off)/;

export const crewSeen = new WeakMap<VehicleState, { x: number; z: number; cargo: number; t: number }>();
/** A crew machine that has not moved or loaded for a while drops its spot and backs out to re-plan. */

/** A crew machine that has not moved or loaded for a while drops its spot and backs out to re-plan. */
export function crewWatchdog(state: GameState, v: VehicleState) {
  const now = state.seconds;
  const e = crewSeen.get(v);
  if (!e || Math.hypot(v.x - e.x, v.z - e.z) > 3 || Math.abs(v.cargo - e.cargo) > 0.05) {
    if (e && Math.hypot(v.x - e.x, v.z - e.z) > 12) crewRetry.delete(v);
    crewSeen.set(v, { x: v.x, z: v.z, cargo: v.cargo, t: now });
    return;
  }
  // A truck already parked in its bay or line stall is waiting to be loaded, not stuck.
  if (bayReady.has(v)) return;
  // A team waiting on its truck, or a machine with no job yet, is idle on purpose.
  if (/^Waiting for (truck|a job|a loader)|Looking for crumbs/.test(v.status)) return;
  if (fillsHaulers(v.defId) && teamHasTruck(state, v) && /Waiting for/.test(v.status)) return;
  // Lining up is a turn-and-roll, not a short heading. Give it the default window.
  const limit = PATIENT.test(v.status) && !/^(Scooping|Pushing|Working|In line)/.test(v.status) ? 90 : /^(Heading|Making|Backing)/.test(v.status) ? 15 : 30;
  if (now - e.t < limit) return;
  e.t = now;
  truckSpot.delete(v);
  bayCommit.delete(v);
  bayReady.delete(v);
  pileJob.delete(v);
  lineTicket.delete(v);
  approachLatch.delete(v);
  standLatch.delete(v);
  if (/^(Out of fuel|Needs a pile|At the|Lights|Light plant|Plant)/.test(v.status)) return;
  // A bucket that stopped filling at the face counts as full, so it goes and tips.
  if (/^Working/.test(v.status) && v.cargo > vehicleStats(v).capacity * 0.5) {
    topped.add(v);
    return;
  }
  // Backing into something: stop reversing and drive on instead.
  if (/^Backing/.test(v.status)) {
    v.unstick = 0;
    return;
  }
  // Each retry in a row backs out further and turns the other way.
  const n = (crewRetry.get(v) ?? 0) + 1;
  crewRetry.set(v, n);
  v.unstick = Math.min(8, 2 + n * 1.5);
  v.bias = n % 2 ? 0.9 : -0.9;
}

const crewRetry = new WeakMap<VehicleState, number>();

export const topped = new WeakSet<VehicleState>();

const roomSince = new WeakMap<VehicleState, { start: number; last: number }>();
/** Don't drive into the machine ahead. Back out when already touching, otherwise pass on the open side. */

/** Don't drive into the machine ahead. Back out when already touching, otherwise pass on the open side. */
export function avoidTraffic(state: GameState, v: VehicleState, c: Control): Control {
  if (v.defId === "crusher" || v.defId === "light") return c;
  const hit = machineAhead(state, v);
  if (!hit) return c;
  const holding = c.throttle === 0 && c.brake > 0.5;
  // A truck waiting beside a loader should ignore that loader's small shifts.
  if (holding && hit.gap > -0.2) return c;
  if (c.throttle < 0.12 || hit.gap > 2.4) return c;
  const away = hit.side >= 0 ? 0.9 : -0.9;
  const pullingOut = (v.defId === "truck" || v.defId === "heavy") && (dumpAnyway.has(v) || v.cargo >= vehicleStats(v).capacity * 0.85);
  if (hit.gap < 0 && !pullingOut) {
    v.status = "Making room";
    const e = roomSince.get(v);
    const now = state.seconds;
    if (!e || now - e.last > 5) roomSince.set(v, { start: now, last: now });
    else {
      e.last = now;
      if (now - e.start > 20) {
        // Still wedged: back straight out a few metres.
        roomSince.delete(v);
        v.unstick = 3;
        v.bias = 0;
      }
    }
    // In the valley, reversing along the bay ray put the dump back into the skid. Slide past it.
    if (areaOf(v.x) === "river" && (v.defId === "truck" || v.defId === "heavy")) {
      return { throttle: 0.35, steer: away, action: false, brake: 0 };
    }
    return { throttle: -0.5, steer: away, action: false, brake: 0 };
  }
  if (pullingOut) return { ...c, steer: clamp(c.steer + away, -1, 1), throttle: Math.max(c.throttle, 0.45) };
  return { ...c, steer: clamp(c.steer + away * 0.45, -1, 1), throttle: Math.max(0.2, Math.min(c.throttle, 0.7)) };
}

/** A face the crew can actually drive onto. The ridge back wall is solid, so a cut walked into it is pulled back out. */

/** North road between yards, then a straight run once both ends are on the same map. */
function lowboyAim(v: VehicleState, tx: number, tz: number) {
  const from = areaOf(v.x);
  const to = areaOf(tx);
  if (from === to && v.z < 82 && tz < 82) {
    if (from === "mountain") {
      const w = switchbackWaypoint(v.x, v.z, tx, tz);
      if (w) return w;
    }
    return { x: tx, z: tz };
  }
  if (v.z < 84) {
    if (from === "mountain") return { x: X1 - 38, z: Math.min(96, v.z + 28) };
    if (from === "river") return { x: X0 + 44, z: 96 };
    return { x: 0, z: 96 };
  }
  const gate = to === "mountain" ? X1 - 38 : to === "river" ? X0 + 44 : 0;
  if (Math.abs(v.x - gate) > 22) return { x: gate, z: 96 };
  return { x: tx, z: tz };
}


export function lowboyDest(v: VehicleState): AreaId | null {
  if (!v.workFace?.startsWith("map:")) return null;
  const area = v.workFace.slice(4);
  if (area === "ridge" || area === "river" || area === "mountain") return area;
  return null;
}


function haulCandidate(state: GameState, rig: VehicleState, dest: AreaId): VehicleState | null {
  if (onHaulRoad(rig.x, rig.z) || areaOf(rig.x) === dest) return null;
  const loadedIds = (state.deck ?? []).map((id) => state.vehicles.find((o) => o.uid === id)?.defId ?? "");
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (let i = 0; i < state.vehicles.length; i++) {
    const o = state.vehicles[i];
    if (o === rig || o.defId === "lowboy" || o.defId === "crusher") continue;
    if (!state.watching && i === state.active) continue;
    if ((state.deck ?? []).includes(o.uid)) continue;
    if (o.cargo > 0.05 || Math.abs(o.speed) > 0.5) continue;
    if (areaOf(o.x) !== areaOf(rig.x)) continue;
    if (orderArea(state, o) !== dest) continue;
    if (deckFit(loadedIds, o.defId) !== "") continue;
    const d = distTo(rig.x, rig.z, o.x, o.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}


export function lowboyDrive(state: GameState, v: VehicleState): Control {
  if (!state.deck) state.deck = [];
  const cargo = state.deck
    .map((id) => state.vehicles.find((o) => o.uid === id))
    .filter((o): o is VehicleState => !!o);
  const dest = lowboyDest(v) ?? (cargo[0] ? orderArea(state, cargo[0]) : null);
  const more = dest ? haulCandidate(state, v, dest) : null;
  if (more && dest) {
    if (distTo(v.x, v.z, more.x, more.z) < 9 && Math.abs(v.speed) < 2) {
      more.speed = 0;
      state.deck.push(more.uid);
      bindDeck(state);
      snapDeck(state);
      v.status = `${DEFS[more.defId].name} is on the deck`;
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    v.status = `Picking up ${DEFS[more.defId].name} for ${areaName(dest)}`;
    const aim = lowboyAim(v, more.x, more.z);
    return seek(v, aim.x, aim.z, 5);
  }
  if (cargo.length) {
    const targetDest = dest ?? areaOf(v.x);
    const pad = yardPad(targetDest);
    const home = areaOf(v.x) === targetDest && v.z < 78 && distTo(v.x, v.z, pad.x, pad.z) < 20 && !onHaulRoad(v.x, v.z);
    if (home) {
      v.status = uncouple(state, v) || `Dropped the ${DEFS[cargo[0].defId].name}`;
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    v.status = `Hauling to ${areaName(targetDest)}`;
    const aim = lowboyAim(v, pad.x, pad.z);
    return seek(v, aim.x, aim.z, 6);
  }
  if (!dest) {
    v.status = "Pick a map to haul to.";
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  const pad = yardPad(dest);
  const there = areaOf(v.x) === dest && v.z < 78 && distTo(v.x, v.z, pad.x, pad.z) < 18 && !onHaulRoad(v.x, v.z);
  if (there) {
    v.status = `Waiting at ${areaName(dest)}`;
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  v.status = `Heading to ${areaName(dest)}`;
  const aim = lowboyAim(v, pad.x, pad.z);
  return seek(v, aim.x, aim.z, 6);
}


export function fuelPoint(v: VehicleState, bay: { x: number; z: number }) {
  // On the high mountain road, follow the gravel down to camp instead of cutting across the slope.
  if (v.x < MOUNTAIN_GATE_X || v.z < 70) return bay;
  if (v.x < X1 - 48) return { x: Math.min(v.x + 90, X1 - 40), z: 96 };
  return { x: X1 - 36, z: 58 };
}

/** The nearest idle dozer, or else loader, clears a rockslide. A pinned face stays on the dig. */

/** What is actually against the nose. A slow turn in the open is not a wall. */
export function noseBlocked(state: GameState, v: VehicleState): "" | "wall" | "pile" {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const r = vehicleStats(v).radius;
  const ax = v.x + fx * r * 0.85;
  const az = v.z + fz * r * 0.85;
  for (const b of BLOCKS) {
    if (b.kind === "water") continue;
    if (Math.abs(ax - b.x) <= b.sx / 2 + 0.35 && Math.abs(az - b.z) <= b.sz / 2 + 0.35) return "wall";
  }
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.tons < 0.4 || d.id.startsWith("feed-")) continue;
    const foot = pileFootprint(d.tons);
    const dx = ax - d.x;
    const dz = az - d.z;
    const n = (dx * dx) / (foot.rx * foot.rx) + (dz * dz) / (foot.rz * foot.rz);
    if (n < 0.9) return "pile";
  }
  return "";
}


export function integrateTank(v: VehicleState, left: number, right: number, dt: number, drag: number) {
  const st = vehicleStats(v);
  const m = tankMotion(left, right);
  // Tracks hold on a grade (no roll-back) but climb slower.
  const climb = climbFactor(gradeAt(v.x, v.z, v.yaw).along, m.forward >= 0);
  const target = (m.forward >= 0 ? m.forward : m.forward * 0.6) * st.maxSpeed * drag * climb;
  const opposing = Math.sign(target) !== Math.sign(v.speed) && Math.abs(v.speed) > 0.25;
  const accel = st.accel * (opposing ? 1.75 : 1);
  if (v.speed < target) v.speed = Math.min(target, v.speed + accel * dt);
  else v.speed = Math.max(target, v.speed - accel * dt);
  if (Math.abs(v.speed) < 0.05 && Math.abs(m.forward) < 0.05) v.speed = 0;
  // Same as the wheeled machines: stick-left still goes left on screen while backing up.
  const reverse = v.speed >= -0.2 ? 1 : -1;
  v.yaw += m.turn * st.turn * 1.1 * reverse * dt;
  v.x += -Math.sin(v.yaw) * v.speed * dt;
  v.z += -Math.cos(v.yaw) * v.speed * dt;
}


export function integrate(v: VehicleState, c: Control, dt: number) {
  const st = vehicleStats(v);
  const drive = clamp(c.throttle, -1, 1);
  const steer = clamp(c.steer, -1, 1);
  const grade = gradeAt(v.x, v.z, v.yaw);
  const climb = climbFactor(grade.along, drive >= 0);
  const target = (drive >= 0 ? drive * st.maxSpeed : drive * st.maxSpeed * 0.45) * climb;
  const opposing = Math.sign(target) !== Math.sign(v.speed) && Math.abs(v.speed) > 0.25;
  // A dump truck used to coast the length of the bridge after the stick was let go.
  const hauler = v.defId === "truck" || v.defId === "heavy";
  const stopping = c.brake > 0.5 || (hauler && Math.abs(drive) < 0.05);
  // Coasting (no pedal, no brake) on a grade only has rolling drag, so gravity can win.
  const coasting = !stopping && Math.abs(drive) < 0.05 && Math.abs(grade.along) > 0.03;
  const accel = coasting ? 0.3 : st.accel * (opposing || stopping ? (hauler && stopping ? 4 : 1.75) : 1);
  if (v.speed < target) v.speed = Math.min(target, v.speed + accel * dt);
  else v.speed = Math.max(target, v.speed - accel * dt);
  // Slopes: gravity pulls the machine down the grade. Brakes (or a hauler's
  // retarder when the pedal is up) hold it once it's nearly stopped.
  if (Math.abs(grade.along) > 0.03) {
    const holding = stopping && Math.abs(v.speed) < 1.2;
    if (holding) v.speed *= 0.5;
    else v.speed += rollAccel(grade.along) * dt;
  }
  if (Math.abs(v.speed) < 0.05 && Math.abs(drive) < 0.05 && Math.abs(grade.along) <= 0.03) v.speed = 0;
  const reverse = v.speed >= -0.2 ? 1 : -1;
  const factor = Math.min(1, Math.abs(v.speed) / 3.5);
  v.yaw += steer * st.turn * Math.max(0.42, factor) * reverse * dt;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  v.x += fx * v.speed * dt;
  v.z += fz * v.speed * dt;
}


let deckUids = new Set<string>();


export function bindDeck(state: GameState) {
  deckUids = new Set(state.deck ?? []);
}


export function aboard(v: VehicleState) {
  return deckUids.has(v.uid);
}


function clampLowboy(v: VehicleState) {
  if (onHaulRoad(v.x, v.z)) return;
  if (v.z > 64 && v.x > 20 && v.x < 980) {
    v.z = Math.max(88, Math.min(104, v.z));
    v.speed *= 0.5;
  }
}


export function resolveCircle(state: GameState, v: VehicleState, radius: number) {
  for (const b of BLOCKS) {
    // A machine whose middle is on the deck overhangs the water. Don't shove it back into a crawl.
    if (b.kind === "water" && (onBridge(v.x, v.z) || bridgeLane(v.x, v.z))) continue;
    const hx = b.sx / 2;
    const hz = b.sz / 2;
    const minX = b.x - hx;
    const maxX = b.x + hx;
    const minZ = b.z - hz;
    const maxZ = b.z + hz;
    const cx = clamp(v.x, minX, maxX);
    const cz = clamp(v.z, minZ, maxZ);
    const dx = v.x - cx;
    const dz = v.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;
    if (d2 < 1e-8) {
      const pl = v.x - minX;
      const pr = maxX - v.x;
      const pd = v.z - minZ;
      const pu = maxZ - v.z;
      const m = Math.min(pl, pr, pd, pu);
      if (m === pl) v.x = minX - radius;
      else if (m === pr) v.x = maxX + radius;
      else if (m === pd) v.z = minZ - radius;
      else v.z = maxZ + radius;
      v.speed *= 0.35;
      continue;
    }
    const d = Math.sqrt(d2);
    const push = (radius - d) / d;
    v.x += dx * push;
    v.z += dz * push;
    // Slide along the wall: only the part of the motion pointed into it is lost.
    const nx = dx / d;
    const nz = dz / d;
    const into = (-Math.sin(v.yaw) * nx - Math.cos(v.yaw) * nz) * Math.sign(v.speed);
    if (into < -0.7) {
      v.speed *= 0.82;
      // Head-on into a bench wall. Creep toward that wall's gap instead of sitting until unstick.
      if (b.id.startsWith("bench-")) {
        const gapX = b.id.endsWith("-w") ? b.x + hx : b.x - hx;
        const toward = Math.sign(gapX - v.x) || 1;
        const want = toward > 0 ? -Math.PI / 2 : Math.PI / 2;
        let dy = want - v.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        v.yaw += Math.max(-0.12, Math.min(0.12, dy));
      }
    } else if (into < 0) {
      // Glancing contact: keep rolling and ease the nose round to run along the wall.
      v.speed *= 0.995;
      const tx = -nz;
      const tz = nx;
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      const side = fx * tx + fz * tz >= 0 ? 1 : -1;
      const want = Math.atan2(-tx * side, -tz * side);
      let dy = want - v.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      v.yaw += Math.max(-0.02, Math.min(0.02, dy));
    }
  }
  if (aboard(v)) return;
  if (onMountainRoad(v.x, v.z) && !mountainOpen(state)) {
    v.x = X0 + 40;
    v.z = 40;
    v.speed = 0;
    v.status = "Lease the High mountain to open this road";
    return;
  }
  if (onMountainRoad(v.x, v.z) && v.defId !== "lowboy" && v.x < MOUNTAIN_GATE_X) {
    // The old spot was inside the valley camp shed, so the claim truck sat there backing off a wall.
    v.x = X0 + 40;
    v.z = 40;
    v.speed = 0;
    v.status = "The mountain road is for the lowboy";
    return;
  }
  if (v.defId === "lowboy" && (onHaulRoad(v.x, v.z) || (v.x > X1 - 70 && v.x < X1 + 10 && v.z > 48))) {
    clampLowboy(v);
    return;
  }
  if (blockRoadGate(v.defId, v.x, v.z)) {
    v.z = Math.min(v.z, v.x > 500 ? 78 : 63);
    v.speed = 0;
    v.status = "The north road is for the lowboy";
    return;
  }
  const padR = radius + 0.4;
  const BOUNDS = boundsFor(v.x);
  if (v.x < BOUNDS.minX + padR) {
    v.x = BOUNDS.minX + padR;
    v.speed *= 0.4;
  } else if (v.x > BOUNDS.maxX - padR) {
    v.x = BOUNDS.maxX - padR;
    v.speed *= 0.4;
  }
  if (v.z < BOUNDS.minZ + padR) {
    v.z = BOUNDS.minZ + padR;
    v.speed *= 0.4;
  } else if (v.z > BOUNDS.maxZ - padR) {
    v.z = BOUNDS.maxZ - padR;
    v.speed *= 0.4;
  }
}

/** Keep machines out of the heart of a loose pile. The toe stays soft so a bucket can still reach it. */

/** Keep machines out of the heart of a loose pile. The toe stays soft so a bucket can still reach it. */
export function holdPiles(state: GameState, v: VehicleState) {
  if (aboard(v)) return;
  const body = vehicleStats(v).radius * 0.45;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.tons < 0.4 || d.id.startsWith("feed-")) continue;
    const foot = pileFootprint(d.tons);
    const rx = foot.rx + body;
    const rz = foot.rz + body;
    const dx = v.x - d.x;
    const dz = v.z - d.z;
    const n = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
    if (n >= 1) continue;
    const scale = 1 / Math.sqrt(Math.max(n, 1e-6));
    v.x = d.x + dx * scale;
    v.z = d.z + dz * scale;
    v.speed *= 0.45;
  }
}

/** Keep a machine on the planks while it crosses, instead of letting the body rub the river. */

/** Keep a machine on the planks while it crosses, instead of letting the body rub the river. */
export function holdDeck(v: VehicleState) {
  if (areaOf(v.x) !== "river") return;
  if (!bridgeLane(v.x, v.z)) return;
  const room = Math.max(0.7, BRIDGE.halfWidth - vehicleStats(v).radius - 0.45);
  const dz = v.z - BRIDGE.z;
  if (Math.abs(dz) <= room) return;
  const edge = BRIDGE.z + Math.sign(dz) * room;
  v.z += (edge - v.z) * 0.22;
}


const bridgeNag = new WeakMap<VehicleState, number>();

/** Weight the bridge scale sees: the machine, its load, and anything strapped to the lowboy's deck. */

/** Weight the bridge scale sees: the machine, its load, and anything strapped to the lowboy's deck. */
export function crossingWeight(state: GameState, v: VehicleState) {
  let t = grossTons(v.defId, v.cargo);
  if (v.defId === "lowboy") {
    for (const uid of state.deck ?? []) {
      const m = state.vehicles.find((o) => o.uid === uid);
      if (m) t += MACHINE_TONS[m.defId] ?? 10;
    }
  }
  return t;
}

/** Overweight machines are held on the bank. Snapping them every frame was the dance at the lip. */

/** Overweight machines are held on the bank. Snapping them every frame was the dance at the lip. */
export function guardBridge(state: GameState, v: VehicleState, index: number) {
  if (areaOf(v.x) !== "river") return;
  const tons = crossingWeight(state, v);
  const flooded = Ops.bridgeClosed(state);
  if (tons <= BRIDGE.limit && !flooded) return;
  const side = Math.sign(v.x - BRIDGE.x) || 1;
  const near =
    Math.abs(v.x - BRIDGE.x) <= BRIDGE.halfLength + 3 && Math.abs(v.z - BRIDGE.z) <= BRIDGE.halfWidth + 2;
  if (!near) return;
  // Already committed to the middle (a load landed in the bed): let it finish.
  if (Math.abs(v.x - BRIDGE.x) < BRIDGE.halfLength - 4) return;
  const vx = -Math.sin(v.yaw) * v.speed;
  if (vx * side < 0) v.speed = 0;
  if (onBridge(v.x, v.z)) v.x = BRIDGE.x + side * (BRIDGE.halfLength + 1.2);
  v.status = flooded ? "Bridge flooded" : "Too heavy for the bridge";
  const now = state.seconds;
  if (now - (bridgeNag.get(v) ?? -99) > 4) {
    bridgeNag.set(v, now);
    const msg = flooded
      ? `The bridge is flooded. ${Ops.bridgeClock(state)}. Work this bank until it opens.`
      : v.defId === "lowboy"
        ? `Bridge limit ${BRIDGE.limit} tons. The lowboy weighs ${tons.toFixed(0)} tons with the deck loaded. The deck counts on the scale — take the north road.`
        : `Bridge limit ${BRIDGE.limit} tons. ${DEFS[v.defId].name} weighs ${tons.toFixed(0)} tons loaded. Carry ${bridgeMaxLoad(v.defId).toFixed(0)} tons or less.`;
    if (!state.watching && index === state.active) log(state, msg);
  }
}


export function resolveVehicles(state: GameState) {
  const list = state.vehicles;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (aboard(a) || aboard(b)) continue;
      const ra = vehicleStats(a).radius;
      const rb = vehicleStats(b).radius;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      const min = ra + rb * 0.92;
      if (d >= min) continue;
      if (d < 1e-4) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      const push = (min - d) / 2;
      const nx = dx / d;
      const nz = dz / d;
      const aPlayer = i === state.active && !state.watching;
      const bPlayer = j === state.active && !state.watching;
      const aShare = aPlayer ? 0.12 : bPlayer ? 0.88 : 0.5;
      a.x -= nx * push * 2 * aShare;
      a.z -= nz * push * 2 * aShare;
      b.x += nx * push * 2 * (1 - aShare);
      b.z += nz * push * 2 * (1 - aShare);
    }
  }
}


export function hitsBlock(x: number, z: number, radius: number) {
  for (const b of BLOCKS) {
    const cx = clamp(x, b.x - b.sx / 2, b.x + b.sx / 2);
    const cz = clamp(z, b.z - b.sz / 2, b.z + b.sz / 2);
    if ((x - cx) ** 2 + (z - cz) ** 2 < radius * radius) return true;
  }
  return inRiver(x, z);
}


export function pointBlocked(x: number, z: number, radius: number, avoidBridge = false) {
  if (inRiver(x, z)) return true;
  if (avoidBridge && onBridge(x, z)) return true;
  for (const b of BLOCKS) {
    const hx = b.sx / 2;
    const hz = b.sz / 2;
    const cx = clamp(x, b.x - hx, b.x + hx);
    const cz = clamp(z, b.z - hz, b.z + hz);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  const bounds = boundsFor(x);
  return x < bounds.minX + radius || x > bounds.maxX - radius || z < bounds.minZ + radius || z > bounds.maxZ - radius;
}


export function segmentClear(x0: number, z0: number, x1: number, z1: number, radius: number) {
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    if (pointBlocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, radius)) return false;
  }
  return true;
}

/** A point outside the blast, on the same bank, that does not sit in the river or a wall. */

/** Why the active machine can't go on the lowboy right now, or "" if it can. */
/** Circles along the trailer deck, behind the fifth wheel. */
export function trailerCircles(rig: VehicleState, trailerYaw = rig.trailerYaw ?? rig.yaw) {
  const hx = rig.x + Math.sin(rig.yaw) * HITCH_Z;
  const hz = rig.z + Math.cos(rig.yaw) * HITCH_Z;
  return [2.2, 4.6, 7.0].map((d) => ({ x: hx + Math.sin(trailerYaw) * d, z: hz + Math.cos(trailerYaw) * d, r: 1.35 }));
}

/** The deck is solid: parked machines get shoved off it, and walls stop the rig. */

/** The deck is solid: parked machines get shoved off it, and walls stop the rig. */
export function trailerCollide(state: GameState, rig: VehicleState, prev: { x: number; z: number; yaw: number }) {
  const ty = stepHitch(rig.x, rig.z, rig.yaw, rig.axleX, rig.axleZ).trailerYaw;
  const circles = trailerCircles(rig, ty);
  const was = { ...rig, x: prev.x, z: prev.z, yaw: prev.yaw };
  const wasBlocked = trailerCircles(was).some((c) => hitsBlock(c.x, c.z, c.r));
  if (!wasBlocked && circles.some((c) => hitsBlock(c.x, c.z, c.r))) {
    rig.x = prev.x;
    rig.z = prev.z;
    rig.yaw = prev.yaw;
    rig.speed = 0;
    return;
  }
  for (const o of state.vehicles) {
    if (o === rig || aboard(o)) continue;
    const r = vehicleStats(o).radius;
    for (const c of circles) {
      const dx = o.x - c.x;
      const dz = o.z - c.z;
      const d = Math.hypot(dx, dz) || 1e-3;
      const min = r + c.r;
      if (d >= min) continue;
      o.x = c.x + (dx / d) * min;
      o.z = c.z + (dz / d) * min;
      o.speed *= 0.3;
    }
  }
}


export function snapDeck(state: GameState) {
  const rig = state.vehicles.find((v) => v.defId === "lowboy");
  if (!rig) return;
  const hitch = stepHitch(rig.x, rig.z, rig.yaw, rig.axleX, rig.axleZ);
  rig.trailerYaw = hitch.trailerYaw;
  rig.axleX = hitch.axleX;
  rig.axleZ = hitch.axleZ;
  const ty = hitch.trailerYaw;
  const backX = Math.sin(ty);
  const backZ = Math.cos(ty);
  const hx = rig.x + Math.sin(rig.yaw) * HITCH_Z;
  const hz = rig.z + Math.cos(rig.yaw) * HITCH_Z;
  const two = state.deck.length > 1;
  state.deck.forEach((uid, i) => {
    const m = state.vehicles.find((v) => v.uid === uid);
    if (!m) return;
    // Two machines sit nose-to-tail; a lone machine rides over the axles.
    const along = two ? (i === 0 ? 3.0 : 6.3) : 4.6;
    m.x = hx + backX * along;
    m.z = hz + backZ * along;
    // Machines are backed onto the lowboy, so they face the trailer ramps.
    m.yaw = ty + Math.PI;
    m.speed = 0;
    m.status = "On the lowboy";
  });
}
