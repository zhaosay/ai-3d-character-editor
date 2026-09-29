import * as THREE from 'three';
import type { AnimationData } from '../../core/animation/types';

export interface MotionCoordinateSpace {
  length_unit: 'm' | 'cm' | 'mm';
  up_axis: 'Y' | 'Z';
  handedness: 'right';
}

const UNIT_TO_METERS: Record<MotionCoordinateSpace['length_unit'], number> = { m: 1, cm: 0.01, mm: 0.001 };

/** Convert declared provider coordinates to the editor's right-handed, Y-up, meter convention. */
export function normalizeMotionSpace(animation: AnimationData, value: unknown): { animation: AnimationData; warning?: string } {
  if (value === undefined || value === null) {
    return { animation, warning: '动作服务未声明坐标系；暂按右手系、Y-up、米制解释返回轨道' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('动作服务 motion_space 必须是对象');
  const space = value as Record<string, unknown>;
  if (!['m', 'cm', 'mm'].includes(String(space['length_unit']))
    || !['Y', 'Z'].includes(String(space['up_axis'])) || space['handedness'] !== 'right') {
    throw new Error('动作服务 motion_space 只支持 right 手性、Y/Z up 和 m/cm/mm 单位');
  }
  const unitScale = UNIT_TO_METERS[space['length_unit'] as MotionCoordinateSpace['length_unit']];
  const basis = space['up_axis'] === 'Z'
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    : new THREE.Quaternion();
  const inverseBasis = basis.clone().invert();
  const needsConversion = unitScale !== 1 || space['up_axis'] !== 'Y';
  if (!needsConversion) return { animation };

  const converted = structuredClone(animation);
  for (const track of converted.tracks) {
    for (const key of track.position) {
      const position = new THREE.Vector3(...key.value).multiplyScalar(unitScale).applyQuaternion(basis);
      key.value = [position.x, position.y, position.z];
    }
    for (const key of track.rotation) {
      const rotation = new THREE.Quaternion(...key.value).normalize();
      rotation.premultiply(basis).multiply(inverseBasis).normalize();
      key.value = [rotation.x, rotation.y, rotation.z, rotation.w];
    }
  }
  return { animation: converted };
}
