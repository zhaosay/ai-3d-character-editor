import * as THREE from 'three';
import { sampleAnimation } from '../animation/sampler';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { applyIKChain } from '../ik/applyIK';
import type { IKChainDef } from '../ik/types';
import type { AnimationData } from '../animation/types';
import type { Interpolation } from '../animation/types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { PhysicsIssue, TrajSample } from './types';
import { smoothHipsY } from './analyze';

export interface PoseEntries {
  rot: Array<{ boneName: string; time: number; value: QuatTuple; interp: Interpolation }>;
  pos: Array<{ boneName: string; time: number; value: Vec3Tuple; interp: Interpolation }>;
}

/** 穿透修复：髋部 position 在穿透段采样点整体上抬（深度 + 5mm 余量）。 */
export function buildHipsLiftEntries(
  samples: TrajSample[],
  issues: PhysicsIssue[],
  hipsName: string,
): PoseEntries['pos'] {
  const pens = issues.filter((i) => i.kind === 'penetration');
  if (pens.length === 0) return [];
  const lift = Math.max(...pens.map((i) => i.value)) + 0.005;
  const inSeg = (t: number) => pens.some((i) => t >= i.t0 - 1e-6 && t <= i.t1 + 1e-6);
  return samples
    .filter((s) => inSeg(s.time))
    .map((s) => ({
      boneName: hipsName,
      time: s.time,
      value: [s.hipsLocal[0], s.hipsLocal[1] + lift, s.hipsLocal[2]] as Vec3Tuple,
      interp: 'linear' as const,
    }));
}

/** 落地缓冲：突变点邻域髋部高度滑动平均，回写 position keys。 */
export function buildSmoothedHipsEntries(
  samples: TrajSample[],
  issues: PhysicsIssue[],
  hipsName: string,
  radius = 0.25,
): PoseEntries['pos'] {
  const spikes = issues.filter((i) => i.kind === 'accelSpike');
  if (spikes.length === 0) return [];
  const smoothed = smoothHipsY(samples, 5);
  const near = (t: number) => spikes.some((i) => Math.abs(t - i.t0) <= radius);
  return samples
    .filter((s) => near(s.time))
    .map((s, k, arr) => {
      void k;
      void arr;
      const idx = samples.indexOf(s);
      return {
        boneName: hipsName,
        time: s.time,
        value: [s.hipsLocal[0], s.hipsLocal[1] + (smoothed[idx] - s.hipsY), s.hipsLocal[2]] as Vec3Tuple,
        interp: 'linear' as const,
      };
    });
}

/**
 * 脚滑修复（脚锁）：接触段内逐采样用腿 IK 把脚钉在接触点，回写整链 rotation。
 * 会临时驱动 live 场景，结束后恢复进入姿势。
 */
export function buildFootLockEntries(
  sceneObject: THREE.Object3D,
  anim: AnimationData,
  issue: PhysicsIssue,
  chainDef: IKChainDef,
  polePoint: Vec3Tuple,
  sampleFps = 30,
): { entries: PoseEntries['rot']; warnings: string[] } {
  const warnings: string[] = [];
  const entries: PoseEntries['rot'] = [];
  const bones = indexBonesByName(sceneObject);
  const root = bones.get(chainDef.rootBone);
  const mid = bones.get(chainDef.midBone);
  const end = bones.get(chainDef.endBone);
  if (!root || !mid || !end) return { entries, warnings: [`${chainDef.id} 骨骼缺失`] };

  const entry = new Map<string, QuatTuple>();
  bones.forEach((b, name) => {
    entry.set(name, [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
  });

  try {
    // 接触点：段内脚位置 xz 均值，y 钳制贴地
    const seg: TrajSample[] = [];
    const n = Math.max(2, Math.floor((issue.t1 - issue.t0) * sampleFps) + 1);
    for (let i = 0; i < n; i++) {
      const t = issue.t0 + ((issue.t1 - issue.t0) * i) / Math.max(n - 1, 1);
      try {
        applySampledPose(sceneObject, sampleAnimation(anim, t));
      } catch (e) {
        warnings.push(`采样 @${t.toFixed(2)}s 失败，已跳过`);
        continue;
      }
      sceneObject.updateWorldMatrix(true, true);
      const v = new THREE.Vector3();
      end.getWorldPosition(v);
      seg.push({
        time: t,
        hipsY: 0,
        hipsLocal: [0, 0, 0],
        feet: { L: [v.x, v.y, v.z], R: null },
      });
    }
    if (seg.length === 0) return { entries, warnings };
    const cx = seg.reduce((s, x) => s + x.feet.L![0], 0) / seg.length;
    const cz = seg.reduce((s, x) => s + x.feet.L![2], 0) / seg.length;
    const cy = Math.min(Math.max(seg.reduce((s, x) => s + x.feet.L![1], 0) / seg.length, -0.005), 0.05);
    const pin: Vec3Tuple = [cx, cy, cz];

    for (const s of seg) {
      try {
        applySampledPose(sceneObject, sampleAnimation(anim, s.time));
      } catch {
        continue;
      }
      sceneObject.updateWorldMatrix(true, true);
      const r = applyIKChain(bones, chainDef, pin, polePoint);
      if (!r) {
        warnings.push(`@${s.time.toFixed(2)}s IK 求解失败`);
        continue;
      }
      for (const b of [root, mid, end]) {
        entries.push({
          boneName: b.name,
          time: s.time,
          value: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
          interp: 'linear',
        });
      }
      if (!r.reached) warnings.push(`@${s.time.toFixed(2)}s 钉点不可达，已用最近可达点`);
    }
  } finally {
    const live = indexBonesByName(sceneObject);
    entry.forEach((q, name) => {
      const b = live.get(name);
      if (b) b.quaternion.fromArray(q);
    });
    sceneObject.updateWorldMatrix(true, true);
  }
  return { entries, warnings };
}
