import * as THREE from 'three';
import type { SampledPose, SampledTransform } from './sampler';
import type { Vec3Tuple, QuatTuple } from '../../types/global';

/**
 * 动画交叉淡化（cross-fade / blend）。
 *
 * 之前切换动画是**硬切**：走路 → 停步时角色瞬间回到站立姿势，像滑块。
 * 真实游戏角色需要一段混合期；Unity 里对应 Animation Controller 的
 * 「过渡时间」，文章里的说法是「有退出时间=丝滑，无退出时间=飘移」。
 *
 * ## 关键陷阱：骨骼集合不匹配
 *
 * `sampleAnimation` 只为**轨道里出现的骨骼**产出条目，且某通道无关键帧时
 * 整个通道被省略（sampler.ts）。若直接「先应用 A 再应用 B」：
 *   - 只在 A 里有轨道的骨骼 → B 不写它 → **沿用 A 的旧值**（不是回到静息）
 *   - 旋转轨道有、位移轨道空的（retarget 产物就是 rotation-only）
 *     → 位移/缩放沿用上一次写入的值
 *
 * 所以混合必须**取骨骼名并集**，缺失通道用**静息值**兜底，
 * 否则淡化过程中会出现「某些骨突然弹回静息」。
 */

/** 静息兜底：某骨骼某通道在某个 clip 里缺失时用它。 */
export type RestFallback = Map<string, {
  position?: Vec3Tuple;
  quaternion?: QuatTuple;
  scale?: Vec3Tuple;
}>;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function slerpToOut(out: THREE.Quaternion, a: QuatTuple, b: QuatTuple, w: number): void {
  _qa.fromArray(a);
  _qb.fromArray(b);
  out.copy(_qa).slerp(_qb, w);
}

/**
 * 混合两个采样姿态。
 *
 * @param w 0 = 完全 a，1 = 完全 b
 * @param rest 缺失通道的兜底；不给则缺失通道**不写入**（保持调用方旧值）
 */
export function blendPoses(a: SampledPose, b: SampledPose, w: number, rest?: RestFallback): SampledPose {
  const t = w < 0 ? 0 : w > 1 ? 1 : w;
  const out: SampledPose = new Map();
  const names = new Set<string>([...a.keys(), ...b.keys()]);
  const q = new THREE.Quaternion();
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();

  for (const name of names) {
    const ta = a.get(name) as SampledTransform | undefined;
    const tb = b.get(name) as SampledTransform | undefined;
    const rf = rest?.get(name);
    const merged: SampledTransform = {};

    // 旋转：缺失的一侧用静息兜底，否则混合结果会偏向「有轨道的那一侧」
    const qa = ta?.quaternion ?? rf?.quaternion;
    const qb = tb?.quaternion ?? rf?.quaternion;
    /**
     * 只有**两侧都拿得到**才混合；否则直接沿用存在的那一侧。
     * 不能因为对侧缺这个通道就把整根骨丢掉 —— 否则淡化过程中
     * 只属于来源 clip 的骨会突然「消失」（表现为该骨保持上一帧旧值）。
     */
    if (qa && !qb) merged.quaternion = [...qa] as QuatTuple;
    else if (qb && !qa) merged.quaternion = [...qb] as QuatTuple;
    else if (qa && qb) {
      if (t <= 0) merged.quaternion = [...qa] as QuatTuple;
      else if (t >= 1) merged.quaternion = [...qb] as QuatTuple;
      else {
        slerpToOut(q, qa, qb, t);
        merged.quaternion = [q.x, q.y, q.z, q.w];
      }
    }

    for (const key of ['position', 'scale'] as const) {
      const va0 = (ta?.[key] ?? rf?.[key]) as Vec3Tuple | undefined;
      const vb0 = (tb?.[key] ?? rf?.[key]) as Vec3Tuple | undefined;
      if (va0 && !vb0) { merged[key] = [...va0] as Vec3Tuple; continue; }
      if (vb0 && !va0) { merged[key] = [...vb0] as Vec3Tuple; continue; }
      if (!va0 || !vb0) continue;
      if (t <= 0) merged[key] = [...va0] as Vec3Tuple;
      else if (t >= 1) merged[key] = [...vb0] as Vec3Tuple;
      else {
        va.fromArray(va0);
        vb.fromArray(vb0);
        va.lerp(vb, t);
        merged[key] = [va.x, va.y, va.z];
      }
    }

    if (merged.quaternion ?? merged.position ?? merged.scale) out.set(name, merged);
  }
  return out;
}

/** 混合面部 morph 权重（键为 `meshPath#targetName`）。 */
export function blendFaceWeights(
  a: Map<string, number>,
  b: Map<string, number>,
  w: number,
): Map<string, number> {
  const t = w < 0 ? 0 : w > 1 ? 1 : w;
  const out = new Map<string, number>();
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const va = a.get(k);
    const vb = b.get(k);
    // 缺失的一侧视为 0（表情没有「静息」概念，未出现即不施加）
    const x = va ?? 0;
    const y = vb ?? 0;
    // 端点必须原样保留（包括 0）：混合结果要能正确覆盖上一个动画的表情，
    // 只写「非零」会让上一个动画残留的表情留在脸上。
    out.set(k, t <= 0 ? x : t >= 1 ? y : x + (y - x) * t);
  }
  return out;
}

/** 淡入淡出权重曲线：smoothstep，避免线性过渡的「机械感」。 */
export function fadeWeight(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 1;
  const t = elapsed <= 0 ? 0 : elapsed >= duration ? 1 : elapsed / duration;
  return t * t * (3 - 2 * t);
}

/**
 * 退出时间 → 源 clip 上的归一化进度。
 *
 * Unity 的「退出时间」是**归一化**的（0..1 的 clip 进度），不是绝对秒数，
 * 这样同一条过渡对不同时长的 clip 都成立。
 *
 * 注意 loop 归一化下 `currentTime` 已由调用方 wrap 到 [0, duration)，
 * 这里不再判断 loop —— 循环播放时 t 到 1 就会自然满足退出条件。
 */
export function exitTimeProgress(
  currentTime: number,
  clipDuration: number,
  exitTime: number,
): boolean {
  if (!(clipDuration > 0)) return false;
  const t = Math.max(0, Math.min(1, currentTime / clipDuration));
  return t >= exitTime;
}