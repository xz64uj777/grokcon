/**
 * Ridge Ore scenery: terraced pit walls, ground textures, haul roads with berms,
 * puddles and tire tracks, instanced boulders/scrub/trees, distant hills and a sky dome.
 * Everything is procedural (canvas textures, merged or instanced low-poly meshes).
 * Purely visual: collision still comes from BLOCKS in the catalog.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BLOCKS, BOUNDS, PADS, PIT, inPit } from "@/game/catalog";

type Track = <T extends { dispose: () => void }>(g: T) => T;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function canvasTex(size: number, paint: (g: CanvasRenderingContext2D, r: () => number) => void, repeat: number, seed: number) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) paint(g, rng(seed));
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function speckle(g: CanvasRenderingContext2D, r: () => number, size: number, base: string, dots: string[], count: number, maxR: number) {
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < count; i++) {
    g.fillStyle = dots[Math.floor(r() * dots.length)];
    const rad = 0.5 + r() * maxR;
    g.beginPath();
    g.arc(r() * size, r() * size, rad, 0, Math.PI * 2);
    g.fill();
  }
}

export function dirtTexture() {
  return canvasTex(256, (g, r) => {
    speckle(g, r, 256, "#7a6450", ["#6a5442", "#8a735c", "#735d48", "#94806a"], 2600, 1.6);
    // soft blotches so the tiling doesn't read as a grid
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? "60,44,32" : "150,128,100"},0.08)`;
      g.beginPath();
      g.arc(r() * 256, r() * 256, 18 + r() * 40, 0, Math.PI * 2);
      g.fill();
    }
  }, 30, 11);
}

export function gravelTexture() {
  return canvasTex(256, (g, r) => {
    speckle(g, r, 256, "#5e544a", ["#463e36", "#7d7266", "#6b6157", "#8f8478", "#3a332d"], 3400, 2.4);
  }, 14, 23);
}

export function rockTexture() {
  return canvasTex(256, (g, r) => {
    g.fillStyle = "#8a7663";
    g.fillRect(0, 0, 256, 256);
    // horizontal strata and cracks
    for (let y = 0; y < 256; y += 6 + r() * 10) {
      g.fillStyle = `rgba(${r() < 0.5 ? "70,54,42" : "170,150,128"},${0.18 + r() * 0.2})`;
      g.fillRect(0, y, 256, 2 + r() * 5);
    }
    g.strokeStyle = "rgba(40,30,24,0.45)";
    for (let i = 0; i < 40; i++) {
      g.lineWidth = 0.6 + r();
      g.beginPath();
      let x = r() * 256;
      let y = r() * 256;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (r() - 0.5) * 30;
        y += r() * 16;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    speckle(g, r, 0, "#000", ["#000"], 0, 0);
  }, 1, 37);
}

export function roadTexture() {
  return canvasTex(128, (g, r) => {
    speckle(g, r, 128, "#4b4137", ["#3c342c", "#5a4e42", "#433a31"], 900, 1.2);
    // tire tracks: two pairs of darker tread bands running the length
    for (const x of [26, 40, 88, 102]) {
      g.fillStyle = "rgba(28,22,18,0.35)";
      g.fillRect(x, 0, 9, 128);
      g.fillStyle = "rgba(20,16,12,0.35)";
      for (let y = 0; y < 128; y += 5) g.fillRect(x, y, 9, 2);
    }
  }, 1, 41);
}

/** Pit walls as stepped benches with uneven rock faces, one merged mesh. */
export function buildPitWalls(scene: THREE.Scene, track: Track, kind: "wall" | "cliff" = "wall", center: { x: number; z: number } = PIT) {
  const geos: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  for (const b of BLOCKS) {
    if (b.kind !== kind) continue;
    // Which way is "away from the pit" for this wall? Steps climb that way.
    const alongX = b.sx >= b.sz;
    const away = alongX ? Math.sign(b.z - center.z) || 1 : Math.sign(b.x - center.x) || 1;
    const thick = alongX ? b.sz : b.sx;
    const long = alongX ? b.sx : b.sz;
    const tiers = 3;
    let y0 = 0;
    for (let i = 0; i < tiers; i++) {
      const h = b.sy * (i === 0 ? 0.42 : i === 1 ? 0.33 : 0.3) + (i === tiers - 1 ? 1.2 : 0);
      // Each bench sets back from the pit side; the base matches the collision footprint.
      const setback = thick * 0.28 * i;
      const t = thick - setback + (i === tiers - 1 ? thick * 0.9 : 0);
      const segL = Math.max(2, Math.round(long / 2.2));
      const g = alongX ? new THREE.BoxGeometry(long + 1.5 - i, h, t, segL, 2, 2) : new THREE.BoxGeometry(t, h, long + 1.5 - i, 2, 2, segL);
      const shift = (setback / 2 + (i === tiers - 1 ? thick * 0.45 : 0)) * away;
      g.translate(b.x + (alongX ? 0 : shift), y0 + h / 2, b.z + (alongX ? shift : 0));
      const pos = g.attributes.position as THREE.BufferAttribute;
      const cols = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k);
        const y = pos.getY(k);
        const z = pos.getZ(k);
        if (y > 0.05) {
          const n = hash3(Math.round(x * 4), Math.round(y * 4), Math.round(z * 4)) - 0.5;
          const n2 = hash3(Math.round(z * 4), Math.round(x * 4), Math.round(y * 4)) - 0.5;
          pos.setXYZ(k, x + n * 0.9, y + n2 * 0.55, z + n2 * 0.9);
        }
        const band = 0.82 + 0.18 * Math.sin(y * 2.3 + hash3(x, 0, z) * 2);
        color.setRGB(0.62 * band, 0.5 * band, 0.4 * band);
        if (i === 0) color.multiplyScalar(0.9);
        cols[k * 3] = color.r;
        cols[k * 3 + 1] = color.g;
        cols[k * 3 + 2] = color.b;
      }
      g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      geos.push(g.toNonIndexed());
      g.dispose();
      y0 += h * 0.92;
    }
  }
  // Loose talus along the toe of each wall.
  const r = rng(kind === "wall" ? 5 : 15);
  for (const b of BLOCKS) {
    if (b.kind !== kind) continue;
    const alongX = b.sx >= b.sz;
    const toward = alongX ? -(Math.sign(b.z - center.z) || 1) : -(Math.sign(b.x - center.x) || 1);
    const long = alongX ? b.sx : b.sz;
    const half = (alongX ? b.sz : b.sx) / 2;
    for (let i = 0; i < long / 3; i++) {
      const g = new THREE.DodecahedronGeometry(0.5 + r() * 0.9, 0);
      const a = (r() - 0.5) * long;
      const off = (half + 0.2 + r() * 0.8) * toward;
      g.scale(1, 0.6, 1);
      g.translate(b.x + (alongX ? a : off), 0.25, b.z + (alongX ? off : a));
      const cols = new Float32Array(g.attributes.position.count * 3);
      const sh = 0.75 + r() * 0.25;
      for (let k = 0; k < cols.length; k += 3) {
        cols[k] = 0.52 * sh;
        cols[k + 1] = 0.44 * sh;
        cols[k + 2] = 0.36 * sh;
      }
      g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      geos.push(g.toNonIndexed());
      g.dispose();
    }
  }
  const stripped = geos.map((g) => {
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    return g;
  });
  const merged = mergeGeometries(stripped, false);
  stripped.forEach((g) => g.dispose());
  if (!merged) return;
  merged.computeVertexNormals();
  // Planar UVs for the rock texture (triplanar-ish: pick by dominant normal axis).
  const pos = merged.attributes.position as THREE.BufferAttribute;
  const nor = merged.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let k = 0; k < pos.count; k++) {
    const ax = Math.abs(nor.getX(k));
    const az = Math.abs(nor.getZ(k));
    const u = ax > az ? pos.getZ(k) : pos.getX(k);
    uv[k * 2] = u / 7;
    uv[k * 2 + 1] = pos.getY(k) / 7;
  }
  merged.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  track(merged);
  const map = track(rockTexture());
  const mat = track(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.96, metalness: 0, flatShading: true }));
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

export type Road = { w: number; h: number; x: number; z: number };

/** Haul roads with tire-track texture and low berms along both long edges. */
export function buildRoads(scene: THREE.Scene, track: Track, roads: Road[]) {
  const tex = track(roadTexture());
  const roadGeos: THREE.BufferGeometry[] = [];
  const bermGeos: THREE.BufferGeometry[] = [];
  for (const rd of roads) {
    const alongZ = rd.h >= rd.w;
    const long = alongZ ? rd.h : rd.w;
    const wide = alongZ ? rd.w : rd.h;
    const g = new THREE.PlaneGeometry(wide, long);
    g.rotateX(-Math.PI / 2);
    if (!alongZ) g.rotateY(Math.PI / 2);
    // stretch the texture along the road so the tire tracks run its length
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k), uv.getY(k) * (long / wide));
    g.translate(rd.x, 0.045, rd.z);
    roadGeos.push(g);
    for (const side of [-1, 1]) {
      // Berm: a low triangular ridge. Leave gaps every 14 m so it reads as pushed dirt.
      for (let s = -long / 2 + 3; s < long / 2 - 3; s += 14) {
        const len = Math.min(10, long / 2 - 3 - s);
        if (len < 2) continue;
        const b = new THREE.CylinderGeometry(0.75, 0.75, len, 3, 1);
        b.rotateZ(Math.PI / 2);
        b.scale(1, 0.55, 1);
        if (alongZ) b.rotateY(Math.PI / 2);
        const off = side * (wide / 2 + 0.6);
        const c = s + len / 2;
        b.translate(rd.x + (alongZ ? off : c), 0.2, rd.z + (alongZ ? c : off));
        bermGeos.push(b);
      }
    }
  }
  const road = mergeGeometries(roadGeos, false);
  roadGeos.forEach((g) => g.dispose());
  if (road) {
    track(road);
    const m = new THREE.Mesh(road, track(new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })));
    m.receiveShadow = true;
    scene.add(m);
  }
  const berm = mergeGeometries(bermGeos.map((g) => g.toNonIndexed()), false);
  bermGeos.forEach((g) => g.dispose());
  if (berm) {
    track(berm);
    const m = new THREE.Mesh(berm, track(new THREE.MeshStandardMaterial({ color: 0x7a644e, roughness: 1, flatShading: true })));
    m.receiveShadow = true;
    scene.add(m);
  }
}

/** A few muddy puddles in the low spots of the yard and pit floor. */
export function buildPuddles(scene: THREE.Scene, track: Track) {
  const spots: [number, number, number][] = [
    [-4, 30, 2.2],
    [10, 46, 1.6],
    [-30, -30, 2.6],
    [14, -24, 1.8],
    [-46, 30, 1.4],
    [36, 18, 1.5],
  ];
  const geos = spots.map(([x, z, r]) => {
    const g = new THREE.CircleGeometry(r, 14);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let k = 1; k < pos.count; k++) {
      const f = 0.75 + hash3(x, k, z) * 0.45;
      pos.setXY(k, pos.getX(k) * f, pos.getY(k) * f * 0.75);
    }
    g.rotateX(-Math.PI / 2);
    g.translate(x, 0.06, z);
    return g;
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) return;
  track(merged);
  const mat = track(new THREE.MeshStandardMaterial({ color: 0x5a6670, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.82 }));
  const mesh = new THREE.Mesh(merged, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function nearPadOrRoad(x: number, z: number, roads: Road[]) {
  for (const p of PADS) if (Math.hypot(x - p.x, z - p.z) < p.r + 4) return true;
  for (const rd of roads) if (Math.abs(x - rd.x) < rd.w / 2 + 3 && Math.abs(z - rd.z) < rd.h / 2 + 3) return true;
  for (const b of BLOCKS) if (Math.abs(x - b.x) < b.sx / 2 + 2 && Math.abs(z - b.z) < b.sz / 2 + 2) return true;
  return false;
}

/** Instanced boulders, scrub and trees, kept off the pit floor, pads and roads. */
export type ScatterSite = { cx: number; bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; avoid: (x: number, z: number) => boolean; seed: number };

export function buildScatter(scene: THREE.Scene, track: Track, roads: Road[], rich: boolean, site?: ScatterSite) {
  const r = rng(site?.seed ?? 77);
  const B = site?.bounds ?? BOUNDS;
  const cx = site?.cx ?? 0;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const spot = (inside: boolean) => {
    for (let tries = 0; tries < 40; tries++) {
      const x = inside ? B.minX + r() * (B.maxX - B.minX) : cx + (r() - 0.5) * 420;
      const z = inside ? B.minZ + r() * (B.maxZ - B.minZ) : (r() - 0.5) * 420;
      const outside = x < B.minX - 4 || x > B.maxX + 4 || z < B.minZ - 4 || z > B.maxZ + 4;
      if (!inside && !outside) continue;
      if (site) {
        if (inside && (site.avoid(x, z) || nearPadOrRoad(x, z, roads))) continue;
      } else if (inside && (inPit(x, z) || nearPadOrRoad(x, z, roads) || Math.hypot(x - 0, z - 44) < 16)) continue;
      if (Math.hypot(x - cx, z) > 200) continue;
      return { x, z };
    }
    return null;
  };
  const place = (mesh: THREE.InstancedMesh, count: number, inside: number, size: [number, number], ySquash: number) => {
    let n = 0;
    for (let i = 0; i < count; i++) {
      const s = spot(i < inside);
      if (!s) continue;
      const k = size[0] + r() * (size[1] - size[0]);
      e.set(r() * 0.4, r() * Math.PI * 2, r() * 0.4);
      q.setFromEuler(e);
      sc.set(k, k * ySquash, k * (0.8 + r() * 0.4));
      p.set(s.x, k * ySquash * 0.35, s.z);
      m.compose(p, q, sc);
      mesh.setMatrixAt(n++, m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  };
  const mul = rich ? 1.5 : 1;
  const boulder = new THREE.InstancedMesh(track(new THREE.DodecahedronGeometry(1, 0)), track(new THREE.MeshStandardMaterial({ color: 0x8a7a6a, roughness: 0.95, flatShading: true })), Math.round(90 * mul));
  boulder.castShadow = true;
  boulder.receiveShadow = true;
  place(boulder, Math.round(90 * mul), Math.round(30 * mul), [0.5, 1.9], 0.7);
  const scrub = new THREE.InstancedMesh(track(new THREE.IcosahedronGeometry(1, 0)), track(new THREE.MeshStandardMaterial({ color: 0x6b6a3e, roughness: 1, flatShading: true })), Math.round(140 * mul));
  place(scrub, Math.round(140 * mul), Math.round(40 * mul), [0.5, 1.2], 0.55);
  // Trees: trunk + two stacked canopy cones in one instanced geometry.
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 2, 5);
  trunk.translate(0, 1, 0);
  const c1 = new THREE.ConeGeometry(1.5, 2.8, 6);
  c1.translate(0, 3, 0);
  const c2 = new THREE.ConeGeometry(1.1, 2.2, 6);
  c2.translate(0, 4.4, 0);
  const paint = (g: THREE.BufferGeometry, rr: number, gg: number, bb: number) => {
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let k = 0; k < cols.length; k += 3) {
      cols[k] = rr;
      cols[k + 1] = gg;
      cols[k + 2] = bb;
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return g.toNonIndexed();
  };
  const parts = [paint(trunk, 0.36, 0.27, 0.2), paint(c1, 0.24, 0.32, 0.22), paint(c2, 0.28, 0.36, 0.24)];
  parts.forEach((g) => g.deleteAttribute("uv"));
  const treeGeo = mergeGeometries(parts, false);
  [trunk, c1, c2, ...parts].forEach((g) => g.dispose());
  if (treeGeo) {
    track(treeGeo);
    const trees = new THREE.InstancedMesh(treeGeo, track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true })), Math.round(60 * mul));
    trees.castShadow = true;
    place(trees, Math.round(60 * mul), Math.round(8 * mul), [0.8, 1.4], 1);
  }
}

/** Ring of low hills fading into the haze, plus a gradient sky dome. */
export function buildBackdrop(scene: THREE.Scene, track: Track, cx = 0, withSky = true, tint = 0x9a7058) {
  const r = rng(99 + cx);
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + r() * 0.1;
    const d = 170 + r() * 70;
    const h = 14 + r() * 26;
    const g = new THREE.SphereGeometry(1, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const n = hash3(i, k, 3) * 0.25;
      pos.setXYZ(k, pos.getX(k) * (1 + n), pos.getY(k) * (1 - n * 0.6), pos.getZ(k) * (1 + n));
    }
    g.scale(40 + r() * 40, h, 30 + r() * 30);
    g.rotateY(a);
    g.translate(cx + Math.cos(a) * d, -2, Math.sin(a) * d);
    g.deleteAttribute("uv");
    geos.push(g);
  }
  const hills = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (hills) {
    hills.computeVertexNormals();
    track(hills);
    scene.add(new THREE.Mesh(hills, track(new THREE.MeshStandardMaterial({ color: tint, roughness: 1, flatShading: true }))));
  }
  if (!withSky) return null;
  const sky = new THREE.SphereGeometry(300, 24, 12);
  const pos = sky.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x7fa6c8);
  const mid = new THREE.Color(0xe9c7a4);
  const low = new THREE.Color(0xd9a27c);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const t = pos.getY(k) / 300;
    if (t > 0.08) c.copy(mid).lerp(top, Math.min(1, (t - 0.08) / 0.6));
    else c.copy(low).lerp(mid, Math.max(0, (t + 0.1) / 0.18));
    cols[k * 3] = c.r;
    cols[k * 3 + 1] = c.g;
    cols[k * 3 + 2] = c.b;
  }
  sky.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  track(sky);
  const skyMesh = new THREE.Mesh(sky, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
  return skyMesh;
}

/** Device tier for cheap quality choices. Kyle's Z Fold is high-end; keep a lower tier for weaker phones. */
export function qualityTier() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const mem = typeof navigator !== "undefined" ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) : 4;
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("q") : null;
  const rich = forced ? forced === "high" : cores >= 8 && mem >= 6;
  return {
    rich,
    dprCap: rich ? 2 : 1.5,
    shadowMap: rich ? 1024 : 512,
    dust: rich ? 140 : 90,
  };
}

/** Soft round puff for dust particles (tiny canvas, drawn once). */
export function puffTexture() {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(c);
}
