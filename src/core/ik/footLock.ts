import * as THREE from 'three';
import { indexBonesByName } from '../animation/applyPose';
import { defaultPoleDir } from './twoBoneIK';
import type { IKChainDef } from './types';
import type { Vec3Tuple } from '../../types/global';

/**
 * 足部锁定（Foot Lock）：消除程序化步态的「脚打滑」。
 *
 * 原理（源自 CMU mocap 与解析式步态的通行做法）：
 * 支撑相（脚触地）内，脚应钉在世界空间的固定点，而非随身体平移。
 * 身体前进时支撑脚不动 → 一旦发现水平位移，就用两骨 IK 把脚拉回落点。
 *
 * 状态机：
 *   - 触地且此前离地 → 记录新落点（plant）
 *   - 持续触地     → 锁定该落点，逐帧 IK 补偿
 *   - 抬起         → 释放锁定
 */

export type FootSide = 'L' | 'R';

export interface FootLockConfig {
  /** 地面高度（世界 Y），低于此值视为穿透，脚会被拉回地面 */
  groundY: number;
  /** 触地判定容差（脚底低于此值即认为触地） */
  contactTolerance: number;
  /** 抬起判定：脚底高于 地面 + 此值即认为离地 */
  liftThreshold: number;
  /** 最大可 IK 补偿的水平位移（米）；超出说明身体走太远，放弃锁定避免腿部扭曲 */
  maxCorrection: number;
  /** 落点吸附容差：水平移动小于此值视为同一落点（吸收数值抖动） */
  plantTolerance: number;
  /** 极向量（膝盖朝向），null 时由几何推断 */
  poleHint?: Vec3Tuple;
}

export const DEFAULT_FOOT_LOCK: FootLockConfig = {
  groundY: 0,
  contactTolerance: 0.045,
  liftThreshold: 0.06,
  maxCorrection: 0.42,
  plantTolerance: 0.02,
};

export interface FootState {
  side: FootSide;
  /** 是否处于支撑相（脚触地） */
  planted: boolean;
  /** 锁定中的世界落点 */
  anchor: Vec3Tuple | null;
  /** 本帧为对齐落点而施加的水平位移（米，XZ 平面） */
  correction: number;
  /** 因超出 maxCorrection 而放弃锁定的次数（诊断用） */
  abandoned: number;
}

function emptyState(side: FootSide): FootState {
  return { side, planted: false, anchor: null, correction: 0, abandoned: 0 };
}

export function createFootLockStates(sides: FootSide[] = ['L', 'R']): Map<FootSide, FootState> {
  return new Map(sides.map((s) => [s, emptyState(s)]));
}

/** 脚底世界位置：用末端骨（foot）世界位置近似，减去骨骼到脚底的高度偏移由调用方给出。 */
export interface FootSample {
  /** 脚底世界位置 */
  pos: THREE.Vector3;
}

/**
 * 更新单脚的锁定状态。
 * @param current 脚底当前世界位置
 * @param velocity 该脚的水平速度（米/秒），用于识别异常跳变
 */
export function updateFootState(
  state: FootState,
  current: THREE.Vector3,
  cfg: FootLockConfig,
  velocity = 0,
): FootState {
  const footY = current.y;
  const airborne = footY >= cfg.groundY + cfg.liftThreshold;

  if (airborne) {
    // 离地：释放锁定
    if (state.planted) return { ...state, planted: false, anchor: null, correction: 0 };
    return { ...state, correction: 0 };
  }

  if (!state.planted) {
    // 触地（刚落地或初始就站在地上）：记录落点
    // 速度过大说明这是采样跳变（如切换角色/时间跳变），仍记录但下帧再校正
    return {
      ...state,
      planted: true,
      anchor: [current.x, cfg.groundY, current.z] as Vec3Tuple,
      correction: 0,
    };
  }

  // 支撑相内：保持原落点
  if (!state.anchor) {
    return { ...state, planted: true, anchor: [current.x, cfg.groundY, current.z] as Vec3Tuple, correction: 0 };
  }

  const dx = state.anchor[0] - current.x;
  const dz = state.anchor[2] - current.z;
  const dist = Math.hypot(dx, dz);
  if (dist > cfg.maxCorrection) {
    // 身体走得太远，IK 追不上（否则腿会被拉成奇怪角度）：放弃本落点，重新记录
    return {
      ...state,
      anchor: [current.x, cfg.groundY, current.z] as Vec3Tuple,
      correction: 0,
      abandoned: state.abandoned + 1,
    };
  }
  // 速度异常大时也重置落点（时间跳变保护）
  if (velocity > 6) {
    return { ...state, anchor: [current.x, cfg.groundY, current.z] as Vec3Tuple, correction: 0 };
  }
  return { ...state, correction: dist };
}

/** 锁定目标：把脚底世界位置校正回落点，并贴到地面。漂移在容差内返回 null（不干预）。 */
export function lockedTarget(state: FootState, cfg: FootLockConfig): Vec3Tuple | null {
  if (!state.planted || !state.anchor || state.correction <= cfg.plantTolerance) return null;
  return [state.anchor[0], cfg.groundY, state.anchor[2]] as Vec3Tuple;
}

export interface FootLockRig {
  thigh: THREE.Bone;
  shin: THREE.Bone;
  foot: THREE.Bone;
}

/** 由骨骼名映射取出腿链。 */
export function resolveFootRig(root: THREE.Object3D, chain: IKChainDef): FootLockRig | null {
  const bones = indexBonesByName(root);
  const thigh = bones.get(chain.rootBone);
  const shin = bones.get(chain.midBone);
  const foot = bones.get(chain.endBone);
  if (!thigh || !shin || !foot) return null;
  return { thigh, shin, foot };
}

/**
 * 脚底世界位置：foot 骨原点沿局部 -Y 下移 soleDrop。
 *
 * soleDrop 必须按骨架实测：不同资产的脚骨原点位置差异很大
 * （有的在踝、有的在脚跟、有的已接近脚底）。用「小腿上最下端顶点
 * 相对脚骨的高度差」测量，比任何硬编码常数都可靠。
 */
export function footSolePosition(foot: THREE.Bone, soleDrop: number, out = new THREE.Vector3()): THREE.Vector3 {
  foot.getWorldPosition(out);
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()));
  return out.addScaledVector(down, soleDrop);
}

/**
 * 实测脚底偏移：找出**绑定到 foot 骨骼**的蒙皮网格（刚性蒙皮下网格是场景
 * 的兄弟节点而非骨骼子节点，必须查 skinIndex，不能 traverse 骨骼），
 * 取这些网格世界顶点相对脚骨原点的最低 Y。
 * 结果缓存到 userData，避免每帧重扫顶点。
 */
export function measureSoleDrop(root: THREE.Object3D, foot: THREE.Bone): number {
  const cached = foot.userData['soleDrop'] as number | undefined;
  if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  const origin = foot.getWorldPosition(new THREE.Vector3());
  let minY = 0;
  let found = false;
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    // 刚性蒙皮：网格是场景的兄弟节点，只有 skeleton.bones 能确定它绑到哪根骨
    const bones = mesh.skeleton?.bones;
    if (!bones || bones.indexOf(foot) < 0) return;
    const pos = mesh.geometry.attributes['position'] as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const dy = v.y - origin.y;
      if (dy < minY) minY = dy;
      found = true;
    }
  });
  if (!found) {
    foot.userData['soleDrop'] = 0;
    return 0;
  }
  // 夹到合理范围，避免极端模型算出离谱值
  const drop = Math.max(0, Math.min(0.14, Math.abs(minY) * 0.9));
  foot.userData['soleDrop'] = drop;
  return drop;
}

/** 膝盖极向量：由髋→踝几何推断膝盖应朝的方向。 */
export function computePolePoint(
  rig: FootLockRig,
  fallback: Vec3Tuple = [0, 0.1, 1],
): Vec3Tuple {
  const rp = rig.thigh.getWorldPosition(new THREE.Vector3());
  const mp = rig.shin.getWorldPosition(new THREE.Vector3());
  const ep = rig.foot.getWorldPosition(new THREE.Vector3());
  const pole = defaultPoleDir([rp.x, rp.y, rp.z], [mp.x, mp.y, mp.z], [ep.x, ep.y, ep.z], fallback);
  return [mp.x + pole[0] * 0.3, mp.y + pole[1] * 0.3, mp.z + pole[2] * 0.3] as Vec3Tuple;
}

/** 统计一轮循环的打滑总量（诊断/测试用）。 */
export function totalSlip(states: Iterable<FootState>): number {
  let sum = 0;
  for (const s of states) sum += s.correction;
  return sum;
}
