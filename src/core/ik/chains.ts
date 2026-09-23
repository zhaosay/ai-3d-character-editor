import * as THREE from 'three';
import type { HumanoidSemantic, SkeletonSnapshot } from '../skeleton/types';
import { defaultPoleDir } from './twoBoneIK';
import type { IKChainDef, IKChainId } from './types';
import type { Vec3Tuple } from '../../types/global';

const CHAINS: Array<{
  id: IKChainId;
  label: string;
  type: 'arm' | 'leg';
  root: HumanoidSemantic;
  mid: HumanoidSemantic;
  end: HumanoidSemantic;
  /** 完全伸直静息姿势时的回退极向量（角色面朝 +Z 假设，仅回退） */
  fallbackPole: Vec3Tuple;
}> = [
  { id: 'arm.L', label: '左手', type: 'arm', root: 'upperArm.L', mid: 'forearm.L', end: 'hand.L', fallbackPole: [0.7, -0.2, -0.7] },
  { id: 'arm.R', label: '右手', type: 'arm', root: 'upperArm.R', mid: 'forearm.R', end: 'hand.R', fallbackPole: [-0.7, -0.2, -0.7] },
  { id: 'leg.L', label: '左脚', type: 'leg', root: 'thigh.L', mid: 'shin.L', end: 'foot.L', fallbackPole: [0, 0.1, 1] },
  { id: 'leg.R', label: '右脚', type: 'leg', root: 'thigh.R', mid: 'shin.R', end: 'foot.R', fallbackPole: [0, 0.1, 1] },
];

/** 由 skeleton 快照自动检测 4 条 IK 链；缺骨骼的链直接跳过（UI 显示不可用）。 */
export function detectIKChains(snapshot: SkeletonSnapshot): IKChainDef[] {
  const byName = new Map(Object.values(snapshot.nodes).map((n) => [n.name, n]));
  const bySemantic = new Map(Object.values(snapshot.nodes).map((n) => [n.semantic, n.name]));
  const out: IKChainDef[] = [];
  for (const c of CHAINS) {
    const rootName = bySemantic.get(c.root) ?? null;
    const midName = bySemantic.get(c.mid) ?? null;
    const endName = bySemantic.get(c.end) ?? null;
    if (!rootName || !midName || !endName) continue;
    const root = byName.get(rootName)!;
    const mid = byName.get(midName)!;
    const end = byName.get(endName)!;
    const rp: Vec3Tuple = [...root.world.position] as Vec3Tuple;
    const mp: Vec3Tuple = [...mid.world.position] as Vec3Tuple;
    const ep: Vec3Tuple = [...end.world.position] as Vec3Tuple;
    const upper = new THREE.Vector3(...mp).distanceTo(new THREE.Vector3(...rp));
    const lower = new THREE.Vector3(...ep).distanceTo(new THREE.Vector3(...mp));
    if (upper < 1e-6 || lower < 1e-6) continue;
    const pole = defaultPoleDir(rp, mp, ep, c.fallbackPole);
    const polePoint: Vec3Tuple = [mp[0] + pole[0] * 0.3, mp[1] + pole[1] * 0.3, mp[2] + pole[2] * 0.3];
    out.push({
      id: c.id,
      label: c.label,
      type: c.type,
      rootBone: rootName,
      midBone: midName,
      endBone: endName,
      upperLen: upper,
      lowerLen: lower,
      defaultTarget: [...ep] as Vec3Tuple,
      defaultPolePoint: polePoint,
    });
  }
  return out;
}
