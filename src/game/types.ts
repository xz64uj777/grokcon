export type OreId = "dirt" | "iron" | "copper" | "gold";

export type VehicleId =
  | "pickup"
  | "skid"
  | "dozer"
  | "loader"
  | "excavator"
  | "truck"
  | "heavy";

export type UpgradeKind = "engine" | "body" | "hydro";

export type PadKind = "crusher" | "reclaim" | "sluice";

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
  upgrades: Record<UpgradeKind, number>;
  hired: boolean;
  operator: boolean;
  workClaim: number | null;
  status: string;
  stuck: number;
  unstick: number;
  bias: number;
  busy: boolean;
};

export type Tutorial = {
  loaded: boolean;
  dumped: boolean;
  bought: boolean;
};

export type GameState = {
  version: 1;
  company: string;
  cash: number;
  lifetime: number;
  seconds: number;
  claims: number[];
  sluice: boolean;
  muted: boolean;
  vehicles: VehicleState[];
  active: number;
  deposits: Deposit[];
  pileSeq: number;
  tutorial: Tutorial;
  log: string[];
};

export type Input = {
  throttle: number;
  steer: number;
  action: boolean;
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
  status: string;
  cargo: string;
  active: boolean;
  hired: boolean;
  operator: boolean;
  workClaim: number | null;
  hireLabel: string;
  affordableHire: boolean;
  upgrades: UpgradeCard[];
};

export type GroundCard = {
  id: number;
  name: string;
  blurb: string;
  priceLabel: string;
  owned: boolean;
  affordable: boolean;
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
  cargoLabel: string;
  cargoFrac: number;
  muted: boolean;
  log: string[];
  machines: MachineCard[];
  crew: CrewCard[];
  grounds: GroundCard[];
  hadSave: boolean;
  savedBlurb: string;
};

export type ViewModel = HudModel & { mode: "title" | "play" };

export type GameApi = {
  start: (mode: "continue" | "fresh", company: string) => void;
  setPanel: (open: boolean) => void;
  buy: (id: string) => void;
  buyGround: (id: number) => void;
  upgrade: (index: number, kind: UpgradeKind) => void;
  crew: (index: number) => void;
  assignSource: (index: number, claim: number | null) => void;
  drive: (index: number) => void;
  setStick: (steer: number, throttle: number) => void;
  setAction: (down: boolean) => void;
  toggleMute: () => void;
  cycle: (dir: number) => void;
};

