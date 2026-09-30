import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { retargetClip } from '../src/services/motion/motionRetarget';
import { buildSourceBoneMap, diagnoseMotionBind } from '../src/services/motion/motionLibrary';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { buildBoneMap } from '../src/services/motion/procedural';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'public/samples/motions/humanoid-v1.json'), 'utf8'));

async function loadSource() {
  const file = pkg.package.files[0];
  const bin = Buffer.from(file.data, 'base64');
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) => {
    new GLTFLoader().parse(ab, '', (g) => res(g as never), (e) => rej(e instanceof Error ? e : new Error(String(e))));
  });
}

describe('内置真人动作库 retarget', () => {
  it('10 个 clip 全部可解析，且时长与 manifest 一致', async () => {
    const { animations } = await loadSource();
    expect(animations).toHaveLength(10);
    for (const a of animations) {
      expect(a.duration).toBeGreaterThan(0.5);
      expect(a.tracks.length).toBeGreaterThan(20);
    }
  }, 60_000);

  it('源骨架的 11 个必需语义全部可绑定', async () => {
    const { scene } = await loadSource();
    const bones: THREE.Bone[] = [];
    scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
    const report = diagnoseMotionBind(buildSourceBoneMap(bones.map((b) => ({ name: b.name }))));
    expect(report.missing).toEqual([]);
  }, 60_000);

  it('retarget 到程序化角色：产生旋转轨道、四元数合法、时长正确', async () => {
    const { scene, animations } = await loadSource();
    const walk = animations.find((a) => a.name === '行走') ?? animations[2];
    const actor = buildDemoCharacter('male');
    try {
      const snap = buildSkeletonTree(actor.scene);
      const result = retargetClip({
        clip: walk,
        sourceScene: scene,
        targetRoot: actor.scene,
        targetBoneMap: buildBoneMap(snap),
        fps: 30,
      });
      expect(result.missing).toEqual([]);
      expect(result.animation.tracks.length).toBeGreaterThanOrEqual(10);
      expect(result.animation.duration).toBeCloseTo(walk.duration, 3);
      for (const track of result.animation.tracks) {
        expect(track.rotation.length).toBeGreaterThan(5);
        for (const k of track.rotation) {
          for (const v of k.value) expect(Number.isFinite(v)).toBe(true);
          // 四元数应归一
          const len = Math.hypot(...k.value);
          expect(len).toBeCloseTo(1, 3);
        }
        // 时间单调递增
        for (let i = 1; i < track.rotation.length; i++) {
          expect(track.rotation[i].time).toBeGreaterThan(track.rotation[i - 1].time);
        }
      }
    } finally {
      actor.dispose();
    }
  }, 60_000);

  it('缺失目标骨骼时如实警告而不是崩溃', async () => {
    const { scene, animations } = await loadSource();
    const actor = buildDemoCharacter('male');
    try {
      const result = retargetClip({
        clip: animations[0],
        sourceScene: scene,
        targetRoot: actor.scene,
        targetBoneMap: { hips: 'Hips', 'thigh.L': '不存在的骨' },
        fps: 30,
      });
      expect(result.warnings.some((w) => w.includes('不存在的骨'))).toBe(true);
      expect(result.animation.tracks.length).toBe(1);
    } finally {
      actor.dispose();
    }
  }, 60_000);

  it('retarget 结果能驱动目标角色骨骼（应用到 pose 后无 NaN）', async () => {
    const { scene, animations } = await loadSource();
    const walk = animations.find((a) => a.name === '行走') ?? animations[2];
    const actor = buildDemoCharacter('male');
    try {
      const snap = buildSkeletonTree(actor.scene);
      const { animation } = retargetClip({
        clip: walk, sourceScene: scene, targetRoot: actor.scene,
        targetBoneMap: buildBoneMap(snap), fps: 30,
      });
      const bones = new Map<string, THREE.Bone>();
      actor.scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone); });
      for (const track of animation.tracks) {
        const bone = bones.get(track.boneName);
        expect(bone, `找不到骨 ${track.boneName}`).toBeDefined();
        const mid = track.rotation[Math.floor(track.rotation.length / 2)];
        bone!.quaternion.set(...mid.value);
      }
      actor.scene.updateMatrixWorld(true);
      for (const b of bones.values()) {
        const q = b.quaternion;
        expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
        const p = b.position;
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      }
      // 骨盆仍在合理高度（源是 1m 白模，我们不搬位移）
      const hips = bones.get('Hips')!;
      expect(hips.position.y).toBeGreaterThan(0.5);
    } finally {
      actor.dispose();
    }
  }, 60_000);
});
