import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bladeDrag,
  bucketPoint,
  controlCheatSheet,
  gearedThrottle,
  homeTool,
  readGesture,
  stepTool,
  sticksToCommand,
  tankMotion,
} from "./controls.ts";


describe("loader-style skid steer controls", () => {
  it("left stick drives and steers like the payloader", () => {
    const forward = sticksToCommand("skid", { x: 0, y: 1 }, { x: 0, y: 0 });
    assert.equal(forward.drive.kind, "car");
    if (forward.drive.kind !== "car") return;
    assert.equal(forward.drive.throttle, 1);
    assert.equal(forward.drive.steer, 0);
    assert.equal(forward.drive.brake, 0);

    const right = sticksToCommand("skid", { x: 1, y: 0 }, { x: 0, y: 0 });
    if (right.drive.kind !== "car") return;
    assert.equal(right.drive.steer, -1);
  });
  it("right stick operates arms and bucket like the payloader", () => {
    const cmd = sticksToCommand("skid", { x: 0, y: 0 }, { x: -1, y: 1 });
    assert.ok(cmd.axes.lift > 0.9, "right stick up raises the arms");
    assert.ok(cmd.axes.tilt > 0.9, "right stick left curls the bucket");
  });
  it("left stick back drives in reverse without a shifter", () => {
    const cmd = sticksToCommand("skid", { x: 0, y: -1 }, { x: 0, y: 0 });
    if (cmd.drive.kind !== "car") throw new Error("car");
    assert.equal(cmd.drive.throttle, -1);
    assert.equal(cmd.drive.brake, 0);
  });
  it("small stick wobble is ignored", () => {
    const cmd = sticksToCommand("skid", { x: 0.05, y: 0.08 }, { x: -0.05, y: 0 });
    if (cmd.drive.kind !== "car") throw new Error("car");
    assert.equal(cmd.drive.throttle, 0);
    assert.equal(cmd.drive.steer, 0);
    assert.equal(cmd.axes.lift, 0);
  });
});
describe("excavator operator layout", () => {
  it("brake off: left stick drives, right stick still runs the boom and bucket", () => {
    const cmd = sticksToCommand("excavator", { x: 0, y: 1 }, { x: -1, y: 1 }, false);
    assert.equal(cmd.axes.swing, 0);
    assert.ok(cmd.axes.lift > 0, "right stick up raises the boom");
    assert.ok(cmd.axes.tilt > 0, "right stick left curls the bucket");
    if (cmd.drive.kind !== "tank") throw new Error("tank");
    const m = tankMotion(cmd.drive.left, cmd.drive.right);
    assert.equal(m.forward, 1);
    assert.equal(m.turn, 0);
  });
  it("left stick sideways steers when the brake is off", () => {
    const cmd = sticksToCommand("excavator", { x: 1, y: 0 }, { x: 0, y: 0 }, false);
    if (cmd.drive.kind !== "tank") throw new Error("tank");
    assert.ok(tankMotion(cmd.drive.left, cmd.drive.right).turn < 0, "stick right turns right");
  });
  it("brake on: left stick slews and crowds, tracks stay planted", () => {
    const cmd = sticksToCommand("excavator", { x: 1, y: 1 }, { x: -1, y: 1 }, true);
    assert.ok(cmd.axes.swing < 0, "left stick right slews right");
    assert.ok(cmd.axes.reach > 0, "left stick forward crowds the dipper");
    assert.ok(cmd.axes.tilt > 0);
    if (cmd.drive.kind !== "tank") throw new Error("tank");
    assert.equal(cmd.drive.left, 0);
    assert.equal(cmd.drive.right, 0);
  });
  it("swing wraps all the way around", () => {
    let t = homeTool("excavator");
    for (let i = 0; i < 400; i++) t = stepTool(t, { lift: 0, tilt: 0, swing: 1, reach: 0 }, 0.05, "excavator");
    assert.ok(Math.abs(t.swing) <= Math.PI + 1e-9);
  });
  it("bucket point follows the swing", () => {
    const t = { ...homeTool("excavator"), swing: Math.PI / 2, reach: 0 };
    const p = bucketPoint(0, 0, 0, t);
    assert.ok(p.x < -3, "swung left puts the bucket on the left (-x)");
  });
});

describe("loader and trucks", () => {
  it("throttle only pushes in the selected gear", () => {
    assert.equal(gearedThrottle(1, 1), 1);
    assert.equal(gearedThrottle(1, 0), 0);
    assert.equal(gearedThrottle(1, -1), -1);
    assert.equal(gearedThrottle(-1, 1), 0);
  });
  it("pulling the left stick back reverses without a gear button", () => {
    const cmd = sticksToCommand("loader", { x: 0, y: -1 }, { x: 0, y: 0 });
    if (cmd.drive.kind !== "car") throw new Error("car");
    assert.equal(cmd.drive.throttle, -1);
    assert.equal(cmd.drive.brake, 0);
  });
});

describe("dozer and truck sticks", () => {
  it("dozer tracks on each stick, blade on the left stick sideways", () => {
    const c = sticksToCommand("dozer", { x: -1, y: 1 }, { x: 1, y: 1 });
    if (c.drive.kind !== "tank") throw new Error("tank");
    assert.equal(tankMotion(c.drive.left, c.drive.right).forward, 1);
    assert.ok(c.axes.lift < 0, "left stick left lowers the blade");
    assert.ok(c.axes.tilt > 0, "right stick sideways angles the blade");
  });
  it("truck bed rides the right stick", () => {
    assert.ok(sticksToCommand("truck", { x: 0, y: 0 }, { x: 0, y: 1 }).axes.lift > 0.9);
  });
});

describe("gestures", () => {
  const base = { ...homeTool("skid"), lift: 0.1, tilt: 0 };
  it("slow curl with bucket low is a clean scoop of the bottom", () => {
    const g = readGesture("skid", base, { ...base, tilt: 0.1 }, 2);
    assert.equal(g.phase, "fill");
    assert.equal(g.cut, "toe");
    assert.equal(g.quality, 1);
  });
  it("ramming in fast spills", () => {
    const g = readGesture("skid", base, { ...base, tilt: 0.1 }, 10);
    assert.ok(g.quality < 0.6);
  });
  it("bucket halfway up scrapes the top", () => {
    const mid = { ...base, lift: 0.35 };
    assert.equal(readGesture("skid", mid, { ...mid, tilt: 0.1 }, 1).cut, "top");
  });
  it("dumping needs the arms up", () => {
    const low = { ...base, tilt: -0.5 };
    assert.equal(readGesture("skid", low, { ...low, tilt: -0.6 }, 0).phase, "none");
    const high = { ...low, lift: 0.8 };
    assert.equal(readGesture("skid", high, { ...high, tilt: -0.6 }, 0).phase, "dump");
  });
  it("swinging while curling makes a sloppy excavator bite", () => {
    const e = { ...homeTool("excavator"), lift: 0.1, reach: 0.6, tilt: 0 };
    const clean = readGesture("excavator", e, { ...e, tilt: 0.1 }, 0);
    const sloppy = readGesture("excavator", e, { ...e, tilt: 0.1, swing: 0.1 }, 0);
    assert.ok(clean.quality > sloppy.quality);
  });
  it("a buried dozer blade stalls", () => {
    assert.ok(bladeDrag(0.02) < 0.3);
    assert.equal(bladeDrag(0.5), 1);
  });
});

describe("cheat sheet", () => {
  it("CHANGES.md contains the table generated from the stick labels", () => {
    const doc = readFileSync(new URL("../../CHANGES.md", import.meta.url), "utf8");
    const start = doc.indexOf("<!-- cheat-sheet:start -->");
    const end = doc.indexOf("<!-- cheat-sheet:end -->");
    assert.ok(start >= 0 && end > start);
    const table = doc.slice(start, end).replace("<!-- cheat-sheet:start -->", "").trim();
    assert.equal(table, controlCheatSheet());
    assert.equal(doc.includes("Gear ▲"), false);
  });
});
