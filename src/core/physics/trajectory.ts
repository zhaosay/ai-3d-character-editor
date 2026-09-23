import * as THREE from 'three';
import type { AnimationData } from '../animation/types';
import { sampleAnimation } from '../animation/sampler';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import type { BoneNames, TrajSample } from './types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';

export interface Trajectory {
  samples: TrajSample[];
  warnings: string[];
}

/**
 * 在 live 场景上逐帧采样世界轨迹（REAL，本地运行）。
 * 采样前后恢复进入时的全部 local 姿势，不污染用户当前 pose。
 */
export function collectTrajectory(
  sceneObject: THREE.Object3D,
  anim: AnimationData,
  names: BoneNames,
  sampleFps = 30,
): Trajectory {
  const warnings: string[] = [];
  const bones = indexBonesByName(sceneObject);
  const hips = bones.get(names.hips);
  const footL = names.footL ? bones.get(names.footL) ?? null : null;
  const footR = names.footR ? bones.get(names.footR) ?? null : null;
  if (!hips) return { samples: [], warnings: ['hips 骨骼缺失，无法分析'] };
  if (!footL && !footR) warnings.push('未找到脚骨骼，仅分析重心');

  // 进入姿势快照
  const entry = new Map<string, { p: Vec3Tuple; q: QuatTuple }>();
  bones.forEach((b, name) => {
    entry.set(name, {
      p: [b.position.x, b.position.y, b.position.z],
      q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    });
  });

  const samples: TrajSample[] = [];
  try {
    const n = Math.max(2, Math.floor(anim.duration * sampleFps) + 1);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const t = Math.min((i * anim.duration) / (n - 1), anim.duration);
      try {
        applySampledPose(sceneObject, sampleAnimation(anim, t));
      } catch (e) {
        warnings.push(`采样 @${t.toFixed(2)}s 失败：${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      sceneObject.updateWorldMatrix(true, true);
      hips.getWorldPosition(v);
      const hipsY = v.y;
      const hipsLocal: Vec3Tuple = [hips.position.x, hips.position.y, hips.position.z];
      const read = (b: THREE.Bone | null): Vec3Tuple | null => {
        if (!b) return null;
        b.getWorldPosition(v);
        return [v.x, v.y, v.z];
      };
      samples.push({ time: t, hipsY, hipsLocal, feet: { L: read(footL), R: read(footR) } });
    }
  } finally {
    const live = indexBonesByName(sceneObject);
    entry.forEach((e, name) => {
      const b = live.get(name);
      if (b) {
        b.position.fromArray(e.p);
        b.quaternion.fromArray(e.q);
      }
    });
    sceneObject.updateWorldMatrix(true, true);
  }
  return { samples, warnings };
}
