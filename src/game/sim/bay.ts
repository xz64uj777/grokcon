/** Loading-zone spots, lining up, and parking in pour reach. */

import { DEFS, GATE, PADS, boundsFor } from "@/game/catalog";
import { areaOf, otherBank, RIVER } from "@/game/river";
import { isPlantKind, isPlanDigger } from "@/game/crew-plan";
import type { Deposit, GameState, VehicleState } from "@/game/types";
import type { Control } from "./types.ts";
import { clamp, distTo, gateFor, handsOn, hypot, livePads, ownsClaim, padOpen, sameArea } from "./world.ts";
import { bestPile, driveFace, pileApproach, pileInReach, slotOf } from "./jobs.ts";
import { diggerForTruck, fillsHaulers, lineFor, pourReach, truckLeaving, truckPartner, wheelLoader } from "./haulers.ts";
import { crewSeen, pointBlocked, seek } from "./motion.ts";
import { peekCrewJob, plannedDeposit } from "./crew.ts";
import { step } from "./tick.ts";

/** An empty truck or heavy yields the bay if its digger is not about to fill it. */
export const BAY_YIELD_SECONDS = 20;

export const BAY_YIELD_BUSY_SECONDS = 45;

export const bayReady = new WeakSet<VehicleState>();

export const bayCommit = new WeakSet<VehicleState>();

/**
 * A loading zone is two or three open parking spots beside the face the
 * digger is on. It stays put while that face is worked, and is rebuilt
 * when the digger moves on to a different face.
 */

/**
 * A loading zone is two or three open parking spots beside the face the
 * digger is on. It stays put while that face is worked, and is rebuilt
 * when the digger moves on to a different face.
 */
type BaySpot = { x: number; z: number };

type LoadZone = {
  gen: number;
  sourceId: string;
  ax: number;
  az: number;
  standX: number;
  standZ: number;
  keepX: number;
  keepZ: number;
  spots: BaySpot[];
};


const diggerZone = new WeakMap<VehicleState, LoadZone>();

export const truckSpot = new WeakMap<VehicleState, { gen: number; index: number }>();


const ZONE_HOLD = 20;

const KEEP_CLEAR = 16;

const SPOT_GAP = 13;


function workAnchor(state: GameState, digger: VehicleState) {
  const planned = plannedDeposit(state, digger);
  if (planned && planned.tons > 0.2) {
    if (planned.kind === "pile") {
      const spot = pileApproach(state, digger, planned);
      return { id: planned.id, standX: spot.x, standZ: spot.z, keepX: planned.x, keepZ: planned.z };
    }
    const face = wheelLoader(digger.defId) ? loaderStand(digger, planned) : driveFace(planned);
    return { id: planned.id, standX: face.x, standZ: face.z, keepX: planned.x, keepZ: planned.z };
  }
  const def = DEFS[digger.defId];
  if (def.scoop > 0) {
    const pile = (digger.cargo > 0.15 && digger.cargoOre ? pileInReach(state, digger) : null) ?? bestPile(state, digger);
    if (pile) {
      const spot = pileApproach(state, digger, pile);
      return { id: pile.id, standX: spot.x, standZ: spot.z, keepX: pile.x, keepZ: pile.z };
    }
  }
  if (def.dig > 0 || def.scoop > 0) {
    // The face under the machine, not the next one it might drive to.
    const ore = digger.cargo > 0.15 ? digger.cargoOre : null;
    let vein: Deposit | null = null;
    let bestD = 28;
    for (const d of state.deposits) {
      if (d.kind !== "vein" || d.tons < 0.5) continue;
      if (!ownsClaim(state, d.claim)) continue;
      if (!sameArea(d, digger)) continue;
      if (ore && d.ore !== ore) continue;
      const dist = distTo(digger.x, digger.z, d.x, d.z);
      if (dist < bestD) {
        bestD = dist;
        vein = d;
      }
    }
    if (vein) {
      const face = wheelLoader(digger.defId) ? loaderStand(digger, vein) : driveFace(vein);
      return { id: vein.id, standX: face.x, standZ: face.z, keepX: vein.x, keepZ: vein.z };
    }
  }
  return { id: `at:${digger.uid}`, standX: digger.x, standZ: digger.z, keepX: digger.x, keepZ: digger.z };
}

/** Too close to the map fence to wait or park. */

/** Too close to the map fence to wait or park. */
function nearFence(x: number, z: number) {
  const b = boundsFor(x);
  return x < b.minX + 14 || x > b.maxX - 14 || z < b.minZ + 14 || z > b.maxZ - 14;
}

/** Ridge ground a truck may wait on: the pit, the yard, or the gold creek road — never the fence strips. */

/** Ridge ground a truck may wait on: the pit, the yard, or the gold creek road — never the fence strips. */
function ridgeParkOk(x: number, z: number) {
  if (areaOf(x) !== "ridge") return !nearFence(x, z);
  if (nearFence(x, z)) return false;
  if (z < -50) return false;
  if (x > 42 && z < 8) return false;
  if (x < -82 || (x < -52 && z < 14)) return false;
  return true;
}

/** Open ground a truck can park on: off the pile, off the river, inside the fence. */

/** Open ground a truck can park on: off the pile, off the river, inside the fence. */
export function spotOpen(x: number, z: number, standX: number, standZ: number, keepX: number, keepZ: number, pour: number) {
  if (Math.hypot(x - keepX, z - keepZ) < KEEP_CLEAR) return false;
  const fromStand = Math.hypot(x - standX, z - standZ);
  if (fromStand < 8 || fromStand > pour) return false;
  if (!ridgeParkOk(x, z)) return false;
  if (areaOf(standX) === "river") {
    if (otherBank(x, standX)) return false;
    if (Math.abs(x - RIVER.x) < RIVER.halfWidth + 6) return false;
  }
  for (const pad of PADS) {
    if (Math.hypot(x - pad.x, z - pad.z) < pad.r + 6) return false;
  }
  return !pointBlocked(x, z, 3.4);
}


function buildSpots(standX: number, standZ: number, keepX: number, keepZ: number, pour: number): BaySpot[] {
  let prefer = Math.atan2(standZ - keepZ, standX - keepX);
  if (!Number.isFinite(prefer)) prefer = 0;
  if (areaOf(standX) === "river") {
    const bank = Math.sign(standX - RIVER.x) || 1;
    if (bank * Math.cos(prefer) < 0.2) prefer = Math.atan2(Math.sin(prefer), bank * 0.45);
  }
  const found: { x: number; z: number; score: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const ang = prefer + (i / 24) * Math.PI * 2;
    const turn = Math.abs(Math.atan2(Math.sin(ang - prefer), Math.cos(ang - prefer)));
    for (const r of [14, 16, 12, 18, 20]) {
      if (r > pour) continue;
      const x = standX + Math.cos(ang) * r;
      const z = standZ + Math.sin(ang) * r;
      if (!spotOpen(x, z, standX, standZ, keepX, keepZ, pour)) continue;
      found.push({ x, z, score: turn * 8 + r * 0.04 });
      break;
    }
  }
  found.sort((a, b) => a.score - b.score);
  const picked: BaySpot[] = [];
  for (const c of found) {
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < SPOT_GAP)) continue;
    picked.push({ x: c.x, z: c.z });
    if (picked.length >= 3) break;
  }
  if (picked.length > 0) return picked;
  let best: BaySpot | null = null;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2;
    for (let r = KEEP_CLEAR; r <= 36; r += 2) {
      const x = keepX + Math.cos(ang) * r;
      const z = keepZ + Math.sin(ang) * r;
      if (!ridgeParkOk(x, z)) continue;
      if (areaOf(standX) === "river" && otherBank(x, standX)) continue;
      if (pointBlocked(x, z, 3.2)) continue;
      const d = Math.hypot(x - standX, z - standZ);
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
      break;
    }
  }
  if (best) return [best];
  const gate = gateFor(standX);
  const ang = Math.atan2(gate.z - standZ, gate.x - standX);
  for (const r of [KEEP_CLEAR, 20, 24, 12]) {
    const x = standX + Math.cos(ang) * r;
    const z = standZ + Math.sin(ang) * r;
    if (!ridgeParkOk(x, z) || pointBlocked(x, z, 3.2)) continue;
    if (areaOf(standX) === "river" && otherBank(x, standX)) continue;
    return [{ x, z }];
  }
  const yard = areaOf(standX) === "ridge" ? { x: GATE.x, z: Math.max(GATE.z, 28) } : { x: standX, z: standZ };
  return [ridgeParkOk(yard.x, yard.z) ? yard : { x: standX, z: standZ }];
}

/** A wheel loader stands on the open side of a face, where a truck can pull in beside it. */

/** A wheel loader stands on the open side of a face, where a truck can pull in beside it. */
export const standLatch = new WeakMap<VehicleState, { id: string; x: number; z: number }>();


export function loaderStand(v: VehicleState, vein: Deposit) {
  const prev = standLatch.get(v);
  if (prev && prev.id === vein.id && !pointBlocked(prev.x, prev.z, 2)) return { x: prev.x, z: prev.z, reach: 3.6 };
  const ring = vein.radius + (v.defId === "hloader" ? 3.4 : 2.6);
  const bank = areaOf(vein.x) === "river" ? Math.sign(vein.x - RIVER.x) || 1 : 0;
  const shift = ((slotOf(v) % 5) - 2) * 0.42;
  let bestX = vein.x + (bank || 1) * ring;
  let bestZ = vein.z;
  let bestS = -Infinity;
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2 + shift;
    const x = vein.x + Math.cos(ang) * ring;
    const z = vein.z + Math.sin(ang) * ring;
    if (pointBlocked(x, z, 2.2)) continue;
    if (areaOf(vein.x) === "river" && otherBank(x, vein.x)) continue;
    if (areaOf(vein.x) === "ridge" && (x < -82 || z < -48 || (x < -52 && z < 14))) continue;
    const pocketX = vein.x + Math.cos(ang) * (ring + 13);
    const pocketZ = vein.z + Math.sin(ang) * (ring + 13);
    const pocket = spotOpen(pocketX, pocketZ, x, z, vein.x, vein.z, 26);
    let score = pocket ? 100 : -30;
    if (bank !== 0) score += Math.cos(ang) * bank * 28;
    for (const pad of PADS) {
      if (Math.hypot(x - pad.x, z - pad.z) < pad.r + 8) score -= 70;
      if (Math.hypot(pocketX - pad.x, pocketZ - pad.z) < pad.r + 8) score -= 40;
    }
    if (score > bestS) {
      bestS = score;
      bestX = x;
      bestZ = z;
    }
  }
  standLatch.set(v, { id: vein.id, x: bestX, z: bestZ });
  return { x: bestX, z: bestZ, reach: 3.6 };
}


export function jobStand(v: VehicleState, vein: Deposit) {
  return wheelLoader(v.defId) ? loaderStand(v, vein) : driveFace(vein);
}


export function loadingZone(state: GameState, digger: VehicleState): LoadZone {
  const a = workAnchor(state, digger);
  const prev = diggerZone.get(digger);
  // DRAFT: a digger that has settled on another face out of pour reach takes its bay with it.
  const leftZone = !!prev && Math.abs(digger.speed) < 0.5 && distTo(digger.x, digger.z, prev.standX, prev.standZ) > pourReach(digger.defId);
  if (prev && prev.spots.length > 0 && !leftZone) {
    const drifted = Math.hypot(prev.ax - a.standX, prev.az - a.standZ);
    if (drifted < ZONE_HOLD) return prev;
    // The spots belong to this face while it still has ore. They move when
    // the digger sets up on the next one.
    const still = state.deposits.find((d) => d.id === prev.sourceId);
    if (still && still.tons > 1) return prev;
    if (distTo(digger.x, digger.z, a.standX, a.standZ) > 14) return prev;
  }
  const pour = digger.defId === "excavator" || digger.defId === "hloader" ? 24 : 20;
  const zone: LoadZone = {
    gen: (prev?.gen ?? 0) + 1,
    sourceId: a.id,
    ax: a.standX,
    az: a.standZ,
    standX: a.standX,
    standZ: a.standZ,
    keepX: a.keepX,
    keepZ: a.keepZ,
    spots: buildSpots(a.standX, a.standZ, a.keepX, a.keepZ, pour),
  };
  diggerZone.set(digger, zone);
  return zone;
}

/** How close the straight path comes to the material. */

/** How close the straight path comes to the material. */
function chordGap(x0: number, z0: number, x1: number, z1: number, kx: number, kz: number) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1) return Math.hypot(x0 - kx, z0 - kz);
  let t = ((kx - x0) * dx + (kz - z0) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x0 + dx * t - kx, z0 + dz * t - kz);
}

/** A parking spot on the truck's own side of the face, when the shared spots are across the pile. */

/** A parking spot on the truck's own side of the face, when the shared spots are across the pile. */
function sideSpot(v: VehicleState, zone: LoadZone, pour: number): BaySpot | null {
  const ang = Math.atan2(v.z - zone.keepZ, v.x - zone.keepX);
  for (const r of [16, 18, 14, 20, 22]) {
    const x = zone.keepX + Math.cos(ang) * r;
    const z = zone.keepZ + Math.sin(ang) * r;
    if (!spotOpen(x, z, zone.standX, zone.standZ, zone.keepX, zone.keepZ, pour)) continue;
    if (chordGap(v.x, v.z, x, z, zone.keepX, zone.keepZ) < 12.5) continue;
    return { x, z };
  }
  return null;
}

/** A farther open pocket a heavy haul can actually reach at a tight shared face. */

/** A farther open pocket a heavy haul can actually reach at a tight shared face. */
function heavyOpenSpot(v: VehicleState, zone: LoadZone, pour: number): BaySpot | null {
  const reach = Math.max(pour, 28);
  const openAng = Math.atan2(zone.standZ - zone.keepZ, zone.standX - zone.keepX);
  const approach = Math.atan2(v.z - zone.keepZ, v.x - zone.keepX);
  const angs = [openAng, approach];
  for (let i = 1; i <= 8; i++) {
    const step = (i / 8) * 0.9;
    angs.push(openAng + step, openAng - step, approach + step, approach - step);
  }
  for (const ang of angs) {
    for (const r of [22, 24, 20, 26, 18]) {
      if (r > reach) continue;
      const x = zone.keepX + Math.cos(ang) * r;
      const z = zone.keepZ + Math.sin(ang) * r;
      if (!spotOpen(x, z, zone.standX, zone.standZ, zone.keepX, zone.keepZ, reach)) continue;
      if (chordGap(v.x, v.z, x, z, zone.keepX, zone.keepZ) < 12.5) continue;
      if (distTo(x, z, zone.standX, zone.standZ) > reach) continue;
      return { x, z };
    }
  }
  return null;
}

/** The truck's own spot in the digger's zone. Latched until the zone moves. */

/** The truck's own spot in the digger's zone. Latched until the zone moves. */
export function spotForTruck(state: GameState, v: VehicleState, digger: VehicleState, place: number): BaySpot {
  const zone = loadingZone(state, digger);
  const spots = zone.spots;
  const used = new Set<number>();
  for (const t of lineFor(state, digger)) {
    if (t === v) continue;
    const hold = truckSpot.get(t);
    if (hold && hold.gen === zone.gen && hold.index < spots.length) used.add(hold.index);
  }
  // Another digger's truck parked on a spot holds it too.
  for (const t of state.vehicles) {
    if (t === v || !DEFS[t.defId].receives || !bayCommit.has(t) || truckPartner.get(t) === digger.uid) continue;
    spots.forEach((s, i) => {
      if (Math.hypot(s.x - t.x, s.z - t.z) < 7) used.add(i);
    });
  }
  const hold = truckSpot.get(v);
  if (hold && hold.gen === zone.gen && hold.index < spots.length && !used.has(hold.index)) return spots[hold.index]!;
  let bestI = 0;
  let bestS = Infinity;
  const scoreOf = (i: number) => {
    const s = spots[i]!;
    return place === 0 ? Math.hypot(s.x - zone.standX, s.z - zone.standZ) : Math.hypot(s.x - v.x, s.z - v.z);
  };
  for (let i = 0; i < spots.length; i++) {
    if (used.has(i)) continue;
    const score = scoreOf(i);
    if (score < bestS) {
      bestS = score;
      bestI = i;
    }
  }
  if (bestS === Infinity) {
    for (let i = 0; i < spots.length; i++) {
      const score = scoreOf(i);
      if (score < bestS) {
        bestS = score;
        bestI = i;
      }
    }
  }
  const chosen = spots[bestI]!;
  if (chordGap(v.x, v.z, chosen.x, chosen.z, zone.keepX, zone.keepZ) < 10) {
    let alt = -1;
    let altD = Infinity;
    for (let i = 0; i < spots.length; i++) {
      if (used.has(i)) continue;
      const s = spots[i]!;
      if (chordGap(v.x, v.z, s.x, s.z, zone.keepX, zone.keepZ) < 12.5) continue;
      const d = Math.hypot(s.x - v.x, s.z - v.z);
      if (d < altD) {
        altD = d;
        alt = i;
      }
    }
    if (alt >= 0) bestI = alt;
    else {
      const pour = digger.defId === "hloader" ? 30 : digger.defId === "excavator" ? 28 : 26;
      const extra = sideSpot(v, zone, pour);
      if (extra) {
        spots.push(extra);
        bestI = spots.length - 1;
      }
    }
  }
  // Only swap in a farther pocket when another digger is already on this face,
  // which is what pins a heavy haul at a tight rim. A lone loader's regular
  // spots must keep the outward gap the pile-queue test checks.
  if (v.defId === "heavy" && place === 0) {
    const crowded = state.vehicles.some(
      (o) =>
        o !== digger &&
        fillsHaulers(o.defId) &&
        (o.operator || handsOn(state, o)) &&
        distTo(o.x, o.z, zone.keepX, zone.keepZ) < 36,
    );
    if (crowded) {
      const pour = digger.defId === "hloader" ? 30 : digger.defId === "excavator" ? 28 : 26;
      const extra = heavyOpenSpot(v, zone, pour);
      if (extra) {
        spots.push(extra);
        bestI = spots.length - 1;
      }
    }
  }
  truckSpot.set(v, { gen: zone.gen, index: bestI });
  return spots[bestI]!;
}


/** A hired digger on this yard the truck can wait beside, even if that bucket is not ready to load. */

/** A hired digger on this yard the truck can wait beside, even if that bucket is not ready to load. */
function hiredDiggerNearby(state: GameState, v: VehicleState) {
  const job = peekCrewJob(state, v);
  if (job) {
    const d = state.vehicles.find(
      (o) => job.partnerUids.includes(o.uid) && isPlanDigger(o.defId) && (o.operator || handsOn(state, o)) && sameArea(o, v),
    );
    if (d) return d;
  }
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const o of state.vehicles) {
    if (!isPlanDigger(o.defId) || !(o.operator || handsOn(state, o)) || !sameArea(o, v)) continue;
    const d = distTo(v.x, v.z, o.x, o.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** Where an idle truck should wait: beside its team's loader, or off the plant / yard, never at the fence. */

/** Where an idle truck should wait: beside its team's loader, or off the plant / yard, never at the fence. */
export function safeWaitSpot(state: GameState, v: VehicleState) {
  const digger = diggerForTruck(state, v) ?? hiredDiggerNearby(state, v);
  if (digger) {
    const zone = loadingZone(state, digger);
    const spot = zone.spots.find((s) => ridgeParkOk(s.x, s.z));
    if (spot) return spot;
    if (ridgeParkOk(digger.x, digger.z)) return { x: digger.x, z: digger.z };
  }
  const gate = gateFor(v.x);
  for (const pad of livePads(state)) {
    if (!padOpen(state, pad.kind) || areaOf(pad.x) !== areaOf(v.x)) continue;
    if (!isPlantKind(pad.kind) && pad.kind !== "reclaim") continue;
    const ang = Math.atan2(gate.z - pad.z, gate.x - pad.x);
    const x = pad.x + Math.cos(ang) * (pad.r + 10);
    const z = pad.z + Math.sin(ang) * (pad.r + 10);
    if (ridgeParkOk(x, z) && !pointBlocked(x, z, 3.2)) return { x, z };
  }
  if (areaOf(v.x) === "ridge") return { x: GATE.x, z: Math.max(GATE.z, 28) };
  return { x: gate.x, z: gate.z };
}

/** Drive onto the open spot and stop. A stopped truck in its spot is the bay. */

/** Drive onto the open spot and stop. A stopped truck in its spot is the bay. */
export function enterBay(v: VehicleState, spot: BaySpot, place: number, keepX: number, keepZ: number): Control {
  const label = place === 0 ? "In the load bay" : `In line (${place + 1})`;
  const dist = distTo(v.x, v.z, spot.x, spot.z);
  const fromKeep = Math.hypot(v.x - keepX, v.z - keepZ);
  // Close to the spot, and still outside the pile. An 8 m bubble reached back into the heap.
  const close = dist < 4.5 && fromKeep > 12.5;
  // Once parked, stay ready through small zone drift so the watchdog does not
  // treat a long wait as a stall the instant the spot jitters.
  const holding = bayReady.has(v) && dist < 8 && fromKeep > 10 && Math.abs(v.speed) < 1.2;
  const was = bayCommit.has(v);
  if (close || holding) bayCommit.add(v);
  else if (dist > 16) bayCommit.delete(v);
  if (holding || (was && close && Math.abs(v.speed) < 0.7)) {
    bayReady.add(v);
    v.status = label;
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  if (bayReady.has(v)) {
    bayReady.delete(v);
    crewSeen.delete(v);
  }
  v.status = place === 0 ? "Lining up at the bay" : `In line (${place + 1})`;
  if (close) return { throttle: 0, steer: 0, action: false, brake: 1 };
  // Point at the spot before rolling. Turning on the move swings a truck into the pile.
  if (fromKeep < 22 && dist > 2.5) {
    const desired = Math.atan2(-(spot.x - v.x), -(spot.z - v.z));
    const err = Math.atan2(Math.sin(desired - v.yaw), Math.cos(desired - v.yaw));
    if (Math.abs(err) > 0.35) return { throttle: 0, steer: clamp(err * 1.8, -1, 1), action: false, brake: 0.75 };
  }
  return seek(v, spot.x, spot.z, 3.2);
}

/** A truck already in pour reach, clear of the pile, can take the load even if it has not nosed into the painted bay spot. */

/** A truck already in pour reach, clear of the pile, can take the load even if it has not nosed into the painted bay spot. */
export function parkInPour(state: GameState, v: VehicleState, digger: VehicleState, place: number, zone: LoadZone, spot: BaySpot): Control | null {
  if (truckLeaving(v)) return null;
  // The digger has to be set up on the face. Otherwise a truck beside it in the yard would park too early.
  if (distTo(digger.x, digger.z, zone.standX, zone.standZ) > 14) return null;
  if (distTo(v.x, v.z, zone.keepX, zone.keepZ) < 12.5) return null;
  if (distTo(v.x, v.z, spot.x, spot.z) > 12) return null;
  const reach = pourReach(digger.defId);
  if (distTo(v.x, v.z, digger.x, digger.z) > reach) return null;
  if (distTo(v.x, v.z, zone.standX, zone.standZ) > reach + 4) return null;
  if (Math.abs(v.speed) > 1.2) return null;
  bayCommit.add(v);
  bayReady.add(v);
  v.status = place === 0 ? "In the load bay" : `In line (${place + 1})`;
  return { throttle: 0, steer: 0, action: false, brake: 1 };
}
