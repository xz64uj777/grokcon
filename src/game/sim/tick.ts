/** The per-tick update: plan, move, pour, and pay. */

import * as Ops from "@/game/ops";
import * as Career from "@/game/career";
import { MOUNTAIN_SPAWNS } from "@/game/mountain";
import { SPAWNS, formatMoney } from "@/game/catalog";
import { RIVER_SPAWNS, X0, areaOf, inChannel, stepWet } from "@/game/river";
import { bladeDrag, machineKind, readGesture, stepTool } from "@/game/controls";
import { advanceMarket } from "@/game/market";
import type { Gesture } from "@/game/controls";
import type { GameState, Input, VehicleState } from "@/game/types";
import type { Control, StepFX, WorkOpts } from "./types.ts";
import { AUTO_CREW, AUTO_PLAYER, ZERO } from "./types.ts";
import { MARKET_KEYS } from "./economy.ts";
import { log, vehicleStats } from "./world.ts";
import { feedTick } from "./feed.ts";
import { faceNearPlayer } from "./jobs.ts";
import { dropInFront, pourIntoTrucks } from "./haulers.ts";
import { aboard, avoidTraffic, behindWestCliff, bindDeck, crewWatchdog, guardBridge, holdDeck, holdPiles, integrate, integrateTank, liftOutOfRiver, machineAhead, noseBlocked, resolveCircle, resolveVehicles, snapDeck, trailerCollide } from "./motion.ts";
import { aiControl, performAction, saleAcc } from "./ai.ts";
import { blastEvacuationControl, groundFactor, rainNow, regen, spawnRockslide, updateBlast } from "./blast.ts";
import { notePass, noteTeamTruckWait, refreshCrewPlan } from "./crew.ts";
import { storyTick } from "./office.ts";


export function step(state: GameState, input: Input, dt: number, playerEnabled: boolean): StepFX {
  if (!state.deck) state.deck = [];
  bindDeck(state);
  regen(state, dt);
  refreshCrewPlan(state);
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
    const x0 = v.x;
    const z0 = v.z;
    integrate(v, c, dt);
    // Hired and parked machines never drive into the water. Mud is not what puts them there.
    const seated = i === state.active && !state.watching;
    if (!seated && inChannel(v.x, v.z) && !inChannel(x0, z0)) {
      v.x = x0;
      v.z = z0;
      v.speed = 0;
    }
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
  liftOutOfRiver(state);
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
    if (v.operator && (state.watching || i !== state.active)) crewWatchdog(state, v);
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
  const seated = state.vehicles[state.active];
  if (seated && !state.watching && !seated.status) {
    seated.status = seated.busy ? "Working" : "In your seat";
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
  noteTeamTruckWait(state, dt);
  state.seconds += dt;
  const raining = rainNow(state) > 0.05;
  if (raining !== wasRaining) log(state, raining ? "Rain's coming in. The valley mud spreads and the low ground floods." : "Rain has stopped. The ground will dry out over a few minutes.");
  return { dig, sales, breaks, blasts };
}
