import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import type { SkeletonSnapshot } from '../src/core/skeleton/types';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { indexBonesByName } from '../src/core/animation/applyPose';
import { resolveBedInteractionFrame } from '../src/core/previs/world';
import { measureLegChain } from '../src/core/ik/sitPose';
import { supineContactOffset } from '../src/core/ik/restContact';
import type { StageProp } from '../src/core/previs/world';

/**
 * 床上躺卧（lie/sleep）的**多点接触**量化验收。
 *
 * 现状（修复前实测，床 size.height=0.5、床面 y=0.5）：
 *   背 悬空 37.1cm、头 悬空 103.7cm、腿 穿插 −49.7cm
 * 也就是身体虽然转成了水平躺姿，但整条身体既没落到床面上、腿又穿过床板到地面。
 *
 * 本文件用「绑定网格最低顶点」测量（不是骨原点），与 collision.ts 的口径一致。
 */

const BED: StageProp = {
  id: 'bed-main', kind: 'bed', position: [0, 0, 0], rotationY: 0,
  size: { width: 1.0, height: 0.5, length: 2.0 },
};

interface Groups { [group: string]: string[] }

const GROUPS: Groups = {
  back: ['Hips', 'Spine'],
  head: ['Head'],
  legs: ['Thigh_L', 'Thigh_R', 'Shin_L', 'Shin_R', 'Foot_L', 'Foot_R'],
};

/** 应用终帧轨道到骨架（position 轨道是绝对局部位置，直接 set）。 */
function applyFinalPose(scene: THREE.Object3D, tracks: Array<{ boneName: string; rotation?: Array<{ value: number[] }>; position?: Array<{ value: number[] }> }>) {
  const bones = indexBonesByName(scene);
  for (const t of tracks) {
    const b = bones.get(t.boneName);
    if (!b) continue;
    const r = t.rotation?.at(-1);
    if (r && r.value.length === 4) b.quaternion.set(r.value[0], r.value[1], r.value[2], r.value[3]);
    const p = t.position?.at(-1);
    if (p && p.value.length === 3) b.position.set(p.value[0], p.value[1], p.value[2]);
  }
  scene.updateWorldMatrix(true, true);
  return bones;
}

/** 按 skinIndex 找真正绑定到指定骨骼的顶点，返回各组的世界最低 Y。 */
function lowestByBinding(scene: THREE.Object3D, groups: Groups): Record<string, number> {
  let skel: THREE.Skeleton | null = null;
  scene.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && !skel) skel = m.skeleton; });
  const order = (skel?.bones ?? []).map((b) => b.name);
  const wanted = new Map<string, string>();
  for (const [group, names] of Object.entries(groups)) for (const n of names) wanted.set(n, group);
  const out: Record<string, number> = {};
  for (const g of Object.keys(groups)) out[g] = Infinity;
  const v = new THREE.Vector3();
  scene.updateWorldMatrix(true, true);
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const si = m.geometry.getAttribute('skinIndex');
    const sw = m.geometry.getAttribute('skinWeight');
    const p = m.geometry.getAttribute('position');
    if (!si || !sw || !p) return;
    m.updateWorldMatrix(true, false);
    for (let i = 0; i < p.count; i++) {
      let best = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getX(i, k);
        if (w > bw) { bw = w; best = si.getX(i, k); }
      }
      const group = wanted.get(order[best]);
      if (!group) continue;
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      if (v.y < out[group]) out[group] = v.y;
    }
  });
  return out;
}

/**
 * 蒙皮顶点的世界最低 Y。
 *
 * 关键：SkinnedMesh 的 CPU 端 `matrixWorld` **不含骨骼变换**（Three.js 在顶点
 * 着色器里做蒙皮），直接用 matrixWorld 量顶点会得到完全错误的结果
 * （早期据此测出的「背悬空 37cm / 腿穿插 50cm」是测量假象，不是真缺陷）。
 * 这里手工做 skinMatrix = Σ w_k · bone_k.matrixWorld 才是真值。
 */
function skinnedLowest(scene: THREE.Object3D, groups: Groups): Record<string, number> {
  let skel: THREE.Skeleton | null = null;
  scene.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && !skel) skel = m.skeleton; });
  const bones = skel?.bones ?? [];
  const wanted = new Map<string, string>();
  for (const [g, ns] of Object.entries(groups)) for (const n of ns) wanted.set(n, g);
  const out: Record<string, number> = {};
  for (const g of Object.keys(groups)) out[g] = Infinity;
  scene.updateWorldMatrix(true, true);
  const skinMat = new THREE.Matrix4();
  const invBind = new THREE.Matrix4();
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton) return;
    const si = m.geometry.getAttribute('skinIndex');
    const sw = m.geometry.getAttribute('skinWeight');
    const p = m.geometry.getAttribute('position');
    if (!si || !sw || !p) return;
    invBind.copy(m.bindMatrix).invert();
    for (let i = 0; i < p.count; i++) {
      let best = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getX(i, k);
        if (w > bw) { bw = w; best = si.getX(i, k); }
      }
      const group = wanted.get(bones[best]?.name ?? '');
      if (!group) continue;
      const e = skinMat.elements;
      e.fill(0);
      for (let k = 0; k < 4; k++) {
        const bi = si.getX(i, k);
        const w = sw.getX(i, k);
        if (w <= 0 || !bones[bi]) continue;
        const be = bones[bi].matrixWorld.elements;
        for (let c = 0; c < 16; c++) e[c] += be[c] * w;
      }
      v.fromBufferAttribute(p, i).applyMatrix4(skinMat).applyMatrix4(invBind);
      if (v.y < out[group]) out[group] = v.y;
    }
  });
  return out;
}

function bedScene(): { scene: THREE.Group; snapshot: SkeletonSnapshot } {
  const { scene } = buildDemoCharacter('male');
  return { scene, snapshot: buildSkeletonTree(scene) };
}

function lieOnBed(bed: StageProp = BED) {
  const { scene, snapshot } = bedScene();
  const chain = measureLegChain(snapshot, 'L', scene);
  const frame = resolveBedInteractionFrame(bed, scene, snapshot, [bed])!;
  const res = generatePlannedTracks(
    buildBoneMap({ nodes: Object.values(snapshot.nodes) } as never),
    [{ t0: 0, t1: 3, template: 'lie', clause: '躺到床上' }, { t0: 3, t1: 6, template: 'sleep', clause: '睡觉' }],
    6, 0, buildRestMap(snapshot), buildRestPositionMap(snapshot),
    frame, {}, {}, 0, undefined, chain,
  );
  applyFinalPose(scene, res.tracks as never);
  return { scene, res, frame, chain, mattressY: bed.position[1] + bed.size.height };
}

describe('床上躺卧：多点接触（量化）', () => {
  it('背部落在床面上（误差 < 3cm）', () => {
    const { scene, mattressY } = lieOnBed();
    const low = skinnedLowest(scene, GROUPS);
    expect(low.back - mattressY, `背部相对床面 ${((low.back - mattressY) * 100).toFixed(1)}cm`).toBeLessThan(0.03);
    expect(low.back - mattressY).toBeGreaterThan(-0.03);
  });

  it('头部不插进床板（颅顶可高于床面）', () => {
    const { scene, mattressY } = lieOnBed();
    const low = skinnedLowest(scene, GROUPS);
    // 仰卧中立位：颅顶本来就比背高几厘米（实测 +5cm），不该被压到床面以下。
    // 修复前是 −19cm（下颌埋进床板）。
    expect(low.head - mattressY, `头部相对床面 ${((low.head - mattressY) * 100).toFixed(1)}cm`).toBeGreaterThan(-0.03);
    expect(low.head - mattressY, `头部相对床面 ${((low.head - mattressY) * 100).toFixed(1)}cm`).toBeLessThan(0.10);
  });

  it('腿部不下垂穿过床板（踝部可略低于床面）', () => {
    const { scene, mattressY } = lieOnBed();
    const low = skinnedLowest(scene, GROUPS);
    // 直腿时踝比背低约 6cm，悬在床沿是正常的；绝不能像修复前那样
    // 掉到地面（−49.7cm）。
    const off = low.legs - mattressY;
    expect(off, `腿部相对床面 ${(off * 100).toFixed(1)}cm`).toBeGreaterThan(-0.12);
    expect(off, `腿部相对床面 ${(off * 100).toFixed(1)}cm`).toBeLessThan(0.10);
  });

  it('床面高度变化时接触关系仍成立', () => {
    for (const h of [0.35, 0.5, 0.62]) {
      const bed: StageProp = { ...BED, size: { ...BED.size, height: h } };
      const { scene, mattressY } = lieOnBed(bed);
      const low = skinnedLowest(scene, GROUPS);
      expect(Math.abs(low.back - mattressY), `床高 ${h}m 背部偏差 ${((low.back - mattressY) * 100).toFixed(1)}cm`)
        .toBeLessThan(0.04);
    }
  });
});

;

;

;

;
