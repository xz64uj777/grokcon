/** Load-bay partners, truck lines, and pouring a bucket into a bed. */

import { DEFS, ORES } from "@/game/catalog";
import { BRIDGE, areaOf, bridgeAllows, bridgeMaxLoad, crossingWorth, onBridge, otherBank, RIVER } from "@/game/river";
import { isPlanDigger } from "@/game/crew-plan";
import { mixPurity } from "@/game/mining";
import type { Deposit, GameState, OreId, VehicleId, VehicleState } from "@/game/types";
import type { Control } from "./types.ts";
import { distTo, handsOn, ownsClaim, sameArea, vehicleStats } from "./world.ts";
import { addPile } from "./feed.ts";
import { cannotCrossTo, slotOf } from "./jobs.ts";
import { bayReady, jobStand, loaderStand } from "./bay.ts";
import { seek } from "./motion.ts";
import { peekCrewJob, teamHasTruck } from "./crew.ts";


function haulerCanTake(state: GameState, v: VehicleState, t: VehicleState, maxDist: number, operatedOnly: boolean) {
  if (!DEFS[t.defId].receives || t === v) return false;
  if (!sameArea(t, v) || !bayReady.has(t) || truckLeaving(t)) return false;
  if (!heavyReaches(t, v)) return false;
  if (operatedOnly && !t.operator && !handsOn(state, t)) return false;
  const room = vehicleStats(t).capacity - t.cargo;
  if (room < 0.4 || (t.cargoOre && v.cargoOre && t.cargoOre !== v.cargoOre)) return false;
  return distTo(v.x, v.z, t.x, t.z) <= maxDist;
}


export function nearestHauler(state: GameState, v: VehicleState, maxDist: number, operatedOnly: boolean): VehicleState | null {
  const line = lineFor(state, v);
  // The line head loads first when it is actually parked in the zone.
  // If it is still out on the road, take the closest truck that is.
  let best: VehicleState | null = null;
  let bestD = maxDist;
  const team = peekCrewJob(state, v)?.partnerUids;
  for (const t of line) {
    if (team && team.length > 0 && !team.includes(t.uid)) continue;
    if (!haulerCanTake(state, v, t, maxDist, operatedOnly)) continue;
    const d = distTo(v.x, v.z, t.x, t.z);
    if (t === line[0]) {
      best = t;
      break;
    }
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  // A ready heavy from another team already in pour reach gets this bucket.
  // Returning the team dump truck immediately left the East Rim heavy sitting
  // through every truck cycle. Same-line order is unchanged so a lone loader's
  // dump truck and heavy still keep their pile gap.
  for (const t of state.vehicles) {
    if (t.defId !== "heavy" || line.includes(t) || t === best) continue;
    if (!haulerCanTake(state, v, t, maxDist, operatedOnly)) continue;
    if (t.cargo >= vehicleStats(t).capacity * 0.9) continue;
    return t;
  }
  return best;
}

export const truckPartner = new WeakMap<VehicleState, string>();

/** One truck per digger. A second truck waits at a pile instead of stacking on the same machine. */
/** One truck per digger, in the order they showed up. The rest wait behind it. */
export const lineTicket = new WeakMap<VehicleState, number>();

let lineNo = 1;

/** Next ticket for a truck joining a digger's line. Needed so other modules can increment this counter. */
export function nextLineTicket() {
  return lineNo++;
}


export function fillsHaulers(id: VehicleId) {
  return id === "loader" || id === "hloader" || id === "excavator";
}


export function wheelLoader(id: VehicleId) {
  return id === "loader" || id === "hloader";
}

/** How far this machine can tip a bucket into a parked truck. */

/** How far this machine can tip a bucket into a parked truck. */
export function pourReach(id: VehicleId) {
  if (id === "hloader") return 28;
  if (id === "excavator") return 26;
  return 22;
}


export function loaderInArea(state: GameState, v: VehicleState) {
  return state.vehicles.some(
    (o) => fillsHaulers(o.defId) && (o.operator || handsOn(state, o)) && areaOf(o.x) === areaOf(v.x),
  );
}


export const stockLatch = new WeakMap<VehicleState, { x: number; z: number }>();


export function stockSpot(v: VehicleState, source: { x: number; z: number }) {
  const prev = stockLatch.get(v);
  if (prev && distTo(prev.x, prev.z, source.x, source.z) < 26) return prev;
  const ang = (slotOf(v) / 8) * Math.PI * 2;
  const spot = { x: source.x + Math.cos(ang) * 12, z: source.z + Math.sin(ang) * 12 };
  stockLatch.set(v, spot);
  return spot;
}


export function truckLeaving(t: VehicleState) {
  const cap = vehicleStats(t).capacity;
  return cap > 0 && t.cargo >= cap * 0.9;
}


function heavyReaches(t: VehicleState, digger: VehicleState) {
  return t.defId !== "heavy" || !otherBank(t.x, digger.x);
}

/** The bank a heavy haul is working, when no dump truck is here to cross for. */

/** The bank a heavy haul is working, when no dump truck is here to cross for. */
function heavyBank(state: GameState, v: VehicleState): number | null {
  if (areaOf(v.x) !== "river" || !fillsHaulers(v.defId)) return null;
  let bank = 0;
  let heavies = 0;
  let dumps = 0;
  for (const t of state.vehicles) {
    if (!DEFS[t.defId].receives || !(t.operator || handsOn(state, t)) || areaOf(t.x) !== "river" || truckLeaving(t)) continue;
    if (t.defId === "truck") dumps++;
    if (t.defId === "heavy") {
      heavies++;
      bank = Math.sign(t.x - RIVER.x) || bank;
    }
  }
  if (dumps > 0 || heavies === 0) return null;
  return bank || -1;
}


export function offHeavyBank(state: GameState, v: VehicleState, x: number) {
  const bank = heavyBank(state, v);
  if (bank == null) return false;
  const side = Math.sign(x - RIVER.x);
  return side !== 0 && side !== bank;
}

/** Seconds since this machine's load last changed. */

/** Seconds since this machine's load last changed. */
const loadSince = new WeakMap<VehicleState, { cargo: number; t: number }>();

export function idleFor(state: GameState, v: VehicleState) {
  const e = loadSince.get(v);
  if (!e || Math.abs(e.cargo - v.cargo) > 0.05) {
    loadSince.set(v, { cargo: v.cargo, t: state.seconds });
    return 0;
  }
  return state.seconds - e.t;
}
/** A loose pile this wheel loader could scoop. */

/** A loose pile this wheel loader could scoop. */
export function hasPile(state: GameState, o: VehicleState) {
  return state.deposits.some((d) => d.kind === "pile" && d.tons >= 0.4 && !d.id.startsWith("feed-") && sameArea(d, o) && ownsClaim(state, d.claim));
}

export const DIGGER_HOLD_SECONDS = 30;

export const TRUCK_IDLE_SECONDS = 45;
/** An empty truck or heavy yields the bay if its digger is not about to fill it. */


export function holdForTruck(state: GameState, v: VehicleState): Control {
  const crossing = loaderToHeavyBank(state, v) ?? loaderToOrphanHeavy(state, v);
  if (crossing) return crossing;
  // An overweight bucket must get off the deck before it waits. Sitting mid-span
  // was how the heavy loader stayed stuck on a bridge that could not take it.
  if (fillsHaulers(v.defId) && areaOf(v.x) === "river" && !bridgeAllows(v.defId, v.cargo) && onBridge(v.x, v.z, 2)) {
    const leave = Math.sign(v.x - BRIDGE.x) || -1;
    const exitX = BRIDGE.x + leave * (BRIDGE.halfLength + 6);
    if (distTo(v.x, v.z, exitX, BRIDGE.z) > 2) {
      v.status = truckWaitStatus(state, v);
      return seek(v, exitX, BRIDGE.z, 2);
    }
  }
  // A full loader on the river walks to the open side before it waits, so the bay is not in the water.
  if (wheelLoader(v.defId) && areaOf(v.x) === "river") {
    const beside = state.vehicles.some(
      (t) => DEFS[t.defId].receives && (t.operator || handsOn(state, t)) && sameArea(t, v) && !truckLeaving(t) && distTo(v.x, v.z, t.x, t.z) < pourReach(v.defId),
    );
    if (!beside) {
      let vein: Deposit | null = null;
      let bestD = 36;
      for (const d of state.deposits) {
        if (d.kind !== "vein" || d.tons < 1 || !ownsClaim(state, d.claim) || !sameArea(d, v) || offHeavyBank(state, v, d.x) || cannotCrossTo(state, v, d.x)) continue;
        const dist = distTo(v.x, v.z, d.x, d.z);
        if (dist < bestD) {
          bestD = dist;
          vein = d;
        }
      }
      if (vein) {
        const stand = loaderStand(v, vein);
        if (distTo(v.x, v.z, stand.x, stand.z) > 5) {
          v.status = "Setting up the load";
          return seek(v, stand.x, stand.z, 3.2);
        }
      }
    }
  }
  // Never silently empty a waiting bucket onto the yard. The operator can
  // still dump manually, but unattended machines retain ore until a truck arrives.
  if (fillsHaulers(v.defId) && v.cargoOre && v.cargo > 0.15 && idleFor(state, v) > DIGGER_HOLD_SECONDS && !teamHasTruck(state, v) && !peekCrewJob(state, v)?.sourceId) {
    v.status = "Waiting for a haul truck — load or dump manually";
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  v.status = truckWaitStatus(state, v);
  return { throttle: 0, steer: 0, action: false, brake: 1 };
}

/** The loader crosses to the heavy's bank. The heavy haul does not use the bridge. */

/** The loader crosses to the heavy's bank. The heavy haul does not use the bridge. */
function loaderToHeavyBank(state: GameState, v: VehicleState): Control | null {
  const bank = heavyBank(state, v);
  if (bank == null || Math.sign(v.x - RIVER.x) === bank) return null;
  return loaderToHeavyBankAt(state, v, bank);
}

/** A hired heavy on the river with no digger on its bank, even when dump trucks are working the other side. */

/** A hired heavy on the river with no digger on its bank, even when dump trucks are working the other side. */
function orphanHeavy(state: GameState): VehicleState | null {
  if (!state.vehicles.some((t) => t.defId === "heavy" && (t.operator || handsOn(state, t)) && areaOf(t.x) === "river")) return null;
  for (const t of state.vehicles) {
    if (t.defId !== "heavy" || !(t.operator || handsOn(state, t)) || areaOf(t.x) !== "river") continue;
    if (truckLeaving(t)) continue;
    const diggerHere = state.vehicles.some(
      (o) => fillsHaulers(o.defId) && (o.operator || handsOn(state, o)) && areaOf(o.x) === "river" && !otherBank(t.x, o.x),
    );
    if (!diggerHere) return t;
  }
  return null;
}

/** Send one loader or excavator across to load a stranded heavy, without pulling every digger off the dump trucks. */

/** Send one loader or excavator across to load a stranded heavy, without pulling every digger off the dump trucks. */
export function loaderToOrphanHeavy(state: GameState, v: VehicleState): Control | null {
  if (!fillsHaulers(v.defId) || areaOf(v.x) !== "river") return null;
  // A loaded bucket or a truck already in this digger's line stays on this bank.
  // Sending the excavator across left the west dump trucks idle in the valley crew.
  if (v.cargo > 0.15) return null;
  if (lineFor(state, v).some((t) => !truckLeaving(t))) return null;
  const heavy = orphanHeavy(state);
  if (!heavy || !otherBank(v.x, heavy.x)) return null;
  const volunteers = state.vehicles.filter(
    (o) =>
      fillsHaulers(o.defId) &&
      (o.operator || handsOn(state, o)) &&
      areaOf(o.x) === "river" &&
      otherBank(o.x, heavy.x) &&
      o.cargo <= 0.15 &&
      !lineFor(state, o).some((t) => !truckLeaving(t)),
  );
  if (!volunteers.length) return null;
  // When a payloader is on the river, it is the one that crosses. The excavator
  // keeps loading the dump trucks even if the loader is busy for a moment.
  const hasLoader = state.vehicles.some(
    (o) => wheelLoader(o.defId) && (o.operator || handsOn(state, o)) && areaOf(o.x) === "river",
  );
  const pool = hasLoader ? volunteers.filter((o) => wheelLoader(o.defId)) : volunteers;
  if (!pool.length) return null;
  pool.sort((a, b) => distTo(a.x, a.z, heavy.x, heavy.z) - distTo(b.x, b.z, heavy.x, heavy.z));
  if (pool[0] !== v) return null;
  return loaderToHeavyBankAt(state, v, Math.sign(heavy.x - RIVER.x) || -1);
}


function loaderToHeavyBankAt(state: GameState, v: VehicleState, bank: number): Control {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 1 || !ownsClaim(state, d.claim) || !sameArea(d, v)) continue;
    if (Math.sign(d.x - RIVER.x) !== bank) continue;
    const dist = distTo(v.x, v.z, d.x, d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  const face = best ? jobStand(v, best) : { x: RIVER.x + bank * (RIVER.halfWidth + 18), z: BRIDGE.z };
  v.status = "Crossing to the heavy haul's bank";
  return seek(v, face.x, face.z, 4);
}


export function diggerAboutToFill(state: GameState, truck: VehicleState, digger: VehicleState): boolean {
  const reach = pourReach(digger.defId);
  const dist = distTo(truck.x, truck.z, digger.x, digger.z);
  // Still at this bay, even with an empty bucket for a moment (r16).
  if (dist <= reach) return true;
  if (dist > reach + 14) return false;
  if (digger.cargo > 0.15) return true;
  return /^(Scooping|Working|Setting up the load|Waiting for)/.test(digger.status);
}

/** Don't scoop a different ore, or go back to the face, while a truck is already in the bay. */

/** Don't scoop a different ore, or go back to the face, while a truck is already in the bay. */
export function holdForReadyHauler(state: GameState, v: VehicleState, _nextOre: OreId | null): Control | null {
  const ready = lineFor(state, v).find((t) => bayReady.has(t));
  if (!ready) return null;
  // Only hold a bucket the waiting truck can actually take. A dirt bucket
  // should not freeze the digger while a silver truck sits in the bay.
  if (v.cargo > 0.15 && (!ready.cargoOre || ready.cargoOre === v.cargoOre)) {
    return holdForTruck(state, v);
  }
  return null;
}


function truckWaitStatus(state: GameState, v: VehicleState) {
  let heavy = false;
  let dump = false;
  for (const t of state.vehicles) {
    if (!DEFS[t.defId].receives || !(t.operator || handsOn(state, t)) || !sameArea(t, v) || truckLeaving(t)) continue;
    if (!heavyReaches(t, v)) continue;
    if (t.defId === "heavy") heavy = true;
    else dump = true;
  }
  if (heavy && !dump) return "Waiting for the heavy haul";
  if (peekCrewJob(state, v)?.team) return "Waiting for truck";
  return "Waiting for a ready dump truck";
}


export function lineFor(state: GameState, digger: VehicleState) {
  const list = state.vehicles.filter((t) => {
    if (!DEFS[t.defId].receives || t === digger) return false;
    if (!(t.operator || handsOn(state, t))) return false;
    if (truckPartner.get(t) !== digger.uid) return false;
    if (!sameArea(t, digger)) return false;
    if (!heavyReaches(t, digger)) return false;
    if (truckLeaving(t)) return false;
    return true;
  });
  for (const t of list) if (!lineTicket.has(t)) lineTicket.set(t, nextLineTicket());
  list.sort((a, b) => (lineTicket.get(a) ?? 0) - (lineTicket.get(b) ?? 0));
  return list;
}


export function diggerForTruck(state: GameState, v: VehicleState) {
  const job = peekCrewJob(state, v);
  if (job?.role === "truck") {
    const digger = state.vehicles.find(
      (o) => job.partnerUids.includes(o.uid) && isPlanDigger(o.defId) && (o.operator || handsOn(state, o)) && heavyReaches(v, o),
    );
    if (digger) {
      truckPartner.set(v, digger.uid);
      if (!lineTicket.has(v)) lineTicket.set(v, nextLineTicket());
      return digger;
    }
    truckPartner.delete(v);
    return null;
  }
  const isDigger = (o: VehicleState) =>
    (o.defId === "loader" || o.defId === "hloader" || o.defId === "excavator") &&
    (o.operator || handsOn(state, o)) &&
    heavyReaches(v, o);
  const open = (o: VehicleState) =>
    isDigger(o) &&
    (!wheelLoader(o.defId) || o.cargo > 0.15 || hasPile(state, o)) &&
    // A part-loaded truck only lines up at a digger holding the same ore (or an empty bucket).
    (v.cargo < 0.15 || !v.cargoOre || o.cargo < 0.15 || !o.cargoOre || o.cargoOre === v.cargoOre);
  // Keep the partner you already have, even if its bucket just changed ore.
  // Dropping it left the truck sitting on "Needs a payloader" while the digger waited.
  const prev = state.vehicles.find((o) => o.uid === truckPartner.get(v) && isDigger(o));
  if (prev && !truckLeaving(v) && distTo(v.x, v.z, prev.x, prev.z) < 120) return prev;
  let best: VehicleState | null = null;
  let bestS = Infinity;
  for (const o of state.vehicles) {
    if (!open(o)) continue;
    const score = lineFor(state, o).length * 1000 + distTo(v.x, v.z, o.x, o.z);
    if (score < bestS) {
      bestS = score;
      best = o;
    }
  }
  if (best) {
    truckPartner.set(v, best.uid);
    if (!lineTicket.has(v)) lineTicket.set(v, nextLineTicket());
  } else truckPartner.delete(v);
  return best;
}


export function cargoInto(v: VehicleState, ore: OreId, tons: number, purity: number) {
  if (tons <= 0) return;
  v.cargoPurity = v.cargo > 0.05 && v.cargoOre === ore ? mixPurity(v.cargo, v.cargoPurity ?? 1, tons, purity) : purity;
  v.cargo += tons;
  v.cargoOre = ore;
}


export function emptyCargo(v: VehicleState) {
  v.cargo = 0;
  v.cargoOre = null;
  v.cargoPurity = 1;
}

/** What a bite of this face will produce, before cutting it. */


export function dropInFront(state: GameState, v: VehicleState, x: number, z: number) {
  if (!v.cargoOre || v.cargo < 0.05) return;
  addPile(state, v.cargoOre, v.cargo, x, z, v.workClaim ?? 1, v.cargoPurity ?? 1);
  emptyCargo(v);
}


export function truckNear(state: GameState, v: VehicleState, x: number, z: number, reach: number) {
  let best: VehicleState | null = null;
  let bestD = reach;
  for (const o of state.vehicles) {
    if (o === v || !DEFS[o.defId].receives) continue;
    const d = distTo(x, z, o.x, o.z);
    if (d <= bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}


/** A pile or face this machine can still scoop or dig. */


export function loadTruck(state: GameState, index = state.active, maxDist = 32, forced: VehicleState | null = null): string {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  const def = DEFS[v.defId];
  if (v.defId === "lowboy") return "Use the lowboy Load control to put a parked machine on the trailer; this control loads ore into dump trucks.";
  if (def.receives || def.capacity <= 0) return "This machine can't load a truck.";
  if (v.cargo < 0.08 || !v.cargoOre) return "Bucket is empty.";
  let truck: VehicleState | null = forced;
  let bestD = maxDist;
  for (const o of forced ? [] : state.vehicles) {
    if (o === v || !DEFS[o.defId].receives) continue;
    const d = distTo(v.x, v.z, o.x, o.z);
    if (d <= bestD) {
      bestD = d;
      truck = o;
    }
  }
  if (!truck) return "No dump truck close enough. Pull up beside it.";
  let cap = vehicleStats(truck).capacity;
  // Crew who mean to cross the bridge leave room for the limit. A heavy haul
  // does not: half a bed will not fit, so it fills up for the west barge.
  const crewTruck = truck.operator && !handsOn(state, truck);
  if (crewTruck && areaOf(truck.x) === "river" && crossingWorth(truck.defId, cap, 0)) {
    cap = Math.min(cap, bridgeMaxLoad(truck.defId));
  }
  const room = cap - truck.cargo;
  if (room < 0.2) return "Dump truck is full.";
  if (truck.cargoOre && truck.cargoOre !== v.cargoOre) {
    if (truck.cargo > 1.5) return `Truck is loaded with ${ORES[truck.cargoOre].name}.`;
    emptyCargo(truck);
  }
  const move = Math.min(v.cargo, room);
  const ore = v.cargoOre;
  cargoInto(truck, ore, move, v.cargoPurity ?? 1);
  v.cargo -= move;
  if (v.cargo <= 0.08) emptyCargo(v);
  v.busy = true;
  const msg = `Loaded ${move.toFixed(1)} tons of ${ORES[ore].name} into the ${DEFS[truck.defId].name}.`;
  v.status = msg;
  truck.status = `Bed ${truck.cargo.toFixed(1)} tons ${ORES[truck.cargoOre ?? ore].name}`;
  return msg;
}


export function pourIntoTrucks(state: GameState) {
  state.vehicles.forEach((v, index) => {
    if (!fillsHaulers(v.defId)) return;
    // Hand-worked machines dump into the truck themselves.
    if (v.manual) return;
    if (!v.operator && !(v === state.vehicles[state.active] && !state.watching)) return;
    if (v.cargo < 0.15 || !v.cargoOre) return;
    const reach = pourReach(v.defId);
    const truck = nearestHauler(state, v, reach, true);
    if (truck) loadTruck(state, index, reach, truck);
  });
}
