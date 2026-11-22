/** Rain, ground, rockslides, and blast timing. */

import { MOUNTAIN_CLAIM, SWITCHBACKS, coldFactor } from "@/game/mountain";
import { ORES, formatMoney, usDist } from "@/game/catalog";
import { areaOf, mudDepth, mudSpeedFactor, onBridge, rainAt } from "@/game/river";
import { BLAST_RADIUS, BLAST_COST, canBlastToday, DRILL_SECONDS, BORE_SECONDS, FUSE_SECONDS, TEST_HOLE_COST, blastDamage, blastYield } from "@/game/mining";
import type { GameState, VehicleState } from "@/game/types";
import type { Control, StepFX } from "./types.ts";
import { distTo, faceOf, gateFor, hypot, log, ownsClaim, sameBank, vehicleStats } from "./world.ts";
import { addPile } from "./feed.ts";
import { faceNearPlayer } from "./jobs.ts";
import { pointBlocked, seek, segmentClear } from "./motion.ts";
import { spend } from "./office.ts";
import { step } from "./tick.ts";


export const ROAD_CLEAR_BONUS = 1800;

/** Drop a rockslide across one of the mountain switchback gaps. Clearing it pays ROAD_CLEAR_BONUS. */

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


export function regen(state: GameState, dt: number) {
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


export function updateBlast(state: GameState, dt: number, blasts: StepFX["blasts"]) {
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


export function blastEvacuationControl(state: GameState, index: number): Control | null {
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
