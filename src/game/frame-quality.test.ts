import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdaptiveResolution } from "@/game/frame-quality";

function renderFrames(quality: ReturnType<typeof createAdaptiveResolution>, fps: number, count: number) {
  let changes = 0;
  for (let i = 0; i < count; i++) {
    if (quality.sample(1 / fps)) changes++;
  }
  return changes;
}

describe("adaptive mobile renderer resolution", () => {
  it("keeps full render detail at a stable 60 fps", () => {
    const quality = createAdaptiveResolution();
    assert.equal(renderFrames(quality, 60, 720), 0);
    assert.equal(quality.scale, 1);
  });

  it("reduces GPU pixel load on sustained slow frames without going below 65%", () => {
    const quality = createAdaptiveResolution();
    assert.ok(renderFrames(quality, 30, 120) > 0);
    assert.ok(quality.scale < 1);
    renderFrames(quality, 30, 1200);
    assert.equal(quality.scale, 0.65);
  });

  it("recovers resolution gradually only after sustained fast frames", () => {
    const quality = createAdaptiveResolution();
    renderFrames(quality, 30, 240);
    const lowered = quality.scale;
    assert.ok(lowered < 1);
    renderFrames(quality, 60, 420);
    assert.equal(quality.scale, lowered, "a brief recovery should not change the scale");
    renderFrames(quality, 60, 120);
    assert.ok(quality.scale > lowered);
    assert.ok(quality.scale < 1);
    renderFrames(quality, 60, 2400);
    assert.equal(quality.scale, 1);
  });

  it("ignores suspended-tab and malformed frame intervals", () => {
    const quality = createAdaptiveResolution();
    for (const dt of [0, -0.1, NaN, Infinity, 1, 0.2]) {
      for (let i = 0; i < 60; i++) assert.equal(quality.sample(dt), false);
    }
    assert.equal(quality.scale, 1);
  });
});
