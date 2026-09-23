import type { QuatTuple, Vec3Tuple } from '../../types/global';

// P1 冻结 Animation schema（P2 实现采样/编辑，P4 实现导出）。
export type Interpolation = 'linear' | 'step' | 'cubic';

export interface Keyframe<T> {
  time: number;
  value: T;
  interp: Interpolation;
}

export interface BoneTrack {
  boneName: string;
  position: Keyframe<Vec3Tuple>[];
  rotation: Keyframe<QuatTuple>[];
  scale: Keyframe<Vec3Tuple>[];
}

export interface AnimationData {
  id: string;
  name: string;
  duration: number;
  fps: number;
  tracks: BoneTrack[];
}

export function createEmptyAnimation(name = 'New Animation', fps = 30, duration = 4): AnimationData {
  return {
    id: `anim_${Date.now()}`,
    name,
    duration,
    fps,
    tracks: [],
  };
}

/** P1 仅做校验，为 P2 预埋 linear 采样。 */
export function validateAnimation(a: AnimationData): string[] {
  const errors: string[] = [];
  if (a.duration <= 0) errors.push('duration must be > 0');
  if (![12, 24, 30, 60].includes(a.fps)) errors.push(`unsupported fps ${a.fps}`);
  for (const t of a.tracks) {
    for (const k of [...t.position, ...t.rotation, ...t.scale]) {
      if (k.time < 0 || k.time > a.duration) errors.push(`key out of range in ${t.boneName} @${k.time}`);
    }
  }
  return errors;
}
