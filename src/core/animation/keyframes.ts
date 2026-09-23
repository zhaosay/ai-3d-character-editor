import type { AnimationData, BoneTrack, Keyframe } from './types';

export const KEY_EPS = 1e-4;

export function getOrCreateTrack(anim: AnimationData, boneName: string): BoneTrack {
  let t = anim.tracks.find((x) => x.boneName === boneName);
  if (!t) {
    t = { boneName, position: [], rotation: [], scale: [] };
    anim.tracks.push(t);
  }
  return t;
}

function sortKeys<T>(keys: Keyframe<T>[]) {
  keys.sort((a, b) => a.time - b.time);
}

/** 插入或替换（|dt| < eps 视为同一帧）。返回实际写入的 time。 */
export function upsertKey<T>(keys: Keyframe<T>[], key: Keyframe<T>): number {
  const t = Math.max(0, key.time);
  const existing = keys.find((k) => Math.abs(k.time - t) < KEY_EPS);
  if (existing) {
    existing.value = key.value;
    existing.interp = key.interp;
    return existing.time;
  }
  keys.push({ ...key, time: t });
  sortKeys(keys);
  return t;
}

export function deleteKeyAt<T>(keys: Keyframe<T>[], time: number, eps = 1e-3): boolean {
  const idx = keys.findIndex((k) => Math.abs(k.time - time) < eps);
  if (idx < 0) return false;
  keys.splice(idx, 1);
  return true;
}

/** 移动关键帧：钳制到 [0, duration]，目标位置有冲突则替换。返回最终 time，找不到返回 null。 */
export function moveKey<T>(keys: Keyframe<T>[], fromTime: number, toTime: number, duration: number, eps = 1e-3): number | null {
  const idx = keys.findIndex((k) => Math.abs(k.time - fromTime) < eps);
  if (idx < 0) return null;
  const clamped = Math.min(Math.max(toTime, 0), duration);
  const conflict = keys.find((k, i) => i !== idx && Math.abs(k.time - clamped) < KEY_EPS);
  if (conflict) keys.splice(keys.indexOf(conflict), 1);
  keys[idx].time = clamped;
  sortKeys(keys);
  return clamped;
}

export function nearestKeyTime<T>(keys: Keyframe<T>[], time: number, eps = 1e-3): number | null {
  let best: number | null = null;
  let bestD = eps;
  for (const k of keys) {
    const d = Math.abs(k.time - time);
    if (d <= bestD) {
      bestD = d;
      best = k.time;
    }
  }
  return best;
}
