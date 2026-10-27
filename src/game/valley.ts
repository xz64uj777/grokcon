/**
 * River Valley scenery: ground, river, bridge, mud that spreads in the rain,
 * valley cliffs, loadout, wash plant and trees. Looks only; the rules are in river.ts.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PADS } from "@/game/catalog";
import { BRIDGE, MUD_ZONES, RIVER, RIVER_BOUNDS, RIVER_CAMP, WASH_PLANT, X0 } from "@/game/river";
import { buildBackdrop, buildPitWalls, buildScatter, dirtTexture, gravelTexture } from "@/game/scenery";

type Track = <T extends { dispose: () => void }>(g: T) => T;
type Std = (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial;

function waterTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#4c7a86";
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = `rgba(${200 + (i % 40)},${220 + (i % 30)},${225},${0.12 + (i % 5) * 0.03})`;
      g.lineWidth = 1 + (i % 3);
      const x = (i * 37) % 128;
      const y = (i * 61) % 128;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 6, y + 3, x + 14, y);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type Valley = {
  update: (dt: number, wet: number, washPlant: boolean) => void;
};

export function buildValley(
  scene: THREE.Scene,
  track: Track,
  std: Std,
  rich: boolean,
  textTexture: (text: string, accent: string) => THREE.Texture,
): Valley {
  // Ground: greener, gravelly valley floor.
  const groundTex = track(dirtTexture());
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(360, 340)), std(0xb9b48f, { map: groundTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(X0, 0, 0);
  ground.receiveShadow = true;
  scene.add(ground);

  // Wet gravel banks and the river itself.
  const bankTex = track(gravelTexture());
  bankTex.repeat.set(2, 18);
  const banks = new THREE.Mesh(track(new THREE.PlaneGeometry(RIVER.halfWidth * 2 + 8, RIVER.maxZ - RIVER.minZ)), std(0x9a8e7c, { map: bankTex, roughness: 0.85 }));
  banks.rotation.x = -Math.PI / 2;
  banks.position.set(RIVER.x, 0.03, (RIVER.maxZ + RIVER.minZ) / 2);
  banks.receiveShadow = true;
  scene.add(banks);
  const wtex = track(waterTexture());
  wtex.repeat.set(1, 10);
  const water = new THREE.Mesh(
    track(new THREE.PlaneGeometry(RIVER.halfWidth * 2, RIVER.maxZ - RIVER.minZ + 60)),
    std(0xffffff, { map: wtex, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.92 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(RIVER.x, 0.07, (RIVER.maxZ + RIVER.minZ) / 2);
  water.receiveShadow = true;
  scene.add(water);

  // Bridge: deck, ramps, rails and piers.
  const wood = std(0x7a5a3c, { roughness: 0.9 });
  const steel = std(0x6f767c, { roughness: 0.4, metalness: 0.6 });
  const deckLen = BRIDGE.halfLength * 2;
  const deckW = BRIDGE.halfWidth * 2;
  const deck = new THREE.Mesh(track(new THREE.BoxGeometry(deckLen - 6, 0.35, deckW)), wood);
  deck.position.set(BRIDGE.x, 0.55, BRIDGE.z);
  deck.castShadow = true;
  deck.receiveShadow = true;
  scene.add(deck);
  for (const side of [-1, 1]) {
    const ramp = new THREE.Mesh(track(new THREE.BoxGeometry(3.4, 0.3, deckW)), wood);
    ramp.position.set(BRIDGE.x + side * (deckLen / 2 - 1.5), 0.3, BRIDGE.z);
    ramp.rotation.z = side * 0.18;
    ramp.receiveShadow = true;
    scene.add(ramp);
    const rail = new THREE.Mesh(track(new THREE.BoxGeometry(deckLen - 6, 0.12, 0.12)), steel);
    rail.position.set(BRIDGE.x, 1.55, BRIDGE.z + side * (BRIDGE.halfWidth - 0.15));
    scene.add(rail);
    for (let i = -2; i <= 2; i++) {
      const post = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 1.0, 0.14)), steel);
      post.position.set(BRIDGE.x + i * ((deckLen - 7) / 4), 1.05, BRIDGE.z + side * (BRIDGE.halfWidth - 0.15));
      scene.add(post);
    }
    const pier = new THREE.Mesh(track(new THREE.CylinderGeometry(0.45, 0.6, 1.4, 8)), std(0x77726a, { roughness: 0.95 }));
    pier.position.set(BRIDGE.x + side * (RIVER.halfWidth - 1), 0.1, BRIDGE.z);
    scene.add(pier);
  }
  const limit = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: textTexture(`BRIDGE  ${BRIDGE.limit} T LIMIT`, "#e26a2c"), transparent: true, depthWrite: false, fog: false })));
  limit.position.set(BRIDGE.x + BRIDGE.halfLength + 3, 4.2, BRIDGE.z - BRIDGE.halfWidth - 1);
  limit.scale.set(6.4, 2.8, 1);
  scene.add(limit);

  // Mud: glossy dark patches that grow as the ground soaks. Flood zones fill with brown water.
  const mudMat = std(0x4a3a2a, { roughness: 0.35, metalness: 0.05, transparent: true, opacity: 0.9 });
  const floodMat = std(0x6b5a44, { roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0 });
  const circle = track(new THREE.CircleGeometry(1, 28));
  const mudMeshes = MUD_ZONES.map((z, i) => {
    const m = new THREE.Mesh(circle, z.flood ? floodMat : mudMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(z.x, 0.05 + i * 0.002, z.z);
    m.scale.set(z.rx, z.rz, 1);
    m.receiveShadow = true;
    scene.add(m);
    return { m, z };
  });

  // Valley cliffs on the west side (terraced, like the pit walls).
  buildPitWalls(scene, track, "cliff", { x: X0, z: 0 });

  // Rail loadout: tall hopper over a short spur of track.
  const loadout = PADS.find((p) => p.kind === "loadout");
  if (loadout) {
    const g = new THREE.Group();
    g.position.set(loadout.x + 8, 0, loadout.z);
    const leg = track(new THREE.BoxGeometry(0.4, 6, 0.4));
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const l = new THREE.Mesh(leg, steel);
      l.position.set(dx, 3, dz);
      l.castShadow = true;
      g.add(l);
    }
    const hop = new THREE.Mesh(track(new THREE.CylinderGeometry(3, 1, 3, 4)), std(0x8a6f3a, { roughness: 0.7, metalness: 0.2 }));
    hop.position.y = 7;
    hop.rotation.y = Math.PI / 4;
    hop.castShadow = true;
    g.add(hop);
    const railGeo = track(new THREE.BoxGeometry(0.15, 0.15, 60));
    for (const dx of [-0.8, 0.8]) {
      const r = new THREE.Mesh(railGeo, steel);
      r.position.set(dx, 0.1, 0);
      g.add(r);
    }
    const car = new THREE.Mesh(track(new THREE.BoxGeometry(3, 2.2, 8)), std(0x5b3b2c, { roughness: 0.8 }));
    car.position.set(0, 1.4, 9);
    car.castShadow = true;
    g.add(car);
    scene.add(g);
  }

  // Wash plant (only once it's bought): trommel drum, frame, chute and settling pond.
  const wash = new THREE.Group();
  wash.position.set(WASH_PLANT.x + 6, 0, WASH_PLANT.z - 6);
  const frame = std(0x2f5d73, { roughness: 0.55, metalness: 0.3 });
  const drum = new THREE.Mesh(track(new THREE.CylinderGeometry(1.4, 1.4, 6, 14, 1, true)), std(0x9aa3a8, { roughness: 0.35, metalness: 0.7, side: THREE.DoubleSide }));
  drum.rotation.z = Math.PI / 2 - 0.12;
  drum.position.set(0, 3.2, 0);
  drum.castShadow = true;
  wash.add(drum);
  for (const dx of [-2.6, 2.6]) {
    for (const dz of [-1.4, 1.4]) {
      const leg = new THREE.Mesh(track(new THREE.BoxGeometry(0.3, 3 + dx * 0.04, 0.3)), frame);
      leg.position.set(dx, 1.5, dz);
      wash.add(leg);
    }
  }
  const chute = new THREE.Mesh(track(new THREE.BoxGeometry(5, 0.3, 1.4)), frame);
  chute.position.set(-5, 2.2, 0);
  chute.rotation.z = 0.35;
  wash.add(chute);
  const hopper = new THREE.Mesh(track(new THREE.CylinderGeometry(2.4, 0.9, 2.2, 4)), frame);
  hopper.position.set(-7.8, 3.6, 0);
  hopper.rotation.y = Math.PI / 4;
  hopper.castShadow = true;
  wash.add(hopper);
  const pond = new THREE.Mesh(track(new THREE.CircleGeometry(4, 20)), std(0x6f7b6a, { roughness: 0.1, metalness: 0.3 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(4, 0.06, 5);
  wash.add(pond);
  wash.visible = false;
  scene.add(wash);

  // Camp marker where the lowboy drops machines.
  const campSign = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: textTexture("VALLEY CAMP", "#e6b325"), transparent: true, depthWrite: false, fog: false })));
  campSign.position.set(RIVER_CAMP.x, 6, RIVER_CAMP.z + 12);
  campSign.scale.set(7, 3, 1);
  scene.add(campSign);

  // Trees, scrub and boulders, kept off the river, mud, bridge and pads.
  const avoid = (x: number, z: number) =>
    Math.abs(x - RIVER.x) < RIVER.halfWidth + 6 ||
    MUD_ZONES.some((m) => ((x - m.x) / (m.rx + 3)) ** 2 + ((z - m.z) / (m.rz + 3)) ** 2 < 1) ||
    Math.hypot(x - RIVER_CAMP.x, z - RIVER_CAMP.z) < 22 ||
    Math.hypot(x - WASH_PLANT.x, z - WASH_PLANT.z) < 18 ||
    Math.abs(z - BRIDGE.z) < 9 ||
    Math.hypot(x - (X0 - 72), z) < 16;
  buildScatter(scene, track, [], rich, { cx: X0, bounds: RIVER_BOUNDS, avoid, seed: 311 });
  buildScatter(scene, track, [], rich, { cx: X0, bounds: RIVER_BOUNDS, avoid, seed: 977 });
  buildBackdrop(scene, track, X0, false, 0x7f7a5a);

  // Fence posts round the valley.
  const postGeo = track(new THREE.BoxGeometry(0.18, 1.3, 0.18));
  const posts: THREE.Matrix4[] = [];
  const B = RIVER_BOUNDS;
  for (let x = B.minX; x <= B.maxX; x += 10) {
    if (Math.abs(x - RIVER.x) < RIVER.halfWidth) continue;
    posts.push(new THREE.Matrix4().setPosition(x, 0.65, B.minZ), new THREE.Matrix4().setPosition(x, 0.65, B.maxZ));
  }
  for (let z = B.minZ + 10; z < B.maxZ; z += 10) posts.push(new THREE.Matrix4().setPosition(B.maxX, 0.65, z));
  const fence = new THREE.InstancedMesh(postGeo, std(0x6a5b48, { roughness: 0.9 }), posts.length);
  posts.forEach((p, i) => fence.setMatrixAt(i, p));
  scene.add(fence);

  // A few tufts of reeds along the water's edge (one merged mesh).
  const reeds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < (rich ? 70 : 40); i++) {
    const side = i % 2 ? 1 : -1;
    const z = RIVER.minZ + ((i * 53) % 140);
    if (Math.abs(z - BRIDGE.z) < 8) continue;
    const g = new THREE.ConeGeometry(0.35, 1.4 + (i % 4) * 0.25, 4);
    g.translate(RIVER.x + side * (RIVER.halfWidth + 0.6 + (i % 3) * 0.5), 0.7, z);
    g.deleteAttribute("uv");
    reeds.push(g.toNonIndexed());
    g.dispose();
  }
  const reedGeo = mergeGeometries(reeds, false);
  reeds.forEach((g) => g.dispose());
  if (reedGeo) {
    track(reedGeo);
    scene.add(new THREE.Mesh(reedGeo, std(0x6f7a3e, { roughness: 1, flatShading: true })));
  }

  let flow = 0;
  return {
    update(dt, wet, washPlant) {
      flow += dt;
      wtex.offset.y = (flow * 0.06) % 1;
      wash.visible = washPlant;
      if (washPlant) drum.rotation.x = (flow * 1.4) % (Math.PI * 2);
      for (const { m, z } of mudMeshes) {
        const grow = 1 + wet * (z.flood ? 0.5 : 0.6);
        m.scale.set(z.rx * grow, z.rz * grow, 1);
      }
      floodMat.opacity = Math.min(0.85, wet * 1.1);
      mudMat.opacity = 0.75 + wet * 0.2;
      mudMat.roughness = 0.45 - wet * 0.35;
    },
  };
}
