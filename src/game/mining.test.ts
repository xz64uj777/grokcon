import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLAST_COST, DRILL_SECONDS, canBlastToday, BENCH_TONS, LAYER_OVERBURDEN, SLIDE_TONS, blastDamage, cutFace, mixPurity, purityFactor, type Seam } from "./mining.ts";

const seam = (o: Partial<Seam> = {}): Seam => ({
  overburden: 20, grade: 0.9, stress: 0, bench: 1, benchProgress: 0, hard: false, tested: false, ...o,
});

describe("overburden and purity", () => {
  it("auto digging strips the dirt before the ore", () => {
    const s = seam();
    const r = cutFace(s, 5, "auto", 1);
    assert.equal(r.ore, false);
    assert.equal(s.overburden, 15);
  });
  it("a clean cut on a stripped face reaches the face grade", () => {
    const r = cutFace(seam({ overburden: 0 }), 2, "toe", 1);
    assert.equal(r.ore, true);
    assert.ok(Math.abs(r.purity - 0.9) < 1e-9);
  });
  it("a sloppy cut lowers purity, digging under dirt lowers it more", () => {
    const clean = cutFace(seam({ overburden: 0 }), 2, "toe", 1).purity;
    const sloppy = cutFace(seam({ overburden: 0 }), 2, "toe", 0.3).purity;
    const under = cutFace(seam(), 2, "toe", 1).purity;
    assert.ok(sloppy < clean);
    assert.ok(under < clean);
  });
  it("price follows purity, dirt is exempt", () => {
    assert.equal(purityFactor("iron", 0.8), 0.8);
    assert.equal(purityFactor("dirt", 0.4), 1);
    assert.ok(Math.abs(mixPurity(10, 1, 10, 0.6) - 0.8) < 1e-9);
  });
});

describe("benches and wall slides", () => {
  it("undercutting a dirty face ends in a slide", () => {
    const s = seam();
    let slid = false;
    for (let i = 0; i < 20 && !slid; i++) slid = cutFace(s, 2, "toe", 1).slide;
    assert.ok(slid);
    assert.ok(s.overburden >= 20 + SLIDE_TONS - 1e-9);
  });
  it("a careful player who strips first never slides", () => {
    const s = seam({ overburden: 30 });
    for (let i = 0; i < 400; i++) {
      const r = cutFace(s, 2, "auto", 1);
      assert.equal(r.slide, false);
    }
  });
  it("digging a full bench opens the next layer", () => {
    const s = seam({ overburden: 0 });
    let benched = false;
    for (let i = 0; i < BENCH_TONS / 2 + 1; i++) benched = cutFace(s, 2, "toe", 1).benched || benched;
    assert.ok(benched);
    assert.equal(s.bench, 2);
    assert.ok(s.overburden > 0 && s.overburden <= LAYER_OVERBURDEN);
  });
});

describe("blasting", () => {
  it("hurts close machines and spares far ones", () => {
    assert.ok(blastDamage(3) > 0.4);
    assert.equal(blastDamage(30), 0);
  });
});

describe("blast rules", () => {
  it("a blast is a flat $750", () => {
    assert.equal(BLAST_COST, 750);
  });
  it("one blast per face per day", () => {
    assert.equal(canBlastToday(-1, 0), true);
    assert.equal(canBlastToday(3, 3), false);
    assert.equal(canBlastToday(3, 4), true);
  });
  it("drilling takes about 10 seconds", () => {
    assert.ok(DRILL_SECONDS >= 8 && DRILL_SECONDS <= 12);
  });
});
