import * as Ops from "@/game/ops";
import * as Career from "@/game/career";
import { climbFactor, gradeAt, rollAccel } from "@/game/terrain";
import { pileFootprint } from "@/game/piles";
import { MILL_PRICE, MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, MOUNTAIN_SPAWNS, SWITCHBACKS, X1, benchAt, coldFactor, switchbackWaypoint } from "@/game/mountain";
import {
  BASE_DEPOSITS,
  BLOCKS,
  CLAIMS,
  DEFS,
  GATE,
  HIRE_COST,
  CREW_KEEP,
  ORES,
  PADS,
  SLUICE,
  SPAWNS,
  START_CASH,
  VEHICLE_ORDER,
  formatMoney,
  usDist,
  inPit,
  boundsFor,
  tierInfo,
  upgradeCost,
} from "@/game/catalog";
import {
  BRIDGE,
  HAUL_FEE,
  RIVER_SPAWNS,
  UNLOCK_CLAIM,
  VALLEY_CLAIMS,
  WASH_PLANT,
  X0,
  areaOf,
  boggedDown,
  BARGE_RATE,
  bridgeMaxLoad,
  crossingWorth,
  otherBank,
  grossTons,
  MACHINE_TONS,
  mudDepth,
  mudSpeedFactor,
  inRiver,
  onBridge,
  bridgeLane,
  rainAt,
  RIVER,
  stepWet,
  TRACKED,
  type AreaId,
} from "@/game/river";
import {
  bladeDrag,
  bucketPoint,
  controlHelp,
  homeTool,
  machineKind,
  readGesture,
  stepTool,
  tankMotion,
  usesGears,
  type Gesture,
} from "@/game/controls";
import { DAY_SECONDS, advanceMarket, freshMarket, marketKey, priceMult, recordSale, trend } from "@/game/market";
import { AXLE_BACK, HITCH_Z, MOUNTAIN_GATE_X, PASS_SUMMIT_X, VALLEY_GATE_X, areaIn, blockRoadGate, deckFit, deckSpots, inDropYard, onHaulRoad, onMountainRoad, spotsUsed, stepHitch } from "@/game/lowboy";
import {
  BLAST_RADIUS,
  BLAST_COST,
  canBlastToday,
  DRILL_SECONDS,
  BORE_SECONDS,
  FUSE_SECONDS,
  TEST_HOLE_COST,
  blastDamage,
  blastYield,
  cutFace,
  damageFactor,
  digRate,
  mixPurity,
  purityFactor,
  repairCost,
} from "@/game/mining";
import type {
  ControlMode,
  Deposit,
  GameState,
  HudModel,
  Input,
  OreId,
  PadKind,
  UpgradeKind,
  VehicleId,
  VehicleState,
} from "@/game/types";

export type Control = {
  throttle: number;
  steer: number;
  action: boolean;
  brake: number;
};

export type StepFX = {
  dig: boolean;
  blasts: { x: number; z: number }[];
  sales: { x: number; z: number; text: string; player: boolean }[];
  breaks: { x: number; z: number; tx: number; tz: number; ore: OreId }[];
};

/** How the action key/gesture is being used this frame. */
export type WorkOpts = {
  phase: "auto" | "fill" | "dump";
  cut: "auto" | "top" | "toe";
  quality: number;
};

const AUTO_PLAYER: WorkOpts = { phase: "auto", cut: "auto", quality: 0.8 };
const AUTO_CREW: WorkOpts = { phase: "auto", cut: "auto", quality: 0.85 };

export const MARKET_PADS = ["crusher", "reclaim", "sluice", "loadout", "wash", "barge", "mill"] as const;
export const MARKET_KEYS = MARKET_PADS.flatMap((pad) => (Object.keys(ORES) as OreId[]).map((ore) => marketKey(pad, ore)));

const ZERO: Control = { throttle: 0, steer: 0, action: false, brake: 0 };
const saleAcc = new WeakMap<VehicleState, number>();
const biteAcc = new WeakMap<VehicleState, number>();

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
  const z = d.z + rz * along;
  // The valley quarry is cut into the west cliff. A dug face must stay on the
  // open side of that wall, or the crew drives through the gap and gets stuck behind it.
  if (areaOf(d.x) === "river" && x < X0 - 76) x = X0 - 76;
  // East rim is cut into the east wall. Keep the face on the bank side of it.
  if (d.id === "east-rim" && x > X0 + 82) x = X0 + 82;
  return { x, z, reach: 3.6, yaw: Math.atan2(-rx, -rz) };
}

/** Where faces are approached from: the pit gate on the ridge, the bridge in the valley. */
export function gateFor(x: number) {
  if (areaOf(x) === "mountain") return { x, z: 60 };
  return areaOf(x) === "river" ? { x: BRIDGE.x, z: BRIDGE.z } : GATE;
}

function sameArea(a: { x: number }, b: { x: number }) {
  return areaOf(a.x) === areaOf(b.x);
}

export function claimAreaOf(id: number): AreaId {
  return id >= MOUNTAIN_CLAIM ? "mountain" : id >= VALLEY_CLAIMS.bars ? "river" : "ridge";
}

function assignedClaim(v: VehicleState): number | null {
  if (v.workClaim == null) return null;
  const claimArea = claimAreaOf(v.workClaim);
  if (claimArea !== areaOf(v.x)) return null;
  return v.workClaim;
}

/** A face the crew was pointed at. Ignored until the machine is on that map, so the lowboy can carry the order up. */
function facePin(state: GameState, v: VehicleState): Deposit | null {
  if (!v.workFace) return null;
  const d = state.deposits.find((o) => o.id === v.workFace);
  if (!d || d.kind !== "vein" || d.tons < 0.35) return null;
  if (!ownsClaim(state, d.claim)) return null;
  if (areaOf(d.x) !== areaOf(v.x)) return null;
  return d;
}

function prettySign(sign: string) {
  return sign.toLowerCase().replace(/(^|[\s·])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

function closestFace(state: GameState, x: number, z: number, v?: VehicleState) {
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

function acceptsJob(state: GameState, v: VehicleState, d: Deposit) {
  const pin = facePin(state, v);
  if (pin && d.kind === "vein" && d.id !== pin.id) return false;
  if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) return false;
  if (d.id === "starter" && assignedClaim(v) != null) return false;
  if (v.workClaim == null && state.sluice && state.preferSluice && d.kind === "pile" && !prefersSluice(state, d.ore)) {
    const washing = state.deposits.some(
      (o) => o.kind === "vein" && o.tons > 1 && ownsClaim(state, o.claim) && prefersSluice(state, o.ore),
    );
    if (washing) return false;
  }
  return true;
}

function takeBite(v: VehicleState, dt: number, period: number) {
  const t = (biteAcc.get(v) ?? period) + dt;
  if (t < period) {
    biteAcc.set(v, t);
    return false;
  }
  biteAcc.set(v, t - period);
  return true;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function hypot(x: number, z: number) {
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
export function unitPrice(ore: OreId, pad: PadKind, sluice: boolean, market?: GameState["market"]) {
  return basePrice(ore, pad, sluice) * priceMult(market, pad, ore);
}

export function basePrice(ore: OreId, pad: PadKind, sluice: boolean) {
  const o = ORES[ore];
  if (pad === "wash") return o.wash;
  if (pad === "barge") return Math.round(o.crusher * BARGE_RATE);
  if (pad === "loadout") return o.crusher;
  if (pad === "mill") return MILL_PRICE[ore];
  if (pad === "reclaim") return ore === "dirt" ? o.reclaim : Math.round(o.crusher * 0.4);
  if (pad === "sluice") {
    if (!sluice) return 0;
    if (ore === "gold" || ore === "copper" || ore === "dirt") return o.sluice;
    return o.crusher;
  }
  return o.crusher;
}

function ownsClaim(state: GameState, claim: number) {
  return state.claims.includes(claim);
}

function owns(state: GameState, id: VehicleId) {
  return state.vehicles.some((v) => v.defId === id);
}

function log(state: GameState, msg: string) {
  state.log.unshift(msg);
  if (state.log.length > 5) state.log.length = 5;
}

type Plants = { sluice: boolean; washPlant: boolean };

/** Bonus price for a contract. Uses the pad the company can actually sell at. */
export function contractUnit(ore: OreId, plants: Plants) {
  if (ore === "silver") return plants.washPlant ? ORES.silver.wash : ORES.silver.crusher;
  if (ore === "gold") return plants.sluice ? ORES.gold.sluice : ORES.gold.crusher;
  return ORES[ore].crusher;
}

function rollContract(seq: number, claims: number[], plants: Plants): GameState["contract"] {
  const options: OreId[] = ["iron"];
  if (claims.includes(2)) options.push("copper");
  if (claims.includes(3)) options.push("gold");
  if (claims.includes(VALLEY_CLAIMS.bars)) options.push("silver");
  const ore = options[seq % options.length] ?? "iron";
  const need = (ore === "gold" ? 4 : ore === "copper" ? 6 : 8) + seq * 2;
  return { ore, delivered: 0, need, bonus: Math.round(need * contractUnit(ore, plants) * 0.5) };
}

function repriceContract(state: GameState) {
  const c = state.contract;
  if (!c) return;
  c.bonus = Math.round(c.need * contractUnit(c.ore, state) * 0.5);
}

function fillContract(state: GameState, ore: OreId, tons: number) {
  const contract = state.contract;
  if (!contract || contract.ore !== ore || tons <= 0) return 0;
  contract.delivered += tons;
  if (contract.delivered + 0.05 < contract.need) return 0;
  const bonus = Math.round(contract.bonus * Ops.contractMult(state));
  Ops.onContractFilled(state);
  state.cash += bonus;
  state.lifetime += bonus;
  state.contractSeq += 1;
  state.contract = rollContract(state.contractSeq, state.claims, state);
  log(state, `Contract filled. Bonus ${formatMoney(bonus)}. Next: ${state.contract.need} tons ${ORES[state.contract.ore].name}.`);
  return bonus;
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

function makeVehicle(id: VehicleId, slot: number): VehicleState {
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
    status: "Parked",
    stuck: 0,
    unstick: 0,
    bias: 1,
    busy: false,
  };
}

function distTo(x: number, z: number, tx: number, tz: number) {
  return hypot(tx - x, tz - z);
}

function livePads(state: GameState) {
  const plant = state.vehicles.find((v) => v.defId === "crusher");
  return PADS.map((pad) => {
    if (pad.kind !== "crusher" || !plant) return pad;
    return { ...pad, x: plant.x, z: plant.z, r: 11 };
  });
}

/** Is this selling spot built? */
export function padOpen(state: GameState, kind: PadKind) {
  if (kind === "sluice") return state.sluice;
  if (kind === "wash") return state.washPlant;
  return true;
}

function nearestPad(state: GameState, x: number, z: number) {
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

function nearestHauler(state: GameState, v: VehicleState, maxDist: number, operatedOnly: boolean) {
  const head = lineFor(state, v)[0];
  // No opportunistic fallback: following any nearby truck breaks the loading
  // queue and makes loaders chase trucks that are arriving, queued, or leaving.
  if (!head || !sameArea(head, v) || !bayReady.has(head)) return null;
  if (operatedOnly && !head.operator && state.vehicles[state.active] !== head) return null;
  const room = vehicleStats(head).capacity - head.cargo;
  if (room < 0.4 || (head.cargoOre && v.cargoOre && head.cargoOre !== v.cargoOre)) return null;
  return distTo(v.x, v.z, head.x, head.z) <= maxDist ? head : null;
}

function closestDeposit(
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
export const FEED_PADS = new Set<PadKind>(["wash", "sluice", "mill"]);
export function dumpsToFeed(defId: VehicleId, pad: PadKind) {
  return (defId === "truck" || defId === "heavy") && FEED_PADS.has(pad);
}
/** The free lease in each area, so a feed pile counts as yours there. */
export function homeClaim(area: AreaId) {
  return area === "mountain" ? MOUNTAIN_CLAIM : area === "river" ? VALLEY_CLAIMS.bars : 1;
}

/** Machines that can feed a plant's pile, in tons per second. */
export const FEED_RATES: Partial<Record<VehicleId, number>> = { excavator: 1.8, loader: 1.4, skid: 0.5 };
function feedCrewFor(state: GameState, pile: Deposit) {
  const candidates = state.vehicles
    .map((v, index) => ({ v, index, rate: FEED_RATES[v.defId] }))
    .filter(({ v, index, rate }) =>
      !!rate && v.operator && v.cargo <= 0.25 && sameArea(v, pile) && !otherBank(v.x, pile.x) &&
      !(index === state.active && !state.watching) && !(state.deck ?? []).includes(v.uid),
    )
    .sort((a, b) => distTo(a.v.x, a.v.z, pile.x, pile.z) - distTo(b.v.x, b.v.z, pile.x, pile.z));
  return candidates.slice(0, state.feedLimit === "all" ? candidates.length : state.feedLimit);
}
/** Each plant's own slow yard feeder (a small conveyor and grizzly) when no machine is feeding. */
export const YARD_FEED_RATE = 0.1;
/** The yard feeder keeps a 20% cut, so it pays less than a crew feeding. */
export const YARD_FEED_KEEP = 0.8;
export const FEED_REACH = 10;

export function feedId(padId: string) {
  return `feed-${padId}`;
}

/** One feed pile per plant; loads tipped there stack on it. */
export function addFeedPile(state: GameState, pad: { id: string; x: number; z: number }, ore: OreId, tons: number, purity: number) {
  const id = feedId(pad.id);
  const have = state.deposits.find((d) => d.id === id);
  if (have) {
    if (have.ore !== ore && have.tons > 0.05) {
      // A different ore can't share the hopper: start a side pile beside it.
      addPile(state, ore, tons, pad.x + 6, pad.z + 6, homeClaim(areaOf(pad.x)), purity);
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
const feedPaid = new WeakMap<Deposit, number>();
/**
 * Feed plant piles. Machines parked at the pile feed at their rate (the player only while
 * holding the work button); with nobody there the plant's yard feeder trickles it in.
 * Pays as it goes; the pile is fed down to zero and then removed.
 */
function feedTick(state: GameState, dt: number, playerAction: boolean, sales: StepFX["sales"]) {
  for (const d of [...state.deposits]) {
    if (!d.id.startsWith("feed-") || d.kind !== "pile") continue;
    const pad = PADS.find((p) => feedId(p.id) === d.id);
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
      v.status = `Feeding the ${pad.name.toLowerCase()}`;
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
function feedJob(state: GameState, v: VehicleState): Control | null {
  if (!FEED_RATES[v.defId] || v.cargo > 0.25) return null;
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

function addPile(state: GameState, ore: OreId, tons: number, x: number, z: number, claim = 1, purity = 1) {
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

function prefersSluice(state: GameState, ore: OreId, x?: number) {
  // The sluice is at the ridge. Away from it, sell where you are.
  // Dirt is topsoil. It can run through the sluice, but it must not outrank a real face.
  if (ore === "dirt") return false;
  if (x !== undefined && areaOf(x) !== "ridge") return false;
  return state.sluice && state.preferSluice && ORES[ore].sluice > ORES[ore].crusher;
}

/** Overburden on the ridge goes to the sluice once you own it. Washing it pays more than the fill buyer. */
function dirtToSluice(state: GameState, ore: OreId, x?: number) {
  if (ore !== "dirt" || !state.sluice || !state.preferSluice) return false;
  if (x !== undefined && areaOf(x) !== "ridge") return false;
  return true;
}

/** River silver, gold gravel, and overburden pay at the wash plant once it is built. Ridge dirt stays on the sluice. */
function prefersWash(state: GameState, ore: OreId, x: number) {
  return state.washPlant && areaOf(x) === "river" && ORES[ore].wash > ORES[ore].crusher;
}

function washScore(state: GameState, ore: OreId) {
  if (ore === "dirt" || !state.sluice || !state.preferSluice) return 0;
  return Math.max(0, ORES[ore].sluice - ORES[ore].crusher) * 40;
}

function canReach(v: VehicleState, padX: number) {
  if (areaOf(v.x) !== areaOf(padX)) return false;
  if (!otherBank(v.x, padX)) return true;
  return crossingWorth(v.defId, vehicleStats(v).capacity, v.cargo);
}

function bestPad(state: GameState, ore: OreId, x: number, z: number, v?: VehicleState) {
  let best: ReturnType<typeof livePads>[number] | null = null;
  let score = -Infinity;
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

function bestVein(state: GameState, v: VehicleState, ore: OreId | null) {
  const pinned = facePin(state, v);
  if (pinned && (!ore || pinned.ore === ore)) return pinned;
  let best: Deposit | null = null;
  let score = -1;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 1) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) continue;
    if (ore && d.ore !== ore) continue;
    if (!sameArea(d, v)) continue;
    const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z);
    const busy = crewNear(state, v, d.x, d.z, 16);
    const s = (unit * Math.min(d.tons, 50)) / (d0 + 10) + (d0 < 40 ? 1000 : 0) + (d.ore === "dirt" ? 0 : 2000) + washScore(state, d.ore) - busy * 2400;
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return best;
}

function slotOf(v: VehicleState) {
  let n = 0;
  for (let i = 0; i < v.uid.length; i++) n = (n + v.uid.charCodeAt(i) * (i + 1)) % 8;
  return n;
}

/** A spot on the near edge of a pile, locked so the machine does not orbit it. */
const approachLatch = new WeakMap<VehicleState, { id: string; x: number; z: number }>();

function pileApproach(v: VehicleState, pile: Deposit) {
  const prev = approachLatch.get(v);
  if (prev && prev.id === pile.id && distTo(v.x, v.z, pile.x, pile.z) < 22) return { x: prev.x, z: prev.z };
  const foot = pileFootprint(Math.max(pile.tons, 0.4));
  const dx = v.x - pile.x;
  const dz = v.z - pile.z;
  const ang = Math.atan2(dz, dx) + ((slotOf(v) % 5) - 2) * 0.38;
  const rx = foot.rx + 2.2;
  const rz = foot.rz + 2.2;
  const spot = { id: pile.id, x: pile.x + Math.cos(ang) * rx, z: pile.z + Math.sin(ang) * rz };
  approachLatch.set(v, spot);
  return spot;
}

function pileInReach(state: GameState, v: VehicleState) {
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
function crewNear(state: GameState, v: VehicleState, x: number, z: number, reach: number) {
  let n = 0;
  for (const o of state.vehicles) {
    if (o === v || !o.operator) continue;
    const od = DEFS[o.defId];
    if (od.dig <= 0 && od.scoop <= 0 && od.push <= 0) continue;
    if (distTo(o.x, o.z, x, z) < reach) n++;
  }
  return n;
}

const pileJob = new WeakMap<VehicleState, string>();
const truckPartner = new WeakMap<VehicleState, string>();

function bestPile(state: GameState, v: VehicleState) {
  let best: Deposit | null = null;
  let score = -1;
  let prev: Deposit | null = null;
  let prevScore = -1;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.tons < 0.4 || d.id.startsWith("feed-")) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (!acceptsJob(state, v, d)) continue;
    if (v.cargo > 0.15 && v.cargoOre && v.cargoOre !== d.ore) continue;
    if (!sameArea(d, v)) continue;
    if (v.defId === "skid" && loaderInArea(state, v) && d.tons < 8) continue;
    const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
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
const lineTicket = new WeakMap<VehicleState, number>();
let lineNo = 1;

function loaderInArea(state: GameState, v: VehicleState) {
  return state.vehicles.some(
    (o) => (o.defId === "loader" || o.defId === "excavator") && (o.operator || o === state.vehicles[state.active]) && areaOf(o.x) === areaOf(v.x),
  );
}

const stockLatch = new WeakMap<VehicleState, { x: number; z: number }>();

function stockSpot(v: VehicleState, source: { x: number; z: number }) {
  const prev = stockLatch.get(v);
  if (prev && distTo(prev.x, prev.z, source.x, source.z) < 26) return prev;
  const ang = (slotOf(v) / 8) * Math.PI * 2;
  const spot = { x: source.x + Math.cos(ang) * 12, z: source.z + Math.sin(ang) * 12 };
  stockLatch.set(v, spot);
  return spot;
}

function truckLeaving(t: VehicleState) {
  const cap = vehicleStats(t).capacity;
  return cap > 0 && t.cargo >= cap * 0.9;
}

function lineFor(state: GameState, digger: VehicleState) {
  const list = state.vehicles.filter((t) => {
    if (!DEFS[t.defId].receives || t === digger) return false;
    if (!(t.operator || t === state.vehicles[state.active])) return false;
    if (truckPartner.get(t) !== digger.uid) return false;
    if (!sameArea(t, digger)) return false;
    if (t.defId === "heavy" && otherBank(t.x, digger.x)) return false;
    if (truckLeaving(t)) return false;
    return true;
  });
  for (const t of list) if (!lineTicket.has(t)) lineTicket.set(t, lineNo++);
  list.sort((a, b) => (lineTicket.get(a) ?? 0) - (lineTicket.get(b) ?? 0));
  return list;
}

function diggerForTruck(state: GameState, v: VehicleState) {
  const open = (o: VehicleState) =>
    (o.defId === "loader" || o.defId === "excavator") &&
    (o.operator || o === state.vehicles[state.active]) &&
    !(v.defId === "heavy" && otherBank(v.x, o.x));
  const prev = state.vehicles.find((o) => o.uid === truckPartner.get(v) && open(o));
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
    if (!lineTicket.has(v)) lineTicket.set(v, lineNo++);
  } else truckPartner.delete(v);
  return best;
}

const dumpAnyway = new WeakSet<VehicleState>();
/** Fixed loading bay assigned per truck: it stays put while the loader works. */
const truckBayHome = new WeakMap<VehicleState, { diggerUid: string; x: number; z: number; ang: number }>();
const plantTicket = new WeakMap<VehicleState, number>();
let plantNo = 1;
const TRUCK_PARK = 16;

function bayPose(home: { x: number; z: number; ang: number }, place: number) {
  const back = TRUCK_PARK + place * 14;
  const x = home.x + Math.cos(home.ang) * back;
  const z = home.z + Math.sin(home.ang) * back;
  const yaw = Math.atan2(-Math.cos(home.ang), -Math.sin(home.ang));
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return { x, z, yaw, fx, fz, stageX: x + fx * 18, stageZ: z + fz * 18, homeX: home.x, homeZ: home.z };
}

function bayHomeForTruck(state: GameState, v: VehicleState, digger: VehicleState) {
  const prev = truckBayHome.get(v);
  if (prev?.diggerUid === digger.uid) return prev;
  let x = digger.x;
  let z = digger.z;
  let yaw = digger.yaw;
  let away: { x: number; z: number } | null = null;
  const def = DEFS[digger.defId];
  if (def.scoop > 0) {
    const pile = (digger.cargo > 0.15 && digger.cargoOre ? pileInReach(state, digger) : null) ?? bestPile(state, digger);
    if (pile) {
      if (digger.cargo <= 0.15 || !digger.cargoOre) {
        const spot = pileApproach(digger, pile);
        x = spot.x;
        z = spot.z;
        yaw = Math.atan2(-(pile.x - x), -(pile.z - z));
      }
      away = { x: x - pile.x, z: z - pile.z };
    }
  } else if (def.dig > 0) {
    const vein = bestVein(state, digger, digger.cargo > 0.15 ? digger.cargoOre : null);
    if (vein) {
      if (digger.cargo <= 0.15 || !digger.cargoOre) {
        const face = driveFace(vein);
        x = face.x;
        z = face.z;
        yaw = faceOf(vein).yaw;
      }
      away = { x: x - vein.x, z: z - vein.z };
    }
  }
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const side = slotOf(digger) % 2 === 0 ? 1 : -1;
  const ang = areaOf(x) === "mountain"
    ? Math.atan2(fx * side, -fz * side)
    : away && Math.hypot(away.x, away.z) > 0.1
      ? Math.atan2(away.z, away.x)
      : Math.atan2(Math.cos(yaw), Math.sin(yaw));
  const home = {
    diggerUid: digger.uid,
    x,
    z,
    ang,
  };
  truckBayHome.set(v, home);
  return home;
}

const bayReady = new WeakSet<VehicleState>();
const bayCommit = new WeakSet<VehicleState>();

/** Stay off the pile. The only way into the bay is from the open side, backing in. */
function enterBay(
  v: VehicleState,
  bay: { x: number; z: number; yaw: number; fx: number; fz: number; stageX: number; stageZ: number; homeX: number; homeZ: number },
  place: number,
): Control {
  const along = (v.x - bay.x) * bay.fx + (v.z - bay.z) * bay.fz;
  const err = Math.atan2(Math.sin(bay.yaw - v.yaw), Math.cos(bay.yaw - v.yaw));
  const label = place === 0 ? "In the load bay" : `In line (${place + 1})`;
  // Behind gold creek there is no road. Come around to the east side first.
  if (bay.homeX < -70 && v.x < bay.homeX + 6) {
    bayCommit.delete(v);
    v.status = "Staying off the pile";
    return seek(v, bay.homeX + 36, bay.homeZ + 14, 4);
  }
  if (along > 10 && distTo(v.x, v.z, bay.stageX, bay.stageZ) < 6) bayCommit.add(v);
  if (!bayCommit.has(v)) {
    v.status = place === 0 ? "Lining up at the bay" : `In line (${place + 1})`;
    return seek(v, bay.stageX, bay.stageZ, 4);
  }
  if (Math.abs(err) > 0.3) {
    v.status = "Turning to back in";
    return { throttle: 0, steer: clamp(err * 1.6, -1, 1), action: false, brake: 0.85 };
  }
  if (along > 2.4) {
    v.status = place === 0 ? "Backing into the bay" : `In line (${place + 1})`;
    return { throttle: -0.32, steer: clamp(-err * 0.6, -1, 1), action: false, brake: 0 };
  }
  bayReady.add(v);
  v.status = label;
  return { throttle: 0, steer: 0, action: false, brake: 1 };
}

function goingToWash(state: GameState, t: VehicleState) {
  if (!t.cargoOre || t.cargo < 0.4 || !prefersWash(state, t.cargoOre, t.x)) return false;
  if (!(t.operator || t === state.vehicles[state.active])) return false;
  const cap = vehicleStats(t).capacity;
  return cap <= 0 || t.cargo >= cap * 0.9 || dumpAnyway.has(t) || distTo(t.x, t.z, WASH_PLANT.x, WASH_PLANT.z) < 80;
}

function plantLine(state: GameState) {
  const list = state.vehicles.filter((t) => goingToWash(state, t));
  for (const t of list) if (!plantTicket.has(t)) plantTicket.set(t, plantNo++);
  list.sort((a, b) => (plantTicket.get(a) ?? 0) - (plantTicket.get(b) ?? 0));
  return list;
}

/** Only the first machine pulls onto the wash plant. The rest wait in a line to the east. */
function plantQueue(state: GameState, v: VehicleState, pad: { kind: string; x: number; z: number; r: number } | null): Control | null {
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
function benchBetween(x: number, z: number, tx: number, tz: number) {
  return areaOf(x) === "mountain" && switchbackWaypoint(x, z, tx, tz) != null;
}

function routeTo(v: VehicleState, tx: number, tz: number) {
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
  if ((tx < -58 && v.x > -66) || (v.x < -66 && tx > v.x + 6)) {
    if (v.x < -24 && v.x > -58 && v.z < 18) return { x: -14, z: Math.min(v.z, 2) };
    if (v.z < 18) return { x: Math.max(v.x, -16), z: 24 };
    if (v.x < -66 && tx > -66) return { x: -60, z: 24 };
    if (v.x > -68 && tx < -58) return { x: -74, z: 24 };
    return { x: tx, z: tz };
  }
  return { x: tx, z: tz };
}

/** In the valley the only way over the river is the bridge, and the only way past the west cliff is the quarry gap. */
function routeRiver(v: VehicleState, tx: number, tz: number) {
  const gap = valleyGap(v.x, v.z, tx, tz);
  if (gap) return gap;
  const side = Math.sign(v.x - BRIDGE.x);
  const goal = Math.sign(tx - BRIDGE.x);
  if (goal === 0 || (side !== 0 && side === goal)) return { x: tx, z: tz };
  // The heavy haul stays on its bank. A dozer or payloader is light enough to cross.
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

function behindWestCliff(x: number, z: number) {
  if (onHaulRoad(x, z) || areaOf(x) !== "river") return false;
  // Only the quarry wall and the dead pocket behind it. The north road and the open west bank are not this.
  if (x > X0 - 78 || x < X0 - 98) return false;
  if (z >= -16 && z <= 2) return false;
  return true;
}

const crewJob = new WeakMap<VehicleState, string>();
const crewPush = new WeakMap<VehicleState, { phase: "in" | "out"; t: number }>();

function veinUsable(state: GameState, v: VehicleState, d: Deposit | null | undefined): d is Deposit {
  return !!d && d.kind === "vein" && d.tons >= 0.35 && ownsClaim(state, d.claim) && sameArea(d, v) && (assignedClaim(v) == null || d.claim === assignedClaim(v));
}

/** Stay on the face you already chose unless another one is clearly better. Stops gold and silver swapping every frame. */
function commitVein(state: GameState, v: VehicleState, next: Deposit | null, scoreOf: (d: Deposit) => number): Deposit | null {
  const pin = facePin(state, v);
  if (pin) return pin;
  const prev = state.deposits.find((d) => d.id === crewJob.get(v));
  if (veinUsable(state, v, prev) && next && prev.id !== next.id) {
    const onIt = distTo(v.x, v.z, prev.x, prev.z) < prev.radius + 16;
    if (onIt || scoreOf(next) < scoreOf(prev) * 1.45) {
      return prev;
    }
  }
  const pick = next ?? (veinUsable(state, v, prev) ? prev : null);
  if (pick) crewJob.set(v, pick.id);
  else crewJob.delete(v);
  return pick;
}

function seek(v: VehicleState, tx: number, tz: number, arrive: number): Control {
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
function machineAhead(state: GameState, v: VehicleState) {
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

/** Don't drive into the machine ahead. Back out when already touching, otherwise pass on the open side. */
function avoidTraffic(state: GameState, v: VehicleState, c: Control): Control {
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
    return { throttle: -0.5, steer: away, action: false, brake: 0 };
  }
  if (pullingOut) return { ...c, steer: clamp(c.steer + away, -1, 1), throttle: Math.max(c.throttle, 0.45) };
  return { ...c, steer: clamp(c.steer + away * 0.45, -1, 1), throttle: Math.max(0.2, Math.min(c.throttle, 0.7)) };
}

/** A face the crew can actually drive onto. The ridge back wall is solid, so a cut walked into it is pulled back out. */
function driveFace(vein: Deposit) {
  const cut = faceOf(vein);
  let x = cut.x;
  const z = areaOf(vein.x) === "ridge" ? Math.max(cut.z, -46) : cut.z;
  if (areaOf(vein.x) === "ridge") {
    // Gold Creek sits beyond the west wall. Keeping its approach inside the
    // pit sends crews straight into that wall and bypasses routeTo's west road.
    if (vein.id !== "gold") x = Math.max(-48, Math.min(36, x));
  } else if (vein.id === "quarry") {
    x = Math.max(x, X0 - 76);
  } else if (vein.id === "east-rim") {
    x = Math.min(x, X0 + 82);
  }
  return { x, z, reach: cut.reach };
}

function workHere(v: VehicleState, x: number, z: number, radius: number): Control | null {
  if (distTo(v.x, v.z, x, z) > radius) return null;
  if (Math.abs(v.speed) > 0.7) return { throttle: 0, steer: 0, action: false, brake: 1 };
  return { throttle: 0, steer: 0, action: true, brake: 1 };
}

/** Where a work order wants the machine. Null when it has no assignment. */
function orderArea(state: GameState, m: VehicleState): AreaId | null {
  if (m.workFace) {
    const d = state.deposits.find((o) => o.id === m.workFace);
    if (d && ownsClaim(state, d.claim)) return areaOf(d.x);
  }
  if (m.workClaim != null && ownsClaim(state, m.workClaim)) return claimAreaOf(m.workClaim);
  return null;
}

function yardPad(area: AreaId) {
  if (area === "mountain") return { x: X1 - 30, z: 52 };
  if (area === "river") return { x: X0 + 46, z: 40 };
  return { x: -8, z: 44 };
}

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

function lowboyDest(v: VehicleState): AreaId | null {
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

function lowboyDrive(state: GameState, v: VehicleState): Control {
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

function fuelPoint(v: VehicleState, bay: { x: number; z: number }) {
  // On the high mountain road, follow the gravel down to camp instead of cutting across the slope.
  if (v.x < MOUNTAIN_GATE_X || v.z < 70) return bay;
  if (v.x < X1 - 48) return { x: Math.min(v.x + 90, X1 - 40), z: 96 };
  return { x: X1 - 36, z: 58 };
}

/** The nearest idle dozer, or else loader, clears a rockslide. A pinned face stays on the dig. */
function slideJob(state: GameState, v: VehicleState): Control | null {
  if (v.defId !== "dozer" && v.defId !== "loader") return null;
  if (v.cargo > 0.25 || facePin(state, v)) return null;
  const slide = state.deposits.find((d) => d.id === "slide-gap" && d.tons > 0.2);
  if (!slide || !sameArea(slide, v)) return null;
  if (v.workClaim != null && v.workClaim !== slide.claim) return null;
  let best = v;
  let bestD = distTo(v.x, v.z, slide.x, slide.z);
  for (const o of state.vehicles) {
    if (o === v || !o.operator || facePin(state, o)) continue;
    if (o.defId !== "dozer" && o.defId !== "loader") continue;
    if (!sameArea(o, slide) || (o.workClaim != null && o.workClaim !== slide.claim)) continue;
    if ((state.deck ?? []).includes(o.uid) || o.cargo > 0.25) continue;
    const d = distTo(o.x, o.z, slide.x, slide.z);
    const better = (o.defId === "dozer" && best.defId !== "dozer") || (o.defId === best.defId && d < bestD);
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
function noseBlocked(state: GameState, v: VehicleState): "" | "wall" | "pile" {
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

function aiControl(state: GameState, index: number): Control {
  const v = state.vehicles[index];
  const def = DEFS[v.defId];
  const st = vehicleStats(v);
  const cap = st.capacity;
  const full = cap > 0 && v.cargo >= cap * 0.9;
  const has = v.cargo > 0.25;
  let target: { x: number; z: number } | null = null;
  let arrive = 6;
  let label = "Looking for work";

  const feeding = v.unstick > 0 ? null : feedJob(state, v);
  if (feeding) return feeding;
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
      if (od.dig <= 0 && o.defId !== "loader") continue;
      if (!(o.operator || i === state.active)) continue;
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

  if (v.cargoOre && v.cargo > 0.35) {
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
    const loadsTrucks = def.id === "loader" || def.id === "excavator";
    if (loadsTrucks) {
      const truck = nearestHauler(state, v, 480, true);
      if (truck && !benchBetween(v.x, v.z, truck.x, truck.z)) {
        target = truck;
        arrive = 7.5;
        label = `Loading ${DEFS[truck.defId].name}`;
      }
      // Loaders/excavators wait at the work area if their assigned truck is
      // still arriving. They never abandon the face to chase a plant or a
      // different truck; the truck moves into the fixed bay instead.
      return;
    }
    const pad = bestPad(state, v.cargoOre, v.x, v.z, v);
    if (!pad) return;
    if (loadsTrucks && benchBetween(v.x, v.z, pad.x, pad.z)) return;
    target = pad;
    arrive = Math.max(5, pad.r * 0.62);
    label = `Hauling to ${pad.name}`;
  };

  const waitingTruckRaw = def.id === "loader" && v.cargo > 0.35 ? nearestHauler(state, v, full ? 480 : 28, true) : null;
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
    if (def.id === "skid" && full && v.cargoOre && loaderInArea(state, v)) {
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
      if (!target) {
        v.status = "Waiting for a ready dump truck";
        return { throttle: 0, steer: 0, action: false, brake: 1 };
      }
    }
    const digHaul = target as { x: number; z: number } | null;
    if (digHaul) {
      v.status = label;
      return seek(v, digHaul.x, digHaul.z, arrive);
    }
    const pinned = facePin(state, v);
    let vein: Deposit | null = pinned;
    if (!pinned) {
      let veinS = -Infinity;
      for (const d of state.deposits) {
        if (d.kind !== "vein" || d.tons < 0.35) continue;
        if (!ownsClaim(state, d.claim)) continue;
        if (assignedClaim(v) != null && d.claim !== assignedClaim(v)) continue;
        const dist = distTo(v.x, v.z, d.x, d.z);
        const s = washScore(state, d.ore) + (d.ore === "dirt" ? 0 : 1500) + (dist < 42 ? 400 : 0) - dist;
        if (s > veinS) {
          veinS = s;
          vein = d;
        }
      }
      vein = commitVein(state, v, vein, (d) => {
        const dist = distTo(v.x, v.z, d.x, d.z);
        return washScore(state, d.ore) + (d.ore === "dirt" ? 0 : 1500) + (dist < 42 ? 400 : 0) - dist;
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
        if (def.id === "loader" || def.id === "excavator") {
          v.status = "Waiting for a ready dump truck";
          return { throttle: 0, steer: 0, action: false, brake: 1 };
        }
      }
      const cut = driveFace(vein);
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Working ${job}`;
        return held;
      }
      v.status = `Heading to ${job}`;
      return seek(v, cut.x, cut.z, 2.2);
    }
    if (v.cargo > 0.25 && v.cargoOre) haulTarget();
    else {
      const pile = bestPile(state, v);
      if (pile) {
        const spot = pileApproach(v, pile);
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
    const leave = cap > 0 && v.cargo >= cap * 0.9;
    if (leave && v.cargoOre) {
      lineTicket.delete(v);
      truckPartner.delete(v);
      bayReady.delete(v);
      truckBayHome.delete(v);
      dumpAnyway.add(v);
      const pad = bestPad(state, v.cargoOre, v.x, v.z, v);
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
        const line = lineFor(state, digger);
        const place = Math.max(0, line.findIndex((t) => t === v));
        return enterBay(v, bayPose(bayHomeForTruck(state, v, digger), place), place);
      }
      v.status = "Needs a payloader";
      return { ...ZERO, brake: 1 };
    }
  } else if (waitingTruck) {
    if (distTo(v.x, v.z, waitingTruck.x, waitingTruck.z) < 8) {
      v.status = `Loading the ${DEFS[waitingTruck.defId].name}`;
      return { throttle: 0, steer: 0, action: true, brake: 1 };
    }
    v.status = `Hauling to the ${DEFS[waitingTruck.defId].name}`;
    return seek(v, waitingTruck.x, waitingTruck.z, 6);
  } else if (has && full) {
    haulTarget();
    if (!target) {
      v.status = "Waiting for a ready dump truck";
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
  } else if (def.dig > 0 || def.scoop > 0) {
    const vein = def.dig > 0 && !full ? bestVein(state, v, v.cargo > 0.15 ? v.cargoOre : null) : null;
    const pile = def.scoop > 0 && !full ? bestPile(state, v) : null;
    const pileD = pile ? distTo(v.x, v.z, pile.x, pile.z) : Infinity;
    const veinD = vein ? distTo(v.x, v.z, vein.x, vein.z) : Infinity;
    // The iron pile sits on the gate. Take it when it is closer than a face.
    const washVein = vein != null && prefersSluice(state, vein.ore);
    const washPile = pile != null && prefersSluice(state, pile.ore);
    const takePile = pile != null && pile.tons >= 1.5 && pileD + 4 < veinD && (!washVein || washPile);
    if (takePile && pile) {
      const spot = pileApproach(v, pile);
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
        if (!target) {
          v.status = "Waiting for a ready dump truck";
          return { throttle: 0, steer: 0, action: false, brake: 1 };
        }
        const truck = target as { x: number; z: number };
        v.status = label;
        return seek(v, truck.x, truck.z, arrive);
      } else {
      const cut = driveFace(vein);
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Working ${prettySign(vein.sign)}`;
        return held;
      }
      target = cut;
      arrive = Math.max(4, cut.reach * 0.7);
      label = `Heading to ${prettySign(vein.sign)}`;
      }
    } else if (def.scoop > 0 && v.operator && assignedClaim(v) != null) {
      const spot = bestVein(state, v, null);
      const cut = spot ? driveFace(spot) : null;
      if (spot && cut) {
        const held = workHere(v, cut.x, cut.z, cut.reach);
        if (held) {
          v.status = `Working ${prettySign(spot.sign)}`;
          return held;
        }
        target = cut;
        arrive = Math.max(4, cut.reach * 0.7);
        label = `Heading to ${prettySign(spot.sign)}`;
      } else label = "No material at assigned source";
    } else if (def.scoop > 0) {
      const spot = bestVein(state, v, null);
      const cut = spot ? driveFace(spot) : null;
      if (spot && cut) {
        target = cut;
        arrive = Math.max(4, cut.reach * 0.7);
        label = `Heading to ${prettySign(spot.sign)}`;
      } else label = "Looking for a pile";
    } else label = "No face in reach";
  }

  v.status = label;
  if (has && v.cargoOre && full) {
    const pad = nearestPad(state, v.x, v.z);
    const wrongPlant =
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

function cargoInto(v: VehicleState, ore: OreId, tons: number, purity: number) {
  if (tons <= 0) return;
  v.cargoPurity = v.cargo > 0.05 && v.cargoOre === ore ? mixPurity(v.cargo, v.cargoPurity ?? 1, tons, purity) : purity;
  v.cargo += tons;
  v.cargoOre = ore;
}

function emptyCargo(v: VehicleState) {
  v.cargo = 0;
  v.cargoOre = null;
  v.cargoPurity = 1;
}

/** What a bite of this face will produce, before cutting it. */
function faceOutput(d: Deposit, cut: WorkOpts["cut"]): OreId {
  if (d.ore === "dirt") return "dirt";
  const top = cut === "top" || cut === "auto";
  return top && d.overburden > 0.05 ? "dirt" : d.ore;
}

function cutLog(state: GameState, d: Deposit, res: ReturnType<typeof cutFace>, player: boolean) {
  if (res.slide) log(state, `Wall slide at ${d.sign}! Dirt fell back on the ore. Strip the top before digging the bottom.`);
  else if (res.benched && player) log(state, `${d.sign} is down to bench ${d.bench}. Strip the next layer of dirt off the top.`);
}

function dropInFront(state: GameState, v: VehicleState, x: number, z: number) {
  if (!v.cargoOre || v.cargo < 0.05) return;
  addPile(state, v.cargoOre, v.cargo, x, z, v.workClaim ?? 1, v.cargoPurity ?? 1);
  emptyCargo(v);
}

function truckNear(state: GameState, v: VehicleState, x: number, z: number, reach: number) {
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

function performAction(
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
  const player = index === state.active;
  const manual = opts.phase !== "auto";
  const kind = machineKind(v.defId);

  if (opts.phase !== "fill") {
    const pad = v.cargoOre ? nearestPad(state, v.x, v.z) : null;
    const planned = v.cargoOre ? bestPad(state, v.cargoOre, v.x, v.z, v) : null;
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
    const reclaimWaste = precious && pad?.kind === "reclaim";
    // A hand-worked excavator dumps where the bucket is, not where the tracks are.
    const excavatorHand = manual && kind === "excavator";
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
    } else if (!excavatorHand && v.cargo > 0.04 && v.cargoOre && pad && dumpsToFeed(v.defId, pad.kind) && (player || pad.kind !== "wash" || plantLine(state)[0] === v)) {
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
      if (sidePile) {
        if (player) log(state, `Hopper is full of something else. ${tons.toFixed(1)} tons of ${ORES[ore].name.toLowerCase()} dropped beside the ${pad.name.toLowerCase()}.`);
        return null;
      }
      const unit = unitPrice(ore, pad.kind, state.sluice, state.market);
      const purity = purityFactor(ore, purityIn);
      const gross = tons * unit * purity * Ops.saleMult(state, ore, pad.kind);
      const net = gross * (player ? 1 : CREW_KEEP);
      Ops.onSale(state, net, tons);
      const bonus = fillContract(state, ore, tons);
      recordSale(state.market, pad.kind, ore, tons);
      state.cash += net;
      state.lifetime += net;
      const id = feedId(pad.id);
      const pile = state.deposits.find((d) => d.id === id);
      if (pile) feedPaid.set(pile, (feedPaid.get(pile) ?? 0) + tons);
      const extra = bonus > 0 ? ` +${formatMoney(bonus)} contract` : "";
      if (player) log(state, `${pad.name} paid ${formatMoney(net)} for ${tons.toFixed(1)} tons of ${ORES[ore].name.toLowerCase()}.`);
      return { x: v.x, z: v.z, text: `+${formatMoney(net)} ${ORES[ore].name} ${tons.toFixed(1)}t${extra}`, player };
    } else if (!excavatorHand && v.cargo > 0.04 && v.cargoOre && pad) {
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
    if (!player && v.defId === "skid" && v.cargoOre && st.capacity > 0 && v.cargo >= st.capacity * 0.85 && loaderInArea(state, v)) {
      const spot = stockLatch.get(v);
      if (spot && distTo(v.x, v.z, spot.x, spot.z) < 4.5) {
        addPile(state, v.cargoOre, v.cargo, spot.x, spot.z, v.workClaim ?? 1, v.cargoPurity ?? 1);
        emptyCargo(v);
        v.status = "Stockpiled for the loader";
        return null;
      }
    }
  }

  if (def.dig > 0 && st.capacity > 0 && v.cargo < st.capacity - 0.03) {
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
    // In realistic mode, skid steers and loaders only collect material during
    // an actual bucket-curl fill gesture. Holding the action button alone must not
    // magically load the bucket; simple controls and crew AI remain assisted.
    if (v.manual && (kind === "skid" || kind === "loader") && opts.phase !== "fill") {
      if (player) v.status = "Lower the bucket and curl it to scoop";
      return null;
    }
    const pile = pileInReach(state, v);
    const spot = v.operator && v.workClaim != null ? bestVein(state, v, null) : null;
    const cut = spot ? faceOf(spot) : null;
    const faceNear = spot && cut && distTo(v.x, v.z, cut.x, cut.z) <= cut.reach;
    const source = faceNear && spot ? spot : pile && pile.tons > 0.05 ? pile : null;
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

function integrateTank(v: VehicleState, left: number, right: number, dt: number, drag: number) {
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
  // Counter-rotating sides spin the machine in place.
  v.yaw += m.turn * st.turn * 1.1 * dt;
  v.x += -Math.sin(v.yaw) * v.speed * dt;
  v.z += -Math.cos(v.yaw) * v.speed * dt;
}

function integrate(v: VehicleState, c: Control, dt: number) {
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

function bindDeck(state: GameState) {
  deckUids = new Set(state.deck ?? []);
}

function aboard(v: VehicleState) {
  return deckUids.has(v.uid);
}

function clampLowboy(v: VehicleState) {
  if (onHaulRoad(v.x, v.z)) return;
  if (v.z > 64 && v.x > 20 && v.x < 980) {
    v.z = Math.max(88, Math.min(104, v.z));
    v.speed *= 0.5;
  }
}

function resolveCircle(state: GameState, v: VehicleState, radius: number) {
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
    v.z = Math.min(v.z, v.x > 500 ? 68 : 63);
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
function holdPiles(state: GameState, v: VehicleState) {
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
function holdDeck(v: VehicleState) {
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
function crossingWeight(state: GameState, v: VehicleState) {
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
function guardBridge(state: GameState, v: VehicleState, index: number) {
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
    if (index === state.active) log(state, msg);
  }
}

function resolveVehicles(state: GameState) {
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

export const ROAD_CLEAR_BONUS = 1800;

/** Drop a rockslide across one of the mountain switchback gaps. Clearing it pays ROAD_CLEAR_BONUS. */
export function spawnRockslide(state: GameState, gap = 0) {
  const w = SWITCHBACKS[Math.max(0, Math.min(SWITCHBACKS.length - 1, gap))];
  const existing = state.deposits.find((d) => d.id === "slide-gap");
  if (existing) {
    existing.x = w.gapX;
    existing.z = w.z;
    existing.tons = Math.max(existing.tons, 16);
    existing.max = Math.max(existing.max, 16);
  } else {
    state.deposits.push({
      id: "slide-gap",
      kind: "pile",
      ore: "dirt",
      tons: 16,
      max: 16,
      x: w.gapX,
      z: w.z,
      regen: 0,
      claim: MOUNTAIN_CLAIM,
      radius: 7,
      sign: "ROCKSLIDE",
      purity: 1,
      overburden: 0,
      grade: 1,
      stress: 0,
      bench: 1,
      benchProgress: 0,
      hard: false,
      tested: true,
      lastBlastDay: -1,
    });
  }
  log(state, `Rockslide on the mountain switchback! Clear it with a dozer or loader for a ${formatMoney(ROAD_CLEAR_BONUS)} bonus.`);
}

function regen(state: GameState, dt: number) {
  for (let i = state.deposits.length - 1; i >= 0; i--) {
    const d = state.deposits[i];
    if (d.regen > 0 && d.tons < d.max) d.tons = Math.min(d.max, d.tons + d.regen * dt);
    // A dozer creates small bites every frame. Keep a fresh crumb so the next bite
    // can merge into it. An emptied pile, even a small one, has to go or the yard fills with ghosts.
    const emptied = d.tons <= 0.02 || (d.tons < 0.2 && d.max >= 0.2);
    if (d.kind === "pile" && d.regen <= 0 && emptied) {
      if (d.id === "slide-gap") {
        state.cash += ROAD_CLEAR_BONUS;
        state.lifetime += ROAD_CLEAR_BONUS;
        log(state, `Switchback rockslide cleared! +${formatMoney(ROAD_CLEAR_BONUS)} road bonus.`);
      }
      state.deposits.splice(i, 1);
    }
  }
}

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
  const crewTruck = truck.operator && state.vehicles[state.active] !== truck;
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

function pourIntoTrucks(state: GameState) {
  state.vehicles.forEach((v, index) => {
    if (v.defId !== "loader" && v.defId !== "excavator") return;
    // Hand-worked machines dump into the truck themselves.
    if (v.manual) return;
    if (!v.operator && !(v === state.vehicles[state.active] && !state.watching)) return;
    if (v.cargo < 0.15 || !v.cargoOre) return;
    const head = lineFor(state, v)[0];
    const reach = v.defId === "excavator" ? 20 : 22;
    if (!head || !bayReady.has(head)) return;
    if (distTo(v.x, v.z, head.x, head.z) <= reach) loadTruck(state, index, reach, head);
  });
}

function faceNearPlayer(state: GameState, v: VehicleState, extra = 4) {
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

function updateBlast(state: GameState, dt: number, blasts: StepFX["blasts"]) {
  const b = state.blast;
  if (!b) return;
  const d = state.deposits.find((o) => o.id === b.deposit);
  if (!d) {
    state.blast = null;
    return;
  }
  if (b.phase === "drill") {
    const wasBoring = b.t < BORE_SECONDS;
    b.t += dt;
    if (wasBoring && b.t >= BORE_SECONDS) log(state, `Holes bored in ${d.sign}. Charging them now. Keep moving back.`);
    if (b.t >= DRILL_SECONDS) {
      b.phase = "fuse";
      b.t = FUSE_SECONDS;
      log(state, `Charges set in ${d.sign}. ${FUSE_SECONDS} seconds. Get every machine back ${usDist(BLAST_RADIUS)}.`);
    }
    return;
  }
  b.t -= dt;
  if (b.t > 0) return;
  const f = faceOf(d);
  const loose = blastYield(d.tons);
  const dirt = Math.min(d.overburden, 30);
  d.tons -= loose;
  d.overburden -= dirt;
  d.stress = 0;
  const oreSpot = blastPilePoint(f.x, f.z, 0);
  const dirtSpot = blastPilePoint(f.x, f.z, 7);
  if (loose > 0.1) addPile(state, d.ore, loose, oreSpot.x, oreSpot.z, d.claim, d.grade * 0.95);
  if (dirt > 0.1) addPile(state, "dirt", dirt, dirtSpot.x, dirtSpot.z, d.claim, 1);
  let hurt = 0;
  for (const v of state.vehicles) {
    const sheltered = blastSheltered.has(v);
    blastSheltered.delete(v);
    if (sheltered) continue;
    const dmg = blastDamage(distTo(v.x, v.z, f.x, f.z));
    if (dmg > 0) {
      v.damage = Math.min(1, (v.damage ?? 0) + dmg);
      hurt += 1;
    }
  }
  blasts.push({ x: f.x, z: f.z });
  state.blast = null;
  log(state, hurt > 0
    ? `BOOM. ${loose.toFixed(0)} tons of loose ${ORES[d.ore].name.toLowerCase()}. ${hurt} machine${hurt > 1 ? "s were" : " was"} too close and needs repair.`
    : `BOOM. ${loose.toFixed(0)} tons of loose ${ORES[d.ore].name.toLowerCase()} is ready to scoop.`);
}

export function rainNow(state: GameState) {
  return rainAt(state.market.seed, state.seconds);
}

/** Share of top speed the ground allows here (mud in the valley; 1 elsewhere). */
export function groundFactor(state: GameState, v: VehicleState) {
  if (onBridge(v.x, v.z)) return 1;
  if (areaOf(v.x) === "mountain") {
    const base = coldFactor(rainNow(state));
    if (v.defId !== "dozer") {
      const slide = state.deposits.find((d) => d.id === "slide-gap" && d.tons > 0.2);
      if (slide && distTo(v.x, v.z, slide.x, slide.z) <= 9) return Math.min(base, 0.35);
    }
    return base;
  }
  return mudSpeedFactor(v.defId, mudDepth(v.x, v.z, state.wet));
}

const blastSheltered = new WeakSet<VehicleState>();

function hitsBlock(x: number, z: number, radius: number) {
  for (const b of BLOCKS) {
    const cx = clamp(x, b.x - b.sx / 2, b.x + b.sx / 2);
    const cz = clamp(z, b.z - b.sz / 2, b.z + b.sz / 2);
    if ((x - cx) ** 2 + (z - cz) ** 2 < radius * radius) return true;
  }
  return inRiver(x, z);
}

function pointBlocked(x: number, z: number, radius: number, avoidBridge = false) {
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

function sameBank(ax: number, bx: number) {
  if (areaOf(ax) !== "river" || areaOf(bx) !== "river") return areaOf(ax) === areaOf(bx);
  const as = Math.sign(ax - RIVER.x);
  const bs = Math.sign(bx - RIVER.x);
  return as === bs || as === 0 || bs === 0;
}

function segmentClear(x0: number, z0: number, x1: number, z1: number, radius: number) {
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    if (pointBlocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, radius)) return false;
  }
  return true;
}

/** A point outside the blast, on the same bank, that does not sit in the river or a wall. */
export function blastEscapeTarget(face: { x: number; z: number }, v: VehicleState) {
  const radius = vehicleStats(v).radius;
  const safe = BLAST_RADIUS + radius + 3;
  const dist = Math.hypot(v.x - face.x, v.z - face.z);
  const gate = gateFor(face.x);
  const glen = Math.hypot(gate.x - face.x, gate.z - face.z) || 1;
  const towardGate = { x: (gate.x - face.x) / glen, z: (gate.z - face.z) / glen };
  const away = dist > 0.1 ? { x: (v.x - face.x) / dist, z: (v.z - face.z) / dist } : towardGate;
  const rot = (ux: number, uz: number, ang: number) => ({
    x: ux * Math.cos(ang) - uz * Math.sin(ang),
    z: ux * Math.sin(ang) + uz * Math.cos(ang),
  });
  const dirs = [away, towardGate];
  for (let i = 1; i <= 12; i++) {
    const ang = (i * Math.PI) / 12;
    dirs.push(rot(away.x, away.z, ang), rot(away.x, away.z, -ang));
  }
  const reach = safe + 8;
  for (const d of dirs) {
    const len = Math.hypot(d.x, d.z) || 1;
    const tx = face.x + (d.x / len) * reach;
    const tz = face.z + (d.z / len) * reach;
    if (!sameBank(v.x, tx)) continue;
    if (pointBlocked(tx, tz, radius)) continue;
    if (!segmentClear(v.x, v.z, tx, tz, Math.max(0.8, radius * 0.45))) continue;
    return { x: tx, z: tz };
  }
  return null;
}

/** Loose rock lands toward this map's gate, not toward the ridge from every face. */
export function blastPilePoint(faceX: number, faceZ: number, side = 0) {
  const gate = gateFor(faceX);
  let dx = gate.x - faceX;
  let dz = gate.z - faceZ;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  for (let step = 6; step <= 16; step += 2) {
    const x = faceX + dx * step - dz * side;
    const z = faceZ + dz * step + dx * side;
    if (!pointBlocked(x, z, 1.2, true)) return { x, z };
  }
  return { x: faceX + dx * 6, z: faceZ + dz * 6 };
}

function blastEvacuationControl(state: GameState, index: number): Control | null {
  const blast = state.blast;
  // The machine in the player's hands is theirs to drive out. A watched crew truck is not.
  if (!blast || (index === state.active && !state.watching)) return null;
  const deposit = state.deposits.find((d) => d.id === blast.deposit);
  const v = state.vehicles[index];
  if (!deposit || !v) return null;
  const face = faceOf(deposit);
  const distance = Math.hypot(v.x - face.x, v.z - face.z);
  const safeDistance = BLAST_RADIUS + vehicleStats(v).radius + 3;
  if (distance >= safeDistance) {
    blastSheltered.delete(v);
    // Stay put. Driving back to the face is how the dump truck kept eating the blast.
    v.status = "Holding clear of the blast";
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  const target = blastEscapeTarget(face, v);
  if (!target) {
    blastSheltered.add(v);
    v.status = "No clear way out of the blast";
    return { throttle: 0, steer: 0, action: false, brake: 1 };
  }
  blastSheltered.delete(v);
  v.status = "Evacuating blast zone";
  return seek(v, target.x, target.z, 2);
}

const passSide = new WeakMap<GameState, AreaId>();
const summitSeen = new WeakSet<GameState>();
const mountainGateSeen = new WeakSet<GameState>();

/** Announce the map change at the valley gate, with a little deadband so reversing across it stays quiet. */
function notePass(state: GameState) {
  const v = state.vehicles[state.active];
  if (!v || !onHaulRoad(v.x, v.z)) return;
  if (onMountainRoad(v.x, v.z) && v.x >= MOUNTAIN_GATE_X && !mountainGateSeen.has(state)) {
    mountainGateSeen.add(state);
    log(state, "Summit gate. The quarry road drops south into High mountain.");
  }
  if (!summitSeen.has(state) && Math.abs(v.x - PASS_SUMMIT_X) < 12) {
    summitSeen.add(state);
    log(state, "You're over the pass summit. The road falls away to the valley.");
  }
  const gate = VALLEY_GATE_X;
  const side: AreaId = v.x >= gate ? "river" : "ridge";
  const prev = passSide.get(state);
  if (!prev) {
    passSide.set(state, side);
    return;
  }
  if (side === prev) return;
  if (side === "river" && v.x < gate + 10) return;
  if (side === "ridge" && v.x > gate - 10) return;
  passSide.set(state, side);
  log(state, side === "river" ? "The pass opens into River Valley." : "The pass opens into Ridge pit.");
}

Ops.setPriceOf((v) => DEFS[v.defId]?.price ?? 20000);

export function step(state: GameState, input: Input, dt: number, playerEnabled: boolean): StepFX {
  if (!state.deck) state.deck = [];
  bindDeck(state);
  regen(state, dt);
  const opsBefore = Ops.before(state);
  const dayBefore = state.market.day;
  const wasRaining = rainNow(state) > 0.05;
  state.wet = stepWet(state.wet, rainNow(state), dt);
  if (Career.seasonOf(state.market.day) === "rain") state.wet = Math.max(state.wet, 0.5);
  if (advanceMarket(state.market, state.seconds, MARKET_KEYS)) log(state, "New day. Ore prices moved. Check the price board.");
  if (state.market.day !== dayBefore) {
    Ops.newDay(state);
    const ev = Ops.ops(state).event;
    if (ev?.kind === "rockslide" && ev.day === state.market.day) spawnRockslide(state, ev.gap ?? 0);
  }
  const controls: Control[] = [];
  const work: WorkOpts[] = [];
  const held: { v: VehicleState; x: number; z: number; yaw: number }[] = [];
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    v.busy = false;
    v.manual = false;
    // A parked crusher is a plant, not a vehicle. Don't let a bump or a grade walk it off.
    if (v.defId === "crusher" && !v.operator && !(i === state.active && !state.watching)) {
      held.push({ v, x: v.x, z: v.z, yaw: v.yaw });
    }
    if (aboard(v)) {
      controls.push({ ...ZERO });
      work.push(AUTO_CREW);
      continue;
    }
    let c: Control;
    let w: WorkOpts = i === state.active && !state.watching ? AUTO_PLAYER : AUTO_CREW;
    if (i === state.active && !state.watching && playerEnabled && state.controlMode === "real" && input.cmd) {
      const cmd = input.cmd;
      const prev = v.tool;
      v.tool = stepTool(prev, cmd.axes, dt, v.defId);
      v.manual = machineKind(v.defId) !== "car";
      let gesture: Gesture = { phase: "none", cut: "top", quality: 0 };
      if (cmd.drive.kind === "tank") {
        const drag = v.defId === "dozer" ? bladeDrag(v.tool.lift) : 1;
        integrateTank(v, cmd.drive.left, cmd.drive.right, dt, drag);
        gesture = readGesture(v.defId, prev, v.tool, v.speed);
        c = { throttle: 0, steer: 0, action: false, brake: 0 };
      } else {
        const throttle = cmd.drive.throttle;
        c = { throttle, steer: cmd.drive.steer, action: false, brake: cmd.drive.brake > 0.1 ? 1 : 0 };
        integrate(v, c, dt);
        gesture = readGesture(v.defId, prev, v.tool, v.speed);
        // Driving with the bed up throws the load off the back.
        if (machineKind(v.defId) === "truck" && v.tool.lift > 0.5 && Math.abs(v.speed) > 5 && v.cargo > 0.5) {
          const fx = -Math.sin(v.yaw);
          const fz = -Math.cos(v.yaw);
          dropInFront(state, v, v.x - fx * 6, v.z - fz * 6);
          log(state, "The load slid off the back. Lower the bed before you drive.");
        }
      }
      if (gesture.phase !== "none") {
        w = { phase: gesture.phase, cut: gesture.cut, quality: gesture.quality };
        c = { ...c, action: true };
      } else if (input.action) {
        c = { ...c, action: true };
      }
      controls.push(c);
      work.push(w);
      continue;
    }
    if (i === state.active && !state.watching) {
      c = playerEnabled
        ? {
            throttle: input.throttle,
            steer: input.steer,
            action: input.action,
            brake: Math.abs(input.throttle) < 0.05 ? 1 : 0,
          }
        : { ...ZERO };
    } else {
      const evacuation = blastEvacuationControl(state, i);
      if (evacuation) {
        c = evacuation;
      } else if (v.operator) {
        c = avoidTraffic(state, v, aiControl(state, i));
      } else {
        // Parking brake on, so an idle machine doesn't roll down a grade.
        c = { ...ZERO, brake: 1 };
        v.status = "Parked";
      }
    }
    controls.push(c);
    work.push(w);
    integrate(v, c, dt);
  }
  // Mud: cap each machine's speed to what the ground allows.
  for (const v of state.vehicles) {
    const f = groundFactor(state, v);
    if (f >= 1) continue;
    const cap = vehicleStats(v).maxSpeed * f;
    if (v.speed > cap) v.speed = cap;
    else if (v.speed < -cap) v.speed = -cap;
  }
  for (const v of state.vehicles) holdDeck(v);
  const rigBefore = state.vehicles.find((v) => v.defId === "lowboy");
  const rigPrev = rigBefore ? { x: rigBefore.x, z: rigBefore.z, yaw: rigBefore.yaw } : null;
  for (let n = 0; n < 2; n++) {
    state.vehicles.forEach((v, i) => {
      resolveCircle(state, v, vehicleStats(v).radius);
      holdPiles(state, v);
      guardBridge(state, v, i);
    });
    resolveVehicles(state);
  }
  for (const v of state.vehicles) {
    if (!behindWestCliff(v.x, v.z)) continue;
    v.x = X0 - 68;
    v.z = -4;
    v.speed = 0;
    v.status = "Backed out of the west cliff";
  }
  if (rigBefore && rigPrev) trailerCollide(state, rigBefore, rigPrev);
  for (const h of held) {
    h.v.x = h.x;
    h.v.z = h.z;
    h.v.yaw = h.yaw;
    h.v.speed = 0;
    h.v.status = "Plant parked";
  }
  pourIntoTrucks(state);
  const sales: StepFX["sales"] = [];
  const breaks: StepFX["breaks"] = [];
  const blasts: StepFX["blasts"] = [];
  let dig = false;
  feedTick(state, dt, playerEnabled && !!input.action, sales);
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    if (v.operator && (state.watching || i !== state.active)) {
      const c = controls[i];
      const hit = noseBlocked(state, v);
      const boxed = machineAhead(state, v);
      // Turning in the open, or crawling beside another machine, is not a wall.
      const trying = c.throttle > 0.4 && Math.abs(v.speed) < 0.3 && !c.action;
      if (trying && (hit || (boxed && boxed.gap < 0))) v.stuck += dt;
      else v.stuck = 0;
      if (v.stuck > 1.1) {
        v.stuck = 0;
        v.unstick = 1.5;
        v.bias = boxed ? (boxed.side >= 0 ? 0.9 : -0.9) : Math.random() < 0.5 ? 1 : -1;
      }
    }
    if (v.unstick > 0) v.unstick = Math.max(0, v.unstick - dt);
    if (!controls[i].action) {
      const pending = saleAcc.get(v) ?? 0;
      if (pending > 0.5) {
        sales.push({
          x: v.x,
          z: v.z,
          text: `+${formatMoney(pending)}`,
          player: i === state.active && !state.watching,
        });
      }
      saleAcc.delete(v);
      continue;
    }
    if (i === state.active && !state.watching) v.status = "";
    const before = v.cargo;
    const sale = performAction(state, i, dt, breaks, work[i]);
    if (sale) sales.push(sale);
    if (i === state.active && v.busy && v.cargo >= before - 1e-6 && !sale) dig = true;
  }
  updateBlast(state, dt, blasts);
  const player = state.vehicles[state.active];
  if (player && !player.status) {
    player.status = player.busy ? "Working" : "In your seat";
  }
  {
    const me = state.vehicles[state.active];
    if (me && !state.watching && me.defId === "dozer") {
      const msg = Ops.ripTick(state, me, dt, faceNearPlayer(state, me, 6));
      if (msg) me.status = msg;
    }
  }
  Ops.tick(state, opsBefore, dt, (v) => vehicleStats(v).capacity, (v) => {
    if (v.cargo > 0.04) dropInFront(state, v, v.x, v.z);
  }, (v) => (areaOf(v.x) === "mountain" ? MOUNTAIN_SPAWNS[0] : areaOf(v.x) === "river" ? RIVER_SPAWNS[0] : SPAWNS[0]));
  storyTick(state);
  snapDeck(state);
  notePass(state);
  state.seconds += dt;
  const raining = rainNow(state) > 0.05;
  if (raining !== wasRaining) log(state, raining ? "Rain's coming in. The valley mud spreads and the low ground floods." : "Rain has stopped. The ground will dry out over a few minutes.");
  return { dig, sales, breaks, blasts };
}

function storyTick(state: GameState) {
  const o = Ops.ops(state);
  const st = o.story ?? 0;
  const g = Career.STORY[st];
  if (!g || !g.done(state, mountainOpen(state))) return;
  o.story = st + 1;
  state.cash += g.pay;
  log(state, `Job done! +${formatMoney(g.pay)}. ${Career.storyText(o.story)}`);
}

function lotStock(state: GameState) {
  const o = Ops.ops(state);
  if (!o.lotTaken || o.lotTaken.day !== state.market.day) o.lotTaken = { day: state.market.day, ids: [] };
  return Career.lotFor(state.market.seed, state.market.day, (id) => DEFS[id].price).filter((x) => !o.lotTaken.ids.includes(x.defId));
}

export function lotButtons(state: GameState) {
  const out: { id: string; label: string; detail: string; enabled: boolean }[] = [];
  const me = state.vehicles[state.active];
  const trade = me && me.defId !== "lowboy" && me.defId !== "crusher" && state.vehicles.length > 1 ? Career.tradeValue(resale(me), Ops.ops(state).wear[me.uid] ?? 0) : 0;
  for (const it of lotStock(state)) {
    const name = DEFS[it.defId].name;
    const blocked = canAdd(state, it.defId);
    out.push({ id: `lot:${it.defId}`, label: `Used ${name} · ${formatMoney(it.price)}`, detail: `${Math.round(it.wear * 100)}% worn. Cheap, slower and thirstier until overhauled.${blocked ? " " + blocked : ""}`, enabled: !blocked && state.cash >= it.price });
    if (trade && me.defId !== it.defId)
      out.push({ id: `lottrade:${it.defId}`, label: `Trade ${DEFS[me.defId].name} for ${name}`, detail: `Lot gives ${formatMoney(trade)} for your machine.`, enabled: !canAdd(state, it.defId, me.defId) && state.cash + trade >= it.price });
  }
  return out;
}

function yardCap(id: VehicleId) {
  if (id === "skid" || id === "truck") return 3;
  if (id === "light") return 4;
  if (id === "dozer" || id === "loader" || id === "excavator" || id === "heavy") return 2;
  return 1;
}

function canAdd(state: GameState, id: VehicleId, leaving?: VehicleId) {
  const count = state.vehicles.filter((v) => v.defId === id).length - (leaving === id ? 1 : 0);
  const cap = yardCap(id);
  if (count >= cap) {
    if (cap <= 1) return "Already on the yard.";
    return `${cap} ${DEFS[id].name.toLowerCase()}s is the yard limit.`;
  }
  return "";
}

export function lotBuy(state: GameState, id: VehicleId, tradeIn: boolean) {
  const it = lotStock(state).find((x) => x.defId === id);
  if (!it) return "Gone from the lot.";
  const o = Ops.ops(state);
  let credit = 0;
  if (tradeIn) {
    const me = state.vehicles[state.active];
    if (!me || me.defId === "lowboy" || me.defId === "crusher" || state.deck?.includes(me.uid) || state.vehicles.length <= 1) return "Can't trade this one.";
    if (canAdd(state, id, me.defId)) return canAdd(state, id, me.defId);
    credit = Career.tradeValue(resale(me), o.wear[me.uid] ?? 0);
    if (state.cash + credit < it.price) return "Not enough cash.";
    delete o.wear[me.uid];
    state.vehicles.splice(state.active, 1);
    state.active = Math.min(state.active, state.vehicles.length - 1);
  } else {
    if (canAdd(state, id)) return canAdd(state, id);
    if (state.cash < it.price) return "Not enough cash.";
  }
  state.cash += credit - it.price;
  state.tutorial.bought = true;
  const nv = makeVehicle(id, state.vehicles.length);
  if (currentArea(state) !== "ridge") placeInArea(state, nv, currentArea(state));
  state.vehicles.push(nv);
  o.wear[nv.uid] = it.wear;
  o.lotTaken.ids.push(id);
  log(state, `Used ${DEFS[id].name} on the yard for ${formatMoney(it.price)}${credit ? ` less ${formatMoney(credit)} trade-in` : ""}.`);
  return "";
}

export function setControlMode(state: GameState, mode: ControlMode) {
  state.controlMode = mode;
  log(state, mode === "real" ? "Realistic controls on. Work the arms and bucket by hand." : "Simple controls on. Hold Space or DIG to work.");
}

export function shiftGear(state: GameState, dir: number) {
  const v = state.vehicles[state.active];
  if (!v || !usesGears(v.defId)) return "";
  if (Math.abs(v.speed) > 1.5) {
    v.status = "Stop before you shift";
    return "Stop before you shift.";
  }
  const next = Math.max(-1, Math.min(1, v.tool.gear + (dir > 0 ? 1 : -1))) as -1 | 0 | 1;
  v.tool = { ...v.tool, gear: next };
  v.status = `Gear ${gearName(next)}`;
  return "";
}

function gearName(g: number) {
  return g > 0 ? "F (forward)" : g < 0 ? "R (reverse)" : "N (neutral)";
}

export function drillTestHole(state: GameState) {
  const v = state.vehicles[state.active];
  if (!v) return "No machine.";
  const d = faceNearPlayer(state, v);
  if (!d) return "Pull up to a face first.";
  if (d.tested) return `${d.sign} is already tested.`;
  if (!ownsClaim(state, d.claim)) return "Lease the ground first.";
  if (!spend(state, TEST_HOLE_COST, `Test hole in ${d.sign}: seam ${Math.round(d.grade * 100)}% clean, ${d.overburden.toFixed(0)} tons of dirt on top${d.hard ? ", hard rock" : ""}.`)) return "Not enough cash.";
  d.tested = true;
  return "";
}

export function blastPrice() {
  return BLAST_COST;
}

export function startBlast(state: GameState) {
  if (state.blast) return "A blast is already set.";
  const v = state.vehicles[state.active];
  if (!v) return "No machine.";
  const d = faceNearPlayer(state, v);
  if (!d) return "Pull up to a face first.";
  if (!ownsClaim(state, d.claim)) return "Lease the ground first.";
  if (d.tons < 1) return "Nothing left to blast here.";
  if (!canBlastToday(d.lastBlastDay, state.market.day)) return `${d.sign} was already blasted today. Try again tomorrow.`;
  let paid = 0;
  if (state.explosives > 0) state.explosives -= 1;
  else {
    paid = blastPrice();
    if (!spend(state, paid, `Blast crew paid ${formatMoney(paid)} for ${d.sign}.`)) return `A blast here costs ${formatMoney(paid)}.`;
  }
  d.lastBlastDay = state.market.day;
  const f = faceOf(d);
  state.blast = { deposit: d.id, x: f.x, z: f.z, phase: "drill", t: 0, paid };
  log(state, `Drilling blast holes in ${d.sign}. The rig stays put. Drive clear. You have ${DRILL_SECONDS + FUSE_SECONDS} seconds.`);
  return "";
}

export function repairVehicle(state: GameState, index: number) {
  const v = state.vehicles[index];
  if (!v || (v.damage ?? 0) <= 0.001) return "Nothing to fix.";
  const cost = repairCost(DEFS[v.defId].price, v.damage);
  if (!spend(state, cost, `${DEFS[v.defId].name} is fixed for ${formatMoney(cost)}.`)) return "Not enough cash.";
  v.damage = 0;
  return "";
}

function spend(state: GameState, cost: number, msg: string) {
  if (state.cash < cost) {
    log(state, "Not enough cash.");
    return false;
  }
  state.cash -= cost;
  state.tutorial.bought = true;
  log(state, msg);
  return true;
}

export function buyVehicle(state: GameState, id: VehicleId) {
  const count = state.vehicles.filter((v) => v.defId === id).length;
  const blocked = canAdd(state, id);
  if (blocked) return blocked;
  const def = DEFS[id];
  const price = yardCap(id) > 1 ? def.price * (count + 1) : def.price;
  if (!spend(state, price, `${def.name} is on the yard for ${formatMoney(price)}.`)) return "Not enough cash.";
  const nv = makeVehicle(id, state.vehicles.length);
  if (currentArea(state) === "river") placeInArea(state, nv, "river");
  state.vehicles.push(nv);
  return "";
}

export function buyWashPlant(state: GameState) {
  if (state.washPlant) return "Wash plant is already running.";
  if (!valleyOpen(state)) return "River Valley opens once you lease the Deep bench.";
  if (!spend(state, WASH_PLANT.price, "Wash plant is running on the east bank of the river.")) return "Not enough cash.";
  state.washPlant = true;
  if (state.contract?.ore === "silver") {
    repriceContract(state);
    log(state, "Silver contract now pays wash-plant prices.");
  }
  return "";
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

function placeInArea(state: GameState, v: VehicleState, area: AreaId) {
  const taken = state.vehicles.filter((o) => o !== v && areaIn(o.x, o.z) === area);
  const list = area === "mountain" ? MOUNTAIN_SPAWNS : area === "river" ? RIVER_SPAWNS : SPAWNS;
  const free = list.find((p) => taken.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 5)) ?? list[taken.length % list.length];
  v.x = free.x;
  v.z = free.z;
  v.yaw = area === "river" ? Math.PI / 2 : 0;
  v.speed = 0;
}

/** Why the active machine can't go on the lowboy right now, or "" if it can. */
/** Circles along the trailer deck, behind the fifth wheel. */
export function trailerCircles(rig: VehicleState, trailerYaw = rig.trailerYaw ?? rig.yaw) {
  const hx = rig.x + Math.sin(rig.yaw) * HITCH_Z;
  const hz = rig.z + Math.cos(rig.yaw) * HITCH_Z;
  return [2.2, 4.6, 7.0].map((d) => ({ x: hx + Math.sin(trailerYaw) * d, z: hz + Math.cos(trailerYaw) * d, r: 1.35 }));
}

/** The deck is solid: parked machines get shoved off it, and walls stop the rig. */
function trailerCollide(state: GameState, rig: VehicleState, prev: { x: number; z: number; yaw: number }) {
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

function snapDeck(state: GameState) {
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

export function ensureLowboy(state: GameState) {
  if (!valleyOpen(state)) return;
  if (state.vehicles.some((v) => v.defId === "lowboy")) return;
  const v = makeVehicle("lowboy", state.vehicles.length);
  v.x = -18;
  v.z = 46;
  v.yaw = Math.PI;
  state.vehicles.push(v);
  log(state, "The lowboy is in the yard. Drive it up the north road.");
}

function nearestDeckLoad(state: GameState, rig: VehicleState) {
  let best: VehicleState | null = null;
  let bestD = 9;
  for (const o of state.vehicles) {
    if (o === rig || o.defId === "lowboy" || o.defId === "crusher") continue;
    if (state.deck.includes(o.uid)) continue;
    if (o.cargo > 0.05) continue;
    if (o.operator || Math.abs(o.speed) > 0.3) continue;
    if (deckSpots(o.defId) == null) continue;
    const d = distTo(rig.x, rig.z, o.x, o.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function uncouple(state: GameState, rig: VehicleState) {
  if (!state.deck?.length) return "";
  const uid = state.deck[0];
  const machine = state.vehicles.find((v) => v.uid === uid);
  if (!machine) {
    state.deck.shift();
    return "";
  }
  const ty = rig.trailerYaw ?? rig.yaw;
  const backX = Math.sin(ty);
  const backZ = Math.cos(ty);
  const rightX = Math.cos(ty);
  const rightZ = -Math.sin(ty);
  const r = vehicleStats(machine).radius;
  const spots = [
    [AXLE_BACK + 2.4, 2.2], [AXLE_BACK + 2.4, -2.2], [AXLE_BACK + 5, 0],
    [3, 5], [3, -5], [AXLE_BACK + 2.4, 6], [AXLE_BACK + 2.4, -6],
  ];
  const free = spots
    .map(([b, sd]) => ({ x: rig.x + backX * b + rightX * sd, z: rig.z + backZ * b + rightZ * sd }))
    .find((p) => !(onHaulRoad(p.x, p.z) ? hitsBlock(p.x, p.z, r) : pointBlocked(p.x, p.z, r)) && !(onHaulRoad(rig.x, rig.z) && !onHaulRoad(p.x, p.z)) && state.vehicles.every((o) => o === machine || o === rig || state.deck.includes(o.uid) || Math.hypot(o.x - p.x, o.z - p.z) > r + vehicleStats(o).radius));
  if (!free) return "No room to drop it here. Pull onto open ground.";
  state.deck.shift();
  machine.x = free.x;
  machine.z = free.z;
  machine.speed = 0;
  machine.status = "Parked";
  bindDeck(state);
  snapDeck(state);
  return "";
}

export function toggleDeck(state: GameState) {
  if (!state.deck) state.deck = [];
  bindDeck(state);
  const rig = state.vehicles[state.active];
  if (!rig || rig.defId !== "lowboy") return "Get in the lowboy first.";

  // One control: add a nearby machine while there is deck left, otherwise unload.
  const target = nearestDeckLoad(state, rig);
  const ids = state.deck.map((id) => state.vehicles.find((v) => v.uid === id)?.defId ?? "");
  const why = target ? deckFit(ids, target.defId) : "";
  if (target && !why) {
    target.speed = 0;
    state.deck.push(target.uid);
    bindDeck(state);
    snapDeck(state);
    log(state, `${DEFS[target.defId].name} is on the deck. ${spotsUsed([...ids, target.defId])} of 3 spots used.`);
    return "";
  }

  if (state.deck.length) {
    const name = DEFS[state.vehicles.find((v) => v.uid === state.deck[0])?.defId ?? "pickup"]?.name ?? "machine";
    const why = uncouple(state, rig);
    if (!why) log(state, `${name} is off the lowboy.`);
    return why;
  }

  if (target) return why;
  return "Pull up to an empty parked machine.";
}
export function mountainUnlockable(state: GameState) {
  return state.claims.includes(VALLEY_CLAIMS.quarry) || state.claims.includes(VALLEY_CLAIMS.rim);
}

export function mountainOpen(state: GameState) {
  return state.claims.includes(MOUNTAIN_CLAIM);
}

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

export function sourceOptions(state: GameState, area: AreaId, defId?: string) {
  if (defId === "lowboy") {
    const maps: { value: string; label: string }[] = [{ value: "map:ridge", label: areaName("ridge") }];
    if (valleyOpen(state)) maps.push({ value: "map:river", label: areaName("river") });
    if (mountainOpen(state)) maps.push({ value: "map:mountain", label: areaName("mountain") });
    return maps;
  }
  const options: { value: string; label: string }[] = [];
  for (const c of CLAIMS) {
    if (!ownsClaim(state, c.id)) continue;
    const claimArea = claimAreaOf(c.id);
    if (claimArea !== area && !(claimArea === "mountain" && mountainOpen(state))) continue;
    options.push({ value: String(c.id), label: `${c.name} · ${areaName(claimArea)}` });
  }
  if (mountainOpen(state)) {
    for (const d of state.deposits) {
      if (d.kind !== "vein" || d.claim !== MOUNTAIN_CLAIM) continue;
      options.push({ value: `face:${d.id}`, label: `${prettySign(d.sign)} · ${areaName(areaOf(d.x))}` });
    }
  }
  return options;
}

function haulBlocker(state: GameState, to: AreaId = haulTarget(state)) {
  const v = state.vehicles[state.active];
  if (!v) return "No machine.";
  if (v.defId === "lowboy") return "Drive the lowboy up the north road. The paid jump is for one machine.";
  if (state.deck?.includes(v.uid)) return "That machine is strapped to the lowboy.";
  if (!valleyOpen(state)) return "River Valley opens once you lease the Deep bench.";
  if (v.defId === "crusher") return "The track crusher stays at the ridge.";
  if (v.cargo > 0.05) return "Dump the load before it goes on the trailer.";
  if (state.blast) return "Finish the blast first.";
  const fee = haulFee(currentArea(state), to);
  if (state.cash < fee) return `The lowboy costs ${formatMoney(fee)}.`;
  return "";
}

/** Put the active machine on the lowboy trailer and send it to the other area. */
export function haulMachine(state: GameState, dest?: AreaId) {
  const to = dest && dest !== currentArea(state) && (dest !== "mountain" || mountainOpen(state)) ? dest : haulTarget(state);
  const why = haulBlocker(state, to);
  if (why) return why;
  const v = state.vehicles[state.active];
  const fee = haulFee(currentArea(state), to);
  state.cash -= fee;
  placeInArea(state, v, to);
  v.tool = homeTool(v.defId);
  v.stuck = 0;
  v.unstick = 0;
  if (to === "river" && !state.claims.includes(VALLEY_CLAIMS.bars)) {
    state.claims.push(VALLEY_CLAIMS.bars);
    log(state, "Welcome to River Valley. The river bars are yours. Silver pays best at a wash plant.");
  }
  log(state, `${DEFS[v.defId].name} hauled to ${areaName(to)} for ${formatMoney(fee)}.`);
  return "";
}

/** Jump into a machine that is already in the other area. */
export function goOtherArea(state: GameState) {
  const here = currentArea(state);
  const order: AreaId[] = ["ridge", "river", "mountain"];
  const start = order.indexOf(here);
  const has = (a: AreaId) => state.vehicles.some((v) => areaIn(v.x, v.z) === a && v.defId !== "crusher" && !(state.deck ?? []).includes(v.uid));
  const other = [1, 2].map((k) => order[(start + k) % 3]).find(has) ?? (here === "river" ? "ridge" : "river");
  const usable = (v: VehicleState) =>
    areaIn(v.x, v.z) === other && v.defId !== "crusher" && !(state.deck ?? []).includes(v.uid);
  const remembered = lastByArea.get(state)?.[other];
  const target = state.vehicles.find((v) => v.uid === remembered && usable(v)) ?? state.vehicles.find(usable);
  if (!target) return "No machine over there yet. Haul one on the lowboy.";
  setActive(state, state.vehicles.indexOf(target));
  log(state, `Now at ${areaName(areaIn(target.x, target.z))}.`);
  return "";
}

export function buySluicePlant(state: GameState) {
  if (state.sluice) return "Sluice is already running.";
  if (!spend(state, SLUICE.price, "Sluice plant is washing on the west road.")) return "Not enough cash.";
  state.sluice = true;
  if (state.contract?.ore === "gold") {
    repriceContract(state);
    log(state, "Gold contract now pays sluice prices.");
  }
  return "";
}

export function buyClaim(state: GameState, id: number) {
  if (ownsClaim(state, id)) return "Already leased.";
  if (id >= VALLEY_CLAIMS.bars && !valleyOpen(state)) return "River Valley opens once you lease the Deep bench.";
  if (id === MOUNTAIN_CLAIM && !mountainUnlockable(state)) return "The high mountain opens once you lease the Valley quarry or East rim.";
  const claim = CLAIMS.find((c) => c.id === id);
  if (!claim) return "No such ground.";
  if (!spend(state, claim.price, `${claim.name} is leased.`)) return "Not enough cash.";
  state.claims.push(id);
  if (id === 4) ensureLowboy(state);
  return "";
}

export function buyUpgrade(state: GameState, index: number, kind: UpgradeKind) {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  const cost = upgradeCost(v.defId, kind, v.upgrades[kind]);
  if (cost == null) return "Already maxed.";
  const label = kind === "engine" ? "Engine" : kind === "hydro" ? "Hydraulics" : DEFS[v.defId].bodyLabel;
  if (!spend(state, cost, `${DEFS[v.defId].name} ${label.toLowerCase()} fitted.`)) return "Not enough cash.";
  v.upgrades[kind] += 1;
  return "";
}

export function toggleCrew(state: GameState, index: number) {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  const name = DEFS[v.defId].name;
  if (!v.hired) {
    if (state.cash < HIRE_COST) {
      log(state, "Not enough cash to hire.");
      return "Not enough cash.";
    }
    state.cash -= HIRE_COST;
    v.hired = true;
    v.operator = true;
    state.tutorial.bought = true;
    log(state, v.defId === "lowboy"
      ? `Driver hired for the ${name}. They haul a parked machine to the map you assigned. You drive it when you are in the seat.`
      : `Operator hired for the ${name}. You keep ${Math.round(CREW_KEEP * 100)}% of their loads.`);
    return "";
  }
  v.operator = !v.operator;
  log(state, v.operator ? `${name} operator on duty.` : `${name} operator off shift.`);
  return "";
}

export function sellVehicle(state: GameState, index: number) {
  if (state.vehicles.length <= 1) return "Keep one machine on the yard.";
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  if (v.defId === "lowboy") return "The lowboy stays with the company.";
  if (state.deck?.includes(v.uid)) return "Unload it from the lowboy first.";
  const refund = resale(v);
  const name = DEFS[v.defId].name;
  state.vehicles.splice(index, 1);
  if (state.active > index) state.active -= 1;
  if (state.active >= state.vehicles.length) state.active = state.vehicles.length - 1;
  state.cash += refund;
  log(state, `Sold the ${name} for ${formatMoney(refund)}.`);
  return "";
}

function resale(v: VehicleState) {
  let sunk = DEFS[v.defId].price;
  for (const kind of ["engine", "body", "hydro"] as const) {
    for (let level = 0; level < v.upgrades[kind]; level++) sunk += upgradeCost(v.defId, kind, level) ?? 0;
  }
  return Math.round(sunk * 0.5);
}

/** Remembers the last machine driven on each map, so the travel button does not dump you in the crusher. */
const lastByArea = new WeakMap<GameState, Partial<Record<AreaId, string>>>();

export function setActive(state: GameState, index: number) {
  if (index < 0 || index >= state.vehicles.length) return;
  const v = state.vehicles[index];
  if ((state.deck ?? []).includes(v.uid)) return;
  state.active = index;
  v.stuck = 0;
  v.unstick = 0;
  const map = lastByArea.get(state) ?? {};
  map[areaIn(v.x, v.z)] = v.uid;
  lastByArea.set(state, map);
}

function cargoLine(state: GameState, v: VehicleState) {
  if (v.defId === "lowboy") {
    const ids = (state.deck ?? []).map((uid) => state.vehicles.find((o) => o.uid === uid)?.defId ?? "");
    const names = ids.map((id) => (id && DEFS[id] ? DEFS[id].name : "")).filter(Boolean);
    return `Deck ${spotsUsed(ids)}/3${names.length ? ` · ${names.join(", ")}` : " · empty"}`;
  }
  const st = vehicleStats(v);
  if (st.capacity <= 0) return "No bed";
  if (v.cargo < 0.05 || !v.cargoOre) return `Empty · ${st.capacity.toFixed(1)} tons`;
  return `${ORES[v.cargoOre].name} ${v.cargo.toFixed(1)} / ${st.capacity.toFixed(1)} tons`;
}

function objective(state: GameState) {
  const t = state.tutorial;
  if (!t.loaded) return "Load iron into the claim truck.";
  if (!t.dumped) return "Sell the load at the crusher.";
  if (!t.bought) return "Open the yard office and buy a machine.";
  const st = Ops.ops(state).story ?? 0;
  if (st < Career.STORY.length) return `${Career.storyText(st)} Pays ${formatMoney(Career.STORY[st].pay)}.`;
  if (!owns(state, "skid") && !owns(state, "dozer") && !owns(state, "loader") && !owns(state, "excavator")) {
    return "Buy a skid steer and cut the iron face.";
  }
  if (!state.claims.includes(2)) return "Lease the copper bench when the box can cover it.";
  if (!state.sluice) return "The sluice is how gold becomes a company.";
  if (!state.claims.includes(3)) return "Lease the gold creek, then wash it.";
  if (!owns(state, "truck") && (owns(state, "loader") || owns(state, "excavator"))) {
    return "A dump truck turns the digger into a crew.";
  }
  if (!owns(state, "excavator")) return "An excavator keeps a face working while you haul.";
  if (!state.claims.includes(4)) return "Lease the deep bench. Bring a heavy crew.";
  if (!owns(state, "heavy")) return "The heavy haul is the last truck on the yard.";
  const info = tierInfo(state.lifetime);
  if (info.next) return `Company mark: ${info.next}.`;
  return "The ridge is yours. Keep the faces moving.";
}

function hint(state: GameState) {
  const v = state.vehicles[state.active];
  if (!v) return "No machine in the seat.";
  if (v.defId === "lowboy") {
    if (onHaulRoad(v.x, v.z)) return "North road. Stay on the gravel. Unload wherever you stop.";
    return "Pull up to an empty machine and tap Load. Two small machines fit. A heavy haul rides alone.";
  }
  if (v.status.startsWith("Loaded") || v.status.startsWith("No dump") || v.status.startsWith("Bucket") || v.status.startsWith("Dump truck") || v.status.startsWith("Truck is") || v.status.startsWith("This machine")) {
    return v.status;
  }
  const def = DEFS[v.defId];
  const st = vehicleStats(v);
  if (!state.tutorial.loaded) return "Drive to the iron pile. Hold DIG to scoop.";
  if (!state.tutorial.dumped) return "Hold DIG beside the track crusher. Drive that plant with Next.";
  if (def.id === "crusher") return "Tracks. Drive it up to the dig. Other machines dump into the hopper beside you.";
  if (v.status === "Unleased ground" || v.status.startsWith("Dump ")) return v.status + ".";
  const extra = def.id === "excavator" ? 2.2 : 0;
  const pad = nearestPad(state, v.x, v.z);
  if (v.cargoOre && prefersWash(state, v.cargoOre, v.x) && v.cargo > 0.08) {
    if (pad?.kind === "wash") return "Hold DIG. The wash plant pays for this load.";
    if (v.cargoOre === "dirt") return "Overburden goes to the wash plant. It pays more than the rail.";
    return `${ORES[v.cargoOre].name} pays at the wash plant.`;
  }
  if (v.cargoOre && (prefersSluice(state, v.cargoOre, v.x) || dirtToSluice(state, v.cargoOre, v.x)) && v.cargo > 0.08) {
    if (pad?.kind === "sluice") return "Hold DIG. The sluice pays for this load.";
    if (v.cargoOre === "dirt") return "Overburden goes to the sluice, west of the yard. It pays more than reclaim.";
    return `${ORES[v.cargoOre].name} pays at the sluice, west of the yard. The crusher will not buy it.`;
  }
  if (v.cargo > 0.08 && pad) return `Hold DIG to sell at the ${pad.name.toLowerCase()}.`;
  const truck = !def.receives && v.cargo > 0.08 ? nearestHauler(state, v, 28, false) : null;
  if (truck) return `Tap LOAD to put this bucket in the ${DEFS[truck.defId].name.toLowerCase()}.`;
  if (st.capacity > 0 && v.cargo >= st.capacity * 0.92) {
    if (v.cargoOre && prefersSluice(state, v.cargoOre, v.x)) return "Full. Haul it to the sluice. It pays more.";
    return def.receives ? "Bed full. Dump beside the track crusher." : "Full. Haul it out, or pull up to a dump truck.";
  }
  const locked = state.deposits.find((d) => !ownsClaim(state, d.claim) && distTo(v.x, v.z, d.x, d.z) < d.radius + 3);
  if (locked) return `${locked.sign} is unleased. Open Ground in the yard office.`;
  if (def.push > 0) return "Hold DIG with the blade in a face. It builds a pile.";
  if (def.dig > 0) {
    const vein = closestDeposit(state, v.x, v.z, "vein", extra);
    if (vein && ownsClaim(state, vein.claim)) return `Hold DIG to break ${ORES[vein.ore].name.toLowerCase()} off the face. The loose rock falls in front.`;
    return "Find a face inside the gate. Next switches machines.";
  }
  if (def.scoop > 0) {
    const pile = closestDeposit(state, v.x, v.z, "pile", 0);
    if (pile) return `Hold DIG. Each bite lifts ${ORES[pile.ore].name.toLowerCase()} into the bucket.`;
    return "No pile in reach. A dozer or excavator makes them.";
  }
  if (def.receives) {
    if (v.cargo < 0.1) return "Park beside a payloader or excavator and let them fill you.";
    return "Hold DIG beside the track crusher to dump.";
  }
  return "Drive with the stick. Hold DIG to work. Next switches machines.";
}

function realHint(state: GameState): string | null {
  const v = state.vehicles[state.active];
  if (!v || state.controlMode !== "real") return null;
  const k = machineKind(v.defId);
  const t = v.tool;
  const pad = nearestPad(state, v.x, v.z);
  const full = vehicleStats(v).capacity > 0 && v.cargo >= vehicleStats(v).capacity * 0.92;
  const face = faceNearPlayer(state, v, 2);
  if (face && face.stress > 0.5) return `The ${face.sign} wall is getting steep! Lift the bucket halfway and strip the dirt off the top first.`;
  if (k === "skid" || k === "loader") {
    const arms = k === "skid" ? "left stick right" : "right stick up";
    const curl = "right stick left";
    if (v.cargo > 0.08 && (pad || truckNear(state, v, v.x, v.z, 9))) {
      if (t.lift < 0.45) return `Raise the arms (${arms}), then dump (right stick right).`;
      return "Dump the bucket: right stick right.";
    }
    if (full) return "Bucket full. Lift it a little and drive to a truck, the crusher or the waste pile.";
    if (t.lift > 0.5) return `Lower the arms to the ground (${k === "skid" ? "left stick left" : "right stick down"}).`;
    return `Roll in slowly with the bucket low, then curl it back (${curl}). Too fast spills.`;
  }
  if (k === "excavator") {
    const tip = bucketPoint(v.x, v.z, v.yaw, t);
    if (v.cargo > 0.08) {
      const truck = truckNear(state, v, tip.x, tip.z, 5.5);
      if (truck) return t.lift < 0.35 ? "Bucket is over the truck. Boom up (right stick back), then dump (right stick right)." : "Dump it: right stick right.";
      return "Swing (left stick sideways) until the bucket is over a truck, boom up and dump.";
    }
    if (closestFace(state, tip.x, tip.z, v)) return "Boom down (right stick forward), arm out (left stick forward), curl slowly (right stick left). Don't swing while curling.";
    return "Tap Sticks: tracks to drive. Swing and reach the bucket into a face.";
  }
  if (k === "dozer") {
    if (t.lift < 0.08) return "Blade is buried and stalling. Lift it a little (right stick up).";
    if (t.lift >= 0.3) return "Lower the blade (right stick down) and drive into a face or pile.";
    return "Blade on the ground. Push the left stick forward into the face.";
  }
  if (k === "truck") {
    if (v.cargo > 0.08 && pad) return t.lift < 0.6 ? `At the ${pad.name.toLowerCase()}. Raise the bed (right stick up).` : "Dumping…";
    if (t.lift > 0.2) return "Lower the bed (right stick down) before you drive.";
    if (v.tool.gear === 0) return "In neutral. Tap Gear ▲ to drive forward.";
  }
  return null;
}

function toolLabel(v: VehicleState, mode: ControlMode) {
  if (mode !== "real") return "";
  const k = machineKind(v.defId);
  const t = v.tool;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const bucket = t.tilt > 0.5 ? "curled" : t.tilt < -0.3 ? "dumped" : "level";
  if (k === "skid" || k === "loader") return `Arms ${pct(t.lift)} · bucket ${bucket}`;
  if (k === "excavator") {
    const deg = Math.round((t.swing * 180) / Math.PI);
    return `Boom ${pct(t.lift)} · arm ${pct(t.reach)} · swing ${Math.abs(deg)}°${deg > 0 ? " L" : deg < 0 ? " R" : ""} · bucket ${bucket}`;
  }
  if (k === "dozer") return `Blade ${t.lift < 0.08 ? "buried" : t.lift < 0.3 ? "on the ground" : "raised"} · angle ${Math.round(t.tilt * 30)}°`;
  if (k === "truck") return `Bed ${t.lift > 0.6 ? "up" : t.lift > 0.05 ? "rising" : "down"}`;
  return "";
}

function faceLabel(state: GameState, v: VehicleState) {
  const d = faceNearPlayer(state, v, 10);
  if (!d) return "";
  const wall = d.stress > 0.5 ? " · WALL STEEP" : "";
  const hard = d.hard ? " · hard rock" : "";
  if (!d.tested) return `${d.sign} · bench ${d.bench} · not tested${hard}${wall}`;
  return `${d.sign} · seam ${Math.round(d.grade * 100)}% · ${d.overburden.toFixed(0)} tons dirt on top · bench ${d.bench}${hard}${wall}`;
}

function priceRows(state: GameState, here: AreaId): HudModel["prices"] {
  const pads = PADS.filter((p) => padOpen(state, p.kind) && areaOf(p.x) === here);
  return (Object.keys(ORES) as OreId[]).filter((ore) => ore !== "silver" || here === "river").map((ore) => ({
    ore,
    name: ORES[ore].name,
    spots: pads.filter((p) => basePrice(ore, p.kind, state.sluice) > 0).map((p) => {
      const mult = priceMult(state.market, p.kind, ore);
      return {
        pad: p.kind,
        name: p.name,
        price: `${formatMoney(unitPrice(ore, p.kind, state.sluice, state.market))}/t`,
        trend: trend(state.market, p.kind, ore),
        pct: Math.round(mult * 100),
      };
    }),
  }));
}

function blastLabel(state: GameState) {
  const b = state.blast;
  if (!b) return "";
  if (b.phase === "drill")
    return b.t < BORE_SECONDS
      ? `Drill rig boring holes… ${Math.max(0, DRILL_SECONDS - b.t).toFixed(1)} s. You can move.`
      : `Charging the holes… ${Math.max(0, DRILL_SECONDS - b.t).toFixed(1)} s. Get back.`;
  const v = state.vehicles[state.active];
  const far = v ? distTo(v.x, v.z, b.x, b.z) : 99;
  return `BLAST IN ${Math.ceil(b.t)} · you are ${usDist(far)}${far < BLAST_RADIUS ? ` · GET BACK ${usDist(BLAST_RADIUS)}!` : " · safe"}`;
}

export function buildHud(state: GameState, hadSave: boolean, excDrive = false): HudModel {
  const v = state.vehicles[state.active];
  const info = tierInfo(state.lifetime);
  const st = v ? vehicleStats(v) : null;
  const sec = Math.floor(state.seconds);
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  const machines: HudModel["machines"] = VEHICLE_ORDER.filter((id) => id !== "pickup" && id !== "crusher").map((id) => {
    const def = DEFS[id];
    const count = state.vehicles.filter((v) => v.defId === id).length;
    const price = yardCap(id) > 1 ? def.price * (count + 1) : def.price;
    const owned = count >= yardCap(id);
    const blurb = yardCap(id) > 1 && count > 0 && count < yardCap(id) ? `${count} on the yard. Next one is ${formatMoney(price)}.` : def.blurb;
    return {
      id,
      name: def.name,
      blurb,
      priceLabel: owned ? "Owned" : count > 0 ? `Another ${formatMoney(price)}` : formatMoney(price),
      owned,
      affordable: !owned && state.cash >= price,
      kind: "vehicle" as const,
    };
  });
  if (valleyOpen(state) && currentArea(state) === "river") {
    machines.push({
      id: WASH_PLANT.id,
      name: WASH_PLANT.name,
      blurb: WASH_PLANT.blurb,
      priceLabel: state.washPlant ? "Owned" : formatMoney(WASH_PLANT.price),
      owned: state.washPlant,
      affordable: !state.washPlant && state.cash >= WASH_PLANT.price,
      kind: "plant",
    });
  }
  if (currentArea(state) === "ridge") machines.push({
    id: SLUICE.id,
    name: SLUICE.name,
    blurb: SLUICE.blurb,
    priceLabel: state.sluice ? "Owned" : formatMoney(SLUICE.price),
    owned: state.sluice,
    affordable: !state.sluice && state.cash >= SLUICE.price,
    kind: "plant",
  });
  const lowboy = state.vehicles.find((v) => v.defId === "lowboy");
  const crew: HudModel["crew"] = state.vehicles.map((veh, index) => {
    const def = DEFS[veh.defId];
    const onDeck = (state.deck ?? []).includes(veh.uid);
    const area = onDeck && lowboy ? areaIn(lowboy.x, lowboy.z) : areaIn(veh.x, veh.z);
    const kinds: { kind: UpgradeKind; label: string }[] = [
      { kind: "engine", label: "Engine" },
      { kind: "body", label: def.bodyLabel },
      { kind: "hydro", label: "Hydraulics" },
    ];
    return {
      index,
      name: def.name,
      area,
      where: onDeck ? "On the lowboy" : onHaulRoad(veh.x, veh.z) && !inDropYard(veh.x, veh.z) ? "On the north road" : "",
      status: index === state.active && !state.watching ? "In your seat" : veh.operator ? veh.status || "On duty" : "Parked",
      cargo: cargoLine(state, veh),
      active: index === state.active,
      hired: veh.hired,
      operator: veh.operator,
      workClaim: veh.workClaim ?? null,
      workSource: veh.defId === "lowboy"
        ? lowboyDest(veh) ? `map:${lowboyDest(veh)}` : "any"
        : veh.workFace ? `face:${veh.workFace}` : veh.workClaim != null ? String(veh.workClaim) : "any",
      sources: sourceOptions(state, area, veh.defId),
      hireLabel: veh.hired ? (veh.operator ? "On duty" : "Off shift") : `Hire · ${formatMoney(HIRE_COST)}`,
      sellLabel: state.vehicles.length > 1 ? `Sell · ${formatMoney(resale(veh))}` : null,
      affordableHire: veh.hired || state.cash >= HIRE_COST,
      repairLabel: (veh.damage ?? 0) > 0.001 ? `Repair · ${formatMoney(repairCost(def.price, veh.damage))}` : null,
      affordableRepair: state.cash >= repairCost(def.price, veh.damage ?? 0),
      damageLabel: (veh.damage ?? 0) > 0.001 ? `Damaged ${Math.round(veh.damage * 100)}%` : "",
      upgrades: kinds.map((k) => {
        const cost = upgradeCost(veh.defId, k.kind, veh.upgrades[k.kind]);
        return {
          kind: k.kind,
          label: k.label,
          level: veh.upgrades[k.kind],
          costLabel: cost == null ? null : formatMoney(cost),
          affordable: cost != null && state.cash >= cost,
        };
      }),
    };
  });
  const here = currentArea(state);
  const grounds: HudModel["grounds"] = CLAIMS.filter((c) => c.id < VALLEY_CLAIMS.bars || (c.id === MOUNTAIN_CLAIM ? mountainUnlockable(state) || mountainOpen(state) : valleyOpen(state))).map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    priceLabel: c.price === 0 ? "Included" : formatMoney(c.price),
    owned: ownsClaim(state, c.id),
    affordable: !ownsClaim(state, c.id) && state.cash >= c.price,
    here: claimAreaOf(c.id) === here || c.id === MOUNTAIN_CLAIM,
    area: claimAreaOf(c.id),
  }));
  const savedBlurb = hadSave
    ? `${state.company} · ${formatMoney(state.cash)} · ${info.name}`
    : `New outfit. Claim truck and ${formatMoney(START_CASH)} in the box.`;
  const contract = state.contract;
  const contractLabel = contract
    ? `Contract: ${ORES[contract.ore].name} ${Math.min(contract.delivered, contract.need).toFixed(1)}/${contract.need} tons · ${formatMoney(contract.bonus)} bonus`
    : "";
  return {
    company: state.company,
    cashLabel: formatMoney(state.cash),
    tier: info.name,
    tierNext: info.next,
    tierProgress: info.progress,
    tierDetail: info.nextAt != null ? `${formatMoney(state.lifetime)} earned · ${formatMoney(info.nextAt)} to ${info.next}` : "The books are closed on a full company.",
    shift: `Shift ${mm}:${ss.toString().padStart(2, "0")}`,
    hint: state.watching
      ? "You stepped out. On-duty operators keep working. Tap a machine to watch it, or Sit to drive."
      : realHint(state) ?? hint(state),
    objective: objective(state),
    vehicleName: v ? DEFS[v.defId].name : "—",
    vehicleIndex: state.active,
    vehicleCount: state.vehicles.length,
    speedLabel: `${Math.round(Math.abs(v?.speed ?? 0) * 2.15)} mph`,
    moving: Math.abs(v?.speed ?? 0) > 0.6,
    cargoLabel: v ? cargoLine(state, v) : "",
    cargoFrac: st && st.capacity > 0 && v ? clamp(v.cargo / st.capacity, 0, 1) : 0,
    muted: state.muted,
    sluice: state.sluice,
    preferSluice: state.preferSluice,
    feedLimit: state.feedLimit,
    log: state.log.slice(0, 4),
    machines,
    crew,
    grounds,
    hadSave,
    savedBlurb,
    contractLabel,
    controlMode: state.controlMode,
    machineId: v ? v.defId : null,
    gearLabel: v && state.controlMode === "real" && usesGears(v.defId) ? `Gear ${gearName(v.tool.gear)}` : null,
    toolLabel: v ? toolLabel(v, state.controlMode) : "",
    purityLabel: v && v.cargo > 0.05 && v.cargoOre && v.cargoOre !== "dirt" ? `Purity ${Math.round((v.cargoPurity ?? 1) * 100)}%` : "",
    faceLabel: v ? faceLabel(state, v) : "",
    help: controlHelp(v?.defId ?? "pickup", excDrive),
    twoSticks: state.controlMode === "real" && !!v && machineKind(v.defId) !== "car",
    prices: priceRows(state, currentArea(state)),
    dayLabel: (() => {
      const left = Math.max(0, DAY_SECONDS - (state.seconds % DAY_SECONDS));
      return `Day ${state.market.day + 1} · new prices in ${Math.floor(left / 60)}:${Math.floor(left % 60).toString().padStart(2, "0")}`;
    })(),
    explosives: state.explosives,
    blastInfo: (() => {
      const d = v ? faceNearPlayer(state, v) : null;
      if (!d || state.blast) return "";
      if (!ownsClaim(state, d.claim) || d.tons < 1) return "";
      if (!canBlastToday(d.lastBlastDay, state.market.day)) return `${d.sign} already blasted today · next blast tomorrow`;
      if (state.explosives > 0) return `Blast ${d.sign} · free practice charge (${state.explosives} left)`;
      return `Blast ${d.sign} · ${formatMoney(blastPrice())} for ~${blastYield(d.tons).toFixed(0)} tons loose`;
    })(),
    canTest: !!v && (() => {
      const d = faceNearPlayer(state, v);
      return !!d && !d.tested && ownsClaim(state, d.claim);
    })(),
    canBlast: !!v && !state.blast && (() => {
      const d = faceNearPlayer(state, v);
      return !!d && ownsClaim(state, d.claim) && d.tons >= 1 && canBlastToday(d.lastBlastDay, state.market.day) && (state.explosives > 0 || state.cash >= blastPrice());
    })(),
    blastLabel: blastLabel(state),
    practice: false,
    ...areaHud(state),
  };
}

function areaHud(state: GameState) {
  const v = state.vehicles[state.active];
  const area = currentArea(state);
  const other: AreaId = haulTarget(state);
  const open = valleyOpen(state);
  const blocker = haulBlocker(state);
  const rain = rainNow(state);
  const depth = v ? mudDepth(v.x, v.z, state.wet) : 0;
  let groundLabel = "";
  if (v && depth > 0.05 && !onBridge(v.x, v.z)) {
    const f = Math.round(groundFactor(state, v) * 100);
    groundLabel = boggedDown(v.defId, depth)
      ? `Bogged in deep mud · ${f}% speed · back out or use tracks`
      : `Mud · ${f}% speed${TRACKED.has(v.defId) ? " · tracks help" : ""}`;
  }
  if (v && area === "mountain") {
    const f = Math.round(groundFactor(state, v) * 100);
    groundLabel = `${f}% speed · bench ${benchAt(v.z)} of 3`;
  }
  let bridgeLabel = "";
  if (v && area === "river" && Math.abs(v.x - BRIDGE.x) < BRIDGE.halfLength + 14 && Math.abs(v.z - BRIDGE.z) < 14) {
    const t = crossingWeight(state, v);
    bridgeLabel = t <= BRIDGE.limit
      ? `Bridge ${BRIDGE.limit} ton limit · you weigh ${t.toFixed(0)} tons · OK`
      : `Bridge ${BRIDGE.limit} ton limit · you weigh ${t.toFixed(0)} tons · TOO HEAVY`;
  }
  const onRoad = !!v && onHaulRoad(v.x, v.z);
  const onMountain = !!v && onMountainRoad(v.x, v.z);
  const deck = deckHud(state);
  const passLabel = !v
    ? ""
    : onMountain
      ? v.x < MOUNTAIN_GATE_X
        ? `${usDist(Math.max(0, MOUNTAIN_GATE_X - v.x))} to the summit gate`
        : v.x < X1 - 70
          ? `${usDist(Math.max(0, X1 - 50 - v.x))} to the quarry road`
          : "Quarry road · south to the faces"
      : onRoad
        ? area === "river"
          ? `${usDist(Math.max(0, v.x))} back to Ridge pit`
          : `${usDist(Math.max(0, VALLEY_GATE_X - v.x))} to River Valley`
        : "";
  const routeLabel =
    mountainOpen(state) && area !== "mountain" && !onMountain
      ? "High mountain quarry: lowboy, north road, then east past River Valley."
      : mountainUnlockable(state) && !mountainOpen(state) && area === "river"
        ? "High mountain road leaves the north road east of camp. Lease it in Ground."
        : "";
  return {
    area,
    areaName: onRoad ? "North road" : areaName(area),
    passLabel,
    routeLabel,
    officeTitle: onRoad ? "Yard office" : area === "mountain" ? "Mountain office" : area === "river" ? "Valley office" : "Ridge office",
    valleyOpen: open,
    mountainOpen: mountainOpen(state),
    ripperControl: !!v && v.defId === "dozer" && !state.watching && Ops.on(3) && Ops.ops(state).ripper,
    ripper: v?.ripper ?? 0,
    mountainHaul:
      area === "ridge" && mountainOpen(state) && !onRoad
        ? haulBlocker(state, "mountain") || `Haul ${v ? DEFS[v.defId].name : "machine"} straight to High mountain · ${formatMoney(MOUNTAIN_HAUL_FEE)}`
        : null,
    canHaulMountain: area === "ridge" && mountainOpen(state) && !onRoad && !haulBlocker(state, "mountain"),
    travelLabel: !open
      ? "River Valley opens once you lease the Deep bench"
      : blocker || `Haul ${v ? DEFS[v.defId].name : "machine"} to ${areaName(other)} · ${formatMoney(haulFee(area, other))}`,
    canHaul: open && !blocker,
    canGoOther: state.vehicles.some(
      (o) => areaIn(o.x, o.z) === other && o.defId !== "crusher" && !(state.deck ?? []).includes(o.uid),
    ),
    otherAreaName: areaName(other),
    rain,
    weatherLabel: area === "mountain" ? (rain > 0.6 ? "Heavy snow" : rain > 0.05 ? "Snow" : "Cold, clear") : rain > 0.6 ? "Heavy rain" : rain > 0.05 ? "Rain" : state.wet > 0.25 ? "Wet ground" : "Dry",
    groundLabel,
    bridgeLabel,
    bridgeClock: area === "river" || Ops.bridgeClosed(state) ? Ops.bridgeClock(state) : "",
    washPlant: state.washPlant,
    deckLabel: deck.label,
    deckButton: deck.button,
    watching: state.watching,
    opsLine: Ops.statusLine(state),
    shop: [...Ops.shopButtons(state), ...lotButtons(state)],
    field: Ops.fieldButtons(state, opsCtx(state)),
    records: Ops.recordsLines(state),
    photo: Ops.ops(state).photo,
    night: Ops.on(8) ? Ops.nightness(state.seconds) : 0,
  };
}

/** What the site-ops buttons need to know about the face in front of the player. */
export function opsCtx(state: GameState) {
  const v = state.vehicles[state.active];
  const d = v ? faceNearPlayer(state, v) : null;
  const nearIds = v ? state.deposits.filter((x) => x.kind === "vein" && sameArea(x, v) && distTo(v.x, v.z, x.x, x.z) < 40).map((x) => x.id) : [];
  return { nearFace: d ? { id: d.id, ore: d.ore, hard: d.hard, tested: d.tested } : null, nearIds };
}

export function opsAction(state: GameState, id: string) {
  if (id.startsWith("lot:")) return lotBuy(state, id.slice(4) as VehicleId, false);
  if (id.startsWith("lottrade:")) return lotBuy(state, id.slice(9) as VehicleId, true);
  return Ops.act(state, id, opsCtx(state));
}

function deckHud(state: GameState): { label: string; button: string | null } {
  const rig = state.vehicles[state.active];
  if (!rig || rig.defId !== "lowboy") return { label: "", button: null };
  const ids = state.deck ?? [];
  const defIds = ids
    .map((uid) => state.vehicles.find((o) => o.uid === uid)?.defId)
    .filter((id): id is VehicleId => !!id);
  const names = defIds.map((id) => DEFS[id].name);
  const label = `LOWBOY · ${spotsUsed(defIds)}/3${names.length ? ` · ${names.join(", ")}` : " · empty"}`;
  const near = nearestDeckLoad(state, rig);
  if (near && !deckFit(defIds, near.defId)) return { label, button: "Load" };
  if (ids.length) return { label, button: "Unload" };
  return { label, button: null };
}
