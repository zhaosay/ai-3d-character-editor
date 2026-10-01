/**
 * 动画状态机骨架（对应 Unity 的 Animation Controller 模型）。
 *
 * 之前切换动画只有一种方式：`selectAnimation(id)` → `currentTime = 0, playing = false`，
 * 即**硬切**。这导致走路→停步时角色瞬间弹回站立姿势。
 *
 * 本文采用 Unity 的核心概念（细节见 DirectorDesk 与常见实践）：
 * - **Entry**：初始状态
 * - **Any State**：任意状态都能跳过去（受击/死亡这类**强制打断**）
 * - **触发器**：一个布尔参数（`isJump`、`isHit`…）决定是否切换
 * - **退出时间**：源动作播到归一化进度后才允许切（=丝滑）
 *   无退出时间 = 立即切（=飘移/受击该有的硬切）
 * - **过渡时间**：两个动作的混合时长（交叉淡化）
 *
 * 这里是**纯数据 + 纯函数**：不碰 store、不碰 three.js，便于单测与序列化。
 */

export interface StateDef {
  /** 状态 id（内部引用用，不要求等于动画 id） */
  id: string;
  /** 对应动画 */
  animationId: string;
  /** 该状态是否循环；不填用全局 loop 设置 */
  loop?: boolean;
  /** 播放速度倍率 */
  speed?: number;
}

export interface TransitionDef {
  /** 源状态 id；`ANY` 表示「任意状态」（打断） */
  from: string;
  to: string;
  /**
   * 触发器参数名。为空则表示「自动」：源动作走到退出时间就切。
   * 有触发器时要求 `params[trigger] === expectedTriggerValue`。
   */
  trigger?: string;
  /**
   * 触发极性，默认 true。
   * Unity 的 bool 触发器只能表达「变为 true」；但**停**（走路→站立）
   * 天然是「isMoving 变为 false」，所以需要能表达反向触发。
   */
  triggerValue?: boolean;
  /** 自动触发所需的额外条件参数名（可选） */
  condition?: string;
  /** 退出时间，归一化 0..1；0 = 立即 */
  exitTime?: number;
  /** 过渡时长（秒）= 交叉淡化时长 */
  duration: number;
}

export interface StateMachineDef {
  entry: string;
  states: StateDef[];
  transitions: TransitionDef[];
}

/** 触发打断的状态 id（对应 Unity 的 Any State）。 */
export const ANY_STATE = 'ANY';

export interface MachineRuntime {
  /** 当前状态 id */
  state: string;
  /** 当前动作在 clip 内的时间（秒） */
  time: number;
  /** 淡化中的来源状态；null = 未在淡化 */
  fadingFrom: string | null;
  /** 来源动作在 clip 内的时间（淡化期间继续推进） */
  fadingFromTime: number;
  /** 淡化已进行时长（秒） */
  fadeElapsed: number;
  /** 淡化总时长（秒） */
  fadeDuration: number;
}

export function createMachine(def: StateMachineDef): MachineRuntime {
  return {
    state: def.entry,
    time: 0,
    fadingFrom: null,
    fadingFromTime: 0,
    fadeElapsed: 0,
    fadeDuration: 0,
  };
}

function stateDef(def: StateMachineDef, id: string): StateDef | undefined {
  return def.states.find((s) => s.id === id);
}

export interface StepContext {
  /** 外部参数（触发器/条件），key 为参数名 */
  params?: Record<string, boolean>;
  /** 当前 clip 时长（秒）；给定则按退出时间自动触发 */
  clipDuration?: number;
  /** 源 clip 是否循环 */
  loop?: boolean;
}

export interface StepResult {
  runtime: MachineRuntime;
  /** 本帧是否发生了状态切换 */
  changed: boolean;
}

/**
 * 推进状态机一帧。
 *
 * 优先级：**Any State 打断优先于当前状态的正常过渡** —— 这正是受击/死亡
 * 要能打断任何动作的原因（不能等攻击播完才挨打）。
 */
export function stepMachine(
  rt: MachineRuntime,
  def: StateMachineDef,
  ctx: StepContext,
  delta: number,
): StepResult {
  const params = ctx.params ?? {};
  const current = stateDef(def, rt.state);
  const speed = current?.speed ?? 1;
  const loop = current?.loop ?? ctx.loop ?? true;
  const dur = ctx.clipDuration ?? 0;

  // 推进两个 playhead
  let time = rt.time + delta * speed;
  let fromTime = rt.fadingFromTime + delta * speed;
  let fadeElapsed = rt.fadeElapsed;

  // 源 clip 循环处理：淡出中的动作**不能 wrap**，否则会突然跳回第一帧
  const normalize = (t: number): number => {
    if (dur <= 0) return t;
    if (t < dur) return t;
    return loop ? t % dur : dur;
  };
  time = normalize(time);
  if (rt.fadingFrom) fromTime = Math.min(fromTime, dur > 0 ? dur : fromTime);

  // 正在淡化：无论是否切换都继续推进
  if (rt.fadingFrom) fadeElapsed = Math.min(rt.fadeDuration, fadeElapsed + delta);

  const base: MachineRuntime = { ...rt, time, fadingFromTime: fromTime, fadeElapsed };

  // 1) Any State 打断
  const interrupted = pickTransition(def, ANY_STATE, rt.state, params, time, dur, false);
  // 2) 当前状态的正常过渡
  const normal = interrupted ?? pickTransition(def, rt.state, rt.state, params, time, dur, true);

  if (!normal) {
    return { runtime: { ...base, fadingFrom: rt.fadingFrom, fadeDuration: rt.fadeDuration }, changed: false };
  }

  return {
    runtime: {
      state: normal.to,
      time: 0,
      fadingFrom: rt.fadingFrom ?? rt.state,
      fadingFromTime: time,
      fadeElapsed: rt.fadingFrom ? fadeElapsed : 0,
      fadeDuration: rt.fadingFrom ? rt.fadeDuration : normal.duration,
    },
    changed: true,
  };
}

function pickTransition(
  def: StateMachineDef,
  fromId: string,
  currentStateId: string,
  params: Record<string, boolean>,
  time: number,
  dur: number,
  respectExitTime: boolean,
): TransitionDef | undefined {
  const candidates = def.transitions.filter((t) => t.from === fromId && t.to !== currentStateId);
  for (const t of candidates) {
    if (t.trigger !== undefined) {
      // 触发器：达到指定极性即可切（打断场景不该等退出时间）
      const want = t.triggerValue ?? true;
      if (params[t.trigger] !== want) continue;
      if (t.condition !== undefined && params[t.condition] !== true) continue;
      return t;
    }
    // 自动过渡：需要走到退出时间
    if (respectExitTime) {
      const exit = t.exitTime ?? 0;
      if (dur > 0) {
        const p = Math.max(0, Math.min(1, time / dur));
        if (p < exit) continue;
      }
      if (t.condition !== undefined && params[t.condition] !== true) continue;
    }
    return t;
  }
  return undefined;
}

/** 淡化权重：来源 → 当前（0 = 全来源，1 = 全当前）。 */
export function machineFadeWeight(rt: MachineRuntime): number | null {
  if (!rt.fadingFrom) return null;
  if (!(rt.fadeDuration > 0)) return 1;
  const t = rt.fadeElapsed / rt.fadeDuration;
  return t * t * (3 - 2 * t);
}

export function machineIsFading(rt: MachineRuntime): boolean {
  return rt.fadingFrom !== null && rt.fadeElapsed < rt.fadeDuration;
}

/** 定义合法性检查（UI 与加载时给出可读报错）。 */
export function validateMachine(def: StateMachineDef): string[] {
  const errs: string[] = [];
  if (!stateDef(def, def.entry)) errs.push(`entry 指向不存在的状态：${def.entry}`);
  for (const s of def.states) {
    if (def.transitions.some((t) => t.to === s.id) && def.states.filter((x) => x.id === s.id).length > 1) {
      errs.push(`状态 id 重复：${s.id}`);
    }
  }
  for (const t of def.transitions) {
    if (t.from !== ANY_STATE && !stateDef(def, t.from)) errs.push(`过渡来源不存在：${t.from}`);
    if (!stateDef(def, t.to)) errs.push(`过渡目标不存在：${t.to}`);
    if (!(t.duration >= 0)) errs.push(`过渡时长非法：${t.duration}`);
    if (t.exitTime !== undefined && (t.exitTime < 0 || t.exitTime > 1)) errs.push(`退出时间应在 0..1：${t.exitTime}`);
  }
  return errs;
}