import * as THREE from 'three';
import type { Vec3Tuple } from '../../types/global';

/**
 * 行走路径：按弧长采样位置与切线朝向。
 *
 * ## 之前的问题
 *
 * 通用走路的根位移是 `restPosition[2] + walkedZ + distance * progress`
 * —— **z 方向纯直线**，x 恒定。另一条分支（有道具交互）虽然用
 * `samplePolyline` 走折线，但**只移动髋骨、不给朝向**，所以身体不会跟着转。
 * 两条路都产不出「真人走弧线」的样子。
 *
 * ## 为什么要按弧长而不是按参数
 *
 * 折线各段长度不等时，按参数 t 均匀插值会让速度忽快忽慢（转弯处「刹车再冲」）。
 * 真人走弧线是**匀速**沿路径的，所以必须按累积弧长取样。
 *
 * ## 朝向约定
 *
 * 角色面朝 **+Z**（见 demo rig：`_L` 在 +X、面向 +Z）。
 * 故绕 Y 的偏航角 = `atan2(tangent.x, tangent.z)`。
 */
export interface PathSample {
  position: THREE.Vector3;
  /** 前进方向的单位向量（水平投影；退化时回退到 +Z） */
  tangent: THREE.Vector3;
  /** 绕 Y 偏航角（弧度），0 = 面朝 +Z */
  heading: number;
  /** 累计弧长（米） */
  arcLength: number;
}

/** 折线的累积弧长表，长度 = 点数。 */
export function arcLengths(points: Vec3Tuple[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const d = new THREE.Vector3(...points[i]).distanceTo(new THREE.Vector3(...points[i - 1]));
    out.push(out[i - 1] + d);
  }
  return out;
}

/** 路径总弧长（米）。 */
export function pathLength(points: Vec3Tuple[]): number {
  const l = arcLengths(points);
  return l[l.length - 1];
}

/**
 * 在指定弧长处采样路径。
 *
 * @param s 弧长（米），会被钳制到 [0, 总长]
 * @param smoothRadius 朝向平滑半径（米）。见下方说明。
 */
export function samplePathAtArcLength(points: Vec3Tuple[], s: number, smoothRadius = 0.45): PathSample {
  const fallback = (p: Vec3Tuple): PathSample => {
    const position = new THREE.Vector3(...p);
    return { position, tangent: new THREE.Vector3(0, 0, 1), heading: 0, arcLength: 0 };
  };
  if (points.length === 0) return fallback([0, 0, 0]);
  if (points.length === 1) return fallback(points[0]);

  const lengths = arcLengths(points);
  const total = lengths[lengths.length - 1];
  if (total < 1e-8) return fallback(points.at(-1)!);

  const d = Math.min(Math.max(s, 0), total);

  let seg = points.length - 2;
  for (let i = 0; i < points.length - 1; i++) {
    if (d <= lengths[i + 1] + 1e-9) { seg = i; break; }
  }
  const a = new THREE.Vector3(...points[seg]);
  const b = new THREE.Vector3(...points[seg + 1]);
  const segLen = Math.max(lengths[seg + 1] - lengths[seg], 1e-8);
  const ratio = (d - lengths[seg]) / segLen;

  const position = a.clone().lerp(b, ratio);
  // 朝向由平滑后的切线导出；切线只看水平分量（不该因地面高差就仰头前进）
  const tangent = smoothedTangent(points, lengths, total, d, smoothRadius);

  return {
    position,
    tangent,
    heading: Math.atan2(tangent.x, tangent.z),
    arcLength: d,
  };
}

/**
 * 平滑后的前进方向。
 *
 * ## 为什么必须平滑（实测发现的缺陷）
 *
 * 折线上每段切线是常量，所以航点处朝向**突变** —— 走起来是「机器人拐直角」。
 * 真人在弧线上身体朝向是**连续变化**的：进弯前就开始偏，出弯后才回正。
 *
 * 做法：在 `d ± radius` 的弧长窗口内对各段切线按长度加权平均。
 * 直线段上窗口内只有一段，结果不变；拐点处自然得到一个「圆角」方向的过渡。
 * 位置仍精确落在折线上，只平滑朝向 —— 不改变脚该踩在哪。
 *
 * @param radius 平滑窗口（米）。0 = 不平滑（分段常量，会突变）
 */
function smoothedTangent(
  points: Vec3Tuple[],
  lengths: number[],
  total: number,
  d: number,
  radius: number,
): THREE.Vector3 {
  if (radius <= 0 || points.length < 3) {
    return segTangent(points, tangentFallbackIndex(points, lengths, d));
  }
  const lo = Math.max(0, d - radius);
  const hi = Math.min(total, d + radius);

  const acc = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i++) {
    const segLo = lengths[i];
    const segHi = lengths[i + 1];
    if (segHi < lo || segLo > hi) continue;
    // 段与窗口的重叠长度作为权重
    const overlap = Math.min(segHi, hi) - Math.max(segLo, lo);
    if (overlap <= 1e-9) continue;
    acc.addScaledVector(segTangent(points, i), overlap);
  }
  if (acc.lengthSq() < 1e-10) return new THREE.Vector3(0, 0, 1);
  acc.y = 0;
  return acc.normalize();
}

/** 第 i 段的单位水平切线；退化时回退到 +Z。 */
function segTangent(points: Vec3Tuple[], i: number): THREE.Vector3 {
  const a = new THREE.Vector3(...points[i]);
  const b = new THREE.Vector3(...points[Math.min(i + 1, points.length - 1)]);
  const t = b.clone().sub(a);
  t.y = 0;
  if (t.lengthSq() < 1e-10) t.set(0, 0, 1);
  return t.normalize();
}

/** 找出弧长 d 落在第几段（退化路径时给出合法下标）。 */
function tangentFallbackIndex(points: Vec3Tuple[], lengths: number[], d: number): number {
  for (let i = 0; i < points.length - 1; i++) if (d <= lengths[i + 1] + 1e-9) return i;
  return Math.max(0, points.length - 2);
}

/** 路径在指定弧长处的朝向（弧度）。 */
export function headingAtArcLength(points: Vec3Tuple[], s: number): number {
  return samplePathAtArcLength(points, s).heading;
}

/**
 * 走完 `progress ∈ [0,1]`（时间进度）对应的弧长。
 *
 * 用 **time → 弧长** 的等速映射，而不是等参数映射：
 * 参数映射在「折线各段不等长」时会产生速度脉动。
 */
export function arcLengthForProgress(points: Vec3Tuple[], progress: number): number {
  return pathLength(points) * Math.min(Math.max(progress, 0), 1);
}

/**
 * 把一条直线「掰弯」——用于在只有起点/终点时生成弧线。
 *
 * ## 为什么需要
 *
 * 大多数走位调用方只给起点和终点（`[from, target]`）。直接插值是直线，
 * 真人不会这样走。给中点一个法向偏移就得到一条自然的弧线。
 *
 * ## 偏移量怎么定
 *
 * `bow` 是**弦高的比例**（0=直线，0.15≈轻微弧）。中点沿
 * 「弦中点→法向」方向偏移 `bow × 弦长`。法向取垂直于弦的水平方向，
 * 并优先绕向**当前朝向的一侧**（人转弯有偏好侧，不是随机左右）。
 *
 * @param from 起点
 * @param to  终点
 * @param bow  弦高比例；0 时退化为原直线
 * @param preferredSide 优先弯曲侧：+1 / -1；null 时按 x 符号取默认
 */
export function bowedRoute(
  from: Vec3Tuple,
  to: Vec3Tuple,
  bow = 0.12,
  preferredSide?: 1 | -1,
): Vec3Tuple[] {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const chord = b.clone().sub(a);
  const flatLen = Math.hypot(chord.x, chord.z);
  if (flatLen < 1e-6 || Math.abs(bow) < 1e-6) return [[...from], [...to]];

  const chordMid = a.clone().add(b).multiplyScalar(0.5);
  // 水平法向 = 弦的水平方向逆时针转 90°
  const dirXZ = new THREE.Vector3(chord.x, 0, chord.z).normalize();
  const normal = new THREE.Vector3(-dirXZ.z, 0, dirXZ.x);
  const side = preferredSide ?? (normal.x >= 0 ? 1 : -1);

  const mid = chordMid.addScaledVector(normal, side * bow * flatLen);
  mid.y = (a.y + b.y) / 2;
  return [[...from], [mid.x, mid.y, mid.z] as Vec3Tuple, [...to]];
}

/**
 * 沿路径的朝向变化率（弧度/米）——用来判断「这个弯人能不能走得过去」。
 *
 * 真人步行的最小转弯半径约 0.5m（原地转不算走）。
 * 曲率 > 2 rad/m（半径 < 0.5m）意味着必须减速或原地转，应改走别处。
 */
export function maxPathCurvature(points: Vec3Tuple[]): number {
  if (points.length < 3) return 0;
  let maxK = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = new THREE.Vector3(...points[i - 1]).setY(0);
    const b = new THREE.Vector3(...points[i]).setY(0);
    const c = new THREE.Vector3(...points[i + 1]).setY(0);
    const ab = b.clone().sub(a);
    const bc = c.clone().sub(b);
    const l1 = ab.length();
    const l2 = bc.length();
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cross = Math.abs(ab.x * bc.z - ab.z * bc.x);
    // 三角形外接圆半径 R = (l1·l2·l3)/(2·cross)，曲率 = 1/R
    const l3 = c.clone().sub(a).length();
    const area2 = cross;
    if (area2 < 1e-9) continue;
    const R = (l1 * l2 * l3) / (2 * area2);
    maxK = Math.max(maxK, 1 / Math.max(R, 1e-6));
  }
  return maxK;
}

/** 最小可行转弯半径（米）：普通人步行约 0.5m。 */
export const MIN_TURN_RADIUS = 0.5;