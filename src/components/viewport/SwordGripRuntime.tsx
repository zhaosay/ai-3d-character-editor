import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useCharacterStore } from '../../stores/characterStore';
import { useWorldStore } from '../../stores/worldStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useWeaponGripStore } from '../../stores/weaponGripStore';
import { solveTwoHandedGrip } from '../../core/weapon/gripSolve';
import { activeChains, type ChainList } from '../../core/weapon/applyHeldGrip';
import type { IKChainDef } from '../../core/ik/types';

/** IK 会改动的手/前臂骨骼的原始状态（局部系 —— 与 applySampledPose 写入的量纲一致）。 */
interface GripSnapshot {
  bones: Array<{ bone: THREE.Bone; quaternion: THREE.Quaternion; position: THREE.Vector3 }>;
}

const EMPTY: GripSnapshot = { bones: [] };

/**
 * 持剑握持的**每帧**解算 + 关闭时复原。
 *
 * ## 为什么必须是独立组件，不能挂在 PlaybackEngine 上
 *
 * 最初把调用写在 `PlaybackEngine` 的 useFrame 里，实测发现**功能从未生效**：
 * 那个 useFrame 有两道早退 —— 必须 `playing` 且当前动画带轨道。
 * 静止看场景时两者都不满足，`solveTwoHandedGrip` 一次都不会执行。
 * 现象是「播放时偶尔对、停下来看又松开了」，极难排查。
 *
 * `ScrubApplier` 也救不了：它只在**暂停且时间变化**时触发。
 * 握持是**持续约束**而非播放的副产品 —— 用户停在某一帧就该看到双手握着剑。
 *
 * ## 为什么必须复原（第二个实测 bug）
 *
 * IK 是**直接改骨骼**的。关闭开关后若不还原，角色会**冻结在上一次 IK 解出的姿势** ——
 * 手仍粘在剑柄上，看起来像「开关完全没用」。
 * 播放时不需要还原（`applySampledPose` 每帧重写），但暂停时没人写 FK，所以必须自己存/还原。
 *
 * ## 顺序
 *
 * 挂在 `ViewportCanvas` 里 `PlaybackEngine` / `BlinkApplier` / `IKSolver` **之后**；
 * R3F 的 useFrame 默认按挂载顺序执行，保证拿到的是已应用过 FK 的姿态。
 * 不用 `renderPriority`：R3F 里非 0 的 priority 会**接管整个渲染循环**，
 * 得自己调 renderer.render，代价远大于收益。
 */
export function SwordGripRuntime() {
  const saved = useRef<GripSnapshot>(EMPTY);

  useFrame(() => {
    const scene = useCharacterStore.getState().sceneObject;
    if (!scene) return;

    const gripState = useWeaponGripStore.getState();
    const sword = useWorldStore.getState().props.find((p) => p.kind === 'sword' && p.attachTo);

    if (!gripState.enabled || !sword) {
      if (saved.current.bones.length > 0) {
        restore(saved.current);
        saved.current = EMPTY;
      }
      return;
    }

    const chains = activeChains();
    if (chains.length === 0) return;

    const snapshot = useSkeletonStore.getState().snapshot;
    const hipsNode = snapshot ? Object.values(snapshot.nodes).find((n) => n.semantic === 'hips') : undefined;
    const hips = hipsNode ? scene.getObjectByProperty('uuid', hipsNode.id) : null;

    // 先存「IK 之前」的状态，供关闭时还原
    saved.current = capture(scene, chains);

    solveTwoHandedGrip(scene, chains, (hips as THREE.Bone | null) ?? null, sword);
  });

  return null;
}

/** 取两条手臂链上的 mid/end 骨骼（IK 只会改这四根）。 */
function armBones(scene: THREE.Object3D, chains: ChainList): THREE.Bone[] {
  const out: THREE.Bone[] = [];
  for (const id of ['arm.L', 'arm.R']) {
    const def = chains.find((c: IKChainDef) => c.id === id);
    if (!def) continue;
    for (const name of [def.midBone, def.endBone]) {
      const bone = scene.getObjectByName(name) as THREE.Bone | undefined;
      if (bone) out.push(bone);
    }
  }
  return out;
}

function capture(scene: THREE.Object3D, chains: ChainList): GripSnapshot {
  return {
    bones: armBones(scene, chains).map((bone) => ({
      bone,
      quaternion: bone.quaternion.clone(),
      position: bone.position.clone(),
    })),
  };
}

function restore(snap: GripSnapshot): void {
  for (const { bone, quaternion, position } of snap.bones) {
    bone.quaternion.copy(quaternion);
    bone.position.copy(position);
  }
}