/** Crew teams, work orders, and the on-duty status line. */

import * as Ops from "@/game/ops";
import { CLAIMS, DEFS, ORES } from "@/game/catalog";
import { areaOf } from "@/game/river";
import { MOUNTAIN_GATE_X, PASS_SUMMIT_X, VALLEY_GATE_X, onHaulRoad, onMountainRoad } from "@/game/lowboy";
import { planCrewJobs, honorTeamDest, isSellPointKind, jobStillValid, isPlanDigger, isPlanTruck, PILE_JOB_TONS, CRUMB_TONS } from "@/game/crew-plan";
import type { AreaId } from "@/game/river";
import type { ManualCrew, CrewAssignment, PlanJob } from "@/game/crew-plan";
import type { GameState, HudModel, PadKind, VehicleState } from "@/game/types";
import { unitPrice } from "./economy.ts";
import { handsOn, livePads, log, machineArea, ownsClaim, padOpen, pileName, prettySign, sameArea, vehicleName } from "./world.ts";
import { FEED_RATES, feederStatus } from "./feed.ts";
import { assignedClaim, bestPad, canReach, dirtToSluice, facePin, pilePin, prefersSluice, prefersWash, washScore } from "./jobs.ts";
import { truckPartner } from "./haulers.ts";
import { aboard } from "./motion.ts";


const passSide = new WeakMap<GameState, AreaId>();

const summitSeen = new WeakSet<GameState>();

const mountainGateSeen = new WeakSet<GameState>();

/** Announce the map change at the valley gate, with a little deadband so reversing across it stays quiet. */

/** Announce the map change at the valley gate, with a little deadband so reversing across it stays quiet. */
export function notePass(state: GameState) {
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


const crewPlans = new WeakMap<GameState, { at: number; jobs: Map<string, CrewAssignment>; uids: string }>();


function crewKey(state: GameState) {
  const roster = state.vehicles
    .filter((v) => v.hired && v.operator && (isPlanDigger(v.defId) || isPlanTruck(v.defId) || v.defId === "skid"))
    .map((v) => `${v.uid}:${v.crewId ?? "auto"}:${v.workFace ?? ""}:${v.workClaim ?? ""}`)
    .sort()
    .join(",");
  const targets = (state.crews ?? []).map((c) => `${c.id}:${c.sourceId ?? ""}:${c.destKind ?? ""}`).join(",");
  return `${roster}|${targets}`;
}


function collectCrewJobs(state: GameState): PlanJob[] {
  const out: PlanJob[] = [];
  for (const d of state.deposits) {
    if (!ownsClaim(state, d.claim)) continue;
    if (d.kind === "pile" && d.id.startsWith("feed-")) continue;
    const crumb = d.kind === "pile" && d.tons >= CRUMB_TONS && d.tons < PILE_JOB_TONS;
    const pile = d.kind === "pile" && d.tons >= PILE_JOB_TONS;
    const vein = d.kind === "vein";
    if (!crumb && !pile && !vein) continue;
    const pad = bestPad(state, d.ore, d.x, d.z);
    if (!pad) continue;
    const sluiceBound = prefersSluice(state, d.ore) || dirtToSluice(state, d.ore, d.x);
    const unit = sluiceBound ? ORES[d.ore].sluice : prefersWash(state, d.ore, d.x) ? ORES[d.ore].wash : ORES[d.ore].crusher;
    if (unit <= 0) continue;
    let score = unit * Math.min(d.tons, 50);
    if (d.ore !== "dirt") score += washScore(state, d.ore);
    if (pile) score += 400;
    if (vein && d.ore === "dirt") score *= 0.15;
    const claimName = CLAIMS.find((c) => c.id === d.claim)?.name ?? `Claim ${d.claim}`;
    out.push({
      id: d.id,
      kind: crumb ? "crumb" : d.kind === "vein" ? "vein" : "pile",
      ore: d.ore,
      oreName: ORES[d.ore].name,
      tons: d.tons,
      x: d.x,
      z: d.z,
      area: areaOf(d.x),
      claim: d.claim,
      destKind: pad.kind,
      destName: pad.name,
      claimName,
      score,
    });
  }
  return out;
}

const PAD_KINDS: import("@/game/types").PadKind[] = ["crusher", "reclaim", "sluice", "loadout", "wash", "barge", "mill"];


function isPadKind(v: unknown): v is import("@/game/types").PadKind {
  return typeof v === "string" && (PAD_KINDS as string[]).includes(v);
}


export function pruneCrews(state: GameState) {
  if (!state.crews) state.crews = [];
  const used = new Set(state.vehicles.map((v) => v.crewId).filter((id): id is number => id != null));
  state.crews = state.crews.filter((c) => used.has(c.id) || c.sourceId || c.destKind);
  for (const v of state.vehicles) {
    if (v.crewId == null) continue;
    if (!state.crews.some((c) => c.id === v.crewId)) state.crews.push({ id: v.crewId, sourceId: null, destKind: null });
  }
  state.crews.sort((a, b) => a.id - b.id);
}


function ensureCrew(state: GameState, id: number) {
  pruneCrews(state);
  let c = state.crews.find((o) => o.id === id);
  if (!c) {
    c = { id, sourceId: null, destKind: null };
    state.crews.push(c);
    state.crews.sort((a, b) => a.id - b.id);
  }
  return c;
}


function nextCrewId(state: GameState) {
  pruneCrews(state);
  let n = 1;
  while (state.crews.some((c) => c.id === n) || state.vehicles.some((v) => v.crewId === n)) n += 1;
  return n;
}


function manualsFromState(state: GameState): ManualCrew[] {
  pruneCrews(state);
  return state.crews
    .map((c) => {
      const memberUids = state.vehicles.filter((v) => v.crewId === c.id && v.hired && v.operator && !v.feederPad).map((v) => v.uid);
      let destKind = c.destKind;
      let destName: string | null = null;
      if (destKind) {
        const pad = livePads(state).find((p) => p.kind === destKind);
        if (!pad || !padOpen(state, pad.kind)) destKind = null;
        else destName = pad.name;
      }
      let sourceId = c.sourceId;
      if (sourceId && !state.deposits.some((d) => d.id === sourceId && (d.kind === "vein" || d.tons >= 0.4) && ownsClaim(state, d.claim))) {
        sourceId = null;
      }
      return { id: c.id, memberUids, sourceId, destKind, destName };
    })
    .filter((c) => c.memberUids.length);
}


export function assignCrew(state: GameState, index: number, crew: string) {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  if (!isPlanDigger(v.defId) && !isPlanTruck(v.defId) && v.defId !== "skid") {
    return "That machine does not join a haul crew.";
  }
  if (crew === "auto" || crew == null || crew === "") {
    v.crewId = null;
    pruneCrews(state);
    refreshCrewPlan(state, true);
    v.status = "Assigned to Auto";
    return "";
  }
  const id = crew === "new" ? nextCrewId(state) : Math.round(Number(crew));
  if (!Number.isFinite(id) || id < 1 || id > 20) return "No such team.";
  v.crewId = id;
  v.feederPad = null;
  ensureCrew(state, id);
  refreshCrewPlan(state, true);
  v.status = `Assigned to Team ${id}`;
  return "";
}


export function setCrewSource(state: GameState, crewId: number, sourceId: string | null) {
  const c = state.crews.find((o) => o.id === crewId);
  if (!c) return "No such team.";
  if (!sourceId || sourceId === "auto") {
    c.sourceId = null;
  } else {
    const d = state.deposits.find((o) => o.id === sourceId);
    if (!d || d.id.startsWith("feed-") || !ownsClaim(state, d.claim)) return "That pile is gone.";
    c.sourceId = d.id;
  }
  refreshCrewPlan(state, true);
  return "";
}


export function setCrewDest(state: GameState, crewId: number, destKind: string | null) {
  const c = state.crews.find((o) => o.id === crewId);
  if (!c) return "No such team.";
  if (!destKind || destKind === "auto") {
    c.destKind = null;
  } else {
    if (!isPadKind(destKind) || !padOpen(state, destKind)) return "That plant is not open.";
    c.destKind = destKind;
  }
  refreshCrewPlan(state, true);
  return "";
}


export function setFeeder(state: GameState, index: number, pad: string | null) {
  const v = state.vehicles[index];
  if (!v) return "No machine.";
  if (!FEED_RATES[v.defId]) return "That machine cannot feed a plant.";
  if (!pad || pad === "auto") {
    v.feederPad = null;
    refreshCrewPlan(state, true);
    return "";
  }
  if (pad !== "sluice" && pad !== "wash") return "No such plant.";
  if (!padOpen(state, pad)) return "That plant is not open.";
  const plant = livePads(state).find((p) => p.kind === pad);
  if (!plant || areaOf(plant.x) !== areaOf(v.x)) return "That plant is not on this map.";
  for (const o of state.vehicles) {
    if (o !== v && o.feederPad === pad) o.feederPad = null;
  }
  v.feederPad = pad;
  v.crewId = null;
  pruneCrews(state);
  refreshCrewPlan(state, true);
  v.status = feederStatus(pad);
  return "";
}


export function feederOptions(state: GameState, area: AreaId) {
  const options: { value: string; label: string }[] = [{ value: "auto", label: "Auto" }];
  if (state.sluice && area === "ridge") options.push({ value: "sluice", label: "Sluice feeder" });
  if (state.washPlant && area === "river") options.push({ value: "wash", label: "Wash feeder" });
  return options;
}


export function teamSourceOptions(state: GameState, area: AreaId) {
  const options: { value: string; label: string }[] = [];
  for (const d of state.deposits) {
    if (!ownsClaim(state, d.claim) || areaOf(d.x) !== area) continue;
    if (d.kind === "pile" && (d.id.startsWith("feed-") || d.tons < 0.4)) continue;
    const place = CLAIMS.find((c) => c.id === d.claim)?.name ?? prettySign(d.sign);
    const what = d.kind === "vein" ? prettySign(d.sign) : `${pileName(d)} · ${d.tons.toFixed(1)} t`;
    options.push({ value: d.id, label: `${what} · ${place}` });
  }
  return options;
}


export function teamDestOptions(state: GameState, area: AreaId) {
  return livePads(state)
    .filter((p) => padOpen(state, p.kind) && areaOf(p.x) === area)
    .sort((a, b) => Number(isSellPointKind(a.kind)) - Number(isSellPointKind(b.kind)))
    .map((p) => ({ value: p.kind, label: p.name }));
}


function teamMemberLine(state: GameState, id: number) {
  const names = state.vehicles
    .filter((v) => v.crewId === id)
    .map((v) => vehicleName(state, v));
  return names.length ? names.join(", ") : "No machines";
}


export function crewSelectOptions(state: GameState, v: VehicleState) {
  if (!isPlanDigger(v.defId) && !isPlanTruck(v.defId) && v.defId !== "skid") return [];
  pruneCrews(state);
  const options = [{ value: "auto", label: "Auto" }, ...state.crews.map((c) => ({ value: String(c.id), label: `Team ${c.id}` }))];
  options.push({ value: "new", label: "New team" });
  return options;
}


/** How long, in game seconds, to average a digger's time waiting on a truck. */
export const TRUCK_WAIT_WINDOW = 60;
/** Under this share of the window, the team light is green. */
export const TRUCK_WAIT_GREEN = 0.15;
/** From the green cutoff through this share, the light is yellow; above it, red. */
export const TRUCK_WAIT_YELLOW = 0.4;

const truckWaitLog = new WeakMap<VehicleState, { t: number; dt: number; waiting: boolean }[]>();

export function isDiggerWaitingForTruck(status: string) {
  return /^(Waiting for truck|Waiting for a ready dump truck|Waiting for the heavy haul)$/.test(status);
}

export function truckLightForWait(ratio: number): "green" | "yellow" | "red" {
  if (ratio < TRUCK_WAIT_GREEN) return "green";
  if (ratio <= TRUCK_WAIT_YELLOW) return "yellow";
  return "red";
}

export function truckWaitHint(light: "green" | "yellow" | "red") {
  if (light === "green") return "Diggers are rarely waiting on a truck.";
  if (light === "yellow") return "Diggers wait on trucks some of the time — another truck may help.";
  return "Diggers waiting on trucks — add a truck";
}

function teamDiggers(state: GameState, crewId: number, area: AreaId) {
  return state.vehicles.filter(
    (v) =>
      v.crewId === crewId &&
      isPlanDigger(v.defId) &&
      machineArea(state, v) === area &&
      v.hired &&
      v.operator &&
      !v.feederPad,
  );
}

/** Record this tick's waiting-for-a-truck time. Call from the sim step; does not change behavior. */
export function noteTeamTruckWait(state: GameState, dt: number) {
  if (dt <= 0) return;
  const cut = state.seconds - TRUCK_WAIT_WINDOW;
  for (const v of state.vehicles) {
    if (!isPlanDigger(v.defId) || !v.hired || !v.operator || v.feederPad) continue;
    let log = truckWaitLog.get(v);
    if (!log) {
      log = [];
      truckWaitLog.set(v, log);
    }
    log.push({ t: state.seconds, dt, waiting: isDiggerWaitingForTruck(v.status) });
    while (log.length && log[0].t < cut) log.shift();
  }
}

/** Share of recent digger time spent waiting on a truck, or null if this team has no digger here. */
export function teamTruckWaitRatio(state: GameState, crewId: number, area: AreaId) {
  const diggers = teamDiggers(state, crewId, area);
  if (!diggers.length) return null;
  let wait = 0;
  let total = 0;
  for (const v of diggers) {
    const log = truckWaitLog.get(v);
    if (!log) continue;
    for (const s of log) {
      total += s.dt;
      if (s.waiting) wait += s.dt;
    }
  }
  if (total <= 0) return 0;
  return wait / total;
}

export function buildHudTeams(state: GameState): import("@/game/types").HudModel["teams"] {
  pruneCrews(state);
  const order: AreaId[] = ["ridge", "river", "mountain"];
  const out: import("@/game/types").HudModel["teams"] = [];
  for (const c of state.crews) {
    const members = state.vehicles.filter((v) => v.crewId === c.id);
    if (!members.length) continue;
    const areas = [...new Set(members.map((v) => machineArea(state, v)))].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    for (const area of areas) {
      const ratio = teamTruckWaitRatio(state, c.id, area);
      const truckLight = ratio == null ? null : truckLightForWait(ratio);
      out.push({
        id: c.id,
        name: `Team ${c.id}`,
        members: teamMemberLine(state, c.id),
        area,
        sourceValue: c.sourceId && state.deposits.some((d) => d.id === c.sourceId) ? c.sourceId : "auto",
        destValue: c.destKind && padOpen(state, c.destKind) ? c.destKind : "auto",
        sources: teamSourceOptions(state, area),
        dests: teamDestOptions(state, area),
        truckLight,
        truckHint: truckLight ? truckWaitHint(truckLight) : null,
      });
    }
  }
  return out;
}


function collectCrewMachines(state: GameState) {
  return state.vehicles
    .filter((v) => v.hired && v.operator && !aboard(v) && !v.feederPad && (isPlanDigger(v.defId) || isPlanTruck(v.defId) || v.defId === "skid"))
    .map((v) => ({
      uid: v.uid,
      defId: v.defId,
      x: v.x,
      z: v.z,
      area: areaOf(v.x),
      cargo: v.cargo,
      cargoOre: v.cargoOre,
      workClaim: assignedClaim(v),
      workFace: facePin(state, v)?.id ?? null,
      workPile: pilePin(state, v)?.id,
      crewId: v.crewId ?? null,
    }));
}


function sourcesGone(state: GameState, jobs: Map<string, CrewAssignment>) {
  for (const a of jobs.values()) {
    if (!a.sourceId) continue;
    const d = state.deposits.find((o) => o.id === a.sourceId);
    if (d?.kind === "vein" && state.crews.some((crew) => crew.id === a.team && crew.sourceId === d.id)) continue;
    if (!jobStillValid(a.jobKind, d?.tons ?? null)) return true;
  }
  return false;
}


function syncTeamPartners(state: GameState, jobs: Map<string, CrewAssignment>) {
  for (const v of state.vehicles) {
    const a = jobs.get(v.uid);
    if (a?.role !== "truck") continue;
    const digger = a.partnerUids.find((uid) => {
      const o = state.vehicles.find((x) => x.uid === uid);
      return !!o && isPlanDigger(o.defId);
    });
    if (digger) truckPartner.set(v, digger);
  }
}

/** Rebuild team jobs about once a second, or sooner if a source runs out or the roster changes. */

/** Rebuild team jobs about once a second, or sooner if a source runs out or the roster changes. */
export function refreshCrewPlan(state: GameState, force = false) {
  const prev = crewPlans.get(state);
  const uids = crewKey(state);
  const stale = force || !prev || state.seconds - prev.at >= 1 || prev.uids !== uids || sourcesGone(state, prev.jobs);
  if (!stale) return prev.jobs;
  const jobs = planCrewJobs(collectCrewMachines(state), collectCrewJobs(state), prev?.jobs ?? null, manualsFromState(state));
  crewPlans.set(state, { at: state.seconds, jobs, uids });
  syncTeamPartners(state, jobs);
  return jobs;
}


export function peekCrewJob(state: GameState, v: VehicleState): CrewAssignment | undefined {
  return crewPlans.get(state)?.jobs.get(v.uid);
}


export function crewAssignment(state: GameState, v: VehicleState) {
  refreshCrewPlan(state);
  return peekCrewJob(state, v);
}


export function plannedDeposit(state: GameState, v: VehicleState) {
  const job = peekCrewJob(state, v);
  if (!job?.sourceId) return null;
  return state.deposits.find((d) => d.id === job.sourceId) ?? null;
}


export function plannedPadFor(state: GameState, v: VehicleState) {
  const job = peekCrewJob(state, v);
  if (!job?.destKind || !v.cargoOre) return null;
  const pad = livePads(state).find((p) => p.kind === job.destKind);
  if (!pad || !padOpen(state, pad.kind)) return null;
  if (unitPrice(v.cargoOre, pad.kind, state.sluice, state.market) <= 0) return null;
  if (areaOf(pad.x) !== areaOf(v.x) || !canReach(v, pad.x)) return null;
  const auto = bestPad(state, v.cargoOre, v.x, v.z, v);
  if (auto && honorTeamDest(auto.kind, pad.kind) == null) return null;
  return pad;
}


export function teamHasTruck(state: GameState, v: VehicleState) {
  const job = peekCrewJob(state, v);
  if (!job || job.role !== "digger") return false;
  return job.partnerUids.some((uid) => {
    const t = state.vehicles.find((o) => o.uid === uid);
    return !!t && isPlanTruck(t.defId) && (t.operator || handsOn(state, t)) && sameArea(t, v);
  });
}


const SAFETY_STATUS =
  /^(Heading to the fuel|At the gas|At the diesel|Towed|Out of fuel|Hot brakes|Bridge flooded|Too heavy|Backing off|Backed out|Making room|Clearing the rockslide|Heading to the rockslide|Heading to feed|Feeding the|Feeding sluice|Feeding wash|Lights|Light plant|Plant parked)/;

/** On-duty board text: the team job, unless the machine is fueling, stuck, or in another safety state. */

/** On-duty board text: the team job, unless the machine is fueling, stuck, or in another safety state. */
export function crewDisplayStatus(state: GameState, v: VehicleState) {
  const status = v.status || "On duty";
  if (v.feederPad === "sluice" || v.feederPad === "wash") return status || feederStatus(v.feederPad);
  if (SAFETY_STATUS.test(status)) return status;
  const job = peekCrewJob(state, v);
  if (!job) return status;
  if (/^(Hauling|Dumping|Wash line)/.test(status) && job.team && job.destName) {
    const ore = job.ore ? ORES[job.ore].name.toLowerCase() : "material";
    return `Team ${job.team}: hauling ${ore} to ${job.destName}`;
  }
  if (/Waiting for (a ready dump truck|the heavy haul|truck)/.test(status) && job.team) {
    return `Team ${job.team}: waiting for truck`;
  }
  if (job.jobKind === "vein" && state.crews.some((crew) => crew.id === job.team && crew.sourceId === job.sourceId)) {
    const source = state.deposits.find((d) => d.id === job.sourceId);
    if (source && source.tons < 0.5) return `Team ${job.team}: waiting at ${job.claimName} · face depleted`;
  }
  if (job.sourceId && job.label) return job.label;
  if (!job.sourceId && job.label && /^(Looking for work|Needs a payloader|Waiting for|Face is dug|No material|No face)/.test(status)) {
    return job.label;
  }
  return status;
}
