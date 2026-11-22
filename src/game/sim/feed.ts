/** Plant hoppers, feed piles, and the yard feeder. */

import * as Ops from "@/game/ops";
import { CREW_KEEP, ORES, PADS, formatMoney } from "@/game/catalog";
import { areaOf, otherBank } from "@/game/river";
import { recordSale } from "@/game/market";
import { mixPurity, purityFactor } from "@/game/mining";
import type { Deposit, GameState, OreId, PadKind, VehicleId, VehicleState } from "@/game/types";
import type { Control, StepFX } from "./types.ts";
import type { Plants } from "./economy.ts";
import { fillContract, unitPrice } from "./economy.ts";
import { distTo, homeClaim, livePads, log, padOpen, sameArea } from "./world.ts";
import { fillsHaulers, lineFor } from "./haulers.ts";
import { seek } from "./motion.ts";
import { regen } from "./blast.ts";

/** Plants with a feed hopper. Haul trucks tip a pile there instead of selling straight in. */
export const FEED_PADS = new Set<PadKind>(["wash", "sluice", "mill"]);

export function dumpsToFeed(defId: VehicleId, pad: PadKind) {
  return (defId === "truck" || defId === "heavy") && FEED_PADS.has(pad);
}
/** The free lease in each area, so a feed pile counts as yours there. */

/** Machines that can feed a plant's pile, in tons per second. */
export const FEED_RATES: Partial<Record<VehicleId, number>> = { excavator: 1.8, loader: 1.4, hloader: 2.4, skid: 0.5 };

function padKindForFeed(pile: Deposit) {
  return padForFeedPile(pile.id)?.kind ?? null;
}


function feedCrewFor(state: GameState, pile: Deposit) {
  const padKind = padKindForFeed(pile);
  const open = (v: VehicleState, index: number, rate: number | undefined) =>
    !!rate && v.operator && sameArea(v, pile) && !otherBank(v.x, pile.x) &&
    !(index === state.active && !state.watching) && !(state.deck ?? []).includes(v.uid);
  const dedicated = state.vehicles
    .map((v, index) => ({ v, index, rate: FEED_RATES[v.defId] }))
    .filter(({ v, index, rate }) => open(v, index, rate) && (v.feederPad === padKind && (padKind === "sluice" || padKind === "wash")));
  const taken = new Set(dedicated.map(({ index }) => index));
  const candidates = state.vehicles
    .map((v, index) => ({ v, index, rate: FEED_RATES[v.defId] }))
    .filter(({ v, index, rate }) =>
      !taken.has(index) && open(v, index, rate) && v.cargo <= 0.25 &&
      !(fillsHaulers(v.defId) && lineFor(state, v).length > 0) &&
      distTo(v.x, v.z, pile.x, pile.z) < (v.defId === "excavator" ? FEED_CALL_RANGE : 120),
    )
    .sort((a, b) => distTo(a.v.x, a.v.z, pile.x, pile.z) - distTo(b.v.x, b.v.z, pile.x, pile.z));
  const extra = state.feedLimit === "all" ? candidates : candidates.slice(0, state.feedLimit);
  return [...dedicated, ...extra];
}
/** Each plant's own slow yard feeder (a small conveyor and grizzly) when no machine is feeding. */

/** Each plant's own slow yard feeder (a small conveyor and grizzly) when no machine is feeding. */
export const YARD_FEED_RATE = 0.1;
/** The yard feeder keeps a 20% cut, so it pays less than a crew feeding. */

/** The yard feeder keeps a 20% cut, so it pays less than a crew feeding. */
export const YARD_FEED_KEEP = 0.8;

export const FEED_REACH = 10;
/** An excavator further off than this keeps digging; the yard feeder covers it. */

/** An excavator further off than this keeps digging; the yard feeder covers it. */
export const FEED_CALL_RANGE = 60;


export function feedId(padId: string) {
  return `feed-${padId}`;
}


function padForFeedPile(id: string) {
  return PADS.find((p) => id === feedId(p.id) || id.startsWith(`${feedId(p.id)}--`)) ?? null;
}


export function sideFeedId(padId: string, ore: OreId) {
  return `${feedId(padId)}--${ore}`;
}

/** One feed pile per plant; loads tipped there stack on it. */

/** One feed pile per plant; loads tipped there stack on it. */
export function addFeedPile(state: GameState, pad: { id: string; x: number; z: number }, ore: OreId, tons: number, purity: number) {
  const id = feedId(pad.id);
  const have = state.deposits.find((d) => d.id === id);
  if (have) {
    if (have.ore !== ore && have.tons > 0.05) {
      // A different ore can't share the hopper. Park it on a feed-side pile so
      // a loader will not haul it back into the plant and dump it unpaid again.
      const sid = sideFeedId(pad.id, ore);
      const side = state.deposits.find((d) => d.id === sid);
      if (side) {
        side.purity = side.tons > 0.05 ? mixPurity(side.tons, side.purity, tons, purity) : purity;
        side.ore = ore;
        side.tons += tons;
        side.max = Math.max(side.max, side.tons);
        return;
      }
      state.deposits.push({
        id: sid, kind: "pile", ore, tons, max: tons, x: pad.x + 8, z: pad.z + 8, regen: 0,
        claim: homeClaim(areaOf(pad.x)), radius: 6, sign: "FEED", purity, overburden: 0, grade: 1,
        stress: 0, bench: 1, benchProgress: 0, hard: false, tested: true, lastBlastDay: -1,
      });
      return;
    }
    have.purity = have.tons > 0.05 ? mixPurity(have.tons, have.purity, tons, purity) : purity;
    have.ore = ore;
    have.tons += tons;
    have.max = Math.max(have.max, have.tons);
    return;
  }
  state.deposits.push({
    id, kind: "pile", ore, tons, max: tons, x: pad.x, z: pad.z, regen: 0,
    claim: homeClaim(areaOf(pad.x)), radius: 6, sign: "FEED", purity, overburden: 0, grade: 1,
    stress: 0, bench: 1, benchProgress: 0, hard: false, tested: true, lastBlastDay: -1,
  });
}


const feedAcc = new Map<string, number>();
/** Tons already paid when a truck dumped them. The feeder still clears the pile, but does not pay twice. */

/** Tons already paid when a truck dumped them. The feeder still clears the pile, but does not pay twice. */
export const feedPaid = new WeakMap<Deposit, number>();
/**
 * Feed plant piles. Machines parked at the pile feed at their rate (the player only while
 * holding the work button); with nobody there the plant's yard feeder trickles it in.
 * Pays as it goes; the pile is fed down to zero and then removed.
 */

/**
 * Feed plant piles. Machines parked at the pile feed at their rate (the player only while
 * holding the work button); with nobody there the plant's yard feeder trickles it in.
 * Pays as it goes; the pile is fed down to zero and then removed.
 */
export function feedTick(state: GameState, dt: number, playerAction: boolean, sales: StepFX["sales"]) {
  for (const d of [...state.deposits]) {
    if (!d.id.startsWith("feed-") || d.kind !== "pile") continue;
    const pad = padForFeedPile(d.id);
    if (!pad) continue;
    const unit = unitPrice(d.ore, pad.kind, state.sluice, state.market) * purityFactor(d.ore, d.purity ?? 1) * Ops.saleMult(state, d.ore, pad.kind);
    const crew = new Set(feedCrewFor(state, d).map(({ index }) => index));
    const feeders: { rate: number; keep: number; player: boolean }[] = [];
    state.vehicles.forEach((v, i) => {
      const rate = FEED_RATES[v.defId];
      if (!rate || !sameArea(v, d) || distTo(v.x, v.z, d.x, d.z) > FEED_REACH || Math.abs(v.speed) > 1.5) return;
      const player = i === state.active && !state.watching;
      if (player ? !playerAction : !crew.has(i)) return;
      v.busy = true;
      v.status = v.feederPad === "sluice" ? "Feeding sluice" : v.feederPad === "wash" ? "Feeding wash plant" : `Feeding the ${pad.name.toLowerCase()}`;
      feeders.push({ rate, keep: player ? 1 : CREW_KEEP, player });
    });
    if (!feeders.length) feeders.push({ rate: YARD_FEED_RATE, keep: YARD_FEED_KEEP, player: false });
    let paid = 0;
    let tons = 0;
    let byPlayer = false;
    let prepaid = feedPaid.get(d) ?? 0;
    for (const f of feeders) {
      let room = f.rate * dt;
      if (prepaid > 0 && d.tons > 0) {
        const done = Math.min(d.tons, prepaid, room);
        d.tons -= done;
        prepaid -= done;
        room -= done;
      }
      const t = Math.min(d.tons, room);
      if (t <= 0) continue;
      d.tons -= t;
      tons += t;
      paid += t * unit * f.keep;
      byPlayer ||= f.player;
    }
    if (prepaid <= 0) feedPaid.delete(d);
    else feedPaid.set(d, prepaid);
    const done = d.tons <= 1e-3;
    if (done) {
      state.deposits = state.deposits.filter((o) => o !== d);
      feedAcc.delete(d.id);
      feedPaid.delete(d);
      if (tons > 0) log(state, `${pad.name} feed pile is fed in.`);
    }
    if (tons <= 0) continue;
    recordSale(state.market, pad.kind, d.ore, tons);
    fillContract(state, d.ore, tons);
    state.cash += paid;
    state.lifetime += paid;
    Ops.onSale(state, paid, tons);
    const acc = (feedAcc.get(d.id) ?? 0) + paid;
    if (acc >= 250 || done) {
      sales.push({ x: d.x, z: d.z, text: `+${formatMoney(acc)} fed`, player: byPlayer });
      feedAcc.set(d.id, 0);
    } else feedAcc.set(d.id, acc);
  }
}

/** Crew loader/excavator job: go feed the nearest plant pile in this area. */

/** Crew loader/excavator job: go feed the nearest plant pile in this area. */
export function feederStatus(kind: "sluice" | "wash") {
  return kind === "sluice" ? "Feeding sluice" : "Feeding wash plant";
}


function assignedFeederPad(state: GameState, v: VehicleState) {
  const kind = v.feederPad;
  if (kind !== "sluice" && kind !== "wash") return null;
  if (!padOpen(state, kind)) return null;
  return livePads(state).find((p) => p.kind === kind && areaOf(p.x) === areaOf(v.x)) ?? null;
}


export function feedJob(state: GameState, v: VehicleState): Control | null {
  if (!FEED_RATES[v.defId]) return null;
  const assigned = assignedFeederPad(state, v);
  if (assigned) {
    v.status = feederStatus(assigned.kind === "wash" ? "wash" : "sluice");
    if (distTo(v.x, v.z, assigned.x, assigned.z) > FEED_REACH - 2) {
      return seek(v, assigned.x, assigned.z, FEED_REACH - 3);
    }
    if (v.cargo > 0.25 && v.cargoOre) return { throttle: 0, steer: 0, action: true, brake: 1 };
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  if (v.cargo > 0.25) return null;
  // Trucks waiting on this machine come first; the plant feeds itself meanwhile.
  if (fillsHaulers(v.defId) && lineFor(state, v).length > 0) return null;
  const index = state.vehicles.indexOf(v);
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (!d.id.startsWith("feed-") || d.tons <= 0.01 || !sameArea(v, d) || otherBank(v.x, d.x)) continue;
    if (!feedCrewFor(state, d).some((candidate) => candidate.index === index)) continue;
    const dist = distTo(v.x, v.z, d.x, d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (!best) return null;
  if (bestD <= FEED_REACH - 2) {
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  v.status = "Heading to feed the plant";
  return seek(v, best.x, best.z, FEED_REACH - 3);
}


export function addPile(state: GameState, ore: OreId, tons: number, x: number, z: number, claim = 1, purity = 1) {
  if (tons <= 0) return;
  let best: Deposit | null = null;
  let bestD = 16;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.ore !== ore || d.id.startsWith("feed-") || d.id === "slide-gap") continue;
    const dist = distTo(x, z, d.x, d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (!best) {
    const loose = state.deposits.filter((d) => d.kind === "pile" && d.regen <= 0);
    if (loose.length >= 16) {
      let near = loose[0];
      let nd = Infinity;
      for (const d of loose) {
        if (d.ore !== ore) continue;
        const dist = distTo(x, z, d.x, d.z);
        if (dist < nd) {
          nd = dist;
          near = d;
        }
      }
      if (near.ore === ore) best = near;
    }
  }
  if (best) {
    const t = best.tons + tons;
    best.purity = mixPurity(best.tons, best.purity ?? 1, tons, purity);
    best.x = (best.x * best.tons + x * tons) / t;
    best.z = (best.z * best.tons + z * tons) / t;
    best.tons = t;
    best.max = Math.max(best.max, t);
    if (best.id !== "starter" && claim !== 1) best.claim = claim;
    return;
  }
  state.pileSeq += 1;
  state.deposits.push({
    id: `pile-${state.pileSeq}`,
    kind: "pile",
    ore,
    tons,
    max: tons,
    x,
    z,
    regen: 0,
    claim,
    radius: 6,
    sign: ORES[ore].name.toUpperCase(),
    purity,
    overburden: 0,
    grade: purity,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: true,
    lastBlastDay: -1,
  });
}
