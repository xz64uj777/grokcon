import type { OreId, UpgradeKind, VehicleId } from "@/game/types";

export const HIRE_COST = 800;
/** Share of a hired operator's sale that lands in the company box. */
export const CREW_KEEP = 0.7;
export const START_CASH = 350;

export const BOUNDS = { minX: -96, maxX: 96, minZ: -72, maxZ: 68 };
export const GATE = { x: -8, z: 20 };
export const PIT = { x: -6, z: -22, rx: 46, rz: 32 };

export function inPit(x: number, z: number) {
  return x > -52 && x < 40 && z > -52 && z < 5;
}

export type BlockKind = "wall" | "building" | "rock";

export type Block = {
  id: string;
  x: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  kind: BlockKind;
};

export const BLOCKS: Block[] = [
  { id: "wall-n", x: -6, z: -56, sx: 96, sy: 10, sz: 8, kind: "wall" },
  { id: "wall-w", x: -56, z: -24, sx: 8, sy: 9, sz: 58, kind: "wall" },
  { id: "wall-e", x: 44, z: -24, sx: 8, sy: 9, sz: 58, kind: "wall" },
  { id: "wall-sw", x: -40, z: 8, sx: 30, sy: 7, sz: 7, kind: "wall" },
  { id: "wall-se", x: 26, z: 8, sx: 32, sy: 7, sz: 7, kind: "wall" },
  { id: "office", x: 22, z: 54, sx: 14, sy: 4.2, sz: 7, kind: "building" },
  { id: "garage", x: -22, z: 54, sx: 18, sy: 5, sz: 8, kind: "building" },
  { id: "crusher", x: 50, z: 26, sx: 12, sy: 9, sz: 10, kind: "building" },
  { id: "rock-1", x: 28, z: -16, sx: 5, sy: 2.8, sz: 4, kind: "rock" },
  { id: "rock-2", x: -42, z: -8, sx: 5, sy: 2.4, sz: 4, kind: "rock" },
  { id: "rock-3", x: -28, z: -44, sx: 4, sy: 2.2, sz: 4, kind: "rock" },
];

export const PADS = [
  { id: "crusher", name: "Crusher", x: 32, z: 30, r: 15, kind: "crusher" as const },
  { id: "reclaim", name: "Reclaim", x: 44, z: 46, r: 8, kind: "reclaim" as const },
  { id: "sluice", name: "Sluice", x: -80, z: 36, r: 8, kind: "sluice" as const },
];

export const SPAWNS = [
  { x: 0, z: 44 },
  { x: -8, z: 40 },
  { x: 12, z: 42 },
  { x: 6, z: 50 },
  { x: -6, z: 50 },
  { x: 18, z: 40 },
  { x: -32, z: 42 },
];

export const ORES: Record<
  OreId,
  { name: string; crusher: number; reclaim: number; sluice: number; color: number }
> = {
  dirt: { name: "Dirt", crusher: 22, reclaim: 52, sluice: 22, color: 0x8d7044 },
  iron: { name: "Iron", crusher: 74, reclaim: 28, sluice: 74, color: 0xa85a3e },
  copper: { name: "Copper", crusher: 160, reclaim: 55, sluice: 190, color: 0x2f8f78 },
  gold: { name: "Gold gravel", crusher: 140, reclaim: 48, sluice: 300, color: 0xd4a84a },
};

export const BASE_DEPOSITS = [
  {
    id: "starter",
    kind: "pile" as const,
    ore: "iron" as const,
    tons: 40,
    max: 40,
    x: -2,
    z: 22,
    regen: 1.15,
    claim: 1,
    radius: 6.5,
    sign: "IRON PILE",
  },
  {
    id: "dirt",
    kind: "vein" as const,
    ore: "dirt" as const,
    tons: 520,
    max: 520,
    x: 16,
    z: 36,
    regen: 2.2,
    claim: 1,
    radius: 8,
    sign: "OVERBURDEN",
  },
  {
    id: "iron",
    kind: "vein" as const,
    ore: "iron" as const,
    tons: 480,
    max: 480,
    x: -16,
    z: -16,
    regen: 1.35,
    claim: 1,
    radius: 8.5,
    sign: "IRON FACE",
  },
  {
    id: "copper",
    kind: "vein" as const,
    ore: "copper" as const,
    tons: 280,
    max: 280,
    x: -34,
    z: -24,
    regen: 0.55,
    claim: 2,
    radius: 8,
    sign: "COPPER BENCH",
  },
  {
    id: "gold",
    kind: "vein" as const,
    ore: "gold" as const,
    tons: 170,
    max: 170,
    x: -80,
    z: 16,
    regen: 0.34,
    claim: 3,
    radius: 7.5,
    sign: "GOLD GRAVEL",
  },
  {
    id: "deep-iron",
    kind: "vein" as const,
    ore: "iron" as const,
    tons: 980,
    max: 980,
    x: -8,
    z: -40,
    regen: 2.5,
    claim: 4,
    radius: 9,
    sign: "DEEP IRON",
  },
  {
    id: "deep-copper",
    kind: "vein" as const,
    ore: "copper" as const,
    tons: 420,
    max: 420,
    x: 18,
    z: -36,
    regen: 0.9,
    claim: 4,
    radius: 8,
    sign: "DEEP COPPER",
  },
];

export type VehicleDef = {
  id: VehicleId;
  name: string;
  blurb: string;
  price: number;
  capacity: number;
  maxSpeed: number;
  accel: number;
  turn: number;
  dig: number;
  scoop: number;
  push: number;
  range: number;
  radius: number;
  receives: boolean;
  upgradeScale: number;
  bodyLabel: string;
};

export const VEHICLE_ORDER: VehicleId[] = [
  "pickup",
  "skid",
  "dozer",
  "loader",
  "truck",
  "excavator",
  "heavy",
];

export const DEFS: Record<VehicleId, VehicleDef> = {
  pickup: {
    id: "pickup",
    name: "Claim truck",
    blurb: "Your first bed. Scoops piles and sells them. Cannot cut a face.",
    price: 0,
    capacity: 2,
    maxSpeed: 18,
    accel: 14,
    turn: 2.35,
    dig: 0,
    scoop: 1.15,
    push: 0,
    range: 7,
    radius: 1.7,
    receives: false,
    upgradeScale: 1,
    bodyLabel: "Bed",
  },
  skid: {
    id: "skid",
    name: "Skid steer",
    blurb: "Cuts veins and scoops. The first machine that can open a face.",
    price: 2200,
    capacity: 2.4,
    maxSpeed: 12,
    accel: 11,
    turn: 2.7,
    dig: 1.7,
    scoop: 1.3,
    push: 0,
    range: 7.5,
    radius: 1.55,
    receives: false,
    upgradeScale: 1.15,
    bodyLabel: "Bucket",
  },
  dozer: {
    id: "dozer",
    name: "Bulldozer",
    blurb: "Pushes a face into a pile for the haulers. No bed of its own.",
    price: 12500,
    capacity: 0,
    maxSpeed: 10,
    accel: 8,
    turn: 1.55,
    dig: 0,
    scoop: 0,
    push: 3.4,
    range: 9,
    radius: 2.15,
    receives: false,
    upgradeScale: 1.45,
    bodyLabel: "Blade",
  },
  loader: {
    id: "loader",
    name: "Payloader",
    blurb: "Big bucket. Fills dump trucks, or hauls a pile to the crusher itself.",
    price: 28000,
    capacity: 8,
    maxSpeed: 13,
    accel: 9,
    turn: 1.7,
    dig: 0,
    scoop: 4.6,
    push: 0,
    range: 8,
    radius: 2.25,
    receives: false,
    upgradeScale: 1.8,
    bodyLabel: "Bucket",
  },
  excavator: {
    id: "excavator",
    name: "Excavator",
    blurb: "Production digger. Park it on a face and fill the truck beside it.",
    price: 64000,
    capacity: 3.2,
    maxSpeed: 6.5,
    accel: 5,
    turn: 1.45,
    dig: 5.6,
    scoop: 0,
    push: 0,
    range: 10,
    radius: 2.3,
    receives: false,
    upgradeScale: 2.15,
    bodyLabel: "Bucket",
  },
  truck: {
    id: "truck",
    name: "Dump truck",
    blurb: "Hauls what the payloader and excavator dig. Hire it a driver.",
    price: 42000,
    capacity: 22,
    maxSpeed: 16,
    accel: 8,
    turn: 1.25,
    dig: 0,
    scoop: 0,
    push: 0,
    range: 8,
    radius: 2.55,
    receives: true,
    upgradeScale: 1.85,
    bodyLabel: "Bed",
  },
  heavy: {
    id: "heavy",
    name: "Heavy haul",
    blurb: "Forty tons a trip. For a company that already owns the ridge.",
    price: 125000,
    capacity: 40,
    maxSpeed: 13,
    accel: 6.5,
    turn: 1.05,
    dig: 0,
    scoop: 0,
    push: 0,
    range: 9,
    radius: 3.05,
    receives: true,
    upgradeScale: 2.5,
    bodyLabel: "Bed",
  },
};

export const SLUICE = {
  id: "sluice",
  name: "Sluice plant",
  price: 18000,
  blurb: "Shaker and trough on the west road. Gold gravel pays out here.",
};

export const CLAIMS = [
  {
    id: 1,
    name: "South yard",
    price: 0,
    blurb: "Iron pile, overburden, and the main iron face inside the gate.",
  },
  {
    id: 2,
    name: "Copper bench",
    price: 9000,
    blurb: "West bench inside the pit. Copper pays more than iron at the crusher.",
  },
  {
    id: 3,
    name: "Gold creek",
    price: 24000,
    blurb: "Gravel bar west of the walls. Run it through the sluice.",
  },
  {
    id: 4,
    name: "Deep bench",
    price: 90000,
    blurb: "Bottom of the ridge. Heavy iron and copper for a full crew.",
  },
];

export const TIERS = [
  { name: "Prospector", at: 0 },
  { name: "Claim hand", at: 2500 },
  { name: "Pit contractor", at: 20000 },
  { name: "Crew boss", at: 75000 },
  { name: "Plant operator", at: 200000 },
  { name: "Ridge Ore Co.", at: 600000 },
  { name: "Ridge Holdings", at: 1500000 },
];

const UPGRADE_COSTS: Record<UpgradeKind, number[]> = {
  engine: [700, 1900, 4800],
  body: [800, 2200, 5600],
  hydro: [650, 1700, 4200],
};

export function formatMoney(n: number) {
  const v = Math.round(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

export function tierInfo(lifetime: number) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) {
    if (lifetime >= TIERS[i].at) idx = i;
  }
  const cur = TIERS[idx];
  const next = TIERS[idx + 1] ?? null;
  const progress = next ? (lifetime - cur.at) / (next.at - cur.at) : 1;
  return { name: cur.name, next: next?.name ?? null, progress: Math.max(0, Math.min(1, progress)), nextAt: next?.at ?? null };
}

export function upgradeCost(defId: VehicleId, kind: UpgradeKind, level: number) {
  if (level >= 3) return null;
  return Math.round(UPGRADE_COSTS[kind][level] * DEFS[defId].upgradeScale);
}

export function isVehicleId(id: string): id is VehicleId {
  return Object.prototype.hasOwnProperty.call(DEFS, id);
}

export function isOreId(id: string): id is OreId {
  return id === "dirt" || id === "iron" || id === "copper" || id === "gold";
}
