/** HUD copy, price rows, and ops buttons. */

import * as Ops from "@/game/ops";
import * as Career from "@/game/career";
import { pileFootprint } from "@/game/piles";
import { MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, X1, benchAt } from "@/game/mountain";
import { CLAIMS, DEFS, HIRE_COST, ORES, PADS, SLUICE, START_CASH, VEHICLE_ORDER, formatMoney, usDist, tierInfo, upgradeCost } from "@/game/catalog";
import { BRIDGE, VALLEY_CLAIMS, WASH_PLANT, areaOf, boggedDown, mudDepth, onBridge, TRACKED } from "@/game/river";
import { bucketPoint, controlHelp, machineKind, usesGears } from "@/game/controls";
import { DAY_SECONDS, priceMult, trend } from "@/game/market";
import { MOUNTAIN_GATE_X, VALLEY_GATE_X, areaIn, deckFit, inDropYard, onHaulRoad, onMountainRoad, spotsUsed } from "@/game/lowboy";
import { BLAST_RADIUS, canBlastToday, DRILL_SECONDS, BORE_SECONDS, blastYield, repairCost } from "@/game/mining";
import type { AreaId } from "@/game/river";
import type { ControlMode, Deposit, GameState, HudModel, OreId, UpgradeKind, VehicleId, VehicleState } from "@/game/types";
import { basePrice, unitPrice } from "./economy.ts";
import { areaName, claimAreaOf, clamp, closestDeposit, closestFace, currentArea, distTo, haulFee, haulTarget, log, mountainOpen, mountainUnlockable, nearestPad, owns, ownsClaim, padOpen, prettySign, sameArea, valleyOpen, vehicleStats } from "./world.ts";
import { dirtToSluice, faceNearPlayer, prefersSluice, prefersWash } from "./jobs.ts";
import { nearestHauler, truckNear } from "./haulers.ts";
import { crossingWeight, lowboyDest } from "./motion.ts";
import { blastPrice, groundFactor, rainNow } from "./blast.ts";
import { buildHudTeams, crewDisplayStatus, crewSelectOptions, feederOptions } from "./crew.ts";
import { gearName, haulBlocker, lotButtons, lotBuy, nearestDeckLoad, resale, sourceOptions, yardCap } from "./office.ts";


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
  if (!owns(state, "truck") && (owns(state, "loader") || owns(state, "hloader") || owns(state, "excavator"))) {
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
    return "Pull up to an empty machine and tap Load. Two small machines fit. A heavy haul or a heavy loader rides alone.";
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
    if (v.cargo < 0.1) return "Park beside a payloader, heavy loader, or excavator and let them fill you.";
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
  if ((k === "skid" || k === "loader" || k === "excavator") && state.deposits.some(
    (d) => d.kind === "pile" && d.id.startsWith("feed-") && d.tons > 0.1 && distTo(v.x, v.z, d.x, d.z) <= 10,
  )) return "Plant feed pile: hold Work to process it. The yard feeder also clears it automatically.";
  const full = vehicleStats(v).capacity > 0 && v.cargo >= vehicleStats(v).capacity * 0.92;
  const face = faceNearPlayer(state, v, 2);
  if (face && face.stress > 0.5) return `The ${face.sign} wall is getting steep! Lift the bucket halfway and strip the dirt off the top first.`;
  if (k === "skid" || k === "loader") {
    const arms = "right stick up";
    const curl = "right stick left";
    if (v.cargo > 0.08 && (pad || truckNear(state, v, v.x, v.z, 9))) {
      if (t.lift < 0.45) return `Raise the arms (${arms}), then dump (right stick right).`;
      return "Dump the bucket: right stick right.";
    }
    if (full) return "Bucket full. Lift it a little and drive to a truck, the crusher or the waste pile.";
    if (t.lift > 0.5) return "Lower the arms to the ground (right stick down).";
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
    return "Tap Park to lock the tracks. Then swing and reach the bucket into a face.";
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


/** Short pile readout when you are close enough to work it, e.g. "Iron Pile · 12 t". */

/** Short pile readout when you are close enough to work it, e.g. "Iron Pile · 12 t". */
export function nearPileLabel(state: GameState, v: VehicleState) {
  let best: Deposit | null = null;
  let bestD = Infinity;
  for (const d of state.deposits) {
    if (d.kind !== "pile" || d.tons <= 0.15) continue;
    const foot = pileFootprint(d.tons);
    const reach = Math.max(foot.rx, foot.rz) + 8;
    const dist = distTo(v.x, v.z, d.x, d.z);
    if (dist <= reach && dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (!best) return "";
  const tons = best.tons >= 10 ? best.tons.toFixed(0) : best.tons.toFixed(1);
  return best.id.startsWith("feed-")
    ? `Plant feed (processing) · ${tons} t`
    : `${ORES[best.ore].name} loose pile · ${tons} t`;
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
      status: index === state.active && !state.watching ? "In your seat" : veh.operator ? crewDisplayStatus(state, veh) : "Parked",
      cargo: cargoLine(state, veh),
      active: index === state.active,
      hired: veh.hired,
      operator: veh.operator,
      workClaim: veh.workClaim ?? null,
      workSource: veh.defId === "lowboy"
        ? lowboyDest(veh) ? `map:${lowboyDest(veh)}` : "any"
        : veh.workFace ? `face:${veh.workFace}` : veh.workClaim != null ? String(veh.workClaim) : "any",
      sources: sourceOptions(state, area, veh.defId),
      crewValue: veh.crewId != null ? String(veh.crewId) : "auto",
      crewOptions: crewSelectOptions(state, veh),
      feederValue: veh.feederPad && padOpen(state, veh.feederPad) ? veh.feederPad : "auto",
      feederOptions: feederOptions(state, area),
      hireLabel: veh.hired ? (veh.operator ? "On duty" : "Off shift") : `Hire · ${formatMoney(HIRE_COST)}`,
      sellLabel: state.vehicles.length > 1 ? `Sell · ${formatMoney(resale(veh))}` : null,
      affordableHire: veh.hired || state.cash >= HIRE_COST,
      repairLabel: (veh.damage ?? 0) > 0.001 ? `Repair · ${formatMoney(repairCost(def.price, veh.damage))}` : null,
      affordableRepair: state.cash >= repairCost(def.price, veh.damage ?? 0),
      damageLabel: (veh.damage ?? 0) > 0.001 ? `Damaged ${Math.round(veh.damage * 100)}%` : "",
      ...(() => {
        const w = Ops.ops(state).wear[veh.uid] ?? 0;
        const broke = (Ops.ops(state).broke ?? []).includes(veh.uid);
        const cost = Career.isWorker(veh) ? Ops.overhaulPrice(veh, w) : 0;
        return {
          wearLabel: !Career.isWorker(veh) || (w < 0.05 && !broke) ? "" : broke ? `Broken down · wear ${Math.round(w * 100)}%` : `Wear ${Math.round(w * 100)}%`,
          overhaulLabel: Career.isWorker(veh) && (broke || w > 0.25) ? `${broke ? "Fix" : "Overhaul"} · ${formatMoney(cost)}` : null,
          affordableOverhaul: state.cash >= cost,
        };
      })(),
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
    hint: state.seconds < 60 && !state.tutorial.loaded
      ? "Drive to the orange pile and hold Dig."
      : state.watching
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
    teams: buildHudTeams(state),
    grounds,
    hadSave,
    savedBlurb,
    contractLabel,
    controlMode: state.controlMode,
    machineId: v ? v.defId : null,
    gearLabel: v && state.controlMode === "real" && usesGears(v.defId) ? `Gear ${gearName(v.tool.gear)}` : null,
    toolLabel: v ? toolLabel(v, state.controlMode) : "",
    purityLabel: v && v.cargo > 0.05 && v.cargoOre && v.cargoOre !== "dirt" ? `Purity ${Math.round((v.cargoPurity ?? 1) * 100)}%` : "",
    faceLabel: v ? nearPileLabel(state, v) || faceLabel(state, v) : "",
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
    showLoad: !!v && (v.defId === "lowboy" || (!DEFS[v.defId].receives && !!nearestHauler(state, v, 32, false))),
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
