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
  bridgeAllows,
  bridgeMaxLoad,
  crossingWorth,
  otherBank,
  grossTons,
  mudDepth,
  mudSpeedFactor,
  inRiver,
  onBridge,
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
import { blockRoadGate, deckFit, deckSpots, inDropYard, onHaulRoad, spotsUsed } from "@/game/lowboy";
import {
  BLAST_RADIUS,
  BLAST_COST,
  canBlastToday,
  DRILL_SECONDS,
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

export const MARKET_PADS = ["crusher", "reclaim", "sluice", "loadout", "wash", "barge"] as const;
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
  return { x: d.x + rx * along, z: d.z + rz * along, reach: 3.6, yaw: Math.atan2(-rx, -rz) };
}

/** Where faces are approached from: the pit gate on the ridge, the bridge in the valley. */
export function gateFor(x: number) {
  return areaOf(x) === "river" ? { x: BRIDGE.x, z: BRIDGE.z } : GATE;
}

function sameArea(a: { x: number }, b: { x: number }) {
  return areaOf(a.x) === areaOf(b.x);
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
  if (v.workClaim != null && d.claim !== v.workClaim) return false;
  if (d.id === "starter" && v.workClaim != null) return false;
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
  if (pad === "reclaim") return ore === "dirt" ? o.reclaim : Math.round(o.crusher * 0.4);
  if (pad === "sluice") {
    if (!sluice) return 0;
    if (ore === "gold") return o.sluice;
    if (ore === "copper") return o.sluice;
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
  const bonus = contract.bonus;
  state.cash += bonus;
  state.lifetime += bonus;
  state.contractSeq += 1;
  state.contract = rollContract(state.contractSeq, state.claims, state);
  log(state, `Contract filled. Bonus ${formatMoney(bonus)}. Next: ${state.contract.need} t ${ORES[state.contract.ore].name}.`);
  return bonus;
}

export function freshGame(company: string): GameState {
  const name = company.trim().slice(0, 24) || "Ridge Ore Co.";
  return {
    version: 3,
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
    washPlant: false,
    wet: 0,
    muted: false,
    deck: [],
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
  let best: VehicleState | null = null;
  let bestD = maxDist;
  for (const o of state.vehicles) {
    if (o === v) continue;
    if (!DEFS[o.defId].receives) continue;
    if (!sameArea(o, v)) continue;
    if (operatedOnly && !o.operator && state.vehicles[state.active] !== o) continue;
    const room = vehicleStats(o).capacity - o.cargo;
    if (room < 0.4) continue;
    if (o.cargo > 0.15 && o.cargoOre && v.cargoOre && o.cargoOre !== v.cargoOre) continue;
    const d = distTo(v.x, v.z, o.x, o.z);
    if (d <= bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
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

function addPile(state: GameState, ore: OreId, tons: number, x: number, z: number, claim = 1, purity = 1) {
  if (tons <= 0) return;
  let best: Deposit | null = null;
  let bestD = 16;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.ore !== ore) continue;
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

function prefersSluice(state: GameState, ore: OreId) {
  return state.sluice && state.preferSluice && ORES[ore].sluice > ORES[ore].crusher;
}

/** River silver only pays properly at the wash plant, so hold it for there once it's built. */
function prefersWash(state: GameState, ore: OreId, x: number) {
  return state.washPlant && areaOf(x) === "river" && ORES[ore].wash > ORES[ore].crusher;
}

function washScore(state: GameState, ore: OreId) {
  if (!state.sluice || !state.preferSluice) return 0;
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
    if (pad.kind === "wash" && prefersWash(state, ore, x)) return pad;
    // When the sluice is purchased, route copper/gold there first: it is the
    // intended recovery plant, not a distance-scored fallback to the crusher.
    if (pad.kind === "sluice" && prefersSluice(state, ore)) return pad;
    // A bridge crossing is a price choice, not a long haul. Metres must not
    // talk a dump truck into the cheaper barge.
    const d = distTo(x, z, pad.x, pad.z);
    const s = otherBank(x, pad.x) ? unit - 12 : unit - d * 0.55;
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
  let best: Deposit | null = null;
  let score = -1;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 1) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (v.workClaim != null && d.claim !== v.workClaim) continue;
    if (ore && d.ore !== ore) continue;
    if (!sameArea(d, v)) continue;
    const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z);
    const s = (unit * Math.min(d.tons, 50)) / (d0 + 10) + (d0 < 40 ? 1000 : 0) + (d.ore === "dirt" ? 0 : 2000) + washScore(state, d.ore);
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return best;
}

function bestPile(state: GameState, v: VehicleState) {
  let best: Deposit | null = null;
  let score = -1;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.tons < 0.4) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (!acceptsJob(state, v, d)) continue;
    if (v.cargo > 0.15 && v.cargoOre && v.cargoOre !== d.ore) continue;
    if (!sameArea(d, v)) continue;
    const unit = prefersSluice(state, d.ore) ? ORES[d.ore].sluice : ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z);
    const s = (unit * Math.min(d.tons, 30)) / (d0 + 8) + (d0 < 36 ? 1000 : 0) + washScore(state, d.ore);
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return best;
}

function routeTo(v: VehicleState, tx: number, tz: number) {
  if (areaOf(v.x) === "river") return routeRiver(v, tx, tz);
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
  if (tx < -58 && v.x > -62) {
    if (v.z < 12 && v.x < -22) return { x: -6, z: Math.min(v.z, 3) };
    if (v.z < 16) return { x: Math.max(v.x, -18), z: 20 };
    return { x: -70, z: Math.max(18, Math.min(v.z, 30)) };
  }
  return { x: tx, z: tz };
}

/** In the valley the only way over the river is the bridge. */
function routeRiver(v: VehicleState, tx: number, tz: number) {
  const side = Math.sign(v.x - BRIDGE.x);
  const goal = Math.sign(tx - BRIDGE.x);
  if (side === goal || side === 0 || goal === 0) return { x: tx, z: tz };
  const end = BRIDGE.halfLength + 4;
  if (onBridge(v.x, v.z, 1)) return { x: BRIDGE.x + goal * (end + 2), z: BRIDGE.z };
  const near = { x: BRIDGE.x + side * end, z: BRIDGE.z };
  // Line up with the deck first, then drive straight over.
  if (Math.abs(v.z - BRIDGE.z) > 2.2 || Math.abs(v.x - near.x) > 5) return near;
  return { x: BRIDGE.x + goal * (end + 2), z: BRIDGE.z };
}

function seek(v: VehicleState, tx: number, tz: number, arrive: number): Control {
  const routed = routeTo(v, tx, tz);
  const via = Math.hypot(routed.x - tx, routed.z - tz) > 3;
  const dx = routed.x - v.x;
  const dz = routed.z - v.z;
  const d = Math.hypot(dx, dz) || 0.0001;
  const desired = Math.atan2(-dx, -dz);
  const diff = Math.atan2(Math.sin(desired - v.yaw), Math.cos(desired - v.yaw));
  // Fast machines (the skid steer especially) were bang-bang steering around
  // the target and drawing figure-eights. Scale the gain to the turn rate.
  const steer = clamp(diff / Math.max(0.9, vehicleStats(v).turn * 0.5), -1, 1);
  let throttle = 1;
  let brake = 0;
  if (Math.abs(diff) > 0.7) {
    throttle = 0;
    brake = 0.7;
  } else if (Math.abs(diff) > 0.32) {
    throttle = 0.25;
  }
  if (d < arrive + 6) throttle = Math.min(throttle, 0.4);
  if (d < arrive) {
    if (via) return { throttle: 0.55, steer: clamp(diff, -1, 1), action: false, brake: 0 };
    if (Math.abs(diff) > 1) return { throttle: 0, steer: clamp(diff, -1, 1), action: false, brake: 1 };
    return { throttle: 0, steer: 0, action: true, brake: 1 };
  }
  return { throttle, steer, action: false, brake };
}

function workHere(v: VehicleState, x: number, z: number, radius: number): Control | null {
  if (distTo(v.x, v.z, x, z) > radius) return null;
  if (Math.abs(v.speed) > 0.7) return { throttle: 0, steer: 0, action: false, brake: 1 };
  return { throttle: 0, steer: 0, action: true, brake: 1 };
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

  if (v.unstick > 0) {
    v.status = "Backing off a wall";
    return { throttle: -0.65, steer: v.bias, action: false, brake: 0 };
  }

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
      return { ...ZERO };
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

  const haulTarget = () => {
    if (!v.cargoOre) return;
    const loaderLike = def.id === "loader";
    if (loaderLike) {
      const truck = nearestHauler(state, v, 70, true);
      if (truck) {
        target = truck;
        arrive = 7.5;
        label = `Loading ${DEFS[truck.defId].name}`;
        return;
      }
    }
    const pad = bestPad(state, v.cargoOre, v.x, v.z, v);
    if (pad) {
      target = pad;
      arrive = Math.max(5, pad.r * 0.62);
      label = `Hauling to ${pad.name}`;
    }
  };

  const waitingTruck = def.id === "loader" && v.cargo > 0.35 ? nearestHauler(state, v, 80, true) : null;

  if (def.push > 0) {
    const vein = bestVein(state, v, null);
    if (vein) {
      target = vein;
      arrive = vein.radius * 0.72;
      label = `Stripping ${ORES[vein.ore].name}`;
    } else label = "No face in reach";
  } else if (def.dig > 0) {
    if (full && v.cargoOre) haulTarget();
    const digHaul = target as { x: number; z: number } | null;
    if (digHaul) {
      v.status = label;
      return seek(v, digHaul.x, digHaul.z, arrive);
    }
    let vein: Deposit | null = null;
    let veinS = -Infinity;
    for (const d of state.deposits) {
      if (d.kind !== "vein" || d.tons < 0.35) continue;
      if (!ownsClaim(state, d.claim)) continue;
      if (v.workClaim != null && d.claim !== v.workClaim) continue;
      const dist = distTo(v.x, v.z, d.x, d.z);
      const s = washScore(state, d.ore) + (d.ore === "dirt" ? 0 : 1500) + (dist < 42 ? 400 : 0) - dist;
      if (s > veinS) {
        veinS = s;
        vein = d;
      }
    }
    if (vein) {
      const cut = faceOf(vein);
      const job = CLAIMS.find((c) => c.id === vein.claim)?.name ?? ORES[vein.ore].name;
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Working ${job}`;
        return held;
      }
      v.status = `Heading to ${job}`;
      return seek(v, cut.x, cut.z, Math.max(3, cut.reach * 0.75));
    }
    if (v.cargo > 0.25 && v.cargoOre) haulTarget();
    else {
      const pile = bestPile(state, v);
      if (pile) {
        v.status = `Scooping ${ORES[pile.ore].name}`;
        return seek(v, pile.x, pile.z, Math.max(3.5, pile.radius * 0.72));
      }
      v.status = "Face is dug out";
      return { ...ZERO };
    }
  } else if (def.receives) {
    const bedFull = cap > 0 && v.cargo >= cap * 0.9;
    if (bedFull) haulTarget();
    if (!target) {
      let digger: VehicleState | null = null;
      let diggerD = Infinity;
      for (let i = 0; i < state.vehicles.length; i++) {
        if (i === index) continue;
        const o = state.vehicles[i];
        if (!(o.operator || i === state.active)) continue;
        if (o.defId !== "loader" && o.defId !== "excavator") continue;
        if (o.cargo < 0.4) continue;
        const d = distTo(v.x, v.z, o.x, o.z);
        if (d < diggerD) {
          diggerD = d;
          digger = o;
        }
      }
      if (digger) {
        if (diggerD < 8) {
          v.status = "Under the bucket";
          return { throttle: 0, steer: 0, action: false, brake: 1 };
        }
        v.status = `Pulling up to the ${DEFS[digger.defId].name}`;
        return seek(v, digger.x, digger.z, 6);
      }
      v.status = "Needs a payloader";
      if (v.cargoOre && v.cargo >= cap * 0.35) haulTarget();
      const truckHaul = target as { x: number; z: number } | null;
      if (truckHaul) {
        v.status = label;
        return seek(v, truckHaul.x, truckHaul.z, arrive);
      }
      const pile = bestPile(state, v);
      if (pile) return seek(v, pile.x, pile.z, Math.max(4, pile.radius * 0.5));
      return { ...ZERO };
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
    if (!target && def.scoop > 0) {
      const pile = bestPile(state, v);
      if (pile) {
        target = pile;
        arrive = Math.max(3.5, pile.radius * 0.72);
        label = "Staying on the pile";
      }
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
      const held = workHere(v, pile.x, pile.z, pile.radius * 0.9);
      if (held) {
        v.status = `Scooping ${ORES[pile.ore].name}`;
        return held;
      }
      target = pile;
      arrive = Math.max(3.5, pile.radius * 0.72);
      label = pile.id === "starter" ? "Scooping the gate pile" : `Scooping ${ORES[pile.ore].name}`;
    } else if (vein) {
      const cut = faceOf(vein);
      const held = workHere(v, cut.x, cut.z, cut.reach);
      if (held) {
        v.status = `Digging ${ORES[vein.ore].name}`;
        return held;
      }
      target = cut;
      arrive = Math.max(3, cut.reach * 0.75);
      label = `Digging ${ORES[vein.ore].name}`;
    } else if (def.scoop > 0 && v.operator && v.workClaim != null) {
      const spot = bestVein(state, v, null);
      const cut = spot ? faceOf(spot) : null;
      if (spot && cut) {
        const held = workHere(v, cut.x, cut.z, cut.reach);
        if (held) {
          v.status = `Working ${ORES[spot.ore].name} face`;
          return held;
        }
        target = cut;
        arrive = cut.reach * 0.75;
        label = `Working ${ORES[spot.ore].name} face`;
      } else label = "No material at assigned source";
    } else if (def.scoop > 0) {
      const spot = bestVein(state, v, null);
      const cut = spot ? faceOf(spot) : null;
      if (spot && cut) {
        target = cut;
        arrive = 8;
        label = `Heading to the ${ORES[spot.ore].name} face`;
      } else label = "Looking for a pile";
    } else label = "No face in reach";
  }

  v.status = label;
  if (has && v.cargoOre && full) {
    const pad = nearestPad(state, v.x, v.z);
    const wrongPlant =
      (prefersSluice(state, v.cargoOre) && pad?.kind !== "sluice") ||
      (prefersWash(state, v.cargoOre, v.x) && pad?.kind !== "wash" && canReach(v, livePads(state).find((p) => p.kind === "wash")?.x ?? v.x)) ||
      (!!pad && unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) <= 0);
    if (pad && !wrongPlant) {
      v.status = `Dumping at ${pad.name}`;
      return { throttle: 0, steer: 0, action: true, brake: 1 };
    }
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
    const precious = v.cargoOre === "gold" || v.cargoOre === "copper";
    const holdForSluice =
      !!v.cargoOre &&
      !!pad &&
      ((prefersSluice(state, v.cargoOre) && pad.kind !== "sluice") ||
        (prefersWash(state, v.cargoOre, v.x) && pad.kind !== "wash" && !player && canReach(v, livePads(state).find((p) => p.kind === "wash")?.x ?? v.x)) ||
        unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) <= 0);
    const crewShort = !player && st.capacity > 0 && v.cargo < st.capacity * 0.9;
    const reclaimWaste = precious && pad?.kind === "reclaim";
    // A hand-worked excavator dumps where the bucket is, not where the tracks are.
    const excavatorHand = manual && kind === "excavator";
    if (!excavatorHand && (holdForSluice || crewShort || reclaimWaste) && v.cargoOre) {
      if (player && holdForSluice) {
        const where = pad?.kind === "wash" ? "Wash plant only takes silver and gold gravel" : `${ORES[v.cargoOre].name} pays at the sluice`;
        v.status = where;
      }
    } else if (!excavatorHand && v.cargo > 0.04 && v.cargoOre && pad) {
      const unit = unitPrice(v.cargoOre, pad.kind, state.sluice, state.market);
      const sold = v.cargo;
      const soldOre = v.cargoOre;
      const purity = purityFactor(soldOre, v.cargoPurity ?? 1);
      const gross = sold * unit * purity;
      const net = gross * (player ? 1 : CREW_KEEP);
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
          v.status = output === "dirt" && vein.ore !== "dirt" ? `Stripped ${bite.toFixed(1)} t of dirt off the top` : `Broke ${bite.toFixed(1)} t of ${ORES[output].name}`;
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
    const pile = closestDeposit(state, v.x, v.z, "pile", 0, v);
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
      const dropX = src.kind === "vein" ? src.x + fx * 6 : v.x + fx * (st.radius + 3.4);
      const dropZ = src.kind === "vein" ? src.z + fz * 6 : v.z + fz * (st.radius + 3.4);
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
        addPile(state, ore, take, dropX, dropZ, src.claim, purity);
        if (takeBite(v, dt, 0.34)) breaks.push({ x: src.x, z: src.z, tx: dropX, tz: dropZ, ore });
        v.busy = true;
        if (player) state.tutorial.loaded = true;
      }
      return null;
    }
  }

  if (player && v.cargo > 0.04 && v.cargoOre) v.status = `${ORES[v.cargoOre].name} stays in the bucket`;
  return null;
}

function integrateTank(v: VehicleState, left: number, right: number, dt: number, drag: number) {
  const st = vehicleStats(v);
  const m = tankMotion(left, right);
  const target = (m.forward >= 0 ? m.forward : m.forward * 0.6) * st.maxSpeed * drag;
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
  const target = drive >= 0 ? drive * st.maxSpeed : drive * st.maxSpeed * 0.45;
  const opposing = Math.sign(target) !== Math.sign(v.speed) && Math.abs(v.speed) > 0.25;
  const accel = st.accel * (opposing || c.brake > 0.5 ? 1.75 : 1);
  if (v.speed < target) v.speed = Math.min(target, v.speed + accel * dt);
  else v.speed = Math.max(target, v.speed - accel * dt);
  if (Math.abs(v.speed) < 0.05 && Math.abs(drive) < 0.05) v.speed = 0;
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

function resolveCircle(v: VehicleState, radius: number) {
  for (const b of BLOCKS) {
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
    v.speed *= 0.82;
  }
  if (aboard(v)) return;
  if (v.defId === "lowboy" && (onHaulRoad(v.x, v.z) || v.z > 64)) {
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

const bridgeNag = new WeakMap<VehicleState, number>();

/** Overweight machines are stopped at the end of the bridge. They can always back off. */
function guardBridge(state: GameState, v: VehicleState, index: number) {
  if (areaOf(v.x) !== "river") return;
  if (bridgeAllows(v.defId, v.cargo)) return;
  if (!onBridge(v.x, v.z)) return;
  const side = Math.sign(v.x - BRIDGE.x) || 1;
  // Already well onto the deck (e.g. a load landed in the bed mid-crossing): let it finish.
  if (Math.abs(v.x - BRIDGE.x) < BRIDGE.halfLength - 3) return;
  v.x = BRIDGE.x + side * (BRIDGE.halfLength + 0.2);
  v.speed = 0;
  const now = state.seconds;
  if (now - (bridgeNag.get(v) ?? -99) > 4) {
    bridgeNag.set(v, now);
    const msg = `Bridge limit ${BRIDGE.limit} t. ${DEFS[v.defId].name} weighs ${grossTons(v.defId, v.cargo).toFixed(0)} t loaded. Carry ${bridgeMaxLoad(v.defId).toFixed(0)} t or less.`;
    if (index === state.active) log(state, msg);
    v.status = "Too heavy for the bridge";
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
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
    }
  }
}

function regen(state: GameState, dt: number) {
  for (let i = state.deposits.length - 1; i >= 0; i--) {
    const d = state.deposits[i];
    if (d.regen > 0 && d.tons < d.max) d.tons = Math.min(d.max, d.tons + d.regen * dt);
    if (d.kind === "pile" && d.regen <= 0 && d.tons < 0.12) state.deposits.splice(i, 1);
  }
}

export function loadTruck(state: GameState, index = state.active, maxDist = 32, forced: VehicleState | null = null): string {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  const def = DEFS[v.defId];
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
  const msg = `Loaded ${move.toFixed(1)} t of ${ORES[ore].name} into the ${DEFS[truck.defId].name}.`;
  v.status = msg;
  truck.status = `Bed ${truck.cargo.toFixed(1)} t ${ORES[truck.cargoOre ?? ore].name}`;
  return msg;
}

function pourIntoTrucks(state: GameState) {
  state.vehicles.forEach((v, index) => {
    if (v.defId !== "loader" && v.defId !== "excavator") return;
    // Hand-worked machines dump into the truck themselves.
    if (v.manual) return;
    if (v.cargo < 0.15 || !v.cargoOre) return;
    loadTruck(state, index, v.defId === "excavator" ? 16 : 22);
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
    const v = state.vehicles[state.active];
    const f = faceOf(d);
    if (!v || distTo(v.x, v.z, f.x, f.z) > f.reach + 8) {
      state.blast = null;
      refundBlast(state, b, d);
      log(state, "Drilling stopped. The blast is called off and you got your money back.");
      return;
    }
    if (Math.abs(v.speed) < 0.5) b.t += dt;
    if (b.t >= DRILL_SECONDS) {
      b.phase = "fuse";
      b.t = FUSE_SECONDS;
      log(state, `Charges set in ${d.sign}. Get every machine back ${BLAST_RADIUS} m!`);
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
    ? `BOOM. ${loose.toFixed(0)} t of loose ${ORES[d.ore].name.toLowerCase()}. ${hurt} machine${hurt > 1 ? "s were" : " was"} too close and needs repair.`
    : `BOOM. ${loose.toFixed(0)} t of loose ${ORES[d.ore].name.toLowerCase()} is ready to scoop.`);
}

export function rainNow(state: GameState) {
  return rainAt(state.market.seed, state.seconds);
}

/** Share of top speed the ground allows here (mud in the valley; 1 elsewhere). */
export function groundFactor(state: GameState, v: VehicleState) {
  if (onBridge(v.x, v.z)) return 1;
  return mudSpeedFactor(v.defId, mudDepth(v.x, v.z, state.wet));
}

const blastSheltered = new WeakSet<VehicleState>();

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
  if (!blast || index === state.active) return null;
  const deposit = state.deposits.find((d) => d.id === blast.deposit);
  const v = state.vehicles[index];
  if (!deposit || !v) return null;
  const face = faceOf(deposit);
  const distance = Math.hypot(v.x - face.x, v.z - face.z);
  const safeDistance = BLAST_RADIUS + vehicleStats(v).radius + 3;
  if (distance >= safeDistance) {
    blastSheltered.delete(v);
    return null;
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

export function step(state: GameState, input: Input, dt: number, playerEnabled: boolean): StepFX {
  if (!state.deck) state.deck = [];
  bindDeck(state);
  regen(state, dt);
  const wasRaining = rainNow(state) > 0.05;
  state.wet = stepWet(state.wet, rainNow(state), dt);
  if (advanceMarket(state.market, state.seconds, MARKET_KEYS)) log(state, "New day. Ore prices moved. Check the price board.");
  const controls: Control[] = [];
  const work: WorkOpts[] = [];
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    v.busy = false;
    v.manual = false;
    if (aboard(v)) {
      controls.push({ ...ZERO });
      work.push(AUTO_CREW);
      continue;
    }
    let c: Control;
    let w: WorkOpts = i === state.active ? AUTO_PLAYER : AUTO_CREW;
    if (i === state.active && playerEnabled && state.controlMode === "real" && input.cmd) {
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
    if (i === state.active) {
      c = playerEnabled
        ? {
            throttle: input.throttle,
            steer: input.steer,
            action: input.action,
            brake: Math.abs(input.throttle) < 0.05 ? 0.4 : 0,
          }
        : { ...ZERO };
    } else {
      const evacuation = blastEvacuationControl(state, i);
      if (evacuation) {
        c = evacuation;
      } else if (v.operator) {
        c = aiControl(state, i);
      } else {
        c = { ...ZERO };
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
  for (let n = 0; n < 2; n++) {
    state.vehicles.forEach((v, i) => {
      resolveCircle(v, vehicleStats(v).radius);
      guardBridge(state, v, i);
    });
    resolveVehicles(state);
  }
  pourIntoTrucks(state);
  const sales: StepFX["sales"] = [];
  const breaks: StepFX["breaks"] = [];
  const blasts: StepFX["blasts"] = [];
  let dig = false;
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    if (v.operator && i !== state.active) {
      const c = controls[i];
      if (c.throttle > 0.45 && Math.abs(v.speed) < 0.45) v.stuck += dt;
      else v.stuck = 0;
      if (v.stuck > 1.25) {
        v.stuck = 0;
        v.unstick = 0.85;
        v.bias = Math.random() < 0.5 ? 1 : -1;
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
          player: i === state.active,
        });
      }
      saleAcc.delete(v);
      continue;
    }
    if (i === state.active) v.status = "";
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
  snapDeck(state);
  state.seconds += dt;
  const raining = rainNow(state) > 0.05;
  if (raining !== wasRaining) log(state, raining ? "Rain's coming in. The valley mud spreads and the low ground floods." : "Rain has stopped. The ground will dry out over a few minutes.");
  return { dig, sales, breaks, blasts };
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
  if (!spend(state, TEST_HOLE_COST, `Test hole in ${d.sign}: seam ${Math.round(d.grade * 100)}% clean, ${d.overburden.toFixed(0)} t of dirt on top${d.hard ? ", hard rock" : ""}.`)) return "Not enough cash.";
  d.tested = true;
  return "";
}

function refundBlast(state: GameState, b: NonNullable<GameState["blast"]>, d: Deposit | undefined) {
  if (b.paid > 0) state.cash += b.paid;
  else state.explosives += 1;
  if (d) d.lastBlastDay = -1;
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
  log(state, `Drilling blast holes in ${d.sign}. Hold still for ${DRILL_SECONDS} seconds. Other machines are pulling back.`);
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
  if (id !== "skid" && count > 0) return "Already on the yard.";
  if (id === "skid" && count >= 3) return "Three skid steers is the yard limit.";
  const def = DEFS[id];
  const price = id === "skid" ? def.price * (count + 1) : def.price;
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
  return v ? areaOf(v.x) : "ridge";
}

export function valleyOpen(state: GameState) {
  return state.claims.includes(UNLOCK_CLAIM);
}

export function areaName(a: AreaId) {
  return a === "river" ? "River Valley" : "Ridge pit";
}

function placeInArea(state: GameState, v: VehicleState, area: AreaId) {
  const taken = state.vehicles.filter((o) => o !== v && areaOf(o.x) === area);
  const list = area === "river" ? RIVER_SPAWNS : SPAWNS;
  const free = list.find((p) => taken.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 5)) ?? list[taken.length % list.length];
  v.x = free.x;
  v.z = free.z;
  v.yaw = area === "river" ? Math.PI / 2 : 0;
  v.speed = 0;
}

/** Why the active machine can't go on the lowboy right now, or "" if it can. */
function snapDeck(state: GameState) {
  const rig = state.vehicles.find((v) => v.defId === "lowboy");
  if (!rig) return;
  const fx = -Math.sin(rig.yaw);
  const fz = -Math.cos(rig.yaw);
  const side = Math.cos(rig.yaw);
  const sideZ = -Math.sin(rig.yaw);
  state.deck.forEach((uid, i) => {
    const m = state.vehicles.find((v) => v.uid === uid);
    if (!m) return;
    const back = 4.6 + i * 3.4;
    m.x = rig.x - fx * back + side * 0.2;
    m.z = rig.z - fz * back + sideZ * 0.2;
    m.yaw = rig.yaw;
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
    if (deckSpots(o.defId) == null) continue;
    const d = distTo(rig.x, rig.z, o.x, o.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export function toggleDeck(state: GameState) {
  if (!state.deck) state.deck = [];
  bindDeck(state);
  const rig = state.vehicles[state.active];
  if (!rig || rig.defId !== "lowboy") return "Get in the lowboy first.";
  if (!valleyOpen(state)) return "The north road opens once you lease the Deep bench.";
  const target = nearestDeckLoad(state, rig);
  if (target) {
    const why = deckFit(state.deck.map((uid) => state.vehicles.find((v) => v.uid === uid)?.defId ?? ""), target.defId);
    if (why) return why;
    target.operator = false;
    target.speed = 0;
    state.deck.push(target.uid);
    bindDeck(state);
    snapDeck(state);
    log(state, `${DEFS[target.defId].name} is on the deck. ${spotsUsed(state.deck.map((uid) => state.vehicles.find((v) => v.uid === uid)?.defId ?? ""))} of ${3} spots used.`);
    return "";
  }
  if (!state.deck.length) return "Pull up to an empty parked machine.";
  if (!inDropYard(rig.x, rig.z)) return "Unload at the ridge yard or the valley camp.";
  const uid = state.deck.pop();
  const m = state.vehicles.find((v) => v.uid === uid);
  if (m) {
    const side = Math.cos(rig.yaw);
    const sideZ = -Math.sin(rig.yaw);
    m.x = rig.x + side * 6;
    m.z = rig.z + sideZ * 6;
    m.speed = 0;
    m.status = "Parked";
    log(state, `${DEFS[m.defId].name} is off the lowboy.`);
  }
  bindDeck(state);
  return "";
}

export function haulBlocker(state: GameState) {
  const v = state.vehicles[state.active];
  if (!v) return "No machine.";
  if (v.defId === "lowboy") return "Drive the lowboy up the north road. The paid jump is for one machine.";
  if (state.deck?.includes(v.uid)) return "That machine is strapped to the lowboy.";
  if (!valleyOpen(state)) return "River Valley opens once you lease the Deep bench.";
  if (v.defId === "crusher") return "The track crusher stays at the ridge.";
  if (v.cargo > 0.05) return "Dump the load before it goes on the trailer.";
  if (state.blast) return "Finish the blast first.";
  if (state.cash < HAUL_FEE) return `The lowboy costs ${formatMoney(HAUL_FEE)}.`;
  return "";
}

/** Put the active machine on the lowboy trailer and send it to the other area. */
export function haulMachine(state: GameState) {
  const why = haulBlocker(state);
  if (why) return why;
  const v = state.vehicles[state.active];
  const to: AreaId = areaOf(v.x) === "river" ? "ridge" : "river";
  state.cash -= HAUL_FEE;
  placeInArea(state, v, to);
  v.tool = homeTool(v.defId);
  v.stuck = 0;
  v.unstick = 0;
  if (to === "river" && !state.claims.includes(VALLEY_CLAIMS.bars)) {
    state.claims.push(VALLEY_CLAIMS.bars);
    log(state, "Welcome to River Valley. The river bars are yours. Silver pays best at a wash plant.");
  }
  log(state, `${DEFS[v.defId].name} hauled to ${areaName(to)} for ${formatMoney(HAUL_FEE)}.`);
  return "";
}

/** Jump into a machine that is already in the other area. */
export function goOtherArea(state: GameState) {
  const here = currentArea(state);
  const i = state.vehicles.findIndex((v) => areaOf(v.x) !== here);
  if (i < 0) return "No machine over there yet. Haul one on the lowboy.";
  setActive(state, i);
  log(state, `Now at ${areaName(areaOf(state.vehicles[i].x))}.`);
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
  if ((id === VALLEY_CLAIMS.bars || id === VALLEY_CLAIMS.quarry) && !valleyOpen(state)) return "River Valley opens once you lease the Deep bench.";
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
  if (v.defId === "lowboy") return "The lowboy does not take a driver. You drive it.";
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
    log(state, `Operator hired for the ${name}. You keep ${Math.round(CREW_KEEP * 100)}% of their loads.`);
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

export function setActive(state: GameState, index: number) {
  if (index < 0 || index >= state.vehicles.length) return;
  state.active = index;
  state.vehicles[index].stuck = 0;
  state.vehicles[index].unstick = 0;
}

function cargoLine(state: GameState, v: VehicleState) {
  if (v.defId === "lowboy") {
    const ids = (state.deck ?? []).map((uid) => state.vehicles.find((o) => o.uid === uid)?.defId ?? "");
    const names = ids.map((id) => (id && DEFS[id] ? DEFS[id].name : "")).filter(Boolean);
    return `Deck ${spotsUsed(ids)}/3${names.length ? ` · ${names.join(", ")}` : " · empty"}`;
  }
  const st = vehicleStats(v);
  if (st.capacity <= 0) return "No bed";
  if (v.cargo < 0.05 || !v.cargoOre) return `Empty · ${st.capacity.toFixed(1)} t`;
  return `${ORES[v.cargoOre].name} ${v.cargo.toFixed(1)} / ${st.capacity.toFixed(1)} t`;
}

function objective(state: GameState) {
  const t = state.tutorial;
  if (!t.loaded) return "Load iron into the claim truck.";
  if (!t.dumped) return "Sell the load at the crusher.";
  if (!t.bought) return "Open the yard office and buy a machine.";
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
    if (onHaulRoad(v.x, v.z)) return "North road. Stay on the gravel. Unload only at a yard.";
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
  if (v.cargoOre && prefersSluice(state, v.cargoOre) && v.cargo > 0.08) {
    if (pad?.kind === "sluice") return "Hold DIG. The sluice pays for this load.";
    return `${ORES[v.cargoOre].name} pays at the sluice, west of the yard. The crusher will not buy it.`;
  }
  if (v.cargo > 0.08 && pad) return `Hold DIG to sell at the ${pad.name.toLowerCase()}.`;
  const truck = !def.receives && v.cargo > 0.08 ? nearestHauler(state, v, 28, false) : null;
  if (truck) return `Tap LOAD to put this bucket in the ${DEFS[truck.defId].name.toLowerCase()}.`;
  if (st.capacity > 0 && v.cargo >= st.capacity * 0.92) {
    if (v.cargoOre && prefersSluice(state, v.cargoOre)) return "Full. Haul it to the sluice. It pays more.";
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
    if (t.lift < 0.08) return "Blade is buried and stalling. Lift it a little (left stick right).";
    if (t.lift >= 0.3) return "Lower the blade (left stick left) and drive into a face or pile.";
    return "Blade on the ground. Push both sticks forward into the face.";
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
  return `${d.sign} · seam ${Math.round(d.grade * 100)}% · ${d.overburden.toFixed(0)} t dirt on top · bench ${d.bench}${hard}${wall}`;
}

function priceRows(state: GameState): HudModel["prices"] {
  const pads = PADS.filter((p) => padOpen(state, p.kind) && (p.x < X0 / 2 || valleyOpen(state)));
  return (Object.keys(ORES) as OreId[]).filter((ore) => ore !== "silver" || valleyOpen(state)).map((ore) => ({
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
  if (b.phase === "drill") return `Drilling blast holes… ${Math.max(0, DRILL_SECONDS - b.t).toFixed(1)} s. Hold still.`;
  const v = state.vehicles[state.active];
  const far = v ? distTo(v.x, v.z, b.x, b.z) : 99;
  return `BLAST IN ${Math.ceil(b.t)} · you are ${far.toFixed(0)} m away${far < BLAST_RADIUS ? ` · GET BACK ${BLAST_RADIUS} m!` : " · safe"}`;
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
    const price = id === "skid" ? def.price * (count + 1) : def.price;
    const owned = id === "skid" ? count >= 3 : count > 0;
    const blurb = id === "skid" && count > 0 && count < 3 ? `${count} on the yard. Next one is ${formatMoney(price)}.` : def.blurb;
    return {
      id,
      name: def.name,
      blurb,
      priceLabel: formatMoney(price),
      owned,
      affordable: !owned && state.cash >= price,
      kind: "vehicle" as const,
    };
  });
  if (valleyOpen(state)) {
    machines.push({
      id: WASH_PLANT.id,
      name: WASH_PLANT.name,
      blurb: WASH_PLANT.blurb,
      priceLabel: formatMoney(WASH_PLANT.price),
      owned: state.washPlant,
      affordable: !state.washPlant && state.cash >= WASH_PLANT.price,
      kind: "plant",
    });
  }
  machines.push({
    id: SLUICE.id,
    name: SLUICE.name,
    blurb: SLUICE.blurb,
    priceLabel: formatMoney(SLUICE.price),
    owned: state.sluice,
    affordable: !state.sluice && state.cash >= SLUICE.price,
    kind: "plant",
  });
  const crew: HudModel["crew"] = state.vehicles.map((veh, index) => {
    const def = DEFS[veh.defId];
    const kinds: { kind: UpgradeKind; label: string }[] = [
      { kind: "engine", label: "Engine" },
      { kind: "body", label: def.bodyLabel },
      { kind: "hydro", label: "Hydraulics" },
    ];
    return {
      index,
      name: def.name,
      status: index === state.active ? "In your seat" : veh.operator ? veh.status : "Parked",
      cargo: cargoLine(state, veh),
      active: index === state.active,
      hired: veh.hired,
      operator: veh.operator,
      workClaim: veh.workClaim ?? null,
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
  const grounds: HudModel["grounds"] = CLAIMS.filter((c) => c.id < VALLEY_CLAIMS.bars || valleyOpen(state)).map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    priceLabel: c.price === 0 ? "Included" : formatMoney(c.price),
    owned: ownsClaim(state, c.id),
    affordable: !ownsClaim(state, c.id) && state.cash >= c.price,
  }));
  const savedBlurb = hadSave
    ? `${state.company} · ${formatMoney(state.cash)} · ${info.name}`
    : `New outfit. Claim truck and ${formatMoney(START_CASH)} in the box.`;
  const contract = state.contract;
  const contractLabel = contract
    ? `Contract: ${ORES[contract.ore].name} ${Math.min(contract.delivered, contract.need).toFixed(1)}/${contract.need} t · ${formatMoney(contract.bonus)} bonus`
    : "";
  return {
    company: state.company,
    cashLabel: formatMoney(state.cash),
    tier: info.name,
    tierNext: info.next,
    tierProgress: info.progress,
    tierDetail: info.nextAt != null ? `${formatMoney(state.lifetime)} earned · ${formatMoney(info.nextAt)} to ${info.next}` : "The books are closed on a full company.",
    shift: `Shift ${mm}:${ss.toString().padStart(2, "0")}`,
    hint: realHint(state) ?? hint(state),
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
    prices: priceRows(state),
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
      return `Blast ${d.sign} · ${formatMoney(blastPrice())} for ~${blastYield(d.tons).toFixed(0)} t loose`;
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
  const other: AreaId = area === "river" ? "ridge" : "river";
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
  let bridgeLabel = "";
  if (v && area === "river" && Math.abs(v.x - BRIDGE.x) < BRIDGE.halfLength + 14 && Math.abs(v.z - BRIDGE.z) < 14) {
    const t = grossTons(v.defId, v.cargo);
    bridgeLabel = bridgeAllows(v.defId, v.cargo)
      ? `Bridge ${BRIDGE.limit} t limit · you weigh ${t.toFixed(0)} t · OK`
      : `Bridge ${BRIDGE.limit} t limit · you weigh ${t.toFixed(0)} t · TOO HEAVY`;
  }
  return {
    area,
    areaName: v && onHaulRoad(v.x, v.z) ? "North road" : areaName(area),
    valleyOpen: open,
    travelLabel: !open
      ? "River Valley opens once you lease the Deep bench"
      : blocker || `Haul ${v ? DEFS[v.defId].name : "machine"} to ${areaName(other)} · ${formatMoney(HAUL_FEE)}`,
    canHaul: open && !blocker,
    canGoOther: state.vehicles.some((o) => areaOf(o.x) === other),
    otherAreaName: areaName(other),
    rain,
    weatherLabel: rain > 0.6 ? "Heavy rain" : rain > 0.05 ? "Rain" : state.wet > 0.25 ? "Wet ground" : "Dry",
    groundLabel,
    bridgeLabel,
    washPlant: state.washPlant,
    deckLabel: deckHud(state).label,
    deckButton: deckHud(state).button,
  };
}

function deckHud(state: GameState): { label: string; button: "Load" | "Unload" | null } {
  const v = state.vehicles[state.active];
  if (!v || v.defId !== "lowboy") return { label: "", button: null };
  const ids = (state.deck ?? []).map((uid) => state.vehicles.find((o) => o.uid === uid)?.defId ?? "");
  const names = ids.map((id) => (id && DEFS[id] ? DEFS[id].name : "")).filter(Boolean);
  const label = `Deck ${spotsUsed(ids)}/3${names.length ? ` · ${names.join(", ")}` : ""}`;
  const near = nearestDeckLoad(state, v);
  if (near && !deckFit(ids, near.defId)) return { label, button: "Load" };
  if (near) return { label, button: "Load" };
  if ((state.deck ?? []).length && inDropYard(v.x, v.z)) return { label, button: "Unload" };
  return { label, button: "Load" };
}
