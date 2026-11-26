/** Map helpers, vehicles, pads, claims, and a fresh save. */

import * as Ops from "@/game/ops";
import { MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, X1 } from "@/game/mountain";
import { BASE_DEPOSITS, DEFS, GATE, PADS, SPAWNS, START_CASH } from "@/game/catalog";
import { BRIDGE, HAUL_FEE, UNLOCK_CLAIM, VALLEY_CLAIMS, X0, areaOf, RIVER } from "@/game/river";
import { homeTool } from "@/game/controls";
import { freshMarket } from "@/game/market";
import { areaIn } from "@/game/lowboy";
import { damageFactor } from "@/game/mining";
import type { AreaId } from "@/game/river";
import type { Deposit, GameState, PadKind, VehicleId, VehicleState } from "@/game/types";
import type { Plants } from "./economy.ts";
import { MARKET_KEYS, rollContract } from "./economy.ts";
import { acceptsJob } from "./jobs.ts";
import { regen } from "./blast.ts";


export function faceOf(d: Deposit) {
  const dug = d.max > 0 ? clamp(1 - d.tons / d.max, 0, 1) : 1;
  const gate = gateFor(d.x);
  let rx = d.x - gate.x;
  let rz = d.z - gate.z;
  const len = Math.hypot(rx, rz) || 1;
  rx /= len;
  rz /= len;
  // Fresh ground is at the opening. The cut walks away from the gate as it is mined.
  const along = d.radius * (-0.85 + dug * 1.7);
  let x = d.x + rx * along;
  let z = d.z + rz * along;
  // The valley quarry is cut into the west cliff. A dug face must stay on the
  // open side of that wall, or the crew drives through the gap and gets stuck behind it.
  if (areaOf(d.x) === "river" && x < X0 - 76) x = X0 - 76;
  // East rim is cut into the east wall. Keep the face on the bank side of it.
  if (d.id === "east-rim" && x > X0 + 82) x = X0 + 82;
  // Gold gravel sits in a tight west pocket. Keep the cut on the open creek side
  // so the crew does not walk into the corner between the west and southwest walls.
  if (d.id === "gold") {
    // Stand on the east lip of the creek, not in the west fence pocket.
    if (x < -74) x = -74;
    if (z < 16) z = 16;
  }
  // The south gold bar walks into the truck lineup as it is mined. Keep the face
  // on the open (bridge) side of the bar.
  if (d.id === "bar-gold" && z < -44) z = -44;
  return { x, z, reach: 3.6, yaw: Math.atan2(-rx, -rz) };
}

/** Where faces are approached from: the pit gate on the ridge, the bridge in the valley. */

/** Where faces are approached from: the pit gate on the ridge, the bridge in the valley. */
export function gateFor(x: number) {
  if (areaOf(x) === "mountain") return { x, z: 60 };
  return areaOf(x) === "river" ? { x: BRIDGE.x, z: BRIDGE.z } : GATE;
}


export function sameArea(a: { x: number }, b: { x: number }) {
  return areaOf(a.x) === areaOf(b.x);
}


export function claimAreaOf(id: number): AreaId {
  return id >= MOUNTAIN_CLAIM ? "mountain" : id >= VALLEY_CLAIMS.bars ? "river" : "ridge";
}

/** Loose river gravel a hired loader can scoop when no pile has been built. */

/** Loose river gravel a hired loader can scoop when no pile has been built. */
export function isRiverBar(d: Deposit) {
  return d.kind === "vein" && d.claim === VALLEY_CLAIMS.bars;
}

/** A wheel loader may cut river bars, a claim or team face, or a face another digger is already on. */


export function numberFleet(state: GameState) {
  const used = new Map<VehicleId, Set<number>>();
  for (const vehicle of state.vehicles) {
    const numbers = used.get(vehicle.defId) ?? new Set<number>();
    used.set(vehicle.defId, numbers);
    const number = vehicle.unitNo;
    if (number && !numbers.has(number)) numbers.add(number);
    else vehicle.unitNo = undefined;
  }
  for (const vehicle of state.vehicles) {
    if (vehicle.unitNo) continue;
    const numbers = used.get(vehicle.defId)!;
    let number = 1;
    while (numbers.has(number)) number++;
    numbers.add(number);
    vehicle.unitNo = number;
  }
}

export function vehicleName(state: GameState, vehicle: VehicleState) {
  const base = DEFS[vehicle.defId].name;
  const numbered = vehicle.unitNo && (vehicle.unitNo > 1 ||
    state.vehicles.some((other) => other !== vehicle && other.defId === vehicle.defId));
  return numbered ? `${base} #${vehicle.unitNo}` : base;
}

export function pileName(pile: Deposit) {
  const number = pile.id.match(/^pile-(\d+)$/)?.[1];
  return number ? `Pile #${number} · ${prettySign(pile.ore)}` : prettySign(pile.sign);
}

export function prettySign(sign: string) {
  return sign.toLowerCase().replace(/(^|[\s·])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}


export function closestFace(state: GameState, x: number, z: number, v?: VehicleState) {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 0.08) continue;
    if (v && !acceptsJob(state, v, d)) continue;
    const face = faceOf(d);
    const dist = distTo(x, z, face.x, face.z);
    if (dist <= face.reach && dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}


export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}


export function hypot(x: number, z: number) {
  return Math.hypot(x, z);
}


export function vehicleStats(v: VehicleState) {
  const d = DEFS[v.defId];
  const hurt = damageFactor(v.damage ?? 0);
  const eng = (1 + v.upgrades.engine * 0.18) * hurt;
  const body = 1 + v.upgrades.body * 0.28;
  const hydro = 1 + v.upgrades.hydro * 0.3;
  const capacity = d.capacity === 0 ? 0 : d.capacity * body;
  const push = d.push * hydro * (d.capacity === 0 ? body : 1);
  return {
    maxSpeed: d.maxSpeed * eng,
    accel: d.accel * eng,
    turn: d.turn,
    capacity,
    dig: d.dig * hydro * hurt,
    scoop: d.scoop * hydro * hurt,
    push: push * hurt,
    radius: d.radius,
  };
}

/** Today's price per ton at a selling spot (normal price × the day's market move). */


export function ownsClaim(state: GameState, claim: number) {
  return state.claims.includes(claim);
}


export function owns(state: GameState, id: VehicleId) {
  return state.vehicles.some((v) => v.defId === id);
}


export function log(state: GameState, msg: string) {
  state.log.unshift(msg);
  if (state.log.length > 5) state.log.length = 5;
}


export function freshGame(company: string): GameState {
  const name = company.trim().slice(0, 24) || "Ridge Ore Co.";
  return {
    version: 4,
    ops: Ops.freshOps(),
    controlMode: "real",
    market: freshMarket(Math.floor(Math.random() * 0xffffffff), MARKET_KEYS),
    explosives: 0,
    blast: null,
    company: name,
    cash: START_CASH,
    lifetime: 0,
    seconds: 0,
    claims: [1],
    sluice: false,
    preferSluice: true,
    feedLimit: 2,
    washPlant: false,
    wet: 0,
    muted: false,
    deck: [],
    watching: false,
    crews: [],
    vehicles: (() => {
      const pickup = makeVehicle("pickup", 0);
      const plant = makeVehicle("crusher", 1);
      plant.x = 34;
      plant.z = 36;
      plant.yaw = Math.PI;
      return [pickup, plant];
    })(),
    active: 0,
    deposits: BASE_DEPOSITS.map((d) => ({ ...d })),
    pileSeq: 1,
    tutorial: { loaded: false, dumped: false, bought: false },
    contractSeq: 0,
    contract: rollContract(0, [1], { sluice: false, washPlant: false }),
    log: ["The claim truck is fueled. The iron pile is south of the gate."],
  };
}


export function makeVehicle(id: VehicleId, slot: number): VehicleState {
  const spawn = SPAWNS[slot] ?? { x: SPAWNS[0].x + slot, z: SPAWNS[0].z };
  return {
    uid: `${id}-${slot}-${Math.floor(Math.random() * 9999)}`,
    defId: id,
    x: spawn.x,
    z: spawn.z,
    yaw: 0,
    speed: 0,
    cargoOre: null,
    cargo: 0,
    cargoPurity: 1,
    damage: 0,
    tool: homeTool(id),
    manual: false,
    upgrades: { engine: 0, body: 0, hydro: 0 },
    hired: false,
    operator: false,
    workClaim: null,
    workFace: null,
    crewId: null,
    feederPad: null,
    status: "Parked",
    stuck: 0,
    unstick: 0,
    bias: 1,
    busy: false,
  };
}


export function distTo(x: number, z: number, tx: number, tz: number) {
  return hypot(tx - x, tz - z);
}


export function livePads(state: GameState) {
  const plant = state.vehicles.find((v) => v.defId === "crusher");
  return PADS.map((pad) => {
    if (pad.kind !== "crusher" || !plant) return pad;
    return { ...pad, x: plant.x, z: plant.z, r: 11 };
  });
}

/** Is this selling spot built? */

/** Is this selling spot built? */
export function padOpen(state: GameState, kind: PadKind) {
  if (kind === "sluice") return state.sluice;
  if (kind === "wash") return state.washPlant;
  return true;
}


export function nearestPad(state: GameState, x: number, z: number) {
  let best: ReturnType<typeof livePads>[number] | null = null;
  let bestD = Infinity;
  for (const pad of livePads(state)) {
    if (!padOpen(state, pad.kind)) continue;
    const d = distTo(x, z, pad.x, pad.z);
    if (d < bestD) {
      bestD = d;
      best = pad;
    }
  }
  return best && bestD <= best.r ? best : null;
}

/** The machine you are driving. Watching means you stepped out, so nobody is in a seat. */

/** The machine you are driving. Watching means you stepped out, so nobody is in a seat. */
export function handsOn(state: GameState, v: VehicleState) {
  return !state.watching && v === state.vehicles[state.active];
}


export function closestDeposit(
  state: GameState,
  x: number,
  z: number,
  kind: "vein" | "pile" | "any",
  extra = 0,
  v?: VehicleState,
) {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (kind !== "any" && d.kind !== kind) continue;
    if (kind === "pile" && d.id.startsWith("feed-")) continue;
    if (v && !acceptsJob(state, v, d)) continue;
    if (d.tons < 0.08 && d.regen <= 0) continue;
    const dist = distTo(x, z, d.x, d.z);
    const zone = d.radius + extra;
    if (dist <= zone && dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** Plants with a feed hopper. Haul trucks tip a pile there instead of selling straight in. */

/** The free lease in each area, so a feed pile counts as yours there. */
export function homeClaim(area: AreaId) {
  return area === "mountain" ? MOUNTAIN_CLAIM : area === "river" ? VALLEY_CLAIMS.bars : 1;
}

/** Machines that can feed a plant's pile, in tons per second. */

/** Where a work order wants the machine. Null when it has no assignment. */
export function orderArea(state: GameState, m: VehicleState): AreaId | null {
  if (m.workFace) {
    const d = state.deposits.find((o) => o.id === m.workFace);
    if (d && ownsClaim(state, d.claim)) return areaOf(d.x);
  }
  if (m.workClaim != null && ownsClaim(state, m.workClaim)) return claimAreaOf(m.workClaim);
  return null;
}


export function yardPad(area: AreaId) {
  if (area === "mountain") return { x: X1 - 30, z: 52 };
  if (area === "river") return { x: X0 + 46, z: 40 };
  return { x: -8, z: 44 };
}

/** North road between yards, then a straight run once both ends are on the same map. */


export function sameBank(ax: number, bx: number) {
  if (areaOf(ax) !== "river" || areaOf(bx) !== "river") return areaOf(ax) === areaOf(bx);
  const as = Math.sign(ax - RIVER.x);
  const bs = Math.sign(bx - RIVER.x);
  return as === bs || as === 0 || bs === 0;
}


export function machineArea(state: GameState, v: VehicleState): AreaId {
  const lowboy = state.vehicles.find((o) => o.defId === "lowboy");
  const onDeck = (state.deck ?? []).includes(v.uid);
  return onDeck && lowboy ? areaIn(lowboy.x, lowboy.z) : areaIn(v.x, v.z);
}

// ---------------------------------------------------------------- areas

export function currentArea(state: GameState): AreaId {
  const v = state.vehicles[state.active];
  return v ? areaIn(v.x, v.z) : "ridge";
}


export function valleyOpen(state: GameState) {
  return state.claims.includes(UNLOCK_CLAIM);
}


export function areaName(a: AreaId) {
  return a === "mountain" ? "High mountain" : a === "river" ? "River Valley" : "Ridge pit";
}

export function mountainUnlockable(state: GameState) {
  return state.claims.includes(VALLEY_CLAIMS.quarry) || state.claims.includes(VALLEY_CLAIMS.rim);
}


export function mountainOpen(state: GameState) {
  return state.claims.includes(MOUNTAIN_CLAIM);
}

/** Where the paid lowboy goes next: ridge → valley → mountain (once leased) → ridge. */

/** Where the paid lowboy goes next: ridge → valley → mountain (once leased) → ridge. */
export function haulTarget(state: GameState): AreaId {
  const here = currentArea(state);
  if (here === "ridge") return "river";
  if (here === "river") return mountainOpen(state) ? "mountain" : "ridge";
  return "ridge";
}


export function haulFee(from: AreaId, to: AreaId) {
  return from === "mountain" || to === "mountain" ? MOUNTAIN_HAUL_FEE : HAUL_FEE;
}
