import * as THREE from 'three';
import { solveTwoBone } from './twoBoneIK';
import type { IKChainDef } from './types';
import type { Vec3Tuple } from '../../types/global';
import type { IKSolveInfo } from './types';

const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _delta = new THREE.Quaternion();

function worldPosOf(b: THREE.Bone, out: THREE.Vector3): THREE.Vector3 {
  return b.getWorldPosition(out);
}

/** 将 bone 的子节点朝向从 cur 转到 desired（世界空间），保持 twist。 */
function aimBone(bone: THREE.Bone, curChildWorld: THREE.Vector3, desiredChildWorld: THREE.Vector3) {
  const bp = new THREE.Vector3();
  bone.getWorldPosition(bp);
  _d0.copy(curChildWorld).sub(bp);
  _d1.copy(desiredChildWorld).sub(bp);
  if (_d0.lengthSq() < 1e-12 || _d1.lengthSq() < 1e-12) return;
  _d0.normalize();
  _d1.normalize();
  bone.getWorldQuaternion(_qw);
  _delta.setFromUnitVectors(_d0, _d1);
  _q.copy(_delta).multiply(_qw);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qp).invert();
    bone.quaternion.copy(_qp).multiply(_q);
  } else {
    bone.quaternion.copy(_q);
  }
}

export interface AppliedIK extends IKSolveInfo {
  /** 求解后末端实际位置（应≈目标/钳制点） */
  endPos: Vec3Tuple;
}

/**
 * 对 live three 骨骼应用 IK（先求解世界位置，再反解局部旋转）。
 * 末端骨骼保持世界朝向（只管位置，P3 范围）。
 */
export function applyIKChain(
  bones: Map<string, THREE.Bone>,
  def: IKChainDef,
  target: Vec3Tuple,
  polePoint: Vec3Tuple,
): AppliedIK | null {
  const root = bones.get(def.rootBone);
  const mid = bones.get(def.midBone);
  const end = bones.get(def.endBone);
  if (!root || !mid || !end) return null;

  root.updateWorldMatrix(true, true);
  const rp = worldPosOf(root, new THREE.Vector3());
  const mp = worldPosOf(mid, new THREE.Vector3());
  const ep = worldPosOf(end, new THREE.Vector3());

  const poleDir = new THREE.Vector3(polePoint[0] - mp.x, polePoint[1] - mp.y, polePoint[2] - mp.z);
  if (poleDir.lengthSq() < 1e-10) poleDir.set(0, 0, 1);
  poleDir.normalize();

  const solved = solveTwoBone(
    [rp.x, rp.y, rp.z],
    [mp.x, mp.y, mp.z],
    [ep.x, ep.y, ep.z],
    target,
    [poleDir.x, poleDir.y, poleDir.z],
  );

  const midSolved = new THREE.Vector3(...solved.mid);
  const endSolved = new THREE.Vector3(...solved.end);

  // root 瞄准 midSolved，再更新后 mid 瞄准 endSolved
  aimBone(root, mp, midSolved);
  root.updateWorldMatrix(true, true);
  const mp2 = worldPosOf(mid, new THREE.Vector3());
  aimBone(mid, worldPosOf(end, new THREE.Vector3()), endSolved);
  mid.updateWorldMatrix(true, true);

  const endNow = worldPosOf(end, new THREE.Vector3());
  void mp2;

  return {
    reached: solved.reached,
    hingeDeg: solved.hingeDeg,
    clamped: !solved.reached,
    endPos: [endNow.x, endNow.y, endNow.z],
  };
}
