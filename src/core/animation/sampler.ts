import * as THREE from 'three';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { AnimationData, Keyframe } from './types';

export interface SampledTransform {
  position?: Vec3Tuple;
  quaternion?: QuatTuple;
  scale?: Vec3Tuple;
}

export type SampledPose = Map<string, SampledTransform>;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();

function sorted<T>(keys: Keyframe<T>[]): Keyframe<T>[] {
  return [...keys].sort((a, b) => a.time - b.time);
}

/** 找到 time 左右两侧的关键帧索引。返回 [prevIdx, nextIdx]，-1 表示缺失。 */
function bracket<T>(keys: Keyframe<T>[], time: number): [number, number] {
  const ks = sorted(keys);
  if (ks.length === 0) return [-1, -1];
  if (time <= ks[0].time) return [0, 0];
  if (time >= ks[ks.length - 1].time) return [ks.length - 1, ks.length - 1];
  let prev = 0;
  for (let i = 0; i < ks.length; i++) {
    if (ks[i].time <= time) prev = i;
    if (ks[i].time >= time) return [prev, i];
  }
  return [prev, prev];
}

export function sampleQuatTrack(keys: Keyframe<QuatTuple>[], time: number): QuatTuple | undefined {
  if (keys.length === 0) return undefined;
  const ks = sorted(keys);
  const [pi, ni] = bracket(ks, time);
  if (pi === ni) return [...ks[pi].value] as QuatTuple;
  const a = ks[pi];
  const b = ks[ni];
  // step：保持前一帧
  const mode = a.interp === 'step' ? 'step' : b.interp === 'step' ? 'step' : a.interp;
  if (mode === 'step') return [...a.value] as QuatTuple;
  if (mode === 'cubic') throw new Error('NOT_IMPLEMENTED: cubic interpolation (P7)');
  // linear slerp
  const span = Math.max(b.time - a.time, 1e-6);
  const t = THREE.MathUtils.clamp((time - a.time) / span, 0, 1);
  _qa.fromArray(a.value);
  _qb.fromArray(b.value);
  _qa.slerp(_qb, t);
  return [_qa.x, _qa.y, _qa.z, _qa.w];
}

export function sampleVec3Track(keys: Keyframe<Vec3Tuple>[], time: number): Vec3Tuple | undefined {
  if (keys.length === 0) return undefined;
  const ks = sorted(keys);
  const [pi, ni] = bracket(ks, time);
  if (pi === ni) return [...ks[pi].value] as Vec3Tuple;
  const a = ks[pi];
  const b = ks[ni];
  const mode = a.interp === 'step' ? 'step' : b.interp === 'step' ? 'step' : a.interp;
  if (mode === 'step') return [...a.value] as Vec3Tuple;
  if (mode === 'cubic') throw new Error('NOT_IMPLEMENTED: cubic interpolation (P7)');
  const span = Math.max(b.time - a.time, 1e-6);
  const t = THREE.MathUtils.clamp((time - a.time) / span, 0, 1);
  _va.fromArray(a.value);
  _vb.fromArray(b.value);
  _va.lerp(_vb, t);
  return [_va.x, _va.y, _va.z];
}

/** 采样整个 clip 在 time 时刻的 pose。P2 只保证 rotation；position/scale 同理可用。 */
export function sampleAnimation(anim: AnimationData, time: number): SampledPose {
  const pose: SampledPose = new Map();
  const t = THREE.MathUtils.clamp(time, 0, anim.duration);
  for (const track of anim.tracks) {
    const out: SampledTransform = {};
    const q = sampleQuatTrack(track.rotation, t);
    if (q) out.quaternion = q;
    const p = sampleVec3Track(track.position, t);
    if (p) out.position = p;
    const s = sampleVec3Track(track.scale, t);
    if (s) out.scale = s;
    if (out.quaternion ?? out.position ?? out.scale) pose.set(track.boneName, out);
  }
  return pose;
}
