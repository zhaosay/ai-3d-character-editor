import * as THREE from 'three';
import { sampleAnimation } from '../animation/sampler';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { applyIKChain } from '../ik/applyIK';
import type { IKChainDef } from '../ik/types';
import type { AnimationData } from '../animation/types';
import type { Interpolation } from '../animation/types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { JointLimit, PhysicsIssue, TrajSample } from './types';
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
  return samples.flatMap((s, idx) => near(s.time) ? [{
    boneName: hipsName,
    time: s.time,
    value: [s.hipsLocal[0], s.hipsLocal[1] + (smoothed[idx] - s.hipsY), s.hipsLocal[2]] as Vec3Tuple,
    interp: 'linear' as const,
  }] : []);
}

/** Shift the pelvis over its active foot supports and use leg IK to keep those feet pinned. */
export function buildBalanceCorrectionEntries(
  sceneObject: THREE.Object3D,
  anim: AnimationData,
  samples: TrajSample[],
  issue: PhysicsIssue,
  hipsName: string,
  chains: Partial<Record<'L' | 'R', { def: IKChainDef; polePoint: Vec3Tuple }>>,
  sampleFps = 30,
): { rot: PoseEntries['rot']; pos: PoseEntries['pos']; warnings: string[] } {
  const rot: PoseEntries['rot'] = [];
  const pos: PoseEntries['pos'] = [];
  const warnings: string[] = [];
  if (issue.kind !== 'balance') return { rot, pos, warnings };
  const relevant = samples.filter((sample) => sample.time >= issue.t0 - 1e-6 && sample.time <= issue.t1 + 1e-6);
  if (relevant.some((sample) => (sample.massCoverage ?? 1) < 0.55)) {
    return { rot, pos, warnings: ['重心骨骼覆盖率不足 55%，拒绝自动配平以避免错误改动'] };
  }
  const bones = indexBonesByName(sceneObject);
  const hips = bones.get(hipsName);
  if (!hips) return { rot, pos, warnings: ['hips 骨骼缺失，无法调整重心'] };
  const neededSides = new Set(relevant.flatMap((sample) => (['L', 'R'] as const).filter((side) => sample.feet[side] && sample.feet[side]![1] < 0.06)));
  if (neededSides.size === 0) return { rot, pos, warnings: ['问题时段没有可用的贴地脚支撑，无法自动配平'] };
  for (const side of neededSides) {
    const chain = chains[side];
    if (!chain || !bones.has(chain.def.rootBone) || !bones.has(chain.def.midBone) || !bones.has(chain.def.endBone)) {
      return { rot, pos, warnings: [`${side === 'L' ? '左' : '右'}腿 IK 链缺失，无法在保持脚底支撑时移动骨盆`] };
    }
  }

  const saved = new Map<string, { p: Vec3Tuple; q: QuatTuple; s: Vec3Tuple }>();
  bones.forEach((bone, name) => saved.set(name, {
    p: bone.position.toArray() as Vec3Tuple,
    q: bone.quaternion.toArray() as QuatTuple,
    s: bone.scale.toArray() as Vec3Tuple,
  }));
  const steps = Math.max(1, Math.round(sampleFps / 10));
  const filtered = relevant.filter((_, index) => index % steps === 0 || index === relevant.length - 1);
  try {
    for (const sample of filtered) {
      if (!sample.centerOfMass) continue;
      const supports = (['L', 'R'] as const).flatMap((side) => {
        const foot = sample.feet[side];
        return foot && foot[1] < 0.06 ? [foot] : [];
      });
      if (supports.length === 0) continue;

      const [cx, , cz] = sample.centerOfMass;
      let targetX: number; let targetZ: number;
      if (supports.length === 1) {
        targetX = supports[0][0]; targetZ = supports[0][2];
      } else {
        const [a, b] = supports;
        const dx = b[0] - a[0]; const dz = b[2] - a[2];
        const lengthSq = dx * dx + dz * dz;
        const along = lengthSq > 1e-8 ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cz - a[2]) * dz) / lengthSq)) : 0;
        targetX = a[0] + along * dx; targetZ = a[2] + along * dz;
      }
      const toX = targetX - cx; const toZ = targetZ - cz;
      const distance = Math.hypot(toX, toZ);
      if (distance <= 0.09) continue;
      const correction = Math.min(0.25, distance - 0.07);
      const deltaWorld = new THREE.Vector3(toX / distance * correction, 0, toZ / distance * correction);

      applySampledPose(sceneObject, sampleAnimation(anim, sample.time));
      sceneObject.updateWorldMatrix(true, true);
      const pins = new Map<'L' | 'R', Vec3Tuple>();
      for (const side of neededSides) {
        const foot = sample.feet[side];
        if (foot && foot[1] < 0.06) pins.set(side, foot);
      }
      const parent = hips.parent;
      const worldOrigin = hips.getWorldPosition(new THREE.Vector3());
      const inverseParent = parent ? parent.matrixWorld.clone().invert() : new THREE.Matrix4();
      const localOrigin = worldOrigin.clone().applyMatrix4(inverseParent);
      const localShifted = worldOrigin.clone().add(deltaWorld).applyMatrix4(inverseParent);
      hips.position.add(localShifted.sub(localOrigin));
      sceneObject.updateWorldMatrix(true, true);

      let solvedAll = true;
      for (const [side, pin] of pins) {
        const chain = chains[side]!;
        const solved = applyIKChain(bones, chain.def, pin, chain.polePoint);
        if (!solved) { solvedAll = false; continue; }
        if (!solved.reached) warnings.push(`${side === 'L' ? '左' : '右'}脚 @${sample.time.toFixed(2)}s 超出 IK 可达范围，配平近似不完整`);
        for (const name of [chain.def.rootBone, chain.def.midBone, chain.def.endBone]) {
          const bone = bones.get(name)!;
          rot.push({ boneName: name, time: sample.time, value: bone.quaternion.toArray() as QuatTuple, interp: 'linear' });
        }
      }
      if (!solvedAll) continue;
      pos.push({ boneName: hipsName, time: sample.time, value: hips.position.toArray() as Vec3Tuple, interp: 'linear' });
    }
  } finally {
    const live = indexBonesByName(sceneObject);
    saved.forEach((pose, name) => {
      const bone = live.get(name); if (!bone) return;
      bone.position.fromArray(pose.p); bone.quaternion.fromArray(pose.q); bone.scale.fromArray(pose.s);
    });
    sceneObject.updateWorldMatrix(true, true);
  }
  if (pos.length === 0) warnings.push('没有生成可用的髋部配平关键帧');
  return { rot, pos, warnings: [...new Set(warnings)] };
}

/** Clamp one animated joint to its preview threshold over the reported interval. */
export function buildJointLimitEntries(
  anim: AnimationData,
  issue: PhysicsIssue,
  limit: JointLimit,
  sampleFps = 30,
): PoseEntries['rot'] {
  if (issue.kind !== 'jointLimit' || issue.boneName !== limit.boneName || issue.limit !== limit.maxDegrees) return [];
  const track = anim.tracks.find((item) => item.boneName === issue.boneName);
  if (!track?.rotation.length) return [];
  const rest = new THREE.Quaternion(...limit.restQuaternion).normalize();
  const step = 1 / Math.max(sampleFps, 1);
  const start = Math.max(0, issue.t0 - step);
  const end = Math.min(anim.duration, issue.t1 + step);
  const count = Math.max(1, Math.ceil((end - start) * sampleFps));
  const entries: PoseEntries['rot'] = [];
  for (let i = 0; i <= count; i++) {
    const time = Math.min(i === count ? end : start + i / sampleFps, anim.duration);
    const currentTuple = sampleAnimation(anim, time).get(issue.boneName)?.quaternion;
    if (!currentTuple) continue;
    const current = new THREE.Quaternion(...currentTuple).normalize();
    const delta = rest.clone().invert().multiply(current).normalize();
    const angle = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(delta.w))));
    if (angle <= limit.maxDegrees) continue;
    const clamped = rest.clone().multiply(new THREE.Quaternion().identity().slerp(delta, limit.maxDegrees / angle)).normalize();
    entries.push({
      boneName: issue.boneName,
      time,
      value: [clamped.x, clamped.y, clamped.z, clamped.w],
      interp: 'linear',
    });
  }
  return entries;
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

  const entry = new Map<string, { position: Vec3Tuple; quaternion: QuatTuple; scale: Vec3Tuple }>();
  bones.forEach((b, name) => {
    entry.set(name, {
      position: [b.position.x, b.position.y, b.position.z],
      quaternion: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
      scale: [b.scale.x, b.scale.y, b.scale.z],
    });
  });

  try {
    // 接触点：段内脚位置 xz 均值，y 钳制贴地
    const seg: TrajSample[] = [];
    const n = Math.max(2, Math.floor((issue.t1 - issue.t0) * sampleFps) + 1);
    for (let i = 0; i < n; i++) {
      const t = issue.t0 + ((issue.t1 - issue.t0) * i) / Math.max(n - 1, 1);
      try {
        applySampledPose(sceneObject, sampleAnimation(anim, t));
      } catch {
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
    entry.forEach((pose, name) => {
      const b = live.get(name);
      if (b) {
        b.position.fromArray(pose.position);
        b.quaternion.fromArray(pose.quaternion);
        b.scale.fromArray(pose.scale);
      }
    });
    sceneObject.updateWorldMatrix(true, true);
  }
  return { entries, warnings };
}
