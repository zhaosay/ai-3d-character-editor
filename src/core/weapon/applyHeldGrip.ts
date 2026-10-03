import type * as THREE from 'three';
import { useIKStore } from '../../stores/ikStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useWorldStore } from '../../stores/worldStore';
import { useWeaponGripStore } from '../../stores/weaponGripStore';
import { solveTwoHandedGrip } from './gripSolve';
import type { IKChainDef } from '../ik/types';

/** 已检测到的 IK 链（过滤掉缺失/未初始化项）。 */
export type ChainList = IKChainDef[];

export function activeChains(): ChainList {
  return Object.values(useIKStore.getState().chains)
    .map((c) => c?.def)
    .filter((d): d is IKChainDef => Boolean(d));
}

/**
 * 持剑时解算双手握持，直接作用于场景对象。
 *
 * ## 现状：生产路径不走这里
 *
 * `SwordGripRuntime.tsx` 是实际生效的每帧求解器，它**直接调 `solveTwoHandedGrip`**，
 * 不经过本模块；因此下面的 `setLast` 诊断链路目前不会更新。
 * 本模块保留作**单步驱动**（调试钩子、将来的 UI 实时读数），
 * 不要把它当成「播放链路的一部分」—— 那是错的。
 *
 * ## 调用顺序要求
 *
 * 必须在 `applySampledPose` **之后**（需要主手 FK 已就位）。
 * 与 WorldStage 的剑渲染**无顺序依赖**：锚点直接由主手算，不读渲染 group。
 *
 * 任何缺失条件（未持剑 / 骨骼不完整 / 开关关闭）都静默返回，
 * 绝不影响播放本身。
 */
export function solveHeldSwordGrip(sceneObject: THREE.Object3D): void {
  const gripState = useWeaponGripStore.getState();
  if (!gripState.enabled) return;

  const sword = useWorldStore.getState().props.find((p) => p.kind === 'sword' && p.attachTo);
  if (!sword) return;

  const chains = activeChains();
  if (chains.length === 0) return;

  const snapshot = useSkeletonStore.getState().snapshot;
  const hipsNode = snapshot
    ? Object.values(snapshot.nodes).find((n) => n.semantic === 'hips')
    : undefined;
  const hips = hipsNode ? sceneObject.getObjectByProperty('uuid', hipsNode.id) : null;

  const r = solveTwoHandedGrip(
    sceneObject,
    chains,
    hips as THREE.Bone | null,
    sword,
  );
  if (r) gripState.setLast(r.offToPommelM, r.reached);
}