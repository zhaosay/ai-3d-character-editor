/**
 * 坐姿腿角解算（纯函数、无 THREE 依赖、可单测）。
 *
 * 解决的问题：`sit` 模板原先用**固定欧拉角**（thigh −72°/shin +68°），
 * 但髋目标高度随座面变化（坐地面 0.13m、坐椅 0.60m、坐高凳 0.88m），
 * 固定角只可能对**一个**座高正确 —— 实测插地 22.8~56.5cm，且脚 pitch 恒 34°。
 *
 * 做法：平面两连杆（serial chain）反解。已知髋关节位置、期望脚底落点、
 * 两段腿长，求两个关节角，使 ①脚底贴地 ②膝向前凸 ③脚掌平贴。
 */

/** 骨骼局部角（前倾为负）↔ 世界前倾角（自铅垂向下量，向前为正）的关系基准。 */
const DEG = Math.PI / 180;

export interface LegChain {
  /** thigh→shin 骨长（米） */
  upper: number;
  /** shin→foot 骨长（米） */
  lower: number;
  /** 髋骨中心到髋关节（thigh 原点）的垂直距离（米） */
  hipDrop: number;
  /** 小腿静息姿态相对铅垂的前倾偏置（度），用于换算 shin/foot 局部角 */
  shinBiasDeg: number;
  /** 脚骨原点高于脚底的量（米） */
  ankleAboveSole: number;
}

export interface SitTargets {
  /** 脚底期望高度（世界 Y，通常是地面） */
  groundY: number;
  /** 髋骨中心期望高度（世界 Y） */
  hipY: number;
  /** 脚相对髋关节的前伸量（米） */
  reach: number;
}

export interface SitSolution {
  /** thigh 局部欧拉角（度，X 轴） */
  thighDeg: number;
  /** shin 局部欧拉角（度，X 轴） */
  shinDeg: number;
  /** foot 局部欧拉角（度，X 轴），使世界脚 pitch ≈ 0 */
  footDeg: number;
  /** 世界小腿前倾角（度） */
  shinWorldDeg: number;
  /** 实际前伸量（米） */
  actualReach: number;
  /** 脚离地量（米，>0 = 悬空，座面过高时无解的物理结果） */
  float: number;
  /** 退化原因，无退化为 null */
  degraded: null | 'seat-too-high' | 'limits-infeasible';
  /** 膝前凸量（叉积），> 0 表示膝盖向前（解剖正确） */
  kneeBulge: number;
}

/** 骨长可达范围 */
function reachOf(c: LegChain): { max: number; min: number } {
  return { max: c.upper + c.lower, min: Math.abs(c.upper - c.lower) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 闭式解。
 *
 * 竖直跨距（唯一等式，2 个未知数）：
 *   L1·cosθ1 + L2·cosθ2 = Δ,  Δ = hipJointY − (groundY + ankleAboveSole)
 * 前伸量（由用户给，用于选择「腿伸多远」）：
 *   d = L1·sinθ1 + L2·sinθ2
 *
 * 令 D = hypot(d, Δ)，用标准两连杆 IK：
 *   β  = acos((D² − L1² − L2²) / (2·L1·L2))      膝内角
 *   ψ  = atan2(d, Δ)                            目标方位角
 *   γ  = acos((D² + L1² − L2²) / (2·D·L1))      大腿相对目标的偏角
 *   θ1 = ψ + γ（膝前凸分支）
 *   θ2 = θ1 − β
 */
export function solveSitLeg(chain: LegChain, targets: SitTargets): SitSolution | null {
  const { upper: L1, lower: L2 } = chain;
  if (!(L1 > 1e-4) || !(L2 > 1e-4)) return null;

  // 髋关节（thigh 原点）位置：随 hips 俯仰前移到髋骨后方并抬高
  const hipDropY = chain.hipDrop;
  const hipJointY = targets.hipY - hipDropY;
  const requiredDrop = hipJointY - (targets.groundY + chain.ankleAboveSole);
  const { max: maxReach, min: minReach } = reachOf(chain);

  const fallBack = (reason: 'seat-too-high' | 'limits-infeasible', float: number, actualReach: number): SitSolution => {
    // 退化：腿尽量伸直下垂（世界竖直），膝弯最小，脚离地。
    // acos 的参数钳到 [-1,1] 后可能得到负角（腿需"向后"才能够到），
    // 这里夹到 [0, 150]，保证输出始终在解剖范围内。
    const shinWorld = 0;
    const cosThigh = clamp((requiredDrop - L2) / L1, -1, 1);
    const thighWorld = clamp(Math.acos(cosThigh) / DEG, 0, 150);
    return {
      thighDeg: -thighWorld,
      shinDeg: shinWorld - chain.shinBiasDeg,
      footDeg: -chain.shinBiasDeg,
      shinWorldDeg: shinWorld,
      actualReach,
      float,
      degraded: reason,
      kneeBulge: 0,
    };
  };

  // 座面过高：Δ 超出腿长之和，数学上无解
  if (requiredDrop > maxReach) {
    return fallBack('seat-too-high', requiredDrop - maxReach, 0);
  }
  // 目标过近：Δ 落到 [0, minReach] 之内
  if (requiredDrop < minReach) {
    return fallBack('limits-infeasible', 0, 0);
  }

  // 目标距离 D；超出可达范围时**等比缩短前伸量**（保持方向不变），
  // 而不是直接退化 —— 否则解不自洽，膝前凸量会变成 0。
  const dRaw = Math.max(0, Number.isFinite(targets.reach) ? targets.reach : 0);
  let D = Math.hypot(dRaw, requiredDrop);
  let d = dRaw;
  if (D > maxReach) {
    // 等比缩到可达边界
    const k = maxReach / D;
    D = maxReach;
    d = dRaw * k;
  } else if (D < minReach) {
    const k = minReach / D;
    D = minReach;
    d = dRaw * k;
  }

  // 关节极限：thigh 世界倾角 ≤ 150°（髋俯仰另计），shin 内角 β ≤ 155° − shinBias
  const shinLimitDeg = 155 - chain.shinBiasDeg;
  const cosBeta = (D * D - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  const beta = Math.acos(clamp(cosBeta, -1, 1)) / DEG;
  if (beta > shinLimitDeg) {
    // 膝弯要求超出极限：取极限值，让脚略高于/低于地面
    return fallBack('limits-infeasible', 0, 0);
  }

  const psi = Math.atan2(d, requiredDrop);
  const cosGamma = (D * D + L1 * L1 - L2 * L2) / (2 * D * L1);
  const gamma = Math.acos(clamp(cosGamma, -1, 1));
  const thighWorld = (psi + gamma) / DEG;
  const shinWorld = thighWorld - beta;

  if (thighWorld > 150) {
    return fallBack('limits-infeasible', 0, 0);
  }

  // 换算回局部欧拉：局部角 = −世界前倾角 − hips 俯仰
  // hips 俯仰取 0（sit 模板的 hips 角不参与腿的几何，髋位移包络已单独处理）
  const thighDeg = -thighWorld;
  const shinDeg = beta + chain.shinBiasDeg;
  // 世界脚 pitch = shinWorld − shinBias + footDeg，目标是 0
  const footDeg = chain.shinBiasDeg - shinWorld;

  // 实际竖直跨距与前伸（回代验证）
  const rad = (v: number) => v * DEG;
  const actualDrop = L1 * Math.cos(rad(thighWorld)) + L2 * Math.cos(rad(shinWorld));
  const actualReach = L1 * Math.sin(rad(thighWorld)) + L2 * Math.sin(rad(shinWorld));
  const soleY = hipJointY - actualDrop - chain.ankleAboveSole;
  const float = soleY - targets.groundY;

  // 膝前凸量 = 三角形（髋-膝-踝）面积的两倍 = L1·L2·sin(β)/D
  const betaRad = beta * DEG;
  const kneeBulge = (L1 * L2 * Math.sin(betaRad)) / Math.max(D, 1e-6);

  return {
    thighDeg,
    shinDeg,
    footDeg,
    shinWorldDeg: shinWorld,
    actualReach,
    float,
    // 腿伸直到极限仍够不着地面（前伸被压缩、膝已接近伸直）时如实标记
    degraded: Math.abs(float) > 0.01 ? 'limits-infeasible' : null,
    kneeBulge,
  };
}

/**
 * 髋部高度包络：由「腿在进度 e 时的竖直跨距」反解，
 * 使脚底在整个过渡过程中保持贴地（否则终态对、中途仍插地）。
 *
 * `ease` 必须与 procedural 驱动腿角时用的曲线**完全一致**
 * （默认 smoothstep），否则角度与跨距错位会插地。
 *
 * 注意 e=0 必须还原**站立腿**（世界竖直、跨距 = L1+L2），
 * 而不是「坐姿角 × 0」—— 否则过渡起点会比站立实际高度低 38cm。
 */
export function hipHeightFromLegSpan(
  chain: LegChain,
  progress: number,
  solution: SitSolution,
  groundY: number,
  ease: (t: number) => number = (t) => t * t * (3 - 2 * t),
): number {
  const e = clamp(ease(clamp(progress, 0, 1)), 0, 1);
  const rad = (v: number) => v * DEG;
  // 站立时的世界前倾角为 0；坐姿时为解算值。按 ease 插值。
  const thighWorld = solution.thighDeg < 0 ? -solution.thighDeg * e : 0;
  const shinWorld = solution.shinWorldDeg * e;
  const span = chain.upper * Math.cos(rad(thighWorld)) + chain.lower * Math.cos(rad(shinWorld));
  return groundY + chain.ankleAboveSole + span + chain.hipDrop;
}

/**
 * 给定**任意**世界前倾角下的髋骨高度（脚底贴地时）。
 *
 * 与 `hipHeightFromLegSpan` 的区别：后者只认「站立 → 某个已解出的坐姿」这条路径；
 * 而 squat / kneel 的腿角是**人为选定的**（不求解），仍需要据此反推髋该降到多高，
 * 否则只能写死一个深度魔数（实测身高 1.55/1.75/1.95m 时 kneel 脚分别悬空
 * 28.4/37.7/47.0cm，squat 插地 8.0/4.7/1.5cm）。
 *
 * @param thighWorldDeg 大腿世界前倾角（向前为正）
 * @param shinWorldDeg 小腿世界前倾角（向前为正）
 */
export function hipHeightForWorldAngles(
  chain: LegChain,
  thighWorldDeg: number,
  shinWorldDeg: number,
  groundY: number,
): number {
  const rad = (v: number) => v * DEG;
  const span = chain.upper * Math.cos(rad(thighWorldDeg)) + chain.lower * Math.cos(rad(shinWorldDeg));
  return groundY + chain.ankleAboveSole + span + chain.hipDrop;
}

/**
 * 跪姿专用：接触点是**小腿/膝**而不是脚底。
 *
 * 跪地时解剖上膝盖与小腿前侧着地、脚背朝后翘起，**脚底离地几十厘米是正确的**。
 * 用脚底当接触面去反解会得到悬空的脚（本项目曾把 kneel 写成脚悬空 20~47cm）。
 * 这里用「小腿长度 × cos(小腿世界角)」作为竖直跨距，使小腿贴地。
 *
 * @param shinWorldDeg 小腿世界前倾角（向前为正）
 */
export function hipHeightForKneel(
  chain: LegChain,
  thighWorldDeg: number,
  shinWorldDeg: number,
  groundY: number,
): number {
  const rad = (v: number) => v * DEG;
  // 触地的是小腿中段，接触高度取小腿骨长的一小截（半径量级）
  const shinContact = chain.lower * Math.cos(rad(shinWorldDeg));
  const thighSpan = chain.upper * Math.cos(rad(thighWorldDeg));
  return groundY + shinContact + thighSpan + chain.hipDrop;
}

/** 站立时（e=0）的髋高，供调用方确认起点一致。 */
export function standingHipHeight(chain: LegChain, groundY: number): number {
  return groundY + chain.ankleAboveSole + chain.upper + chain.lower + chain.hipDrop;
}
