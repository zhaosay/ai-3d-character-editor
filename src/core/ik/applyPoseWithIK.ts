import type * as THREE from 'three';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import type { SampledPose } from '../animation/sampler';
import { applyIKChain } from './applyIK';
import type { IKChainDef } from './types';
import type { Vec3Tuple } from '../../types/global';

export interface IKPin {
  def: IKChainDef;
  target: Vec3Tuple;
  polePoint: Vec3Tuple;
}

export interface PinSolve {
  id: string;
  label: string;
  reached: boolean;
  clamped: boolean;
  hingeDeg: number;
  endPos: Vec3Tuple;
}

/**
 * 先应用采样 pose（FK），再对启用的链做 IK（保持末端钉住）。
 * Scrub / Agent bake 前统一走这里，避免“FK 闪一帧 / 抓到求解前旧姿势”。
 */
export function applyPoseWithIK(
  root: THREE.Object3D,
  pose: SampledPose,
  pins: IKPin[],
): PinSolve[] {
  applySampledPose(root, pose);
  if (pins.length === 0) {
    root.updateWorldMatrix(true, true);
    return [];
  }
  const bones = indexBonesByName(root);
  const out: PinSolve[] = [];
  for (const pin of pins) {
    try {
      const r = applyIKChain(bones, pin.def, pin.target, pin.polePoint);
      if (r) {
        out.push({
          id: pin.def.id,
          label: pin.def.label,
          reached: r.reached,
          clamped: r.clamped,
          hingeDeg: r.hingeDeg,
          endPos: r.endPos,
        });
      }
    } catch (e) {
      console.error(`IK pin ${pin.def.id}:`, e);
    }
  }
  root.updateWorldMatrix(true, true);
  return out;
}

/** 空 pose（只做 IK，常用于 targetDelta 后立即求解）。 */
export function solvePinsLive(root: THREE.Object3D, pins: IKPin[]): PinSolve[] {
  return applyPoseWithIK(root, new Map(), pins);
}

export function currentPin(
  def: IKChainDef,
  target: Vec3Tuple,
  polePoint: Vec3Tuple,
): IKPin {
  return { def, target: [...target] as Vec3Tuple, polePoint: [...polePoint] as Vec3Tuple };
}
