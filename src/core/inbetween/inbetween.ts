import * as THREE from 'three';
import type { Keyframe } from '../animation/types';
import type { EaseMode, InbetweenRequest } from './types';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function applyEase(t: number, mode: EaseMode): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  switch (mode) {
    case 'linear':
      return x;
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'easeOutIn':
      return x < 0.5 ? (1 - Math.cos(Math.PI * x)) / 2 : (1 + Math.cos(Math.PI - Math.PI * x)) / 2;
  }
}

/** 用两个相邻 key 计算任意 t∈(0,1) 的插值。标量直接 lerp+缓动；quat 走 slerp。 */
export function interpolatePairValue<K extends Keyframe<unknown>>(a: K, b: K, tRaw: number, ease: EaseMode): unknown {
  const span = Math.max(b.time - a.time, 1e-6);
  const u = THREE.MathUtils.clamp((tRaw - a.time) / span, 0, 1);
  const tt = applyEase(u, ease);
  if (a.interp === 'step' || b.interp === 'step') return a.value;
  const va = a.value as unknown;
  const vb = b.value as unknown;
  if (Array.isArray(va) && Array.isArray(vb) && (va as unknown[]).length === (vb as unknown[]).length) {
    const na = (va as number[]).length;
    if (na === 4) {
      // 四元数假定：分量 slerp
      _qa.set(va[0] as number, va[1] as number, va[2] as number, va[3] as number);
      _qb.set(vb[0] as number, vb[1] as number, vb[2] as number, vb[3] as number);
      _qa.slerp(_qb, tt);
      return [_qa.x, _qa.y, _qa.z, _qa.w];
    }
    // 向量逐分量 lerp（与编辑器内采样约定一致）
    return (va as number[]).map((x, i) => x + ((vb as number[])[i] - x) * tt);
  }
  if (typeof va === 'number' && typeof vb === 'number') {
    return va + (vb - va) * tt;
  }
  return a.value;
}

/** 在 [minTime, maxTime] 区间内密度均匀插入（步长 = 1/density 秒），总帧数 ceil span*density - 1。 */
export function inbetweenKeys<K extends Keyframe<unknown>>(req: InbetweenRequest & { keys: K[]; isQuat?: boolean }): K[] {
  const ks = [...req.keys].sort((a, b) => a.time - b.time);
  if (ks.length < 2 || req.density <= 0 || req.maxTime <= req.minTime) return ks;

  const out: K[] = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    out.push(a);
    const lo = Math.max(a.time, req.minTime);
    const hi = Math.min(b.time, req.maxTime);
    if (hi <= lo) continue;
    const stepCount = Math.max(1, Math.ceil((hi - lo) * req.density) - 1);
    for (let j = 1; j <= stepCount; j++) {
      const t = lo + ((hi - lo) * j) / (stepCount + 1);
      if (t >= b.time - 1e-6) continue;
      out.push({
        ...a,
        time: round3(t),
        value: interpolatePairValue(a, b, t, req.ease),
        interp: a.interp === 'cubic' || b.interp === 'cubic' ? 'cubic' : 'linear',
      } as K);
    }
  }
  out.push(ks[ks.length - 1]);
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
