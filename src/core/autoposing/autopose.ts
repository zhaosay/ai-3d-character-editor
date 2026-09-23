import * as THREE from 'three';
import { indexBonesByName } from '../animation/applyPose';
import { applyIKChain } from '../ik/applyIK';
import type { IKChainDef, IKChainId } from '../ik/types';
import type { SkeletonSnapshot } from '../skeleton/types';
import { AUTOPOSE_LIMITS, type AutoPoseParams, type AutoPoseResult } from './types';

export function clampAutoPoseParams(p: AutoPoseParams): AutoPoseParams {
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(Math.max(v, lo), hi);
  return {
    hipsDrop: c(p.hipsDrop, AUTOPOSE_LIMITS.hipsDrop),
    leanXDeg: c(p.leanXDeg, AUTOPOSE_LIMITS.leanX),
    leanZDeg: c(p.leanZDeg, AUTOPOSE_LIMITS.leanZ),
    pinFeet: p.pinFeet,
    pinHands: p.pinHands,
  };
}

export interface TorsoBones {
  hips: string | null;
  spine: string | null;
  chest: string | null;
}

/** 从语义快照解析躯干骨骼名；缺失返回 null（调用方降级警告）。 */
export function resolveTorsoBones(snapshot: SkeletonSnapshot): TorsoBones {
  const bySemantic = new Map(Object.values(snapshot.nodes).map((n) => [n.semantic, n.name]));
  return {
    hips: bySemantic.get('hips') ?? null,
    spine: bySemantic.get('spine') ?? null,
    chest: bySemantic.get('chest') ?? null,
  };
}

export interface ChainPin {
  def: IKChainDef;
  /** 调整前捕获的世界钉点 */
  pin: [number, number, number];
  polePoint: [number, number, number];
}

const LEG_IDS: IKChainId[] = ['leg.L', 'leg.R'];
const ARM_IDS: IKChainId[] = ['arm.L', 'arm.R'];

/**
 * 对 live 场景应用 AutoPose（独立模块，可单测）：
 * 1. 捕获钉点（脚/手当前世界位置）；
 * 2. 髋部 local Y 平移 + 脊柱/胸部 lean；
 * 3. 用腿/臂 IK 把钉点拉回（脚不离地、手不动）。
 * 超限链钳制并警告，不硬拉变形。
 */
export function applyAutoposeLive(
  sceneObject: THREE.Object3D,
  snapshot: SkeletonSnapshot,
  chains: Record<IKChainId, { def: IKChainDef; polePoint: [number, number, number] } | undefined>,
  raw: AutoPoseParams,
): AutoPoseResult {
  const params = clampAutoPoseParams(raw);
  const warnings: string[] = [];
  const adjusted: string[] = [];
  if (
    raw.hipsDrop !== params.hipsDrop ||
    raw.leanXDeg !== params.leanXDeg ||
    raw.leanZDeg !== params.leanZDeg
  ) {
    warnings.push('输入超限已钳制到安全范围');
  }

  const bones = indexBonesByName(sceneObject);
  const torso = resolveTorsoBones(snapshot);
  if (!torso.hips) {
    return { adjusted, warnings: ['未找到 hips 骨骼，AutoPose 不可用'] };
  }

  // 1. 捕获钉点
  const pins: ChainPin[] = [];
  const want: IKChainId[] = [...(params.pinFeet ? LEG_IDS : []), ...(params.pinHands ? ARM_IDS : [])];
  sceneObject.updateWorldMatrix(true, true);
  for (const id of want) {
    const c = chains[id];
    if (!c) continue;
    const end = bones.get(c.def.endBone);
    const mid = bones.get(c.def.midBone);
    if (!end || !mid) {
      warnings.push(`${id} 骨骼缺失，已跳过`);
      continue;
    }
    const ep = new THREE.Vector3();
    end.getWorldPosition(ep);
    pins.push({ def: c.def, pin: [ep.x, ep.y, ep.z], polePoint: [...c.polePoint] });
  }

  // 2. 髋部下压（local Y）
  const hips = bones.get(torso.hips);
  if (!hips) return { adjusted, warnings: ['hips 骨骼在场景中缺失'] };
  hips.position.y += params.hipsDrop;
  adjusted.push(torso.hips);

  // 3. 躯干 lean（local 系后乘，保持层级语义）
  const leanQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(params.leanXDeg),
      0,
      THREE.MathUtils.degToRad(params.leanZDeg),
      'XYZ',
    ),
  );
  for (const name of [torso.spine, torso.chest]) {
    if (!name) continue;
    const b = bones.get(name);
    if (!b) {
      warnings.push(`${name} 缺失，已跳过`);
      continue;
    }
    b.quaternion.multiply(leanQ);
    adjusted.push(name);
  }
  sceneObject.updateWorldMatrix(true, true);

  // 4. IK 拉回钉点
  for (const p of pins) {
    try {
      const r = applyIKChain(bones, p.def, p.pin, p.polePoint);
      if (!r) {
        warnings.push(`${p.def.id} 求解失败`);
        continue;
      }
      adjusted.push(p.def.rootBone, p.def.midBone, p.def.endBone);
      if (!r.reached) warnings.push(`${p.def.label}超出可达，已钳制（目标保持最近可达点）`);
    } catch (e) {
      warnings.push(`${p.def.id} 求解异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  sceneObject.updateWorldMatrix(true, true);
  return { adjusted: [...new Set(adjusted)], warnings };
}
