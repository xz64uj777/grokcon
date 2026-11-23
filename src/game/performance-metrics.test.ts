import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFrameRecorder } from "@/game/performance-metrics";

describe("bounded on-device performance recorder", () => {
  it("reports stable 60 fps and CPU work without rounding away valid observations", () => {
    const recorder = createFrameRecorder();
    for (let i = 0; i < 120; i++) recorder.sample(1000 / 60, 6);
    const result = recorder.summary();
    assert.equal(result.samples, 120);
    assert.equal(result.fps, 60);
    assert.equal(result.onePercentLowFps, 60);
    assert.equal(result.p95WorkMs, 6);
    assert.equal(result.slowFramePercent, 0);
    assert.equal(result.durationSeconds, 2);
  });

  it("records slow frames and p95 instead of reporting only average FPS", () => {
    const recorder = createFrameRecorder();
    for (let i = 0; i < 90; i++) recorder.sample(16, 3);
    for (let i = 0; i < 10; i++) recorder.sample(50, 29);
    const summary = recorder.summary();
    assert.equal(summary.samples, 100);
    assert.equal(summary.p95FrameMs, 50);
    assert.equal(summary.p95WorkMs, 29);
    assert.equal(summary.slowFramePercent, 10);
    assert.equal(summary.onePercentLowFps, 20);
    assert.ok(summary.fps > 50 && summary.fps < 53);
  });

  it("ignores suspended tabs and invalid values", () => {
    const recorder = createFrameRecorder();
    recorder.sample(16, 5, true);
    recorder.sample(1500, 5);
    recorder.sample(NaN, 5);
    recorder.sample(16, Infinity);
    recorder.sample(16, 2);
    assert.equal(recorder.summary().samples, 1);
  });

  it("keeps only the most recent fixed-size window, with explicit reset", () => {
    const recorder = createFrameRecorder(3);
    for (const n of [16, 17, 18, 50]) recorder.sample(n, n / 2);
    assert.equal(recorder.summary().samples, 3);
    assert.equal(recorder.totalFrames, 4);
    assert.equal(recorder.summary().p95FrameMs, 50);
    recorder.reset();
    assert.equal(recorder.totalFrames, 0);
    assert.equal(recorder.summary().fps, 0);
  });
});
