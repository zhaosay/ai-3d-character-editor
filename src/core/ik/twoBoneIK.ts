import * as THREE from 'three';
import type { Vec3Tuple } from '../../types/global';

export interface TwoBoneResult {
  mid: Vec3Tuple;
  end: Vec3Tuple;
  /** 实际使用的 root→target 距离（钳制后） */
  dist: number;
  /** 目标是否在可达范围内（未被钳制） */
  reached: boolean;
  /** 中间关节内角（度），用于 UI 显示与钳制检查 */
  hingeDeg: number;
}

const _r = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * 解析式双骨 IK（纯数学，无 three 对象依赖，可单测）。
 *
 * 防翻转策略：
 * 1. maxReach = (upper+lower)*0.999，避免完全伸直的奇异翻转；
 * 2. minReach = |upper-lower|+eps，避免完全折叠；
 * 3. 中间关节强制落在 pole 半平面（bend 分量由 pole 推导），膝盖/手肘不会反折。
 */
export function solveTwoBone(
  root: Vec3Tuple,
  mid: Vec3Tuple,
  end: Vec3Tuple,
  target: Vec3Tuple,
  poleDir: Vec3Tuple,
  maxReachScale = 0.999,
): TwoBoneResult {
  const rv = new THREE.Vector3(...root);
  const mv = new THREE.Vector3(...mid);
  const ev = new THREE.Vector3(...end);
  const tv = new THREE.Vector3(...target);

  const upper = mv.distanceTo(rv);
  const lower = ev.distanceTo(mv);
  if (upper < 1e-8 || lower < 1e-8) {
    throw new Error('IK chain has zero-length bone');
  }

  _r.copy(tv).sub(rv);
  const d0 = _r.length();
  const maxReach = (upper + lower) * maxReachScale;
  const minReach = Math.abs(upper - lower) + 1e-4;
  const d = THREE.MathUtils.clamp(d0, minReach, maxReach);
  const reached = d0 >= minReach && d0 <= maxReach;

  // 目标与 root 重合时退化为保持当前末端方向
  if (d0 < 1e-8) {
    _axis.copy(ev).sub(rv).normalize();
  } else {
    _axis.copy(_r).normalize();
  }

  // 弯曲平面法向分量：pole 在垂直于 axis 的分量
  _pole.set(...poleDir);
  if (_pole.lengthSq() < 1e-12) _pole.set(0, 0, 1);
  _pole.normalize();
  _bend.copy(_pole).addScaledVector(_axis, -_pole.dot(_axis));
  if (_bend.lengthSq() < 1e-8) {
    // pole 与 axis 平行，任选一个垂直方向
    _tmp.set(1, 0, 0);
    if (Math.abs(_axis.dot(_tmp)) > 0.9) _tmp.set(0, 0, 1);
    _bend.copy(_tmp).addScaledVector(_axis, -_tmp.dot(_axis));
  }
  _bend.normalize();

  // 余弦定理：root 处夹角
  const cosA = THREE.MathUtils.clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  const midSolved = rv.clone().addScaledVector(_axis, cosA * upper).addScaledVector(_bend, sinA * upper);
  const endSolved = rv.clone().addScaledVector(_axis, d);

  const cosH = THREE.MathUtils.clamp((upper * upper + lower * lower - d * d) / (2 * upper * lower), -1, 1);
  const hingeDeg = THREE.MathUtils.radToDeg(Math.acos(cosH));

  return {
    mid: [midSolved.x, midSolved.y, midSolved.z],
    end: [endSolved.x, endSolved.y, endSolved.z],
    dist: d,
    reached,
    hingeDeg,
  };
}

/** 由静息姿势推导默认极向量方向：取 mid 偏离 root→end 轴的分量；完全伸直时用启发式回退。 */
export function defaultPoleDir(
  root: Vec3Tuple,
  mid: Vec3Tuple,
  end: Vec3Tuple,
  fallback: Vec3Tuple,
): Vec3Tuple {
  const rv = new THREE.Vector3(...root);
  const mv = new THREE.Vector3(...mid);
  const ev = new THREE.Vector3(...end);
  const axis = ev.clone().sub(rv);
  if (axis.lengthSq() < 1e-12) return [...fallback] as Vec3Tuple;
  axis.normalize();
  const v = mv.clone().sub(rv);
  const perp = v.clone().addScaledVector(axis, -v.dot(axis));
  if (perp.length() < 1e-4 * v.length() + 1e-6) return [...fallback] as Vec3Tuple;
  perp.normalize();
  return [perp.x, perp.y, perp.z];
}
