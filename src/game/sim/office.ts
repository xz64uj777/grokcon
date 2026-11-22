/** Buying, hiring, hauling between maps, and the used lot. */

import * as Ops from "@/game/ops";
import * as Career from "@/game/career";
import { MOUNTAIN_CLAIM, MOUNTAIN_SPAWNS } from "@/game/mountain";
import { CLAIMS, DEFS, HIRE_COST, CREW_KEEP, SLUICE, SPAWNS, formatMoney, upgradeCost } from "@/game/catalog";
import { RIVER_SPAWNS, VALLEY_CLAIMS, WASH_PLANT, areaOf } from "@/game/river";
import { homeTool, usesGears } from "@/game/controls";
import { AXLE_BACK, areaIn, deckFit, deckSpots, onHaulRoad, spotsUsed } from "@/game/lowboy";
import { repairCost } from "@/game/mining";
import type { AreaId } from "@/game/river";
import type { ControlMode, GameState, UpgradeKind, VehicleId, VehicleState } from "@/game/types";
import { repriceContract } from "./economy.ts";
import { areaName, claimAreaOf, currentArea, distTo, haulFee, haulTarget, hypot, log, makeVehicle, mountainOpen, mountainUnlockable, ownsClaim, prettySign, valleyOpen, vehicleStats } from "./world.ts";
import { bindDeck, hitsBlock, pointBlocked, snapDeck } from "./motion.ts";
import { pruneCrews } from "./crew.ts";


export function storyTick(state: GameState) {
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


export function yardCap(id: VehicleId) {
  if (id === "skid" || id === "truck") return 3;
  if (id === "light" || id === "loader") return 4;
  if (id === "dozer" || id === "hloader" || id === "excavator" || id === "heavy") return 2;
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


export function gearName(g: number) {
  return g > 0 ? "F (forward)" : g < 0 ? "R (reverse)" : "N (neutral)";
}


export function repairVehicle(state: GameState, index: number) {
  const v = state.vehicles[index];
  if (!v || (v.damage ?? 0) <= 0.001) return "Nothing to fix.";
  const cost = repairCost(DEFS[v.defId].price, v.damage);
  if (!spend(state, cost, `${DEFS[v.defId].name} is fixed for ${formatMoney(cost)}.`)) return "Not enough cash.";
  v.damage = 0;
  return "";
}


export function overhaulVehicle(state: GameState, index: number) {
  const msg = Ops.overhaulAt(state, index);
  if (msg) log(state, msg);
  return msg;
}


export function spend(state: GameState, cost: number, msg: string) {
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


export function nearestDeckLoad(state: GameState, rig: VehicleState) {
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


export function uncouple(state: GameState, rig: VehicleState) {
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


export function haulBlocker(state: GameState, to: AreaId = haulTarget(state)) {
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
  pruneCrews(state);
  state.cash += refund;
  log(state, `Sold the ${name} for ${formatMoney(refund)}.`);
  return "";
}


export function resale(v: VehicleState) {
  let sunk = DEFS[v.defId].price;
  for (const kind of ["engine", "body", "hydro"] as const) {
    for (let level = 0; level < v.upgrades[kind]; level++) sunk += upgradeCost(v.defId, kind, level) ?? 0;
  }
  return Math.round(sunk * 0.5);
}

/** Remembers the last machine driven on each map, so the travel button does not dump you in the crusher. */

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
