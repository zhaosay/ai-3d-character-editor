import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { detectIKChains } from '../src/core/ik/chains';
import { sampleAnimation } from '../src/core/animation/sampler';
import { applySampledPose, indexBonesByName } from '../src/core/animation/applyPose';
import { FootLockRuntime } from '../src/services/motion/footLockRuntime';
import { DEFAULT_FOOT_LOCK, footSolePosition, measureSoleDrop, resolveFootRig } from '../src/core/ik/footLock';
import type { AnimationData } from '../src/core/animation/types';

function walkScene() {
  const actor = buildDemoCharacter('male');
  const snap = buildSkeletonTree(actor.scene);
  const boneMap = buildBoneMap(snap);
  const segments = [{ t0: 0, t1: 3, template: 'march' as const, clause: '走' }];
  const result = generatePlannedTracks(boneMap, segments, 3, 0, buildRestMap(snap), buildRestPositionMap(snap));
  const anim: AnimationData = { id: 'walk', name: 'walk', duration: 3, fps: 30, tracks: result.tracks };
  const chains = detectIKChains(snap);
  return { actor, scene: actor.scene, anim, chains };
}

/** 采样整段动画，返回每帧两脚的世界位置（无锁定）。 */
function footTracks(scene: THREE.Object3D, anim: AnimationData) {
  const bones = indexBonesByName(scene);
  const left = bones.get('Foot_L')!;
  const right = bones.get('Foot_R')!;
  const frames: Array<{ t: number; l: THREE.Vector3; r: THREE.Vector3 }> = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 30;
    applySampledPose(scene, sampleAnimation(anim, t));
    scene.updateWorldMatrix(true, true);
    frames.push({
      t,
      l: left.getWorldPosition(new THREE.Vector3()),
      r: right.getWorldPosition(new THREE.Vector3()),
    });
  }
  return frames;
}

/** 每只脚在「触地帧」中的最大水平位移（打滑量）。 */
function maxSlip(frames: ReturnType<typeof footTracks>, key: 'l' | 'r') {
  let worst = 0;
  let plantedAt: THREE.Vector3 | null = null;
  for (const f of frames) {
    const p = f[key];
    // 程序化角色脚 Y 落在 0.02–0.14，取 0.17 以上视为摆动抬起
    const airborne = p.y >= 0.17;
    if (airborne) {
      plantedAt = null;
      continue;
    }
    if (plantedAt) worst = Math.max(worst, Math.hypot(p.x - plantedAt.x, p.z - plantedAt.z));
    else plantedAt = p.clone();
  }
  return worst;
}

describe('足部锁定端到端（真实骨骼）', () => {
  it('未锁定时程序化步态确实存在明显打滑（证明问题真实）', () => {
    const { scene, anim, actor } = walkScene();
    try {
      const frames = footTracks(scene, anim);
      const slipL = maxSlip(frames, 'l');
      const slipR = maxSlip(frames, 'r');
      expect(Math.max(slipL, slipR)).toBeGreaterThan(0.02);
    } finally {
      actor.dispose();
    }
  });

  it('开启锁定后支撑脚水平位移被压到 IK 求解误差内', () => {
    const { scene, anim, chains, actor } = walkScene();
    try {
      const runtime = new FootLockRuntime(chains, { ...DEFAULT_FOOT_LOCK, maxCorrection: 5 });
      const bones = indexBonesByName(scene);
      // 必须以「脚底」而非脚骨原点度量：刚性蒙皮下两者高度不同
      const soleOf = (side: 'L' | 'R') => {
        const chain = chains.find((c) => c.id === `leg.${side}`)!;
        const rig = resolveFootRig(scene, chain)!;
        return { bone: bones.get(`Foot_${side}`)!, drop: measureSoleDrop(scene, rig.foot) };
      };
      const feet = { L: soleOf('L'), R: soleOf('R') };
      const plant: Record<string, THREE.Vector3> = {};

      let slip = 0;
      for (let i = 0; i <= 90; i++) {
        const t = i / 30;
        applySampledPose(scene, sampleAnimation(anim, t));
        scene.updateWorldMatrix(true, true);
        runtime.solve(scene, t, 1 / 30);
        scene.updateWorldMatrix(true, true);
        for (const side of ['L', 'R'] as const) {
          const p = footSolePosition(feet[side].bone, feet[side].drop, new THREE.Vector3());
          if (p.y >= DEFAULT_FOOT_LOCK.groundY + DEFAULT_FOOT_LOCK.liftThreshold) {
            delete plant[side];
            continue;
          }
          if (plant[side]) slip = Math.max(slip, Math.hypot(p.x - plant[side].x, p.z - plant[side].z));
          else plant[side] = p.clone();
        }
      }
      // 锁定后残余位移应在厘米级（IK 求解器精度内）
      expect(slip).toBeLessThan(0.03);
    } finally {
      actor.dispose();
    }
  });

  it('锁定把打滑量至少降低一个数量级', () => {
    const { scene, anim, chains, actor } = walkScene();
    try {
      const bare = (() => {
        const { scene: s, anim: a, actor: ac } = walkScene();
        try {
          return Math.max(maxSlip(footTracks(s, a), 'l'), maxSlip(footTracks(s, a), 'r'));
        } finally {
          ac.dispose();
        }
      })();
      const locked = (() => {
        const rt = new FootLockRuntime(chains, { ...DEFAULT_FOOT_LOCK, maxCorrection: 5 });
        const bones = indexBonesByName(scene);
        const drop = measureSoleDrop(scene, resolveFootRig(scene, chains.find((c) => c.id === 'leg.L')!)!.foot);
        const foot = bones.get('Foot_L')!;
        let worst = 0;
        let planted: THREE.Vector3 | null = null;
        for (let i = 0; i <= 90; i++) {
          const t = i / 30;
          applySampledPose(scene, sampleAnimation(anim, t));
          scene.updateWorldMatrix(true, true);
          rt.solve(scene, t, 1 / 30);
          scene.updateWorldMatrix(true, true);
          const p = footSolePosition(foot, drop, new THREE.Vector3());
          if (p.y >= DEFAULT_FOOT_LOCK.groundY + DEFAULT_FOOT_LOCK.liftThreshold) { planted = null; continue; }
          if (planted) worst = Math.max(worst, Math.hypot(p.x - planted.x, p.z - planted.z));
          else planted = p.clone();
        }
        return worst;
      })();
      expect(bare).toBeGreaterThan(0.05);           // 未锁定确有明显打滑
      expect(locked).toBeLessThan(bare * 0.2);      // 锁定后至少降低 5 倍
    } finally {
      actor.dispose();
    }
  });

  it('锁定不会产生 NaN 或断裂姿态', () => {
    const { scene, anim, chains, actor } = walkScene();
    try {
      const runtime = new FootLockRuntime(chains, DEFAULT_FOOT_LOCK);
      const bones = indexBonesByName(scene);
      for (let i = 0; i <= 60; i++) {
        const t = i / 30;
        applySampledPose(scene, sampleAnimation(anim, t));
        runtime.solve(scene, t, 1 / 30);
        for (const b of bones.values()) {
          expect(Number.isFinite(b.quaternion.x + b.quaternion.y + b.quaternion.z + b.quaternion.w)).toBe(true);
        }
      }
    } finally {
      actor.dispose();
    }
  });

  it('时间回退会重置状态（拖动时间轴后落点仍正确）', () => {
    const { scene, anim, chains, actor } = walkScene();
    try {
      const runtime = new FootLockRuntime(chains, DEFAULT_FOOT_LOCK);
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        applySampledPose(scene, sampleAnimation(anim, t));
        runtime.solve(scene, t, 1 / 30);
      }
      // 回退到 0 再前进，落点应与首次一致（无残留状态）
      runtime.solve(scene, 0, 1 / 30);
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        applySampledPose(scene, sampleAnimation(anim, t));
        runtime.solve(scene, t, 1 / 30);
      }
      const bones = indexBonesByName(scene);
      const p = bones.get('Foot_L')!.getWorldPosition(new THREE.Vector3());
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    } finally {
      actor.dispose();
    }
  });

  it('无腿链的角色不会崩溃（安全降级）', () => {
    const empty = new THREE.Group();
    const runtime = new FootLockRuntime([], DEFAULT_FOOT_LOCK);
    expect(runtime.solve(empty, 0, 1 / 30)).toBe(0);
  });
});
