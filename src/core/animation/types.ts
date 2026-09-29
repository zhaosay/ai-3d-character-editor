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

/** Morph target weights are keyed alongside skeletal tracks and survive character reloads. */
export interface FaceTrack {
  meshPath: string;
  targetName: string;
  keys: Keyframe<number>[];
}

export interface AnimationData {
  id: string;
  name: string;
  duration: number;
  fps: number;
  tracks: BoneTrack[];
  /** Optional for backwards compatibility with existing project.json files. */
  faceTracks?: FaceTrack[];
}

let animationIdSequence = 0;

export function createEmptyAnimation(name = 'New Animation', fps = 30, duration = 4): AnimationData {
  return {
    id: `anim_${Date.now()}_${++animationIdSequence}`,
    name,
    duration,
    fps,
    tracks: [],
    faceTracks: [],
  };
}

/** P1 仅做校验，为 P2 预埋 linear 采样。 */
export function validateAnimation(a: AnimationData): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(a.duration) || a.duration <= 0) errors.push('duration must be > 0');
  if (![12, 24, 30, 60].includes(a.fps)) errors.push(`unsupported fps ${a.fps}`);
  if (!Array.isArray(a.tracks)) {
    errors.push('tracks must be an array');
    return errors;
  }
  const boneNames = new Set<string>();
  for (const [index, t] of a.tracks.entries()) {
    if (!t || typeof t !== 'object' || typeof t.boneName !== 'string' || !t.boneName.trim()) {
      errors.push(`track ${index + 1} is missing a bone name`);
      continue;
    }
    if (boneNames.has(t.boneName)) errors.push(`duplicate track for ${t.boneName}`);
    boneNames.add(t.boneName);
    const channels = [
      ['position', t.position, 3], ['rotation', t.rotation, 4], ['scale', t.scale, 3],
    ] as const;
    for (const [channel, keys, valueSize] of channels) {
      if (!Array.isArray(keys)) {
        errors.push(`${channel} keys must be an array in ${t.boneName}`);
        continue;
      }
      for (const [keyIndex, key] of keys.entries()) {
        const time = key?.time;
        const value = key?.value as unknown;
        if (!Number.isFinite(time) || time < 0 || time > a.duration) errors.push(`key out of range in ${t.boneName} @${time}`);
        if (!Array.isArray(value) || value.length !== valueSize || value.some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
          errors.push(`invalid ${channel} value in ${t.boneName} key ${keyIndex + 1}`);
        }
        if (!key || !['linear', 'step', 'cubic'].includes(key.interp)) errors.push(`invalid interpolation in ${t.boneName} @${time}`);
      }
    }
  }
  if (a.faceTracks !== undefined && !Array.isArray(a.faceTracks)) errors.push('faceTracks must be an array');
  for (const track of Array.isArray(a.faceTracks) ? a.faceTracks : []) {
    if (!track || typeof track !== 'object') {
      errors.push('face track must be an object');
      continue;
    }
    if (!track.meshPath || !track.targetName) errors.push('face track target is missing');
    if (!Array.isArray(track.keys)) {
      errors.push(`face keys must be an array in ${track.targetName || '(unnamed)'}`);
      continue;
    }
    for (const key of track.keys) {
      if (!key || !Number.isFinite(key.time) || key.time < 0 || key.time > a.duration) errors.push(`face key out of range in ${track.targetName} @${key?.time}`);
      if (!key || !Number.isFinite(key.value) || key.value < 0 || key.value > 1) errors.push(`face weight out of range in ${track.targetName} @${key?.time}`);
    }
  }
  return errors;
}
