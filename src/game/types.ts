import type { Command, ToolState } from "@/game/controls";
import type { Market } from "@/game/market";
import type { Ops, OpsButton } from "@/game/ops";

export type OreId = "dirt" | "iron" | "copper" | "gold" | "silver";

export type VehicleId =
  | "pickup"
  | "skid"
  | "dozer"
  | "loader"
  | "hloader"
  | "excavator"
  | "truck"
  | "heavy"
  | "crusher"
  | "lowboy"
  | "light";

export type UpgradeKind = "engine" | "body" | "hydro";

export type PadKind = "crusher" | "reclaim" | "sluice" | "loadout" | "wash" | "barge" | "mill";

export type Deposit = {
  id: string;
  kind: "vein" | "pile";
  ore: OreId;
  tons: number;
  max: number;
  x: number;
  z: number;
  regen: number;
  claim: number;
  radius: number;
  sign: string;
  /** Pile purity, or for a face unused. 0..1. */
  purity: number;
  overburden: number;
  grade: number;
  stress: number;
  bench: number;
  benchProgress: number;
  hard: boolean;
  tested: boolean;
  /** In-game day of the last blast here, or -1. */
  lastBlastDay: number;
};

export type CrewSetup = {
  id: number;
  /** Deposit id for a pile or face, or null for Auto. */
  sourceId: string | null;
  /** Plant the team hauls to, or null for Auto. */
  destKind: PadKind | null;
};

export type VehicleState = {
  uid: string;
  defId: VehicleId;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  cargoOre: OreId | null;
  cargo: number;
  cargoPurity: number;
  damage: number;
  tool: ToolState;
  /** Transient: the player is working the tools by hand this frame. */
  manual: boolean;
  upgrades: Record<UpgradeKind, number>;
  hired: boolean;
  operator: boolean;
  workClaim: number | null;
  /** A single face, such as Summit gold. Empty means any face on the work claim. */
  workFace: string | null;
  /** Manual crew id (Team 1, 2, …), or null for Auto. */
  crewId: number | null;
  /** Stays at this plant and feeds its dump pile. Null means Auto. */
  feederPad?: "sluice" | "wash" | null;
  status: string;
  stuck: number;
  unstick: number;
  bias: number;
  busy: boolean;
  /** Dozer ripper shank, 0 (up) to 1 (in the ground). Set by the drag control. */
  ripper?: number;
  /** Lowboy trailer heading. The deck pivots around the fifth wheel, so this lags the cab in a turn. */
  trailerYaw?: number;
  axleX?: number;
  axleZ?: number;
};

export type Tutorial = {
  loaded: boolean;
  dumped: boolean;
  bought: boolean;
};

export type Contract = {
  ore: OreId;
  delivered: number;
  need: number;
  bonus: number;
};

export type ControlMode = "real" | "simple";

export type Blast = {
  deposit: string;
  x: number;
  z: number;
  phase: "drill" | "fuse";
  t: number;
  /** Cash paid for this blast (0 when a free practice charge was used). */
  paid: number;
};

export type GameState = {
  version: 4;
  /** Round 3 site operations (fuel, tires, reputation, events...). */
  ops: Ops;
  controlMode: ControlMode;
  market: Market;
  explosives: number;
  blast: Blast | null;
  company: string;
  cash: number;
  lifetime: number;
  seconds: number;
  claims: number[];
  sluice: boolean;
  preferSluice: boolean;
  /** Maximum hired machines that automatically feed a plant stockpile. */
  feedLimit: 1 | 2 | "all";
  /** River Valley wash plant bought. */
  washPlant: boolean;
  /** How soaked the ground is, 0 (dry) to 1 (soaked). Rain itself comes from the market seed. */
  wet: number;
  muted: boolean;
  vehicles: VehicleState[];
  /** Player-made crews. Empty means every machine is on Auto. */
  crews: CrewSetup[];
  /** Uids strapped to the lowboy deck, load order. */
  deck: string[];
  active: number;
  deposits: Deposit[];
  pileSeq: number;
  tutorial: Tutorial;
  contractSeq: number;
  contract: Contract;
  log: string[];
  /** Out of the seat. Hired operators drive, including the machine the camera is on. Not saved. */
  watching: boolean;
};

export type Input = {
  throttle: number;
  steer: number;
  action: boolean;
  /** Realistic controls: the full stick/key command for the active machine. */
  cmd?: Command;
};

export type MachineCard = {
  id: string;
  name: string;
  blurb: string;
  priceLabel: string;
  owned: boolean;
  affordable: boolean;
  kind: "vehicle" | "plant";
};

export type UpgradeCard = {
  kind: UpgradeKind;
  label: string;
  level: number;
  costLabel: string | null;
  affordable: boolean;
};

export type CrewCard = {
  index: number;
  name: string;
  /** Yard this machine belongs to. The office crew tabs filter on this. */
  area: "ridge" | "river" | "mountain";
  /** On the trailer or the north road, so the roster can say so. */
  where: string;
  status: string;
  cargo: string;
  active: boolean;
  hired: boolean;
  operator: boolean;
  workClaim: number | null;
  /** Select value: "any", a claim id, or "face:<deposit id>". */
  workSource: string;
  sources: { value: string; label: string }[];
  crewValue: string;
  crewOptions: { value: string; label: string }[];
  feederValue: string;
  feederOptions: { value: string; label: string }[];
  hireLabel: string;
  sellLabel: string | null;
  affordableHire: boolean;
  repairLabel: string | null;
  affordableRepair: boolean;
  damageLabel: string;
  wearLabel: string;
  overhaulLabel: string | null;
  affordableOverhaul: boolean;
  upgrades: UpgradeCard[];
};

export type GroundCard = {
  id: number;
  name: string;
  blurb: string;
  priceLabel: string;
  owned: boolean;
  affordable: boolean;
  /** This lease is on the map whose office is open. */
  here: boolean;
  area: "ridge" | "river" | "mountain";
};

export type HudModel = {
  company: string;
  cashLabel: string;
  tier: string;
  tierNext: string | null;
  tierProgress: number;
  tierDetail: string;
  shift: string;
  hint: string;
  objective: string;
  vehicleName: string;
  vehicleIndex: number;
  vehicleCount: number;
  speedLabel: string;
  /** True while the active machine is rolling (the info card shrinks to one line). */
  moving: boolean;
  cargoLabel: string;
  cargoFrac: number;
  muted: boolean;
  sluice: boolean;
  preferSluice: boolean;
  feedLimit: 1 | 2 | "all";
  log: string[];
  machines: MachineCard[];
  crew: CrewCard[];
  teams: {
    id: number;
    name: string;
    members: string;
    area: "ridge" | "river" | "mountain";
    sourceValue: string;
    destValue: string;
    sources: { value: string; label: string }[];
    dests: { value: string; label: string }[];
    /** Truck-wait light for this team on this map. Null when the team has no digger. */
    truckLight: "green" | "yellow" | "red" | null;
    truckHint: string | null;
  }[];
  grounds: GroundCard[];
  hadSave: boolean;
  savedBlurb: string;
  contractLabel: string;
  controlMode: ControlMode;
  machineId: VehicleId | null;
  gearLabel: string | null;
  toolLabel: string;
  purityLabel: string;
  faceLabel: string;
  help: { title: string; phoneLeft: string; phoneRight: string };
  twoSticks: boolean;
  prices: PriceRow[];
  dayLabel: string;
  explosives: number;
  blastInfo: string;
  canTest: boolean;
  canBlast: boolean;
  blastLabel: string;
  practice: boolean;
  /** Which area the active machine is in. */
  area: "ridge" | "river" | "mountain";
  areaName: string;
  /** Distance readout while on the north road, e.g. "0.5 mi to River Valley". */
  passLabel: string;
  /** Where the mountain quarry road is, once that lease is open. */
  routeLabel: string;
  officeTitle: string;
  /** River Valley is open (Deep bench owned). */
  valleyOpen: boolean;
  /** High mountain leased. */
  mountainOpen: boolean;
  /** Show the ripper drag control (dozer with a ripper, in your seat). */
  ripperControl: boolean;
  ripper: number;
  /** Direct ridge-to-mountain lowboy line, or null when not offered here. */
  mountainHaul: string | null;
  canHaulMountain: boolean;
  /** Short travel line for the office, e.g. "Haul Skid steer to River Valley · $500". */
  travelLabel: string;
  canHaul: boolean;
  /** Other area has a machine you can jump to. */
  canGoOther: boolean;
  otherAreaName: string;
  rain: number;
  weatherLabel: string;
  groundLabel: string;
  bridgeLabel: string;
  /** Set while a flood has the bridge shut: time passed, and time until it opens. */
  bridgeClock: string;
  washPlant: boolean;
  deckLabel: string;
  deckButton: string | null;
  /** You stepped out. The crew is driving and the camera is only watching. */
  watching: boolean;
  opsLine: string;
  shop: OpsButton[];
  field: OpsButton[];
  records: string[];
  photo: boolean;
  night: number;
};

export type PriceRow = {
  ore: OreId;
  name: string;
  spots: { pad: PadKind; name: string; price: string; trend: "up" | "down" | "flat"; pct: number }[];
};

export type ViewModel = HudModel & { mode: "title" | "play"; booksReady: boolean; excDrive: boolean };

export type GameApi = {
  start: (mode: "continue" | "fresh", company: string) => void;
  setPanel: (open: boolean) => void;
  buy: (id: string) => void;
  buyGround: (id: number) => void;
  upgrade: (index: number, kind: UpgradeKind) => void;
  crew: (index: number) => void;
  assignSource: (index: number, source: string | null) => void;
  assignCrew: (index: number, crew: string) => void;
  setCrewSource: (crewId: number, sourceId: string | null) => void;
  setCrewDest: (crewId: number, destKind: string | null) => void;
  setFeedLimit: (limit: 1 | 2 | "all") => void;
  setFeeder: (index: number, pad: string | null) => void;
  setHaulSluice: (on: boolean) => void;
  drive: (index: number) => void;
  sell: (index: number) => void;
  setStick: (steer: number, throttle: number) => void;
  setAction: (down: boolean) => void;
  /** Release every stick and held button (used when the screen changes shape). */
  releaseInput: () => void;
  setSticks: (left: { x: number; y: number }, right: { x: number; y: number }) => void;
  shift: (dir: number) => void;
  setControlMode: (mode: ControlMode) => void;
  toggleExcDrive: () => void;
  testHole: () => void;
  blast: () => void;
  repair: (index: number) => void;
  overhaul: (index: number) => void;
  practice: (on: boolean) => void;
  loadTruck: () => void;
  /** Step out so hired operators drive, or sit back down. */
  watch: (on: boolean) => void;
  /** Point the camera at a machine without taking the controls. */
  look: (index: number) => void;
  haul: (to?: "ridge" | "river" | "mountain") => void;
  /** Jump to a machine that is already in the other area. */
  goOther: () => void;
  toggleMute: () => void;
  cycle: (dir: number) => void;
  downloadBooks: () => void;
  importBooks: (text: string) => boolean;
  ops: (id: string) => void;
  /** Ripper shank depth from the drag control, 0..1. */
  setRipper: (depth: number) => void;
};
