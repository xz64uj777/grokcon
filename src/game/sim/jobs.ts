/** Choosing a face, pile, or plant for a hired machine. */

import * as Ops from "@/game/ops";
import { pileFootprint } from "@/game/piles";
import { DEFS, ORES } from "@/game/catalog";
import { X0, areaOf, bridgeAllows, crossingWorth, otherBank, RIVER } from "@/game/river";
import { bucketPoint } from "@/game/controls";
import { isPlantKind, PILE_JOB_TONS, CRUMB_TONS } from "@/game/crew-plan";
import type { Deposit, GameState, OreId, VehicleState } from "@/game/types";
import type { Control, WorkOpts } from "./types.ts";
import { unitPrice } from "./economy.ts";
import { claimAreaOf, distTo, faceOf, handsOn, hypot, isRiverBar, livePads, ownsClaim, padOpen, sameArea, vehicleStats } from "./world.ts";
import { fillsHaulers, loaderInArea, offHeavyBank, wheelLoader } from "./haulers.ts";
import { spotOpen } from "./bay.ts";
import { pointBlocked, routeTo } from "./motion.ts";
import { crewJob } from "./ai.ts";
import { peekCrewJob, plannedDeposit } from "./crew.ts";

const biteAcc = new WeakMap<VehicleState, number>();

/** A wheel loader may cut river bars, a claim or team face, or a face another digger is already on. */
export function loaderMayCut(state: GameState, v: VehicleState, d: Deposit | null | undefined): d is Deposit {
  if (!d || d.kind !== "vein") return false;
  if (!ownsClaim(state, d.claim) || (assignedClaim(v) != null && d.claim !== assignedClaim(v))) return false;
  if (assignedClaim(v) != null || isRiverBar(d)) return true;
  const planned = plannedDeposit(state, v);
  if (planned && planned.id === d.id) return true;
  return state.vehicles.some((o) => {
    if (o === v || !fillsHaulers(o.defId) || !(o.operator || handsOn(state, o))) return false;
    if (areaOf(o.x) !== areaOf(d.x)) return false;
    const theirs = plannedDeposit(state, o);
    if (theirs && theirs.id === d.id) return true;
    return distTo(o.x, o.z, d.x, d.z) < 36 && /^(Working|Heading to|Scooping) /.test(o.status);
  });
}


function loaderCutVein(state: GameState, v: VehicleState): Deposit | null {
  if (assignedClaim(v) != null) return bestVein(state, v, null);
  const planned = plannedDeposit(state, v);
  if (planned && planned.kind === "vein" && loaderMayCut(state, v, planned) && sameArea(planned, v) && !cannotCrossTo(state, v, planned.x)) return planned;
  const spot = bestVein(state, v, v.cargo > 0.08 ? v.cargoOre : null);
  return loaderMayCut(state, v, spot) ? spot : null;
}

/** Vein a loader may keep filling, honoring a started bucket's ore. */

/** Vein a loader may keep filling, honoring a started bucket's ore. */
export function loaderFillVein(state: GameState, v: VehicleState): Deposit | null {
  if (v.workClaim == null && v.cargo > 0.08) {
    const spot = bestVein(state, v, v.cargoOre);
    return loaderMayCut(state, v, spot) ? spot : null;
  }
  return loaderCutVein(state, v);
}

export function assignedClaim(v: VehicleState): number | null {
  if (v.workClaim == null) return null;
  const claimArea = claimAreaOf(v.workClaim);
  if (claimArea !== areaOf(v.x)) return null;
  return v.workClaim;
}

/** A face the crew was pointed at. Ignored until the machine is on that map, so the lowboy can carry the order up. */

/** A face the crew was pointed at. Ignored until the machine is on that map, so the lowboy can carry the order up. */
export function facePin(state: GameState, v: VehicleState): Deposit | null {
  if (!v.workFace) return null;
  const d = state.deposits.find((o) => o.id === v.workFace);
  if (!d || d.kind !== "vein" || d.tons < 0.35) return null;
  if (!ownsClaim(state, d.claim)) return null;
  if (areaOf(d.x) !== areaOf(v.x)) return null;
  return d;
}


export function acceptsJob(state: GameState, v: VehicleState, d: Deposit) {
  const pin = facePin(state, v);
  if (pin && d.kind === "vein" && d.id !== pin.id) return false;
  if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) return false;
  if (d.id === "starter" && assignedClaim(v) != null) return false;
  const planned = peekCrewJob(state, v);
  if (planned?.sourceId) return d.id === planned.sourceId;
  // Sluice work comes first, but only while a washable pile is actually waiting.
  // A live gold or copper vein used to block dirt and iron piles for the whole
  // shift, so claim stock sat untouched. Dirt still counts as sluice work.
  if (v.workClaim == null && state.sluice && state.preferSluice && d.kind === "pile" && !prefersSluice(state, d.ore) && !dirtToSluice(state, d.ore, d.x)) {
    const washing = state.deposits.some(
      (o) =>
        o.kind === "pile" &&
        o.tons >= 1.5 &&
        !o.id.startsWith("feed-") &&
        ownsClaim(state, o.claim) &&
        sameArea(o, v) &&
        (prefersSluice(state, o.ore) || dirtToSluice(state, o.ore, o.x)),
    );
    if (washing) return false;
  }
  return true;
}


export function takeBite(v: VehicleState, dt: number, period: number) {
  const t = (biteAcc.get(v) ?? period) + dt;
  if (t < period) {
    biteAcc.set(v, t);
    return false;
  }
  biteAcc.set(v, t - period);
  return true;
}


export function prefersSluice(state: GameState, ore: OreId, x?: number) {
  // The sluice is at the ridge. Away from it, sell where you are.
  // Dirt is topsoil. It can run through the sluice, but it must not outrank a real face.
  if (ore === "dirt") return false;
  if (x !== undefined && areaOf(x) !== "ridge") return false;
  return state.sluice && state.preferSluice && ORES[ore].sluice > ORES[ore].crusher;
}

/** Overburden on the ridge goes to the sluice once you own it. Washing it pays more than the fill buyer. */

/** Overburden on the ridge goes to the sluice once you own it. Washing it pays more than the fill buyer. */
export function dirtToSluice(state: GameState, ore: OreId, x?: number) {
  if (ore !== "dirt" || !state.sluice || !state.preferSluice) return false;
  if (x !== undefined && areaOf(x) !== "ridge") return false;
  return true;
}

/** River silver, gold gravel, and overburden pay at the wash plant once it is built. Ridge dirt stays on the sluice. */

/** River silver, gold gravel, and overburden pay at the wash plant once it is built. Ridge dirt stays on the sluice. */
export function prefersWash(state: GameState, ore: OreId, x: number) {
  return state.washPlant && areaOf(x) === "river" && ORES[ore].wash > ORES[ore].crusher;
}


export function washScore(state: GameState, ore: OreId) {
  if (ore === "dirt" || !state.sluice || !state.preferSluice) return 0;
  return Math.max(0, ORES[ore].sluice - ORES[ore].crusher) * 40;
}


export function canReach(v: VehicleState, padX: number) {
  if (areaOf(v.x) !== areaOf(padX)) return false;
  if (!otherBank(v.x, padX)) return true;
  return crossingWorth(v.defId, vehicleStats(v).capacity, v.cargo);
}

/** A machine must not drive onto a bank the bridge will not take at its current weight. */

/** A machine must not drive onto a bank the bridge will not take at its current weight. */
export function cannotCrossTo(state: GameState, v: VehicleState, x: number) {
  if (!otherBank(v.x, x)) return false;
  if (Ops.bridgeClosed(state)) return true;
  return !bridgeAllows(v.defId, v.cargo);
}


export function bestPad(state: GameState, ore: OreId, x: number, z: number, v?: VehicleState) {
  let best: ReturnType<typeof livePads>[number] | null = null;
  let score = -Infinity;
  const open: ReturnType<typeof livePads> = [];
  for (const pad of livePads(state)) {
    if (!padOpen(state, pad.kind)) continue;
    if (areaOf(pad.x) !== areaOf(x)) continue;
    if (v && !canReach(v, pad.x)) continue;
    const unit = unitPrice(ore, pad.kind, state.sluice, state.market);
    if (unit <= 0) continue;
    if (pad.kind === "sluice" && ore === "dirt" && !dirtToSluice(state, ore, x)) continue;
    if (pad.kind === "wash" && prefersWash(state, ore, x)) return pad;
    // When the sluice is purchased, route copper/gold there first: it is the
    // intended recovery plant, not a distance-scored fallback to the crusher.
    if (pad.kind === "sluice" && (prefersSluice(state, ore) || dirtToSluice(state, ore, x))) return pad;
    open.push(pad);
  }
  // An owned plant that pays for this ore beats the railroad and the barge.
  const plantFirst = open.some((p) => isPlantKind(p.kind));
  for (const pad of open) {
    if (plantFirst && (pad.kind === "loadout" || pad.kind === "barge")) continue;
    const unit = unitPrice(ore, pad.kind, state.sluice, state.market);
    // A bridge crossing is a price choice, not a long haul. Metres must not
    // talk a dump truck into the cheaper barge.
    const d = distTo(x, z, pad.x, pad.z);
    const cross = otherBank(x, pad.x);
    // Crossing is only worth a better price. A long drive on this bank must not
    // lose to the cheaper buyer on the other side, or the crew circles the bridge.
    const s = cross ? unit - 30 : unit - Math.min(10, d * 0.06);
    if (s > score) {
      score = s;
      best = pad;
    }
  }
  return best;
}


export function plannedPad(state: GameState, index: number) {
  const v = state.vehicles[index];
  if (!v?.cargoOre) return null;
  return bestPad(state, v.cargoOre, v.x, v.z, v)?.kind ?? null;
}


function veinScore(state: GameState, v: VehicleState, d: Deposit) {
  const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
  const d0 = distTo(v.x, v.z, d.x, d.z);
  const busy = crewNear(state, v, d.x, d.z, 16);
  return (unit * Math.min(d.tons, 50)) / (d0 + 10) + (d0 < 40 ? 1000 : 0) + (d.ore === "dirt" ? 0 : 2000) + washScore(state, d.ore) - busy * 2400;
}


export function bestVein(state: GameState, v: VehicleState, ore: OreId | null) {
  const pinned = facePin(state, v);
  if (pinned && (!ore || pinned.ore === ore)) return pinned;
  let best: Deposit | null = null;
  let score = -Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 1) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) continue;
    if (ore && d.ore !== ore) continue;
    if (!sameArea(d, v) || offHeavyBank(state, v, d.x) || cannotCrossTo(state, v, d.x)) continue;
    if (!acceptsJob(state, v, d)) continue;
    const s = veinScore(state, v, d);
    if (s > score) {
      score = s;
      best = d;
    }
  }
  const held = commitVein(state, v, best, (d) => veinScore(state, v, d));
  if (held && ore && held.ore !== ore) return best;
  return held;
}


export function slotOf(v: VehicleState) {
  let n = 0;
  for (let i = 0; i < v.uid.length; i++) n = (n + v.uid.charCodeAt(i) * (i + 1)) % 8;
  return n;
}

/** A spot on the near edge of a pile, locked so the machine does not orbit it. */

/** A spot on the near edge of a pile, locked so the machine does not orbit it. */
export const approachLatch = new WeakMap<VehicleState, { id: string; x: number; z: number }>();


function approachBusy(state: GameState, v: VehicleState, x: number, z: number) {
  for (const o of state.vehicles) {
    if (o === v || !o.operator) continue;
    const od = DEFS[o.defId];
    if (od.dig <= 0 && od.scoop <= 0 && !od.receives) continue;
    if (distTo(o.x, o.z, x, z) < vehicleStats(v).radius + vehicleStats(o).radius + 2.8) return true;
  }
  return false;
}


export function pileApproach(state: GameState, v: VehicleState, pile: Deposit) {
  const prev = approachLatch.get(v);
  if (
    prev &&
    prev.id === pile.id &&
    distTo(v.x, v.z, pile.x, pile.z) < 22 &&
    !approachBusy(state, v, prev.x, prev.z)
  ) {
    return { x: prev.x, z: prev.z };
  }
  const foot = pileFootprint(Math.max(pile.tons, 0.4));
  if (!wheelLoader(v.defId)) {
    const dx = v.x - pile.x;
    const dz = v.z - pile.z;
    const ang = Math.atan2(dz, dx) + ((slotOf(v) % 5) - 2) * 0.38;
    const spot = { id: pile.id, x: pile.x + Math.cos(ang) * (foot.rx + 2.2), z: pile.z + Math.sin(ang) * (foot.rz + 2.2) };
    approachLatch.set(v, spot);
    return spot;
  }
  // On the open side of the heap, still close enough to scoop, with room for a truck outside it.
  const bank = areaOf(pile.x) === "river" ? Math.sign(pile.x - RIVER.x) || 1 : 0;
  const shift = ((slotOf(v) % 5) - 2) * 0.42;
  let bestX = pile.x + (bank || 1) * (foot.rx + 2.2);
  let bestZ = pile.z;
  let bestS = -Infinity;
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2 + shift;
    const x = pile.x + Math.cos(ang) * (foot.rx + 2.2);
    const z = pile.z + Math.sin(ang) * (foot.rz + 2.2);
    if (pointBlocked(x, z, 1.8)) continue;
    if (areaOf(pile.x) === "river" && otherBank(x, pile.x)) continue;
    if (areaOf(pile.x) === "ridge" && (x < -82 || (x < -52 && z < 14))) continue;
    const pocketX = x + Math.cos(ang) * 12;
    const pocketZ = z + Math.sin(ang) * 12;
    let score = spotOpen(pocketX, pocketZ, x, z, pile.x, pile.z, 24) ? 100 : -20;
    if (bank !== 0) score += Math.cos(ang) * bank * 28;
    if (approachBusy(state, v, x, z)) score -= 80;
    if (score > bestS) {
      bestS = score;
      bestX = x;
      bestZ = z;
    }
  }
  const spot = { id: pile.id, x: bestX, z: bestZ };
  approachLatch.set(v, spot);
  return spot;
}


export function pileInReach(state: GameState, v: VehicleState) {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.id.startsWith("feed-") || d.tons < 0.2) continue;
    if (!acceptsJob(state, v, d)) continue;
    const foot = pileFootprint(d.tons);
    const dx = v.x - d.x;
    const dz = v.z - d.z;
    const rx = foot.rx + 4.4;
    const rz = foot.rz + 4.4;
    if ((dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) >= 1) continue;
    const dist = Math.hypot(dx, dz);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** Other working machines already on this spot. Each crew member should pick a different one. */

/** Other working machines already on this spot. Each crew member should pick a different one. */
export function crewNear(state: GameState, v: VehicleState, x: number, z: number, reach: number) {
  let n = 0;
  for (const o of state.vehicles) {
    if (o === v || !o.operator) continue;
    const od = DEFS[o.defId];
    if (od.dig <= 0 && od.scoop <= 0 && od.push <= 0) continue;
    if (distTo(o.x, o.z, x, z) < reach) n++;
  }
  return n;
}


export const pileJob = new WeakMap<VehicleState, string>();


export function bestPile(state: GameState, v: VehicleState) {
  let best: Deposit | null = null;
  let score = -Infinity;
  let prev: Deposit | null = null;
  let prevScore = -1;
  for (const d of state.deposits) {
    // 1.5 t is the scoop cutoff, except a skid given a crumb by the planner.
    if (d.kind !== "pile" || d.id.startsWith("feed-")) continue;
    const planned = peekCrewJob(state, v);
    const crumb = planned?.sourceId === d.id && planned.jobKind === "crumb";
    if (d.tons < (crumb ? CRUMB_TONS : PILE_JOB_TONS)) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (!acceptsJob(state, v, d)) continue;
    if (v.cargo > 0.15 && v.cargoOre && v.cargoOre !== d.ore) continue;
    if (!sameArea(d, v) || offHeavyBank(state, v, d.x) || cannotCrossTo(state, v, d.x)) continue;
    if (v.defId === "skid" && !crumb && loaderInArea(state, v) && d.tons < 8) continue;
    const unit = prefersSluice(state, d.ore) || dirtToSluice(state, d.ore, d.x) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z);
    const s = (unit * Math.min(d.tons, 30)) / (d0 + 8) + (d0 < 36 ? 1000 : 0) + washScore(state, d.ore) - crewNear(state, v, d.x, d.z, 14) * 2200;
    if (d.id === pileJob.get(v)) {
      prev = d;
      prevScore = s;
    }
    if (s > score) {
      score = s;
      best = d;
    }
  }
  if (prev && prev.tons > 0.8 && prevScore + 1600 >= score) best = prev;
  if (best) pileJob.set(v, best.id);
  return best;
}

/** One truck per digger. A second truck waits at a pile instead of stacking on the same machine. */
/** One truck per digger, in the order they showed up. The rest wait behind it. */


function veinUsable(state: GameState, v: VehicleState, d: Deposit | null | undefined): d is Deposit {
  return !!d && d.kind === "vein" && d.tons >= 0.35 && ownsClaim(state, d.claim) && sameArea(d, v) && (assignedClaim(v) == null || d.claim === assignedClaim(v)) && acceptsJob(state, v, d);
}

/** Stay on the face you already chose unless another one is clearly better. Stops gold and silver swapping every frame. */

/** Stay on the face you already chose unless another one is clearly better. Stops gold and silver swapping every frame. */
export function commitVein(state: GameState, v: VehicleState, next: Deposit | null, scoreOf: (d: Deposit) => number): Deposit | null {
  const pin = facePin(state, v);
  if (pin) return pin;
  const prev = state.deposits.find((d) => d.id === crewJob.get(v));
  if (veinUsable(state, v, prev) && !offHeavyBank(state, v, prev.x) && !cannotCrossTo(state, v, prev.x) && next && prev.id !== next.id) {
    const onIt = distTo(v.x, v.z, prev.x, prev.z) < prev.radius + 16;
    // A crowded river bar should not send the excavator across the valley to the quarry.
    if (isRiverBar(prev) && prev.tons >= 8 && !isRiverBar(next)) return prev;
    if (onIt || scoreOf(next) < scoreOf(prev) * 1.45) {
      return prev;
    }
  }
  const pick = next ?? (veinUsable(state, v, prev) && !offHeavyBank(state, v, prev.x) && !cannotCrossTo(state, v, prev.x) ? prev : null);
  if (pick) crewJob.set(v, pick.id);
  else crewJob.delete(v);
  return pick;
}

/** A face the crew can actually drive onto. The ridge back wall is solid, so a cut walked into it is pulled back out. */
export function driveFace(vein: Deposit) {
  const cut = faceOf(vein);
  let x = cut.x;
  const z = areaOf(vein.x) === "ridge" ? Math.max(cut.z, -46) : cut.z;
  if (areaOf(vein.x) === "ridge") {
    // Gold Creek sits beyond the west wall. Keeping its approach inside the
    // pit sends crews straight into that wall and bypasses routeTo's west road.
    if (vein.id === "gold") {
      x = Math.max(-74, x);
      // z is already clamped in faceOf; keep the stand off the west pocket.
    } else x = Math.max(-48, Math.min(36, x));
  } else if (vein.id === "quarry") {
    x = Math.max(x, X0 - 76);
  } else if (vein.id === "east-rim") {
    x = Math.min(x, X0 + 82);
  }
  return { x, z, reach: cut.reach };
}


export function workHere(v: VehicleState, x: number, z: number, radius: number): Control | null {
  if (distTo(v.x, v.z, x, z) > radius) return null;
  if (Math.abs(v.speed) > 0.7) return { throttle: 0, steer: 0, action: false, brake: 1 };
  return { throttle: 0, steer: 0, action: true, brake: 1 };
}

/** Where a work order wants the machine. Null when it has no assignment. */

/** What a bite of this face will produce, before cutting it. */
export function faceOutput(d: Deposit, cut: WorkOpts["cut"]): OreId {
  if (d.ore === "dirt") return "dirt";
  const top = cut === "top" || cut === "auto";
  return top && d.overburden > 0.05 ? "dirt" : d.ore;
}


export function faceNearPlayer(state: GameState, v: VehicleState, extra = 4) {
  const tip = v.defId === "excavator" ? bucketPoint(v.x, v.z, v.yaw, v.tool) : { x: v.x, z: v.z };
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.ore === "dirt") continue;
    const f = faceOf(d);
    const dist = Math.min(distTo(tip.x, tip.z, f.x, f.z), distTo(v.x, v.z, f.x, f.z));
    if (dist <= f.reach + extra && dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

export const SHORT_CARRY_RANGE = 60;
