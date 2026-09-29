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

const MAX_SAMPLE_FPS = 240;
const MAX_TRAJECTORY_SAMPLES = 100_000;
const MASS_WEIGHTS: Record<string, number> = {
  hips: 0.14, spine: 0.2, chest: 0.15, neck: 0.02, head: 0.08,
  'shoulder.L': 0.01, 'shoulder.R': 0.01,
  'upperArm.L': 0.03, 'upperArm.R': 0.03, 'forearm.L': 0.02, 'forearm.R': 0.02,
  'hand.L': 0.01, 'hand.R': 0.01, 'thigh.L': 0.1, 'thigh.R': 0.1,
  'shin.L': 0.045, 'shin.R': 0.045, 'foot.L': 0.015, 'foot.R': 0.015,
};
const EXPECTED_MASS_WEIGHT = Object.values(MASS_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

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
  if (!Number.isFinite(sampleFps) || sampleFps < 1 || sampleFps > MAX_SAMPLE_FPS) {
    return { samples: [], warnings: [`轨迹分析采样帧率必须在 1–${MAX_SAMPLE_FPS} FPS 之间`] };
  }
  if (!Number.isFinite(anim.duration) || anim.duration <= 0) {
    return { samples: [], warnings: ['动画时长无效，无法采样物理轨迹'] };
  }
  const sampleCount = Math.max(2, Math.floor(anim.duration * sampleFps) + 1);
  if (!Number.isSafeInteger(sampleCount) || sampleCount > MAX_TRAJECTORY_SAMPLES) {
    return { samples: [], warnings: [`轨迹分析需要 ${sampleCount} 个采样点，超过上限 ${MAX_TRAJECTORY_SAMPLES}；请缩短动画或降低采样帧率`] };
  }
  const bones = indexBonesByName(sceneObject);
  const hips = bones.get(names.hips);
  const footL = names.footL ? bones.get(names.footL) ?? null : null;
  const footR = names.footR ? bones.get(names.footR) ?? null : null;
  const massBones = Object.entries(names.massBones ?? {}).flatMap(([semantic, name]) => {
    const bone = name ? bones.get(name) : undefined;
    return bone ? [{ semantic, bone }] : [];
  });
  const mappedMassWeight = massBones.reduce((sum, item) => sum + (MASS_WEIGHTS[item.semantic] ?? 0), 0);
  const massCoverage = mappedMassWeight / EXPECTED_MASS_WEIGHT;
  const jointBones = (names.jointLimits ?? []).flatMap((limit) => {
    const bone = bones.get(limit.boneName);
    return bone ? [{ ...limit, bone }] : [];
  });
  if (!hips) return { samples: [], warnings: ['hips 骨骼缺失，无法分析'] };
  if (!footL && !footR) warnings.push('未找到脚骨骼，仅分析重心');
  if (massBones.length === 0) warnings.push('未映射可用于重心估算的人体骨骼，失衡分析不可用');
  else if (massCoverage < 0.8) warnings.push(`重心估算仅覆盖约 ${Math.round(massCoverage * 100)}% 的预期身体质量骨骼；低覆盖度时将跳过失衡判定`);

  // 进入姿势快照
  const entry = new Map<string, { p: Vec3Tuple; q: QuatTuple; s: Vec3Tuple }>();
  bones.forEach((b, name) => {
    entry.set(name, {
      p: [b.position.x, b.position.y, b.position.z],
      q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
      s: [b.scale.x, b.scale.y, b.scale.z],
    });
  });

  const samples: TrajSample[] = [];
  const massPosition = new THREE.Vector3();
  const footAxis = new THREE.Vector3();
  const footQuaternion = new THREE.Quaternion();
  try {
    const n = sampleCount;
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
      const readFootForward = (bone: THREE.Bone | null): [number, number] | undefined => {
        if (!bone) return undefined;
        bone.getWorldQuaternion(footQuaternion);
        footAxis.set(0, 0, 1).applyQuaternion(footQuaternion);
        const horizontalLength = Math.hypot(footAxis.x, footAxis.z);
        return horizontalLength > 1e-6
          ? [footAxis.x / horizontalLength, footAxis.z / horizontalLength]
          : [0, 1];
      };
      const footForward = {
        ...(footL ? { L: readFootForward(footL)! } : {}),
        ...(footR ? { R: readFootForward(footR)! } : {}),
      };
      let centerOfMass: Vec3Tuple | undefined;
      if (massBones.length > 0) {
        const weighted = new THREE.Vector3();
        for (const item of massBones) {
          item.bone.getWorldPosition(massPosition);
          weighted.addScaledVector(massPosition, (MASS_WEIGHTS[item.semantic] ?? 0) / mappedMassWeight);
        }
        centerOfMass = [weighted.x, weighted.y, weighted.z];
      }
      const jointAngles: Record<string, number> = {};
      for (const joint of jointBones) {
        const rest = new THREE.Quaternion(...joint.restQuaternion).normalize();
        const current = joint.bone.quaternion.clone().normalize();
        const delta = rest.invert().multiply(current).normalize();
        jointAngles[joint.boneName] = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(delta.w))));
      }
      samples.push({ time: t, hipsY, hipsLocal, feet: { L: read(footL), R: read(footR) }, footForward, centerOfMass, massCoverage, jointAngles });
    }
  } finally {
    const live = indexBonesByName(sceneObject);
    entry.forEach((e, name) => {
      const b = live.get(name);
      if (b) {
        b.position.fromArray(e.p);
        b.quaternion.fromArray(e.q);
        b.scale.fromArray(e.s);
      }
    });
    sceneObject.updateWorldMatrix(true, true);
  }
  return { samples, warnings };
}
