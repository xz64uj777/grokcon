/**
 * Realistic machine controls. Pure functions, no game imports, so they can be
 * unit tested with plain Node and reused by any input source (keys or sticks).
 *
 * Stick convention: x = +1 right, y = +1 forward / up.
 * Drive convention: steer = +1 turns LEFT (matches the rest of the sim).
 */

export type Stick = { x: number; y: number };
export type Gear = -1 | 0 | 1;

export type ToolState = {
  /** Arms, boom, blade or bed height. 0 = on the ground, 1 = all the way up. */
  lift: number;
  /** Bucket: +1 curled back (holding), -1 dumped. Dozer: blade angle. */
  tilt: number;
  /** Excavator cab swing in radians. 0 = facing over the tracks. */
  swing: number;
  /** Excavator arm reach. 0 = tucked in, 1 = all the way out. */
  reach: number;
  /** Legacy saved value; drive direction now comes directly from the joystick. */
  gear: Gear;
};

export type ToolAxes = { lift: number; tilt: number; swing: number; reach: number };

export type DriveCmd =
  | { kind: "tank"; left: number; right: number }
  | { kind: "car"; throttle: number; steer: number; brake: number };

export type Command = { drive: DriveCmd; axes: ToolAxes };

export type MachineKind = "skid" | "excavator" | "loader" | "dozer" | "truck" | "car";

export function machineKind(defId: string): MachineKind {
  if (defId === "skid") return "skid";
  if (defId === "excavator") return "excavator";
  if (defId === "loader") return "loader";
  if (defId === "dozer") return "dozer";
  if (defId === "truck" || defId === "heavy") return "truck";
  return "car";
}

/** Legacy helper retained for old saves; no machine needs a manual gear selector. */
export function usesGears(_defId: string) { return false; }

export function homeTool(defId: string): ToolState {
  const k = machineKind(defId);
  return {
    lift: k === "dozer" ? 0.6 : k === "truck" ? 0 : 0.15,
    tilt: 0,
    swing: 0,
    reach: 0.4,
    gear: 1,
  };
}

const NO_AXES: ToolAxes = { lift: 0, tilt: 0, swing: 0, reach: 0 };

function c1(n: number) {
  return Math.max(-1, Math.min(1, n));
}

function dead(n: number, zone = 0.12) {
  if (Math.abs(n) < zone) return 0;
  return Math.sign(n) * ((Math.abs(n) - zone) / (1 - zone));
}

/**
 * Phone sticks to a machine command.
 * parked: excavator parking brake. Off = the left stick drives and steers.
 * On = that same stick slews the house and crowds the dipper.
 * The right stick always runs the boom and bucket.
 */
export function sticksToCommand(defId: string, left: Stick, right: Stick, parked = false): Command {
  const L = { x: dead(left.x), y: dead(left.y) };
  const R = { x: dead(right.x), y: dead(right.y) };
  const k = machineKind(defId);
  switch (k) {
    case "skid":
      // Loader-style controls: left stick drives, steers and reverses; right stick runs the lift arms and bucket.
      return {
        drive: { kind: "car", throttle: L.y, steer: L.x === 0 ? 0 : -L.x, brake: 0 },
        axes: { ...NO_AXES, lift: R.y, tilt: -R.x },
      };
    case "dozer":
      // Left and right track levers. Left stick sideways = blade up/down, right = blade angle.
      return { drive: { kind: "tank", left: L.y, right: R.y }, axes: { ...NO_AXES, lift: L.x, tilt: R.x } };
    case "excavator": {
      // Right stick always: up raises the boom, left curls the bucket, right dumps it.
      const axes: ToolAxes = { ...NO_AXES, lift: R.y, tilt: -R.x };
      if (!parked) {
        // One left stick, like the chatdemo excavator: forward drives, sideways steers.
        return { drive: { kind: "tank", left: c1(L.y + L.x), right: c1(L.y - L.x) }, axes };
      }
      return { drive: { kind: "tank", left: 0, right: 0 }, axes: { ...axes, swing: -L.x, reach: L.y } };
    }
    case "loader":
      return {
        drive: { kind: "car", throttle: L.y, steer: L.x === 0 ? 0 : -L.x, brake: 0 },
        axes: { ...NO_AXES, lift: R.y, tilt: -R.x },
      };
    case "truck":
      return {
        drive: { kind: "car", throttle: L.y, steer: L.x === 0 ? 0 : -L.x, brake: 0 },
        axes: { ...NO_AXES, lift: R.y },
      };
    default:
      return { drive: { kind: "car", throttle: L.y, steer: L.x === 0 ? 0 : -L.x, brake: 0 }, axes: { ...NO_AXES } };
  }
}

export function mergeCommands(a: Command, b: Command): Command {
  const axes: ToolAxes = {
    lift: c1(a.axes.lift + b.axes.lift),
    tilt: c1(a.axes.tilt + b.axes.tilt),
    swing: c1(a.axes.swing + b.axes.swing),
    reach: c1(a.axes.reach + b.axes.reach),
  };
  if (a.drive.kind === "tank" && b.drive.kind === "tank") {
    return { drive: { kind: "tank", left: c1(a.drive.left + b.drive.left), right: c1(a.drive.right + b.drive.right) }, axes };
  }
  if (a.drive.kind === "car" && b.drive.kind === "car") {
    return {
      drive: {
        kind: "car",
        throttle: c1(a.drive.throttle + b.drive.throttle),
        steer: c1(a.drive.steer + b.drive.steer),
        brake: Math.min(1, a.drive.brake + b.drive.brake),
      },
      axes,
    };
  }
  return { drive: a.drive, axes };
}

export const TOOL_RATES = { lift: 0.85, tilt: 1.7, swing: 1.3, reach: 0.9 };

/** Move the tool toward the stick input. Returns a new object. */
export function stepTool(tool: ToolState, axes: ToolAxes, dt: number, defId: string): ToolState {
  const k = machineKind(defId);
  const next = { ...tool };
  next.lift = Math.max(0, Math.min(1, tool.lift + axes.lift * TOOL_RATES.lift * dt));
  next.tilt = Math.max(-1, Math.min(1, tool.tilt + axes.tilt * TOOL_RATES.tilt * dt));
  if (k === "excavator") {
    let sw = tool.swing + axes.swing * TOOL_RATES.swing * dt;
    sw = Math.atan2(Math.sin(sw), Math.cos(sw));
    next.swing = sw;
    next.reach = Math.max(0, Math.min(1, tool.reach + axes.reach * TOOL_RATES.reach * dt));
  }
  return next;
}

/** Tank drive: speed from both sides, turn from the difference. */
export function tankMotion(left: number, right: number) {
  const L = c1(left);
  const R = c1(right);
  return { forward: (L + R) / 2, turn: (R - L) / 2 };
}

/** Car drive with a shifter. Throttle only pushes in the selected gear. */
export function gearedThrottle(throttle: number, gear: Gear) {
  return Math.max(0, throttle) * gear;
}

export type Gesture = {
  phase: "fill" | "dump" | "none";
  /** "top" scrapes the dirt off the top of a face. "toe" digs the bottom. */
  cut: "top" | "toe";
  /** 0..1. How clean the scoop is. Low quality spills and mixes dirt in. */
  quality: number;
};

const NONE: Gesture = { phase: "none", cut: "top", quality: 0 };

/**
 * Read what the operator is doing with the tool this frame.
 * prev/next: tool before and after this frame. speed: ground speed (m/s).
 */
export function readGesture(defId: string, prev: ToolState, next: ToolState, speed: number): Gesture {
  const k = machineKind(defId);
  const curling = next.tilt > prev.tilt + 1e-4;
  const dumping = next.tilt < prev.tilt - 1e-4;
  const liftMoving = Math.abs(next.lift - prev.lift);
  if (k === "skid" || k === "loader") {
    if (curling && next.lift < 0.5 && next.tilt < 0.98) {
      const sp = Math.abs(speed);
      const speedQ = sp <= 4 ? 1 : Math.max(0.35, 1 - (sp - 4) / 7);
      const heightQ = next.lift < 0.3 ? 1 : 0.9;
      return { phase: "fill", cut: next.lift < 0.25 ? "toe" : "top", quality: speedQ * heightQ };
    }
    if (dumping && next.tilt < -0.3 && next.lift > 0.45) return { phase: "dump", cut: "top", quality: 1 };
    return NONE;
  }
  if (k === "excavator") {
    if (curling && next.lift < 0.4 && next.reach > 0.3 && next.tilt < 0.98) {
      // Swinging or yanking the boom while curling slops material out.
      const swingMoving = Math.abs(next.swing - prev.swing) > 1e-4;
      const jerk = (liftMoving > 1e-4 ? 0.2 : 0) + (swingMoving ? 0.3 : 0);
      return { phase: "fill", cut: next.lift < 0.15 ? "toe" : "top", quality: Math.max(0.35, 1 - jerk) };
    }
    if (dumping && next.tilt < -0.3 && next.lift > 0.35) return { phase: "dump", cut: "top", quality: 1 };
    return NONE;
  }
  if (k === "dozer") {
    if (next.lift < 0.3 && speed > 0.3) return { phase: "fill", cut: next.lift < 0.12 ? "toe" : "top", quality: 0.85 };
    return NONE;
  }
  if (k === "truck") {
    if (next.lift > 0.6) return { phase: "dump", cut: "top", quality: 1 };
    return NONE;
  }
  return NONE;
}

/** Dozer blade depth: deeper digs more but drags. Too deep stalls. */
export function bladeDrag(lift: number) {
  if (lift >= 0.3) return 1;
  if (lift < 0.08) return 0.18; // stalled: the blade is buried
  return 0.55 + (lift - 0.08) * 2;
}

/** Excavator bucket tip, world space, from machine position, yaw and tool. */
export function bucketPoint(x: number, z: number, yaw: number, tool: ToolState) {
  const a = yaw + tool.swing;
  const r = 3.2 + tool.reach * 4.2;
  return { x: x - Math.sin(a) * r, z: z - Math.cos(a) * r };
}

export type HelpCard = { title: string; phoneLeft: string; phoneRight: string };

export function controlHelp(defId: string, parked = false): HelpCard {
  switch (machineKind(defId)) {
    case "skid":
      return { title: "Skid steer", phoneLeft: "Drive/reverse ↕ · steer ↔", phoneRight: "Arms ↕ · bucket ↔" };
    case "excavator":
      return parked
        ? { title: "Excavator · park on", phoneLeft: "Slew ↔ · dipper ↕", phoneRight: "Boom up ↑ · curl ← dump →" }
        : { title: "Excavator", phoneLeft: "Drive ↕ · steer ↔", phoneRight: "Boom up ↑ · curl ← dump →" };
    case "loader":
      return { title: "Payloader", phoneLeft: "Drive/reverse ↕ · steer ↔", phoneRight: "Arms ↕ · bucket ↔" };
    case "dozer":
      return { title: "Bulldozer", phoneLeft: "Left track ↕ · blade ↔", phoneRight: "Right track ↕ · angle ↔" };
    case "truck":
      return { title: "Dump truck", phoneLeft: "Drive/reverse ↕ · steer ↔", phoneRight: "Bed up/down ↕" };
    default:
      return { title: "Drive", phoneLeft: "Drive", phoneRight: "" };
  }
}
