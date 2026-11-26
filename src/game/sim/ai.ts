/** Hired-machine controls and the dig / dump action. */

import * as Ops from "@/game/ops";
import { DEFS, CREW_KEEP, ORES, formatMoney } from "@/game/catalog";
import { bucketPoint, machineKind } from "@/game/controls";
import { recordSale } from "@/game/market";
import { cutFace, digRate, purityFactor } from "@/game/mining";
import type { Deposit, GameState, VehicleId, VehicleState } from "@/game/types";
import type { Control, StepFX, WorkOpts } from "./types.ts";
import { ZERO } from "./types.ts";
import { fillContract, unitPrice } from "./economy.ts";
import { clamp, closestFace, distTo, faceOf, handsOn, haulTarget, hypot, livePads, log, nearestPad, ownsClaim, prettySign, sameArea, vehicleStats } from "./world.ts";
import { addFeedPile, addPile, dumpsToFeed, feedId, feedJob, markFeedPaid, sideFeedId } from "./feed.ts";
import { SHORT_CARRY_RANGE, acceptsJob, approachLatch, assignedClaim, bestPad, bestPile, bestVein, canReach, cannotCrossTo, commitVein, crewDigPosition, crewNear, dirtToSluice, driveFace, faceOutput, facePin, loaderFillVein, loaderMayCut, pileApproach, pileInReach, prefersSluice, prefersWash, takeBite, washScore, workHere } from "./jobs.ts";
import { TRUCK_IDLE_SECONDS, cargoInto, diggerAboutToFill, diggerForTruck, dropInFront, emptyCargo, fillsHaulers, hasPile, holdForReadyHauler, holdForTruck, idleFor, lineFor, lineTicket, nextLineTicket, loadTruck, loaderInArea, loaderToOrphanHeavy, nearestHauler, offHeavyBank, stockLatch, stockSpot, truckLeaving, truckNear, truckPartner, wheelLoader } from "./haulers.ts";
import { BAY_YIELD_BUSY_SECONDS, BAY_YIELD_SECONDS, bayCommit, bayReady, enterBay, jobStand, loaderStand, loadingZone, parkInPour, safeWaitSpot, spotForTruck, truckSpot } from "./bay.ts";
import { dumpAnyway, plantQueue, plantTicket, washQueuePlace } from "./plants.ts";
import { benchBetween, fuelPoint, lowboyDrive, noseBlocked, seek, topped } from "./motion.ts";
import { plannedDeposit, plannedPadFor, teamHasTruck } from "./crew.ts";

export const saleAcc = new WeakMap<VehicleState, number>();


export const crewJob = new WeakMap<VehicleState, string>();

const crewPush = new WeakMap<VehicleState, { phase: "in" | "out"; t: number }>();

/** The nearest idle dozer, or else loader, clears a rockslide. A pinned face stays on the dig. */
function slideJob(state: GameState, v: VehicleState): Control | null {
  if (v.defId !== "dozer" && !wheelLoader(v.defId)) return null;
  if (v.cargo > 0.25 || facePin(state, v)) return null;
  const slide = state.deposits.find((d) => d.id === "slide-gap" && d.tons > 0.2);
  if (!slide || !sameArea(slide, v)) return null;
  if (v.workClaim != null && v.workClaim !== slide.claim) return null;
  const slideClass = (id: VehicleId) => (id === "hloader" ? "loader" : id);
  let best = v;
  let bestD = distTo(v.x, v.z, slide.x, slide.z);
  for (const o of state.vehicles) {
    if (o === v || !o.operator || facePin(state, o)) continue;
    if (o.defId !== "dozer" && !wheelLoader(o.defId)) continue;
    if (!sameArea(o, slide) || (o.workClaim != null && o.workClaim !== slide.claim)) continue;
    if ((state.deck ?? []).includes(o.uid) || o.cargo > 0.25) continue;
    const d = distTo(o.x, o.z, slide.x, slide.z);
    const better = (o.defId === "dozer" && best.defId !== "dozer") || (slideClass(o.defId) === slideClass(best.defId) && d < bestD);
    if (better) {
      best = o;
      bestD = d;
    }
  }
  if (best !== v) return null;
  if (bestD < 8) {
    const desired = Math.atan2(-(slide.x - v.x), -(slide.z - v.z));
    const diff = Math.atan2(Math.sin(desired - v.yaw), Math.cos(desired - v.yaw));
    v.status = "Clearing the rockslide";
    return { throttle: Math.abs(diff) > 0.5 ? 0.15 : 0.4, steer: clamp(diff, -1, 1), action: Math.abs(diff) < 0.6, brake: 0 };
  }
  v.status = "Heading to the rockslide";
  return seek(v, slide.x, slide.z, 5);
}

/** What is actually against the nose. A slow turn in the open is not a wall. */


export function aiControl(state: GameState, index: number): Control {
  const v = state.vehicles[index];
  const def = DEFS[v.defId];
  const st = vehicleStats(v);
  const cap = st.capacity;
  // A near-full bucket that has stopped filling counts as full.
  if (v.cargo < 0.25) topped.delete(v);
  const full = cap > 0 && (v.cargo >= cap * 0.9 || topped.has(v));
  const has = v.cargo > 0.25;
  let target: { x: number; z: number } | null = null;
  let arrive = 6;
  let label = "Looking for work";

  const feeding = v.unstick > 0 ? null : feedJob(state, v);
  if (feeding) return feeding;
  // Do not keep pushing a load onto a bridge the scale will reject, or a flooded deck.
  if (/^(Too heavy for the bridge|Bridge flooded)/.test(v.status) && v.cargo > 0.15) {
    if (fillsHaulers(v.defId)) return holdForTruck(state, v);
    const pad = v.cargoOre ? bestPad(state, v.cargoOre, v.x, v.z, v) : null;
    if (pad) return seek(v, pad.x, pad.z, Math.max(5, pad.r * 0.62));
    const wait = safeWaitSpot(state, v);
    if (distTo(v.x, v.z, wait.x, wait.z) > 5) return seek(v, wait.x, wait.z, 5);
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  if (v.unstick > 0) {
    const hit = noseBlocked(state, v);
    v.status = hit === "wall" ? "Backing off a wall" : hit === "pile" ? "Backing off a pile" : "Backing up";
    return { throttle: -0.65, steer: v.bias, action: false, brake: 0 };
  }
  const pumps = Ops.fuelAim(state, v);
  if (pumps) {
    const aim = fuelPoint(v, pumps);
    if (distTo(v.x, v.z, aim.x, aim.z) < 1) {
      v.status = Ops.fuelKind(v.defId) === "gas" ? "At the gas pump" : "At the diesel pump";
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    v.status = "Heading to the fuel pumps";
    return seek(v, aim.x, aim.z, 4);
  }
  if (v.defId === "light") {
    v.status = Ops.nightness(state.seconds) > 0.35 ? "Lights on" : "Light plant parked";
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  const slide = slideJob(state, v);
  if (slide) return slide;
  if (v.defId === "lowboy") return lowboyDrive(state, v);

  if (def.id === "crusher") {
    let digger: VehicleState | null = null;
    let best = Infinity;
    for (let i = 0; i < state.vehicles.length; i++) {
      if (i === index) continue;
      const o = state.vehicles[i];
      if (o.defId === "pickup") continue;
      const od = DEFS[o.defId];
      if (od.dig <= 0 && !wheelLoader(o.defId)) continue;
      if (!(o.operator || handsOn(state, o))) continue;
      const d = distTo(v.x, v.z, o.x, o.z);
      const score = d - (od.dig > 0 ? 40 : 0);
      if (score < best) {
        best = score;
        digger = o;
      }
    }
    if (!digger) {
      v.status = "Plant parked";
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    const dx = digger.x - v.x;
    const dz = digger.z - v.z;
    const dist = Math.hypot(dx, dz) || 1;
    if (dist < 18) {
      v.status = "Plant set";
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    v.status = "Tracking the face";
    return seek(v, digger.x - (dx / dist) * 14, digger.z - (dz / dist) * 14, 6);
  }

  if (v.cargo < 0.25) plantTicket.delete(v);

  if (v.cargoOre && v.cargo > 0.35 && !keepBucketAtPad(state, v, cap, "auto")) {
    const pad = nearestPad(state, v.x, v.z);
    const planned = bestPad(state, v.cargoOre, v.x, v.z, v);
    if (pad && planned && pad.id === planned.id && unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) > 0) {
      const held = plantQueue(state, v, pad);
      if (held) return held;
      v.status = `Dumping at ${pad.name}`;
      return { throttle: 0, steer: 0, action: true, brake: 1 };
    }
  }

  const haulTarget = () => {
    if (!v.cargoOre) return;
    const loadsTrucks = fillsHaulers(def.id);
    if (loadsTrucks) {
      // Stay put while a team truck is on the way. Only a lone loader with
      // the plant in reach does a short self-haul.
      if (teamHasTruck(state, v)) return;
      const pad = bestPad(state, v.cargoOre, v.x, v.z, v);
      if (pad && distTo(v.x, v.z, pad.x, pad.z) <= SHORT_CARRY_RANGE) {
        target = pad;
        arrive = Math.max(5, pad.r * 0.62);
        label = `Hauling to ${pad.name}`;
      }
      return;
    }
    const pad = bestPad(state, v.cargoOre, v.x, v.z, v);
    if (!pad) return;
    if (loadsTrucks && benchBetween(v.x, v.z, pad.x, pad.z)) return;
    target = pad;
    arrive = Math.max(5, pad.r * 0.62);
    label = `Hauling to ${pad.name}`;
  };

  const waitingTruckRaw = wheelLoader(def.id) && v.cargo > 0.35 ? nearestHauler(state, v, full ? 480 : 28, true) : null;
  const waitingTruck = waitingTruckRaw && !benchBetween(v.x, v.z, waitingTruckRaw.x, waitingTruckRaw.z) ? waitingTruckRaw : null;

  if (def.push > 0) {
    const scoreVein = (d: Deposit) => {
      const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
      const d0 = distTo(v.x, v.z, d.x, d.z);
      return (unit * Math.min(d.tons, 50)) / (d0 + 10) + (d0 < 40 ? 1000 : 0) + (d.ore === "dirt" ? 0 : 2000) + washScore(state, d.ore);
    };
    const vein = commitVein(state, v, bestVein(state, v, null), scoreVein);
    if (vein) {
      const cut = faceOf(vein);
      const name = prettySign(vein.sign);
      const dist = distTo(v.x, v.z, cut.x, cut.z);
      const cycle = crewPush.get(v) ?? { phase: "in" as const, t: 0 };
      const atFace = dist <= Math.max(5.2, cut.reach + 1.2);
      if (!atFace && cycle.phase !== "out") {
        target = cut;
        arrive = 3.4;
        label = `Heading to ${name}`;
      } else {
        cycle.t += 1 / 60;
        if (cycle.phase === "in" && (cycle.t > 1.15 || dist < 1.6)) {
          cycle.phase = "out";
          cycle.t = 0;
        } else if (cycle.phase === "out" && cycle.t > 1.15) {
          cycle.phase = "in";
          cycle.t = 0;
        }
        crewPush.set(v, cycle);
        const desired = Math.atan2(-(cut.x - v.x), -(cut.z - v.z));
        const diff = Math.atan2(Math.sin(desired - v.yaw), Math.cos(desired - v.yaw));
        if (cycle.phase === "in") {
          v.status = `Pushing ${name}`;
          return { throttle: 0.42, steer: clamp(diff * 1.3, -1, 1), action: Math.abs(diff) < 0.9, brake: 0 };
        }
        v.status = `Backing off ${name}`;
        return { throttle: -0.48, steer: clamp(-diff * 0.35, -1, 1), action: false, brake: 0 };
      }
    } else label = "No face in reach";
  } else if (def.dig > 0) {
    const plannedSource = plannedDeposit(state, v);
    const aid = !full ? loaderToOrphanHeavy(state, v) : null;
    if (aid) return aid;
    if (def.id === "skid" && full && v.cargoOre && plannedSource?.kind !== "pile" && loaderInArea(state, v)) {
      const src = bestVein(state, v, v.cargoOre) ?? bestPile(state, v) ?? { x: v.x, z: v.z };
      const spot = stockSpot(v, src);
      if (distTo(v.x, v.z, spot.x, spot.z) < 3.2) {
        v.status = "Stockpiling for the loader";
        return { throttle: 0, steer: 0, action: true, brake: 1 };
      }
      v.status = "Making a pile for the loader";
      return seek(v, spot.x, spot.z, 2.6);
    }
    if (full && v.cargoOre) {
      haulTarget();
      if (!target) return holdForTruck(state, v);
    }
    const digHaul = target as { x: number; z: number } | null;
    if (digHaul) {
      v.status = label;
      return seek(v, digHaul.x, digHaul.z, arrive);
    }
    const pinned = facePin(state, v);
    let vein: Deposit | null = pinned ?? (plannedSource?.kind === "vein" && !cannotCrossTo(state, v, plannedSource.x) ? plannedSource : null);
    if (!vein) {
      let veinS = -Infinity;
      for (const d of state.deposits) {
        if (d.kind !== "vein" || d.tons < 0.35) continue;
        if (!ownsClaim(state, d.claim)) continue;
        if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) continue;
        if (offHeavyBank(state, v, d.x) || cannotCrossTo(state, v, d.x) || (assignedClaim(v) == null && !sameArea(d, v))) continue;
        if (!acceptsJob(state, v, d)) continue;
        const dist = distTo(v.x, v.z, d.x, d.z);
        const s = washScore(state, d.ore) + (d.ore === "dirt" ? 0 : 1500) + (dist < 42 ? 400 : 0) - dist - crewNear(state, v, d.x, d.z, 14) * 2000;
        if (s > veinS) {
          veinS = s;
          vein = d;
        }
      }
      vein = commitVein(state, v, vein, (d) => {
        const dist = distTo(v.x, v.z, d.x, d.z);
        return washScore(state, d.ore) + (d.ore === "dirt" ? 0 : 1500) + (dist < 42 ? 400 : 0) - dist - crewNear(state, v, d.x, d.z, 14) * 2000;
      });
    }
    if (vein) {
      const job = prettySign(vein.sign);
      if (v.cargo > 0.25 && v.cargoOre && faceOutput(vein, "auto") !== v.cargoOre) {
        haulTarget();
        const pad = target as { x: number; z: number } | null;
        if (pad) {
          v.status = `Hauling ${ORES[v.cargoOre].name}`;
          return seek(v, pad.x, pad.z, arrive);
        }
        if (fillsHaulers(def.id)) return holdForTruck(state, v);
      }
      const cut = crewDigPosition(state, v, vein);
      if (!cut) {
        v.status = "Making room at the face";
        return { ...ZERO, brake: 1 };
      }
      const wait = holdForReadyHauler(state, v, faceOutput(vein, "auto"));
      if (wait) return wait;
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Working ${job}`;
        return held;
      }
      v.status = `Heading to ${job}`;
      return seek(v, cut.x, cut.z, Math.min(2.2, cut.reach));
    }
    const cleanupPile = def.id === "skid" && plannedSource?.kind === "pile" ? plannedSource : null;
    if (v.cargo > 0.25 && v.cargoOre && cleanupPile?.ore !== v.cargoOre) haulTarget();
    else {
      const pile = bestPile(state, v);
      if (pile) {
        const spot = pileApproach(state, v, pile);
        if (def.id === "skid" && !approachLatch.has(v)) {
          v.status = "Making room at the pile";
          return { ...ZERO, brake: 1 };
        }
        if (distTo(v.x, v.z, spot.x, spot.z) < 2.4 && Math.abs(v.speed) < 1.1 && pileInReach(state, v)) {
          v.status = `Scooping ${ORES[pile.ore].name}`;
          return { throttle: 0, steer: 0, action: true, brake: 1 };
        }
        v.status = `Scooping ${ORES[pile.ore].name}`;
        return seek(v, spot.x, spot.z, 2.4);
      }
      v.status = "Face is dug out";
      return { ...ZERO };
    }
  } else if (def.receives) {
    if (v.cargo < 0.15) dumpAnyway.delete(v);
    // A truck can wait in line for a matching load. If the assigned loader
    // has switched ores, let the truck sell the partial load after the timeout.
    let stale = false;
    if (cap > 0 && v.cargo > 0.4) {
      stale = dumpAnyway.has(v);
      if (!stale && idleFor(state, v) > TRUCK_IDLE_SECONDS) {
        const partnerUid = truckPartner.get(v);
        const partner = state.vehicles.find((candidate) => candidate.uid === partnerUid);
        const canTopUp = !partner?.cargoOre || partner.cargoOre === v.cargoOre;
        stale = !v.status.startsWith("In line") || !canTopUp;
      }
    }
    const leave = cap > 0 && (v.cargo >= cap * 0.9 || stale);
    if (leave && v.cargoOre) {
      lineTicket.delete(v);
      truckPartner.delete(v);
      bayReady.delete(v);
      bayCommit.delete(v);
      truckSpot.delete(v);
      dumpAnyway.add(v);
      const pad = plannedPadFor(state, v) ?? bestPad(state, v.cargoOre, v.x, v.z, v);
      if (pad) {
        target = pad;
        arrive = Math.min(6, Math.max(5, pad.r * 0.62));
        v.status = `Hauling to ${pad.name}`;
        const held = plantQueue(state, v, pad);
        if (held) return held;
        const here = nearestPad(state, v.x, v.z);
        if (here && here.id === pad.id) {
          v.status = `Dumping at ${pad.name}`;
          return { throttle: 0, steer: 0, action: true, brake: 1 };
        }
        return seek(v, pad.x, pad.z, arrive);
      }
    }
    if (!target) {
      const digger = diggerForTruck(state, v);
      if (digger) {
        const waited = idleFor(state, v);
        const othersWaiting = lineFor(state, digger).some((t) => t !== v && !truckLeaving(t));
        if (
          bayReady.has(v) &&
          v.cargo < 0.4 &&
          waited > BAY_YIELD_SECONDS &&
          (!diggerAboutToFill(state, v, digger) || (othersWaiting && waited > BAY_YIELD_BUSY_SECONDS))
        ) {
          // This machine is empty and the digger is not about to fill it.
          // After a longer wait, also yield if another truck is in line even
          // though a digger is nearby — being close is not the same as loading this bed.
          bayReady.delete(v);
          bayCommit.delete(v);
          truckSpot.delete(v);
          lineTicket.set(v, nextLineTicket());
        }
        const line = lineFor(state, digger);
        const place = Math.max(0, line.findIndex((t) => t === v));
        const zone = loadingZone(state, digger);
        const spot = spotForTruck(state, v, digger, place);
        const parked = parkInPour(state, v, digger, place, zone, spot);
        if (parked) return parked;
        return enterBay(v, spot, place, zone.keepX, zone.keepZ);
      }
      v.status = "Needs a payloader";
      const wait = safeWaitSpot(state, v);
      if (distTo(v.x, v.z, wait.x, wait.z) > 5) return seek(v, wait.x, wait.z, 5);
      return { ...ZERO, brake: 1 };
    }
  } else if (waitingTruck) {
    return holdForTruck(state, v);
  } else if (has && full) {
    haulTarget();
    if (!target) return holdForTruck(state, v);
  } else if (def.dig > 0 || def.scoop > 0) {
    const aid = !full ? loaderToOrphanHeavy(state, v) : null;
    if (aid) return aid;
    const vein = def.dig > 0 && !full ? bestVein(state, v, v.cargo > 0.15 ? v.cargoOre : null) : null;
    const pile = def.scoop > 0 && !full ? bestPile(state, v) : null;
    const pileD = pile ? distTo(v.x, v.z, pile.x, pile.z) : Infinity;
    const veinD = vein ? distTo(v.x, v.z, vein.x, vein.z) : Infinity;
    // The iron pile sits on the gate. Take it when it is closer than a face.
    const washVein = vein != null && prefersSluice(state, vein.ore);
    const washPile = pile != null && (prefersSluice(state, pile.ore) || dirtToSluice(state, pile.ore, pile.x));
    const takePile = pile != null && pile.tons >= 1.5 && pileD + 4 < veinD && (!washVein || washPile);
    if (takePile && pile) {
      const spot = pileApproach(state, v, pile);
      if (distTo(v.x, v.z, spot.x, spot.z) < 2.4 && Math.abs(v.speed) < 1.1 && pileInReach(state, v)) {
        v.status = `Scooping ${ORES[pile.ore].name}`;
        return { throttle: 0, steer: 0, action: true, brake: 1 };
      }
      target = spot;
      arrive = 2.4;
      label = pile.id === "starter" ? "Scooping the gate pile" : `Scooping ${ORES[pile.ore].name}`;
    } else if (vein) {
      if (v.cargo > 0.25 && v.cargoOre && faceOutput(vein, "auto") !== v.cargoOre) {
        haulTarget();
        if (!target) return holdForTruck(state, v);
        const truck = target as { x: number; z: number };
        v.status = label;
        return seek(v, truck.x, truck.z, arrive);
      } else {
      const cut = driveFace(vein);
      const wait = holdForReadyHauler(state, v, faceOutput(vein, "auto"));
      if (wait) return wait;
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Working ${prettySign(vein.sign)}`;
        return held;
      }
      target = cut;
      arrive = Math.max(4, cut.reach * 0.7);
      label = `Heading to ${prettySign(vein.sign)}`;
      }
    } else if (def.scoop > 0) {
      const spot = bestVein(state, v, null);
      const cut = spot ? jobStand(v, spot) : null;
      const canCut = loaderMayCut(state, v, spot);
      if (spot && cut && canCut) {
        const wait = holdForReadyHauler(state, v, faceOutput(spot, "auto"));
        if (wait) return wait;
        const held = workHere(v, cut.x, cut.z, cut.reach);
        if (held) {
          v.status = `Working ${prettySign(spot.sign)}`;
          return held;
        }
        target = cut;
        arrive = Math.max(4, cut.reach * 0.7);
        label = `Heading to ${prettySign(spot.sign)}`;
      } else if (spot && cut) {
        target = cut;
        arrive = Math.max(4, cut.reach * 0.7);
        label = wheelLoader(def.id) && !hasPile(state, v) ? "Needs a pile (dozer, skid or blast)" : `Heading to ${prettySign(spot.sign)}`;
      } else label = assignedClaim(v) != null ? "No material at assigned source" : "Looking for a pile";
    } else label = "No face in reach";
  }

  v.status = label;
  if (has && v.cargoOre && full && !keepBucketAtPad(state, v, cap, "auto")) {
    const pad = nearestPad(state, v.x, v.z);
    const wrongPlant =
      (pad?.kind === "reclaim" && v.cargoOre !== "dirt" && bestPad(state, v.cargoOre, v.x, v.z, v)?.kind !== "reclaim") ||
      (prefersSluice(state, v.cargoOre, v.x) && pad?.kind !== "sluice") ||
      (dirtToSluice(state, v.cargoOre, v.x) && pad?.kind !== "sluice") ||
      (prefersWash(state, v.cargoOre, v.x) && pad?.kind !== "wash" && canReach(v, livePads(state).find((p) => p.kind === "wash")?.x ?? v.x)) ||
      (!!pad && unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) <= 0);
    if (pad && !wrongPlant) {
      const held = plantQueue(state, v, pad);
      if (held) return held;
      v.status = `Dumping at ${pad.name}`;
      return { throttle: 0, steer: 0, action: true, brake: 1 };
    }
  }
  if (target && "kind" in target) {
    const held = plantQueue(state, v, target as { kind: string; x: number; z: number; r: number });
    if (held) return held;
  }
  if (!target) return { ...ZERO };
  return seek(v, target.x, target.z, arrive);
}


function materialInFront(state: GameState, v: VehicleState, reach: number) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  let vein: Deposit | null = null;
  let pile: Deposit | null = null;
  let veinD = Infinity;
  let pileD = Infinity;
  for (const d of state.deposits) {
    if (d.tons < 0.2) continue;
    if (!acceptsJob(state, v, d)) continue;
    const dx = d.x - v.x;
    const dz = d.z - v.z;
    const dist = Math.hypot(dx, dz);
    if (dist > reach || dist < 0.05) continue;
    const dot = (dx / dist) * fx + (dz / dist) * fz;
    if (dot < 0.25) continue;
    if (d.kind === "vein" && dist < veinD) {
      vein = d;
      veinD = dist;
    } else if (d.kind === "pile" && dist < pileD) {
      pile = d;
      pileD = dist;
    }
  }
  return vein ?? pile;
}


function cutLog(state: GameState, d: Deposit, res: ReturnType<typeof cutFace>, player: boolean) {
  if (res.slide) log(state, `Wall slide at ${d.sign}! Dirt fell back on the ore. Strip the top before digging the bottom.`);
  else if (res.benched && player) log(state, `${d.sign} is down to bench ${d.bench}. Strip the next layer of dirt off the top.`);
}

/** A pile or face this machine can still scoop or dig. */
function fillSourceInReach(state: GameState, v: VehicleState) {
  const def = DEFS[v.defId];
  if (def.scoop > 0 && pileInReach(state, v)) return true;
  if (def.dig > 0) {
    const tip = v.defId === "excavator" ? bucketPoint(v.x, v.z, v.yaw, v.tool) : { x: v.x, z: v.z };
    if (closestFace(state, tip.x, tip.z, v)) return true;
  }
  if (wheelLoader(def.id) && v.operator) {
    const spot = loaderFillVein(state, v);
    if (!spot) return false;
    const stand = loaderStand(v, spot);
    if (distTo(v.x, v.z, stand.x, stand.z) <= stand.reach + 1.4) return true;
    const cut = faceOf(spot);
    return distTo(v.x, v.z, cut.x, cut.z) <= cut.reach;
  }
  return false;
}

/** Keep the bucket when still filling, or when a truck is in line for it. Trucks at a pad still dump. */

/** Keep the bucket when still filling, or when a truck is in line for it. Trucks at a pad still dump. */
function keepBucketAtPad(state: GameState, v: VehicleState, cap: number, phase: WorkOpts["phase"], seated = false) {
  if (DEFS[v.defId].receives || phase === "dump") return false;
  if (fillsHaulers(v.defId) && lineFor(state, v).length > 0) return true;
  if (!fillSourceInReach(state, v)) return false;
  // A player still on the pile should keep a full bucket too, instead of selling the instant it fills.
  if (seated) return true;
  return cap > 0 && v.cargo < cap * 0.9;
}


export function performAction(
  state: GameState,
  index: number,
  dt: number,
  breaks: StepFX["breaks"],
  opts: WorkOpts,
): StepFX["sales"][number] | null {
  const v = state.vehicles[index];
  const def = DEFS[v.defId];
  const st = vehicleStats(v);
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const player = !state.watching && index === state.active;
  const plannedSource = player ? null : plannedDeposit(state, v);
  const scoopingAssignedPile = plannedSource?.kind === "pile";
  const manual = opts.phase !== "auto";
  const kind = machineKind(v.defId);

  if (opts.phase !== "fill") {
    const pad = v.cargoOre ? nearestPad(state, v.x, v.z) : null;
    const planned = v.cargoOre ? bestPad(state, v.cargoOre, v.x, v.z, v) : null;
    const keepBucket = keepBucketAtPad(state, v, st.capacity, opts.phase, player);
    const onPlan = !!pad && !!planned && pad.id === planned.id;
    const washStop = !!v.cargoOre && !!pad && pad.kind === "wash" && prefersWash(state, v.cargoOre, v.x);
    const precious = v.cargoOre === "gold" || v.cargoOre === "copper";
    const holdForSluice =
      !!v.cargoOre &&
      !!pad &&
      !washStop &&
      ((prefersSluice(state, v.cargoOre, v.x) && pad.kind !== "sluice") ||
        (dirtToSluice(state, v.cargoOre, v.x) && pad.kind !== "sluice") ||
        (prefersWash(state, v.cargoOre, v.x) && pad.kind !== "wash" && !player && canReach(v, livePads(state).find((p) => p.kind === "wash")?.x ?? v.x)) ||
        unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) <= 0);
    const crewShort = !player && !onPlan && st.capacity > 0 && v.cargo < st.capacity * 0.9 && !dumpAnyway.has(v);
    const reclaimWaste = pad?.kind === "reclaim" && (precious || (!player && v.cargoOre !== "dirt" && planned?.kind !== "reclaim"));
    // A hand-worked excavator dumps where the bucket is, not where the tracks are.
    const excavatorHand = manual && kind === "excavator";
    // Movement and unloading share the queue even if both trucks reach the pad.
    if (pad?.kind === "wash" && !keepBucket && !excavatorHand && washQueuePlace(state, v) > 0) return null;
    if (!excavatorHand && (holdForSluice || crewShort || reclaimWaste) && v.cargoOre) {
      if (player && holdForSluice) {
        const where = prefersWash(state, v.cargoOre, v.x)
          ? v.cargoOre === "dirt"
            ? "Overburden goes to the wash plant"
            : "This pays at the wash plant"
          : pad?.kind === "wash"
            ? "Wash plant only takes silver, gold gravel, and overburden"
            : v.cargoOre === "dirt"
              ? "Overburden goes to the sluice"
              : `${ORES[v.cargoOre].name} pays at the sluice`;
        v.status = where;
      }
    } else if (!keepBucket && !excavatorHand && v.cargo > 0.04 && v.cargoOre && pad && dumpsToFeed(v.defId, pad.kind)) {
      // The check is paid on the dump. The pile is only what's left for the plant to chew through.
      const tons = v.cargo;
      const ore = v.cargoOre;
      const purityIn = v.cargoPurity ?? 1;
      const hopper = state.deposits.find((d) => d.id === feedId(pad.id));
      const sidePile = !!hopper && hopper.ore !== ore && hopper.tons > 0.05;
      addFeedPile(state, pad, ore, tons, purityIn);
      emptyCargo(v);
      v.busy = true;
      if (player) state.tutorial.dumped = true;
      // The check is paid on the dump even when the hopper already has another ore
      // and this load sits beside the plant. Leaving it unpaid zeroed mountain sales
      // after the first dirt went into the mill.
      const unit = unitPrice(ore, pad.kind, state.sluice, state.market);
      const purity = purityFactor(ore, purityIn);
      const gross = tons * unit * purity * Ops.saleMult(state, ore, pad.kind);
      const net = gross * (player ? 1 : CREW_KEEP);
      Ops.onSale(state, net, tons);
      const bonus = fillContract(state, ore, tons);
      recordSale(state.market, pad.kind, ore, tons);
      state.cash += net;
      state.lifetime += net;
      const id = sidePile ? sideFeedId(pad.id, ore) : feedId(pad.id);
      const pile = state.deposits.find((d) => d.id === id);
      if (pile) markFeedPaid(pile, tons);
      const extra = bonus > 0 ? ` +${formatMoney(bonus)} contract` : "";
      if (player) {
        if (sidePile) log(state, `${pad.name} paid ${formatMoney(net)} for ${tons.toFixed(1)} tons of ${ORES[ore].name.toLowerCase()}. The hopper was full of something else, so it was dropped beside the plant.`);
        else log(state, `${pad.name} paid ${formatMoney(net)} for ${tons.toFixed(1)} tons of ${ORES[ore].name.toLowerCase()}.`);
      }
      return { x: v.x, z: v.z, text: `+${formatMoney(net)} ${ORES[ore].name} ${tons.toFixed(1)}t${extra}`, player };
    } else if (!keepBucket && !excavatorHand && v.cargo > 0.04 && v.cargoOre && pad) {
      const unit = unitPrice(v.cargoOre, pad.kind, state.sluice, state.market);
      const sold = v.cargo;
      const soldOre = v.cargoOre;
      const purity = purityFactor(soldOre, v.cargoPurity ?? 1);
      const gross = sold * unit * purity * Ops.saleMult(state, soldOre, pad.kind);
      const net = gross * (player ? 1 : CREW_KEEP);
      Ops.onSale(state, net, sold);
      const oreName = ORES[soldOre].name;
      const bonus = fillContract(state, soldOre, sold);
      recordSale(state.market, pad.kind, soldOre, sold);
      state.cash += net;
      state.lifetime += net;
      emptyCargo(v);
      saleAcc.set(v, 0);
      v.busy = true;
      if (player) state.tutorial.dumped = true;
      if (pad.kind === "crusher") {
        const plant = state.vehicles.find((o) => o.defId === "crusher");
        if (plant) plant.busy = true;
      }
      const extra = bonus > 0 ? ` +${formatMoney(bonus)} contract` : "";
      if (player && pad.kind === "mill") log(state, `Summit mill paid ${formatMoney(net)} for ${sold.toFixed(1)} tons of ${ORES[soldOre].name.toLowerCase()}.`);
      const pure = soldOre === "dirt" ? "" : ` ${Math.round(purity * 100)}%`;
      return { x: v.x, z: v.z, text: `+${formatMoney(net)} ${oreName} ${sold.toFixed(1)}t${pure}${extra}`, player };
    }
    if (manual && opts.phase === "dump" && v.cargo > 0.04 && v.cargoOre) {
      // Hand dumping: into a truck if one is under the bucket, otherwise onto the ground.
      if (kind === "excavator") {
        const tip = bucketPoint(v.x, v.z, v.yaw, v.tool);
        const truck = truckNear(state, v, tip.x, tip.z, 5.5);
        if (truck) {
          const msg = loadTruck(state, index, 99, truck);
          if (player) log(state, msg);
        } else {
          dropInFront(state, v, tip.x, tip.z);
          if (player) v.status = "Dumped on the ground";
        }
        v.busy = true;
        return null;
      }
      if (kind === "skid" || kind === "loader") {
        const truck = truckNear(state, v, v.x + fx * 3, v.z + fz * 3, 6.5);
        if (truck) {
          const msg = loadTruck(state, index, 99, truck);
          if (player) log(state, msg);
        } else {
          dropInFront(state, v, v.x + fx * (st.radius + 2.6), v.z + fz * (st.radius + 2.6));
          if (player) v.status = "Dumped on the ground";
        }
        v.busy = true;
        return null;
      }
      if (kind === "truck") {
        dropInFront(state, v, v.x - fx * (st.radius + 3), v.z - fz * (st.radius + 3));
        if (player) v.status = "Dumped on the ground. Back up to the crusher to get paid.";
        v.busy = true;
        return null;
      }
    }
    if (opts.phase === "dump") return null;
    if (!player && v.defId === "skid" && v.cargoOre && st.capacity > 0 && v.cargo >= st.capacity * 0.85 && plannedSource?.kind !== "pile" && loaderInArea(state, v)) {
      const spot = stockLatch.get(v);
      if (spot && distTo(v.x, v.z, spot.x, spot.z) < 4.5) {
        addPile(state, v.cargoOre, v.cargo, spot.x, spot.z, v.workClaim ?? 1, v.cargoPurity ?? 1);
        emptyCargo(v);
        v.status = "Stockpiled for the loader";
        return null;
      }
    }
  }

  if (!scoopingAssignedPile && def.dig > 0 && st.capacity > 0 && v.cargo < st.capacity - 0.03) {
    const tip = manual && kind === "excavator" ? bucketPoint(v.x, v.z, v.yaw, v.tool) : { x: v.x, z: v.z };
    const vein = closestFace(state, tip.x, tip.z, v);
    if (vein) {
      if (!ownsClaim(state, vein.claim)) {
        if (player) v.status = "Unleased ground";
        return null;
      }
      const output = faceOutput(vein, opts.cut);
      if (v.cargo > 0.08 && v.cargoOre && v.cargoOre !== output) {
        if (manual) {
          if (player) v.status = `Dump the ${ORES[v.cargoOre].name.toLowerCase()} first`;
          return null;
        }
        addPile(state, v.cargoOre, v.cargo, v.x + fx * 6, v.z + fz * 6, v.workClaim ?? 1, v.cargoPurity ?? 1);
        emptyCargo(v);
      }
      v.busy = true;
      if (!takeBite(v, dt, 0.5)) {
        if (player) v.status = `Breaking ${ORES[output].name}`;
        return null;
      }
      const want = Math.min(vein.ore === "dirt" || output === "dirt" ? Infinity : vein.tons, st.dig * 0.5 * digRate(vein));
      const res = vein.ore === "dirt"
        ? { ore: true, tons: Math.min(vein.tons, want), purity: 1, slide: false, benched: false }
        : cutFace(vein, want, opts.cut, opts.quality);
      const bite = res.tons;
      if (res.ore) vein.tons -= bite;
      cutLog(state, vein, res, player);
      if (bite > 0) {
        const room = st.capacity - v.cargo;
        const precious = output === "gold" || output === "copper";
        const truckBeside = state.vehicles.some(
          (o) => o !== v && DEFS[o.defId].receives && vehicleStats(o).capacity - o.cargo > 0.4 && distTo(v.x, v.z, o.x, o.z) < 16,
        );
        let intoBucket: number;
        if (manual) intoBucket = Math.min(room, bite * (0.45 + 0.55 * opts.quality));
        else intoBucket = def.id === "excavator" ? Math.min(room, truckBeside ? bite : bite * 0.2) : Math.min(room, precious ? bite : bite * 0.62);
        const spill = bite - intoBucket;
        if (intoBucket > 0.01) cargoInto(v, output, intoBucket, res.purity);
        const dx = v.x - vein.x;
        const dz = v.z - vein.z;
        const dist = Math.hypot(dx, dz) || 1;
        const side = def.id === "excavator" ? 8 : 0;
        const toeX = vein.x + (dx / dist) * 4.2 + (-dz / dist) * side;
        const toeZ = vein.z + (dz / dist) * 4.2 + (dx / dist) * side;
        if (spill > 0.04) addPile(state, output, spill, toeX, toeZ, vein.claim, res.purity);
        breaks.push({
          x: vein.x,
          z: vein.z,
          tx: spill > intoBucket ? toeX : v.x,
          tz: spill > intoBucket ? toeZ : v.z,
          ore: output,
        });
        if (player) {
          state.tutorial.loaded = true;
          v.status = output === "dirt" && vein.ore !== "dirt" ? `Stripped ${bite.toFixed(1)} tons of dirt off the top` : `Broke ${bite.toFixed(1)} tons of ${ORES[output].name}`;
        }
      }
      return null;
    }
  }

  if (def.scoop > 0 && st.capacity > 0 && v.cargo < st.capacity - 0.03) {
    // Realistic bucket curl remains the precision input. An explicit hold of
    // Work (phase "auto") is also an assisted scoop, so players do not lose
    // the ability to clear loose piles when the sticks are hard to use on mobile.
    if (v.manual && (kind === "skid" || kind === "loader") && opts.phase !== "fill" && opts.phase !== "auto") {
      if (player) v.status = "Lower the bucket and curl it to scoop";
      return null;
    }
    const pile = pileInReach(state, v);
    const assigned = v.operator && v.workClaim != null ? bestVein(state, v, null) : null;
    const spot = assigned ?? (wheelLoader(v.defId) ? loaderFillVein(state, v) : null);
    let faceNear = false;
    if (spot && wheelLoader(v.defId)) {
      const stand = loaderStand(v, spot);
      faceNear = distTo(v.x, v.z, stand.x, stand.z) <= stand.reach + 1.4;
    }
    if (spot && !faceNear) {
      const cut = faceOf(spot);
      faceNear = distTo(v.x, v.z, cut.x, cut.z) <= cut.reach;
    }
    const source = !scoopingAssignedPile && faceNear && spot ? spot : pile && pile.tons > 0.05 ? pile : null;
    if (source) {
      if (!ownsClaim(state, source.claim)) return null;
      const output = source.kind === "vein" ? faceOutput(source, opts.cut) : source.ore;
      if (v.cargo > 0.08 && v.cargoOre && v.cargoOre !== output) {
        if (player) v.status = `Dump ${ORES[v.cargoOre].name} first`;
        return null;
      }
      v.busy = true;
      if (!takeBite(v, dt, 0.42)) {
        if (player) v.status = `Scooping ${ORES[output].name}`;
        return null;
      }
      const want = Math.min(st.capacity - v.cargo, st.scoop * 0.42);
      if (source.kind === "vein" && source.ore !== "dirt") {
        const res = cutFace(source, Math.min(want * digRate(source), output === "dirt" ? want : source.tons), opts.cut, opts.quality);
        if (res.ore) source.tons -= res.tons;
        cutLog(state, source, res, player);
        if (res.tons > 0) cargoInto(v, output, res.tons, res.purity);
      } else {
        const take = Math.min(source.tons, want);
        if (take > 0) {
          source.tons -= take;
          // A sloppy, fast scoop picks up ground dirt with the pile.
          const keep = manual ? take * (0.5 + 0.5 * opts.quality) : take;
          if (keep < take - 0.01) addPile(state, source.ore, take - keep, v.x + fx * 2.5, v.z + fz * 2.5, source.claim, source.purity ?? 1);
          cargoInto(v, source.ore, keep, (source.purity ?? 1) * (0.85 + 0.15 * opts.quality));
        }
      }
      breaks.push({ x: source.x, z: source.z, tx: v.x, tz: v.z, ore: output });
      if (player) state.tutorial.loaded = true;
      return null;
    }
  }

  if (def.push > 0) {
    const src = materialInFront(state, v, def.range);
    if (src && ownsClaim(state, src.claim) && acceptsJob(state, v, src)) {
      const want = st.push * dt * (src.kind === "vein" ? digRate(src) : 1) * (manual ? 1.6 - v.tool.lift * 2 : 1);
      // Spoil lands in front of the blade. Dropping it at the vein buried the pile in the hill.
      const dropX = v.x + fx * (st.radius + 1.8);
      const dropZ = v.z + fz * (st.radius + 1.8);
      let ore = src.ore;
      let take = 0;
      let purity = src.purity ?? 1;
      if (src.kind === "vein" && src.ore !== "dirt") {
        ore = faceOutput(src, opts.cut);
        const res = cutFace(src, ore === "dirt" ? want : Math.min(src.tons, want), opts.cut, opts.quality);
        if (res.ore) src.tons -= res.tons;
        cutLog(state, src, res, player);
        take = res.tons;
        purity = res.purity;
      } else {
        take = Math.min(src.tons, want);
        src.tons -= take;
      }
      if (take > 0) {
        if (src.id !== "slide-gap") addPile(state, ore, take, dropX, dropZ, src.claim, purity);
        if (takeBite(v, dt, 0.34)) breaks.push({ x: src.x, z: src.z, tx: dropX, tz: dropZ, ore });
        v.busy = true;
        if (player) state.tutorial.loaded = true;
      }
      return null;
    }
  }

  if (player && v.cargo > 0.04 && v.cargoOre && !v.status.includes("sluice") && !v.status.startsWith("Wash plant")) {
    v.status = `${ORES[v.cargoOre].name} stays in the bucket`;
  }
  return null;
}
