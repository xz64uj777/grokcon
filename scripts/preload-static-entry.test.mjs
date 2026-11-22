import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectCriticalPreloads } from "./preload-static-entry.mjs";

const manifest = {
  "_three-vendor-HASH.js": {
    file: "assets/three-vendor-HASH.js", name: "three-vendor",
  },
  "src/game/mount.ts": {
    file: "assets/mount-HASH.js", isDynamicEntry: true,
    imports: ["static.html", "_three-vendor-HASH.js"],
  },
  "static.html": {
    file: "assets/static-HASH.js", isEntry: true,
    dynamicImports: ["src/game/mount.ts"],
  },
};

describe("critical Three.js preload injection", () => {
  it("starts the graphics and game downloads before the shell script", () => {
    const html = '<head><script type="module" crossorigin src="/grokcon/assets/static-HASH.js"></script></head>';
    const result = injectCriticalPreloads(html, manifest);
    assert.match(result, /rel="modulepreload" crossorigin href="\/grokcon\/assets\/three-vendor-HASH.js"/);
    assert.match(result, /rel="modulepreload" crossorigin href="\/grokcon\/assets\/mount-HASH.js"/);
    assert.ok(result.indexOf("three-vendor-HASH.js") < result.indexOf("static-HASH.js"));
    assert.ok(result.indexOf("mount-HASH.js") < result.indexOf("static-HASH.js"));
    assert.equal(injectCriticalPreloads(result, manifest), result, "The build step must be idempotent");
  });

  it("supports Android's relative RIDGE_BASE=./ without hard-coded GitHub Pages paths", () => {
    const html = '<script type="module" crossorigin src="./assets/static-HASH.js"></script>';
    const result = injectCriticalPreloads(html, manifest);
    assert.match(result, /href="\.\/assets\/three-vendor-HASH.js"/);
    assert.match(result, /href="\.\/assets\/mount-HASH.js"/);
  });

  it("refuses an unexpected build manifest instead of emitting broken links", () => {
    const html = '<script type="module" crossorigin src="/grokcon/assets/static-HASH.js"></script>';
    assert.throws(() => injectCriticalPreloads(html, { "static.html": manifest["static.html"] }), /manifest/);
    assert.throws(() => injectCriticalPreloads("<head></head>", manifest), /entry script/);
  });
});
