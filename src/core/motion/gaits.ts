/**
 * 真人运动基元（纯函数，无 THREE 依赖，可单测）。
 *
 * 对照开源方案总结的四条核心规律（见 README「动作真实度」）：
 * 1. Anticipation 预备：动作前先反向蓄力
 * 2. Follow-through 跟随：到位后轻微过冲再回落
 * 3. Proximal-to-Distal 近端先动：肩→肘→腕 依次延迟
 * 4. Breath Coupling 呼吸耦合：胸廓起伏带动肩与头微动
 */

/** 把进度钳制到 0..1。 */
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 平滑步进：两端一阶导为 0，用于起止不突兀。 */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 更柔的三次平滑（首尾二阶导为 0），用于呼吸等大摆幅。 */
export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** 0→1→0 的钟形包络，峰值在 peak（默认中点）。 */
export function bell(t: number, peak = 0.5): number {
  const x = clamp01(t);
  if (x <= peak) return peak === 0 ? 1 : smoothstep(x / peak);
  return peak >= 1 ? 0 : smoothstep((1 - x) / (1 - peak));
}

export interface AnticipationOptions {
  /** 预备占比（占整段时长） */
  windup?: number;
  /** 预备的反向幅度比例（0.25 = 动作幅度的 25%） */
  windupAmount?: number;
  /** 跟随占比 */
  settle?: number;
  /** 跟随的过冲比例 */
  overshoot?: number;
}

/**
 * 预备-执行-跟随包络，输出 -1..1+ 的缩放曲线：
 *   [0, w)     反向蓄力到 -windupAmount
 *   [w, 1-s)   主动作 0 → 1
 *   [1-s, 1]   过冲 1+overshoot → 回到 1
 * 起止均为 0（无动作时不产生偏移），符合真人的「动前先静、动后归位」。
 */
export function anticipationEnvelope(t: number, opts: AnticipationOptions = {}): number {
  const windup = clamp01(opts.windup ?? 0.12);
  const settle = clamp01(opts.settle ?? 0.18);
  const windupAmount = opts.windupAmount ?? 0.22;
  const overshoot = opts.overshoot ?? 0.12;
  const x = clamp01(t);
  if (x === 0 || x === 1) return 0;
  if (windup > 0 && x < windup) return -windupAmount * smoothstep(x / windup);
  const settleStart = 1 - settle;
  if (settle > 0 && x > settleStart) {
    // 跟随段：轻微过冲后衰减回 1
    const k = (x - settleStart) / settle;
    return 1 + overshoot * (1 - smoothstep(k));
  }
  // 主动作段：在前 45% 内升到 1，之后保持 —— 到位后不该继续缓升
  const rise = windup + (settleStart - windup) * 0.45;
  return smoothstep((x - windup) / Math.max(1e-6, rise - windup));
}

/** 近端先动：t 是整体进度，delay 是该关节相对延迟（占整段比例）。 */
export function proximalDelay(t: number, delay: number): number {
  return clamp01((t - delay) / Math.max(1e-6, 1 - delay));
}

export interface BreathOptions {
  /** 呼吸频率（次/秒），真人静息约 0.25Hz（15 次/分） */
  hz?: number;
  /** 幅度比例（相对动作幅度） */
  amount?: number;
  /** 整体时间（秒） */
  time?: number;
}

/**
 * 呼吸信号：返回 0..1 的胸廓起伏，驱动胸+肩+头。
 * 用两个不同频率叠加（主频 + 次谐波）避免机械的正弦感。
 */
export function breathSignal(time: number, opts: BreathOptions = {}): number {
  const hz = opts.hz ?? 0.25;
  const amount = opts.amount ?? 1;
  const t = time * hz * Math.PI * 2;
  return amount * (0.82 * Math.sin(t) + 0.18 * Math.sin(t * 2 + 0.6));
}

// ---- 步态周期 ----

export interface GaitOptions {
  /** 腿长（米），用于由步幅推导周期 */
  legLength?: number;
  /** 步幅（米），单步 */
  stride?: number;
}

/**
 * 由步幅/腿长推导步态周期（秒/单步）。
 * 真人经验：单步时长 ≈ 0.45–0.55s；步幅越大周期越长但次线性。
 */
export function gaitPeriod(opts: GaitOptions = {}): number {
  const legLength = opts.legLength ?? 0.85;
  const stride = opts.stride ?? 0.62;
  const ratio = Math.max(0.35, Math.min(1.6, stride / Math.max(0.2, legLength * 0.7)));
  return 0.5 * Math.pow(ratio, 0.35);
}

export interface GaitSample {
  /** 大腿摆动（度） */
  thigh: number;
  /** 小腿屈膝（度，正值=屈膝） */
  knee: number;
  /** 脚踝（度） */
  ankle: number;
  /** 髋部垂直起伏（米，负=下沉） */
  hipLift: number;
  /** 骨盆左右扭转（度） */
  pelvisYaw: number;
  /** 手臂摆动（度） */
  armSwing: number;
  /** 肘部屈曲（度） */
  elbow: number;
}

/**
 * 单腿一整步（0..1）的关节轨迹。phase 为该腿在步态中的相位偏移（0 或 0.5）。
 *
 * 真人步态的关键细节：
 * - 支撑期(0–0.6)：膝近乎伸直，脚跟先着地→全脚掌，髋由后摆到前
 * - 摆动期(0.6–1)：**先快速屈膝抬腿**，再伸膝落地（这是最容易被做错的地方）
 * - 髋部起伏是 2× 步频：双支撑相(0 与 0.5)最低，单支撑相最高
 */
export function gaitLeg(phase: number, opts: GaitOptions = {}): GaitSample {
  const p = ((phase % 1) + 1) % 1;
  const swingStart = 0.6;
  const isSwing = p >= swingStart;
  const u = isSwing ? (p - swingStart) / (1 - swingStart) : p / swingStart;
  // 摆幅与步幅成比例；腿越长需要更大的摆幅才能达到同样步幅
  const legLength = opts.legLength ?? 0.85;
  const stride = opts.stride ?? 0.62;
  const amp = Math.max(0.6, Math.min(1.5, stride / (legLength * 0.62)));

  let thigh: number;
  let knee: number;
  let ankle: number;

  if (!isSwing) {
    // 支撑期：大腿从后(负)摆到前(正)，膝基本伸直
    thigh = (-18 + 36 * smoothstep(u)) * amp;
    // 支撑中期有轻微屈膝缓冲（承重），不是完全笔直
    knee = 6 + 4 * Math.sin(Math.PI * u);
    // 脚跟落地(负) → 全脚掌(平) → 蹬离(正)
    ankle = -12 * (1 - smoothstep(clamp01(u / 0.3))) + 22 * smoothstep(clamp01((u - 0.65) / 0.35));
  } else {
    // 摆动期：大腿继续前摆，膝**先屈后伸**
    thigh = (18 + 10 * smoothstep(u)) * amp;
    // 屈膝峰值在摆动中前段，之后伸膝准备落地 —— 真人与机器人最容易的差别就在这里
    const flex = bell(u, 0.42);
    knee = 6 + 58 * flex;
    // 摆动前期勾脚尖避免绊倒，落地前踝背伸
    ankle = 14 * bell(u, 0.35) - 10 * smoothstep(clamp01((u - 0.6) / 0.4));
  }

  // 髋部起伏：2× 步频。相位 0/0.5 是双支撑相（双脚着地）→ 骨盆最低；
  // 单支撑相（0.25/0.75）骨盆最高。用 -cos 保证 0/0.5 为最低点。腿越长起伏越大。
  const hipLift = (0.022 - 0.044 * Math.abs(Math.cos(Math.PI * 2 * p))) * (legLength / 0.85);
  // 骨盆随支撑腿反向扭转
  const pelvisYaw = 6 * Math.cos(Math.PI * 2 * p);

  const armSwing = 20 * amp * Math.cos(Math.PI * 2 * p);
  // 真人摆臂时肘始终微屈（15–25°），不是完全伸直
  const elbow = 18 + 8 * Math.sin(Math.PI * 2 * p);

  return { thigh, knee, ankle, hipLift, pelvisYaw, armSwing, elbow };
}

/** 全身步态：左右腿反相（相差半个周期），手臂与同侧腿反相。 */
export function gaitCycle(phase: number, opts: GaitOptions = {}): { left: GaitSample; right: GaitSample; hipLift: number; pelvisYaw: number } {
  const left = gaitLeg(phase, opts);
  const right = gaitLeg(phase + 0.5, opts);
  return {
    left,
    right,
    // 髋部起伏取两腿较高者（支撑腿决定骨盆高度）
    hipLift: Math.max(left.hipLift, right.hipLift),
    // 骨盆扭转取左腿信号
    pelvisYaw: left.pelvisYaw,
  };
}
