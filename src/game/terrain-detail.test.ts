import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { terrainMeshSegments } from "@/game/terrain-detail";

describe("terrain mesh resolution", () => {
  it("preserves the existing high-quality terrain tessellation", () => {
    assert.deepEqual(terrainMeshSegments(true), {
      ridge: [170, 170],
      mountain: [160, 150],
    });
  });

  it("cuts low-tier ground triangles without changing the simulated terrain", () => {
    const rich = terrainMeshSegments(true);
    const low = terrainMeshSegments(false);
    const triangles = (segments: readonly [number, number]) => segments[0] * segments[1] * 2;
    assert.ok(triangles(low.ridge) < triangles(rich.ridge) * 0.6);
    assert.ok(triangles(low.mountain) < triangles(rich.mountain) * 0.6);
    assert.ok(triangles(low.ridge) > 25000, "Keep a visible smoothly draped ground surface");
    assert.ok(triangles(low.mountain) > 25000, "Keep a visible smoothly draped mountain surface");
  });
});
