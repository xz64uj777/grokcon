/** Lightweight on-device frame metrics. Only enabled by ?perf=1 or ?qa=1. */
export type FrameSummary = {
  samples: number;
  durationSeconds: number;
  fps: number;
  onePercentLowFps: number;
  p95FrameMs: number;
  p95WorkMs: number;
  slowFramePercent: number;
};

export function createFrameRecorder(capacity = 900) {
  // Keep bounded samples (about 15 seconds at 60 fps), not an unbounded
  // telemetry stream. Data never leaves the browser automatically.
  const frames: number[] = [];
  const work: number[] = [];
  let totalFrames = 0;

  function sample(frameMs: number, workMs: number, hidden = false) {
    if (hidden || !Number.isFinite(frameMs) || frameMs <= 0 ||
        frameMs >= 1000 || !Number.isFinite(workMs) || workMs < 0) return;
    frames.push(frameMs);
    work.push(workMs);
    totalFrames++;
    if (frames.length > capacity) {
      frames.shift();
      work.shift();
    }
  }

  function reset() {
    frames.length = 0;
    work.length = 0;
    totalFrames = 0;
  }

  function summary(): FrameSummary {
    const count = frames.length;
    if (!count) return {
      samples: 0, durationSeconds: 0, fps: 0, onePercentLowFps: 0,
      p95FrameMs: 0, p95WorkMs: 0, slowFramePercent: 0,
    };
    const percentile = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
    };
    const round = (value: number) => Math.round(value * 100) / 100;
    const duration = frames.reduce((sum, ms) => sum + ms, 0);
    const p99 = percentile(frames, 0.99);
    return {
      samples: count,
      durationSeconds: round(duration / 1000),
      fps: round(1000 * count / duration),
      onePercentLowFps: round(1000 / p99),
      p95FrameMs: round(percentile(frames, 0.95)),
      p95WorkMs: round(percentile(work, 0.95)),
      slowFramePercent: round(100 * frames.filter((ms) => ms > 1000 / 30).length / count),
    };
  }

  return { sample, reset, summary, get totalFrames() { return totalFrames; } };
}
