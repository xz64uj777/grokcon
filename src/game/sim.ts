import {
  BASE_DEPOSITS,
  BOUNDS,
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
  tierInfo,
  upgradeCost,
} from "@/game/catalog";
import type {
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
  sales: { x: number; z: number; text: string; player: boolean }[];
  breaks: { x: number; z: number; tx: number; tz: number; ore: OreId }[];
};

const ZERO: Control = { throttle: 0, steer: 0, action: false, brake: 0 };
const saleAcc = new WeakMap<VehicleState, number>();
const biteAcc = new WeakMap<VehicleState, number>();

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
  const eng = 1 + v.upgrades.engine * 0.18;
  const body = 1 + v.upgrades.body * 0.28;
  const hydro = 1 + v.upgrades.hydro * 0.3;
  const capacity = d.capacity === 0 ? 0 : d.capacity * body;
  const push = d.push * hydro * (d.capacity === 0 ? body : 1);
  return {
    maxSpeed: d.maxSpeed * eng,
    accel: d.accel * eng,
    turn: d.turn,
    capacity,
    dig: d.dig * hydro,
    scoop: d.scoop * hydro,
    push,
    radius: d.radius,
  };
}

export function unitPrice(ore: OreId, pad: PadKind, sluice: boolean) {
  const o = ORES[ore];
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

function rollContract(seq: number, claims: number[]): GameState["contract"] {
  const options: OreId[] = ["iron"];
  if (claims.includes(2)) options.push("copper");
  if (claims.includes(3)) options.push("gold");
  const ore = options[seq % options.length] ?? "iron";
  const need = (ore === "gold" ? 4 : ore === "copper" ? 6 : 8) + seq * 2;
  const unit = ore === "gold" ? ORES.gold.sluice : ORES[ore].crusher;
  return { ore, delivered: 0, need, bonus: Math.round(need * unit * 0.5) };
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
  state.contract = rollContract(state.contractSeq, state.claims);
  log(state, `Contract filled. Bonus ${formatMoney(bonus)}. Next: ${state.contract.need} t ${ORES[state.contract.ore].name}.`);
  return bonus;
}

export function freshGame(company: string): GameState {
  const name = company.trim().slice(0, 24) || "Ridge Ore Co.";
  return {
    version: 1,
    company: name,
    cash: START_CASH,
    lifetime: 0,
    seconds: 0,
    claims: [1],
    sluice: false,
    muted: false,
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
    contract: rollContract(0, [1]),
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

function nearestPad(state: GameState, x: number, z: number) {
  let best: ReturnType<typeof livePads>[number] | null = null;
  let bestD = Infinity;
  for (const pad of livePads(state)) {
    if (pad.kind === "sluice" && !state.sluice) continue;
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
) {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (kind !== "any" && d.kind !== kind) continue;
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

function addPile(state: GameState, ore: OreId, tons: number, x: number, z: number) {
  if (tons <= 0) return;
  let best: Deposit | null = null;
  let bestD = 5.5;
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
    best.x = (best.x * best.tons + x * tons) / t;
    best.z = (best.z * best.tons + z * tons) / t;
    best.tons = t;
    best.max = Math.max(best.max, t);
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
    claim: 1,
    radius: 6,
    sign: ORES[ore].name.toUpperCase(),
  });
}

function prefersSluice(state: GameState, ore: OreId) {
  return state.sluice && (ore === "copper" || ore === "gold");
}

function bestPad(state: GameState, ore: OreId, x: number, z: number) {
  let best: ReturnType<typeof livePads>[number] | null = null;
  let score = -Infinity;
  for (const pad of livePads(state)) {
    if (pad.kind === "sluice" && !state.sluice) continue;
    const unit = unitPrice(ore, pad.kind, state.sluice);
    const d = distTo(x, z, pad.x, pad.z);
    // When the sluice is purchased, route copper/gold there first: it is the
    // intended recovery plant, not a distance-scored fallback to the crusher.
    if (pad.kind === "sluice" && state.sluice && (ore === "copper" || ore === "gold")) {
      return pad;
    }
    const s = unit - d * 0.55;
    if (s > score) {
      score = s;
      best = pad;
    }
  }
  return best;
}

function bestVein(state: GameState, v: VehicleState, ore: OreId | null) {
  let best: Deposit | null = null;
  let score = -1;
  for (const d of state.deposits) {
    if (d.kind !== "vein" || d.tons < 1) continue;
    if (!ownsClaim(state, d.claim)) continue;
    if (v.workClaim != null && d.claim !== v.workClaim) continue;
    if (ore && d.ore !== ore) continue;
    const unit = ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z) + 10;
    const s = (unit * Math.min(d.tons, 50)) / d0;
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
    if (v.workClaim != null && d.claim !== v.workClaim) continue;
    if (v.cargo > 0.15 && v.cargoOre && v.cargoOre !== d.ore) continue;
    const unit = ORES[d.ore].crusher;
    const d0 = distTo(v.x, v.z, d.x, d.z) + 8;
    const s = (unit * Math.min(d.tons, 30)) / d0;
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return best;
}

function routeTo(v: VehicleState, tx: number, tz: number) {
  if (inPit(v.x, v.z) === inPit(tx, tz)) return { x: tx, z: tz };
  // The yard side of the gate is still outside the pit. Turning back for the
  // gate there made crew pace a figure-8 and never reach the iron pile.
  const inGateSlot = v.z < GATE.z + 6 && v.z > 0 && Math.abs(v.x - GATE.x) < 24;
  if (inGateSlot || distTo(v.x, v.z, GATE.x, GATE.z) <= 9) return { x: tx, z: tz };
  return GATE;
}

function seek(v: VehicleState, tx: number, tz: number, arrive: number): Control {
  const routed = routeTo(v, tx, tz);
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

  if (def.id === "crusher") {
    const digger = state.vehicles.find(
      (o, i) => i !== index && (o.operator || i === state.active) && (DEFS[o.defId].dig > 0 || DEFS[o.defId].scoop > 0),
    );
    if (!digger) {
      v.status = "Plant parked";
      return { ...ZERO };
    }
    const dx = digger.x - v.x;
    const dz = digger.z - v.z;
    const dist = Math.hypot(dx, dz) || 1;
    // A moving digger is usually driving here to dump. Chasing it makes a figure-8.
    if (dist < 22 || Math.abs(digger.speed) > 1.1) {
      v.status = "Plant set";
      return { throttle: 0, steer: 0, action: false, brake: 1 };
    }
    v.status = "Tracking the face";
    return seek(v, digger.x - (dx / dist) * 16, digger.z - (dz / dist) * 16, 6);
  }

  const haulTarget = () => {
    if (!v.cargoOre) return;
    const loaderLike = def.id === "loader" || def.id === "excavator";
    if (loaderLike) {
      const truck = nearestHauler(state, v, 70, true);
      if (truck) {
        target = truck;
        arrive = 7.5;
        label = `Loading ${DEFS[truck.defId].name}`;
        return;
      }
    }
    const pad = bestPad(state, v.cargoOre, v.x, v.z);
    if (pad) {
      target = pad;
      arrive = Math.max(5, pad.r * 0.62);
      label = `Hauling to ${pad.name}`;
    }
  };

  if (def.push > 0) {
    const vein = bestVein(state, v, null);
    if (vein) {
      target = vein;
      arrive = vein.radius * 0.72;
      label = `Stripping ${ORES[vein.ore].name}`;
    } else label = "No face in reach";
  } else if (def.receives) {
    const diggerNear = state.vehicles.some(
      (o, i) =>
        i !== index &&
        (o.operator || i === state.active) &&
        (DEFS[o.defId].dig > 0 || DEFS[o.defId].scoop > 0) &&
        distTo(v.x, v.z, o.x, o.z) < 18,
    );
    const bedFull = cap > 0 && v.cargo >= cap * 0.82;
    const leftWithALoad = v.cargo >= 4 && !diggerNear;
    if (bedFull || leftWithALoad) haulTarget();
    else {
      const digger = state.vehicles.find(
        (o, i) => i !== index && (o.operator || i === state.active) && (DEFS[o.defId].dig > 0 || DEFS[o.defId].id === "loader"),
      );
      if (digger) {
        target = { x: digger.x + 7, z: digger.z + 5 };
        arrive = 8;
        label = "Waiting on a load";
      } else {
        const iron = state.deposits.find((d) => d.id === "iron");
        target = iron ? { x: iron.x + 9, z: iron.z + 7 } : { x: GATE.x, z: 2 };
        arrive = 8;
        label = "Waiting on a loader";
      }
    }
  } else if (has && full) {
    haulTarget();
  } else if (def.dig > 0 || def.scoop > 0) {
    const vein = def.dig > 0 && !full ? bestVein(state, v, v.cargo > 0.15 ? v.cargoOre : null) : null;
    const pile = def.scoop > 0 && !full ? bestPile(state, v) : null;
    const pileD = pile ? distTo(v.x, v.z, pile.x, pile.z) : Infinity;
    const veinD = vein ? distTo(v.x, v.z, vein.x, vein.z) : Infinity;
    // The iron pile sits on the gate. Take it when it is closer than a face.
    const takePile = pile != null && pile.tons >= 1.5 && pileD + 4 < veinD;
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
      const held = workHere(v, vein.x, vein.z, vein.radius * 0.95);
      if (held) {
        v.status = `Digging ${ORES[vein.ore].name}`;
        return held;
      }
      target = vein;
      arrive = Math.max(4, vein.radius * 0.82);
      label = `Digging ${ORES[vein.ore].name}`;
    } else if (has) haulTarget();
    else if (def.scoop > 0 && v.operator && v.workClaim != null) {
      const face = bestVein(state, v, null);
      if (face) {
        const held = workHere(v, face.x, face.z, face.radius * 0.9);
        if (held) {
          v.status = `Working ${ORES[face.ore].name} face`;
          return held;
        }
        target = face;
        arrive = face.radius * 0.8;
        label = `Working ${ORES[face.ore].name} face`;
      } else label = "No material at assigned source";
    } else label = def.scoop > 0 ? "Looking for a pile" : "No face in reach";
  }

  if ((def.id === "excavator" || def.id === "loader") && has && !full) {
    const truck = nearestHauler(state, v, 18, true);
    if (truck && v.cargo > Math.min(1.4, cap * 0.4)) {
      target = truck;
      arrive = 7.5;
      label = `Loading ${DEFS[truck.defId].name}`;
    }
  }

  v.status = label;
  if (has && v.cargoOre && full) {
    const pad = nearestPad(state, v.x, v.z);
    const wrongPlant = prefersSluice(state, v.cargoOre) && pad?.kind !== "sluice";
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

function performAction(
  state: GameState,
  index: number,
  dt: number,
  allowStockpile: boolean,
  breaks: StepFX["breaks"],
): StepFX["sales"][number] | null {
  const v = state.vehicles[index];
  const def = DEFS[v.defId];
  const st = vehicleStats(v);
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const player = index === state.active;

  const pad = v.cargoOre ? nearestPad(state, v.x, v.z) : null;
  const holdForSluice = !!v.cargoOre && !!pad && prefersSluice(state, v.cargoOre) && pad.kind !== "sluice";
  if (holdForSluice && v.cargoOre) {
    if (player) v.status = `${ORES[v.cargoOre].name} pays at the sluice`;
  } else if (v.cargo > 0.04 && v.cargoOre && pad) {
    const unit = unitPrice(v.cargoOre, pad.kind, state.sluice);
    const sold = v.cargo;
    const soldOre = v.cargoOre;
    const gross = sold * unit;
    const net = gross * (player ? 1 : CREW_KEEP);
    const oreName = ORES[soldOre].name;
    const bonus = fillContract(state, soldOre, sold);
    state.cash += net;
    state.lifetime += net;
    v.cargo = 0;
    v.cargoOre = null;
    saleAcc.set(v, 0);
    v.busy = true;
    if (player) state.tutorial.dumped = true;
    if (pad.kind === "crusher") {
      const plant = state.vehicles.find((o) => o.defId === "crusher");
      if (plant) plant.busy = true;
    }
    const extra = bonus > 0 ? ` +${formatMoney(bonus)} contract` : "";
    return { x: v.x, z: v.z, text: `+${formatMoney(net)} ${oreName}${extra}`, player };
  }

  const extra = def.id === "excavator" ? 2.2 : 0;
  if ((def.dig > 0 || def.scoop > 0) && v.cargo > 0.05 && v.cargoOre && !def.receives) {
    const truck = nearestHauler(state, v, 9 + extra, false);
    if (truck) {
      const room = vehicleStats(truck).capacity - truck.cargo;
      if (room > 0.05 && (!truck.cargoOre || truck.cargo < 0.05 || truck.cargoOre === v.cargoOre)) {
        const rate = Math.max(st.dig, st.scoop, 2.5) * 2 * dt;
        const move = Math.min(v.cargo, room, Math.max(rate, 0.4 * dt));
        if (truck.cargo < 0.05) truck.cargoOre = v.cargoOre;
        truck.cargo += move;
        v.cargo -= move;
        if (v.cargo <= 0.05) {
          v.cargo = 0;
          v.cargoOre = null;
        }
        v.busy = true;
        truck.busy = true;
        return null;
      }
    }
  }

  if (def.dig > 0 && st.capacity > 0 && v.cargo < st.capacity - 0.03) {
    const vein = closestDeposit(state, v.x, v.z, "vein", extra);
    if (vein) {
      if (!ownsClaim(state, vein.claim)) {
        if (player) v.status = "Unleased ground";
        return null;
      }
      if (v.cargo > 0.08 && v.cargoOre && v.cargoOre !== vein.ore) {
        if (player) v.status = `Dump ${ORES[v.cargoOre].name} first`;
        return null;
      }
      v.busy = true;
      if (!takeBite(v, dt, 0.5)) {
        if (player) v.status = `Breaking ${ORES[vein.ore].name}`;
        return null;
      }
      const bite = Math.min(vein.tons, st.dig * 0.5);
      if (bite > 0) {
        const room = st.capacity - v.cargo;
        const intoBucket = Math.min(room, bite * 0.62);
        const spill = bite - intoBucket;
        vein.tons -= bite;
        if (intoBucket > 0.01) {
          v.cargo += intoBucket;
          v.cargoOre = vein.ore;
        }
        const dx = v.x - vein.x;
        const dz = v.z - vein.z;
        const dist = Math.hypot(dx, dz) || 1;
        const toeX = vein.x + (dx / dist) * 5.2;
        const toeZ = vein.z + (dz / dist) * 5.2;
        if (spill > 0.04) addPile(state, vein.ore, spill, toeX, toeZ);
        breaks.push({
          x: vein.x,
          z: vein.z,
          tx: spill > intoBucket ? toeX : v.x,
          tz: spill > intoBucket ? toeZ : v.z,
          ore: vein.ore,
        });
        if (player) {
          state.tutorial.loaded = true;
          v.status = `Broke ${bite.toFixed(1)} t of ${ORES[vein.ore].name}`;
        }
      }
      return null;
    }
  }

  if (def.scoop > 0 && st.capacity > 0 && v.cargo < st.capacity - 0.03) {
    const pile = closestDeposit(state, v.x, v.z, "pile", 0);
    // Only crew explicitly assigned to a claim may scoop directly from its
    // vein when that claim has no loose pile. Player controls keep their
    // existing pile-only behavior.
    const face = !pile && v.operator && v.workClaim != null
      ? bestVein(state, v, null)
      : null;
    const source = pile && pile.tons > 0.05 ? pile : face && face.tons > 0.05 && face.claim === v.workClaim ? face : null;
    if (source) {
      if (!ownsClaim(state, source.claim)) return null;
      if (v.cargo > 0.08 && v.cargoOre && v.cargoOre !== source.ore) {
        if (player) v.status = `Dump ${ORES[v.cargoOre].name} first`;
        return null;
      }
      v.busy = true;
      if (!takeBite(v, dt, 0.42)) {
        if (player) v.status = `Scooping ${ORES[source.ore].name}`;
        return null;
      }
      const take = Math.min(source.tons, st.capacity - v.cargo, st.scoop * 0.42);
      if (take > 0) {
        source.tons -= take;
        v.cargo += take;
        v.cargoOre = source.ore;
        breaks.push({ x: source.x, z: source.z, tx: v.x, tz: v.z, ore: source.ore });
        if (player) state.tutorial.loaded = true;
      }
      return null;
    }
  }

  if (def.push > 0) {
    const src = materialInFront(state, v, def.range);
    if (src && ownsClaim(state, src.claim)) {
      const take = Math.min(src.tons, st.push * dt);
      if (take > 0) {
        src.tons -= take;
        const dropX = src.kind === "vein" ? src.x + fx * 6 : v.x + fx * (st.radius + 3.4);
        const dropZ = src.kind === "vein" ? src.z + fz * 6 : v.z + fz * (st.radius + 3.4);
        addPile(state, src.ore, take, dropX, dropZ);
        if (takeBite(v, dt, 0.34)) breaks.push({ x: src.x, z: src.z, tx: dropX, tz: dropZ, ore: src.ore });
        v.busy = true;
        if (player) state.tutorial.loaded = true;
      }
      return null;
    }
  }

  if (
    allowStockpile &&
    (def.dig > 0 || def.scoop > 0) &&
    v.cargo > 0.04 &&
    v.cargoOre &&
    Math.abs(v.speed) < 1.1
  ) {
    const nearVein = closestDeposit(state, v.x, v.z, "vein", extra);
    const nearTruck = nearestHauler(state, v, 9, false);
    if (!nearVein && !pad && !nearTruck) {
      const drop = Math.min(v.cargo, Math.max(st.scoop, st.dig, 3) * dt);
      addPile(state, v.cargoOre, drop, v.x + fx * (st.radius + 2.6), v.z + fz * (st.radius + 2.6));
      v.cargo -= drop;
      if (v.cargo <= 0.08) {
        // Clear tiny floating-point leftovers so the machine can be fully emptied.
        v.cargo = 0;
        v.cargoOre = null;
      }
      v.busy = true;
    }
  }
  return null;
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
    let dx = v.x - cx;
    let dz = v.z - cz;
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
  const padR = radius + 0.4;
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

function resolveVehicles(state: GameState) {
  const list = state.vehicles;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
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

export function step(state: GameState, input: Input, dt: number, playerEnabled: boolean): StepFX {
  regen(state, dt);
  const controls: Control[] = [];
  for (let i = 0; i < state.vehicles.length; i++) {
    const v = state.vehicles[i];
    v.busy = false;
    let c: Control;
    if (i === state.active) {
      c = playerEnabled
        ? {
            throttle: input.throttle,
            steer: input.steer,
            action: input.action,
            brake: Math.abs(input.throttle) < 0.05 ? 0.4 : 0,
          }
        : { ...ZERO };
    } else if (v.operator) {
      c = aiControl(state, i);
    } else {
      c = { ...ZERO };
      v.status = "Parked";
    }
    controls.push(c);
    integrate(v, c, dt);
  }
  for (let n = 0; n < 2; n++) {
    for (const v of state.vehicles) resolveCircle(v, vehicleStats(v).radius);
    resolveVehicles(state);
  }
  const sales: StepFX["sales"] = [];
  const breaks: StepFX["breaks"] = [];
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
    const sale = performAction(state, i, dt, i === state.active, breaks);
    if (sale) sales.push(sale);
    if (i === state.active && v.busy && v.cargo >= before - 1e-6 && !sale) dig = true;
  }
  const player = state.vehicles[state.active];
  if (player && !player.status) {
    player.status = player.busy ? "Working" : "In your seat";
  }
  state.seconds += dt;
  return { dig, sales, breaks };
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
  if (owns(state, id)) return "Already on the yard.";
  const def = DEFS[id];
  if (!spend(state, def.price, `${def.name} is on the yard.`)) return "Not enough cash.";
  state.vehicles.push(makeVehicle(id, state.vehicles.length));
  return "";
}

export function buySluicePlant(state: GameState) {
  if (state.sluice) return "Sluice is already running.";
  if (!spend(state, SLUICE.price, "Sluice plant is washing on the west road.")) return "Not enough cash.";
  state.sluice = true;
  return "";
}

export function buyClaim(state: GameState, id: number) {
  if (ownsClaim(state, id)) return "Already leased.";
  const claim = CLAIMS.find((c) => c.id === id);
  if (!claim) return "No such ground.";
  if (!spend(state, claim.price, `${claim.name} is leased.`)) return "Not enough cash.";
  state.claims.push(id);
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
    log(state, `Operator hired for the ${name}. You keep ${Math.round(CREW_KEEP * 100)}% of their loads.`);
    return "";
  }
  v.operator = !v.operator;
  log(state, v.operator ? `${name} operator on duty.` : `${name} operator off shift.`);
  return "";
}

export function setActive(state: GameState, index: number) {
  if (index < 0 || index >= state.vehicles.length) return;
  state.active = index;
  state.vehicles[index].stuck = 0;
  state.vehicles[index].unstick = 0;
}

function cargoLine(v: VehicleState) {
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
  const truck = !def.receives && v.cargo > 0.08 ? nearestHauler(state, v, 9 + extra, false) : null;
  if (truck) return `Hold DIG to load the ${DEFS[truck.defId].name.toLowerCase()}.`;
  if (st.capacity > 0 && v.cargo >= st.capacity * 0.92) {
    return def.receives ? "Bed full. Dump beside the track crusher." : "Full. Haul it out, or pull up to a dump truck.";
  }
  const locked = state.deposits.find((d) => !ownsClaim(state, d.claim) && distTo(v.x, v.z, d.x, d.z) < d.radius + 3);
  if (locked) return `${locked.sign} is unleased. Open Ground in the yard office.`;
  if (def.push > 0) return "Hold DIG with the blade in a face. It builds a pile.";
  if (def.dig > 0) {
    const vein = closestDeposit(state, v.x, v.z, "vein", extra);
    if (vein && ownsClaim(state, vein.claim)) return `Hold DIG to break ${ORES[vein.ore].name.toLowerCase()} off the face. The loose rock falls in front.`;
    return "Find a face inside the gate. V switches machines.";
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
  return "WASD drive. Hold DIG to work. V next machine.";
}

export function buildHud(state: GameState, hadSave: boolean): HudModel {
  const v = state.vehicles[state.active];
  const info = tierInfo(state.lifetime);
  const st = v ? vehicleStats(v) : null;
  const sec = Math.floor(state.seconds);
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  const machines: HudModel["machines"] = VEHICLE_ORDER.filter((id) => id !== "pickup" && id !== "crusher").map((id) => {
    const def = DEFS[id];
    const owned = owns(state, id);
    return {
      id,
      name: def.name,
      blurb: def.blurb,
      priceLabel: formatMoney(def.price),
      owned,
      affordable: !owned && state.cash >= def.price,
      kind: "vehicle" as const,
    };
  });
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
      cargo: cargoLine(veh),
      active: index === state.active,
      hired: veh.hired,
      operator: veh.operator,
      workClaim: veh.workClaim ?? null,
      hireLabel: veh.hired ? (veh.operator ? "On duty" : "Off shift") : `Hire · ${formatMoney(HIRE_COST)}`,
      affordableHire: veh.hired || state.cash >= HIRE_COST,
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
  const grounds: HudModel["grounds"] = CLAIMS.map((c) => ({
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
    hint: hint(state),
    objective: objective(state),
    vehicleName: v ? DEFS[v.defId].name : "—",
    vehicleIndex: state.active,
    vehicleCount: state.vehicles.length,
    speedLabel: `${Math.round(Math.abs(v?.speed ?? 0) * 2.15)} mph`,
    cargoLabel: v ? cargoLine(v) : "",
    cargoFrac: st && st.capacity > 0 && v ? clamp(v.cargo / st.capacity, 0, 1) : 0,
    muted: state.muted,
    log: state.log.slice(0, 4),
    machines,
    crew,
    grounds,
    hadSave,
    savedBlurb,
    contractLabel,
  };
}
