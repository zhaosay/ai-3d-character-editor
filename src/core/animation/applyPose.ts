import * as THREE from 'three';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { SampledPose } from './sampler';

/** 以 bone.name 建索引（重名取第一个，P2 已在注释说明）。 */
export function indexBonesByName(root: THREE.Object3D): Map<string, THREE.Bone> {
  const map = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone && !map.has(o.name)) map.set(o.name, o as THREE.Bone);
  });
  return map;
}

export function applySampledPose(root: THREE.Object3D, pose: SampledPose): string[] {
  const bones = indexBonesByName(root);
  const missing: string[] = [];
  pose.forEach((t, name) => {
    const b = bones.get(name);
    if (!b) {
      missing.push(name);
      return;
    }
    if (t.quaternion) b.quaternion.fromArray(t.quaternion);
    if (t.position) b.position.fromArray(t.position);
    if (t.scale) b.scale.fromArray(t.scale);
  });
  root.updateWorldMatrix(true, true);
  return missing;
}

export function captureBoneLocal(
  root: THREE.Object3D,
  boneName: string,
): { position: Vec3Tuple; quaternion: QuatTuple; scale: Vec3Tuple } | null {
  const bones = indexBonesByName(root);
  const b = bones.get(boneName);
  if (!b) return null;
  return {
    position: [b.position.x, b.position.y, b.position.z],
    quaternion: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    scale: [b.scale.x, b.scale.y, b.scale.z],
  };
}

export function setBoneLocal(
  root: THREE.Object3D,
  boneName: string,
  v: { position?: Vec3Tuple; quaternion?: QuatTuple; scale?: Vec3Tuple },
): boolean {
  const bones = indexBonesByName(root);
  const b = bones.get(boneName);
  if (!b) return false;
  if (v.position) b.position.fromArray(v.position);
  if (v.quaternion) b.quaternion.fromArray(v.quaternion);
  if (v.scale) b.scale.fromArray(v.scale);
  b.updateWorldMatrix(true, false);
  return true;
}

/** 恢复到 restLocal（快照值），用于停止播放后回到初始姿势。 */
export function resetToRest(
  root: THREE.Object3D,
  rest: Map<string, { position: Vec3Tuple; quaternion: QuatTuple; scale: Vec3Tuple }>,
) {
  const bones = indexBonesByName(root);
  rest.forEach((t, name) => {
    const b = bones.get(name);
    if (b) {
      b.position.fromArray(t.position);
      b.quaternion.fromArray(t.quaternion);
      b.scale.fromArray(t.scale);
    }
  });
  root.updateWorldMatrix(true, true);
}
