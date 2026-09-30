import * as THREE from 'three';
import type { HumanoidSemantic } from '../../core/skeleton/types';
import type { BoneTrack, Keyframe } from '../../core/animation/types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import { positiveIntent, sampleWeaponAttachment, type WorldInteractionFrame } from '../../core/previs/world';
import { sitPoseAt, hipHeightForKneel, hipHeightForWorldAngles } from '../../core/ik/sitPose';
import type { LegChain } from '../../core/ik/sitSolve';
import {
  anticipationEnvelope, breathSignal, gaitCycle, gaitLeg, gaitPeriod, proximalDelay,
} from '../../core/motion/gaits';

export type BoneMap = Partial<Record<HumanoidSemantic, string>>;
/** 静息四元数（语义→快照 restLocal），模板偏移量以此为基准合成，适配任意绑定姿势。 */
export type RestMap = Partial<Record<HumanoidSemantic, QuatTuple>>;
/** 静息局部位置。根节点移动必须基于这个值，否则会把角色压到原点。 */
export type RestPositionMap = Partial<Record<HumanoidSemantic, Vec3Tuple>>;

export interface ProcOptions {
  prompt: string;
  duration: number;
  seed?: number;
  segments?: PlanSegment[];
  bedInteraction?: WorldInteractionFrame | null;
  worldInteractions?: Record<string, WorldInteractionFrame>;
  segmentInteractions?: Record<number, WorldInteractionFrame>;
  groundY?: number;
  groundHipLocalOffset?: Vec3Tuple;
}

export interface ProcTracks {
  template: string;
  templates: string[];
  tracks: BoneTrack[];
  warnings: string[];
  segments: PlanSegment[];
  quality: PrevisQuality;
}

export interface PrevisQuality {
  status: 'ready' | 'warning';
  movementMeters: number;
  warnings: string[];
}

export interface PlanSegment {
  t0: number;
  t1: number;
  template: string;
  clause: string;
  intensity?: number;
  speed?: number;
  targetPropId?: string;
}

type EulerDeg = [number, number, number];
/**
 * 模板函数：t = 段内进度 0..1，timeSec = 该采样点的绝对时间（秒）。
 * timeSec 供需要真实时钟的动态（呼吸、步态周期）使用；不需要时忽略。
 */
type ScheduleFn = (t: number, timeSec?: number) => EulerDeg;
type Schedule = Partial<Record<HumanoidSemantic, ScheduleFn>>;

const D2R = Math.PI / 180;
const STEP = 0.25;
/** 双支撑相骨盆起伏的常量基准（gaitLeg 的 hipLift 在整周期首尾恒为该值）。 */
const GAIT_HIP_BASE = 0.022 - 0.044;

export function eulerXyzToQuat(e: EulerDeg): QuatTuple {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0] * D2R, e[1] * D2R, e[2] * D2R, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

/** 静息 ⊗ 局部偏移（与 three 的 quaternion.multiply 语义一致）。模板一律输出偏移量，合成时叠到各绑定 rest 上。 */
export function composeRestOffset(rest: QuatTuple, offset: EulerDeg): QuatTuple {
  const qr = new THREE.Quaternion(...rest);
  const qo = new THREE.Quaternion().setFromEuler(new THREE.Euler(offset[0] * D2R, offset[1] * D2R, offset[2] * D2R, 'XYZ'));
  qr.multiply(qo);
  return [qr.x, qr.y, qr.z, qr.w];
}

/** 关键词选模板（中英），命中多个取第一个；无命中用 sway 占位并警告。 */
export function pickTemplate(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/换手|换到左手|换到右手|交给左手|交给右手|递给左手|递给右手|左手接过|右手接过/.test(p)) return 'handoff';
  if (/左手.{0,4}(?:抬高|举高|抬起|举起|抬起手)|raise left hand/.test(p)) return 'raise_left';
  if (/右手.{0,4}(?:抬高|举高|抬起|举起|抬起手)|raise right hand/.test(p)) return 'raise_right';
  if (/(?:头|脑袋).{0,5}(?:向左|往左|左转|左偏)|(?:向左|往左|左侧|左边).{0,3}(?:转头|看|望|注视|扭头|偏头)|turn head left/.test(p)) return 'look_left';
  if (/(?:头|脑袋).{0,5}(?:向右|往右|右转|右偏)|(?:向右|往右|右侧|右边).{0,3}(?:转头|看|望|注视|扭头|偏头)|turn head right/.test(p)) return 'look_right';
  if (/坐下|坐到|坐在|落座|sit down|sitting/.test(p)) return 'sit';
  if (/跪下|下跪|跪地|跪倒/.test(p)) return 'kneel';
  if (/下蹲|蹲下|蹲起|squat|crouch/.test(p)) return 'squat';
  // 武侠优先：避免“挥剑”被 wave 的“挥”截胡（“挥手”不含“剑”，不受影响）
  if (/拔剑|挥剑|刺剑|劈剑|舞剑|剑|sword|slash|draw|stab/.test(p)) return 'sword';
  if (/格挡|防御|抵挡|招架|block|parry|guard|defend/.test(p)) return 'block';
  if (/踢|扫腿|鞭腿|kick/.test(p)) return 'kick';
  if (/出拳|挥拳|直拳|勾拳|punch|jab|hook/.test(p)) return 'punch';
  if (/拿起|拿着|抓取|伸手|递给|接住|取下|reach|grab|pick.?up/.test(p)) return 'reach';
  if (/回头|回眸|看向|望向|注视|look|gaze/.test(p)) return 'look';
  if (/转身|转向|转过来|turn/.test(p)) return 'turn';
  if (/睡觉|入睡|睡着|sleep/.test(p)) return 'sleep';
  if (/躺倒|躺下|躺平|仰卧|卧倒|lying|lie down/.test(p)) return 'lie';
  if (/起身|站起|站直|stand up/.test(p)) return 'stand';
  if (/挥|抬手|招手|wave|hello|hi\b/.test(p)) return 'wave';
  if (/鞠|躬|bow|点头|nod/.test(p)) return 'bow';
  if (/呼吸|待机|停下|停步|idle|breath/.test(p)) return 'breath';
  if (/踏步|走|跑|march|walk|run/.test(p)) return 'march';
  return 'sway';
}

function schedules(
  template: string,
  phase: number,
  bedInteraction?: WorldInteractionFrame | null,
  clause = '',
  /** 该段是否「无支撑面、就地坐在/躺在地面」而非在道具上：影响腿的折叠与倒地编排。 */
  onBareGround = false,
  /**
   * 坐姿腿角解（由 sitPose 按真实骨长 + 实际座高解出）。
   * 为空时回退到旧的固定角（仅用于地面盘腿 —— 那是平面两连杆无法表达的姿态）。
   */
  sitLeg?: { thighDeg: number; shinDeg: number; footDeg: number } | null,
): Schedule {
  const TAU = Math.PI * 2;
  switch (template) {
    case 'raise_left':
    case 'raise_right': {
      const side = template === 'raise_left' ? 'L' : 'R';
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      return {
        [`upperArm.${side}`]: (t: number) => [-115 * env(t), 0, (side === 'L' ? 22 : -22) * env(t)],
        [`forearm.${side}`]: (t: number) => [-12 * env(t), 0, 0],
        'spine': (t) => [-3 * env(t), 0, 0],
      };
    }
    case 'look_left':
    case 'look_right': {
      const yaw = template === 'look_left' ? -1 : 1;
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      return {
        'head': (t) => [0, 38 * yaw * env(t), 0],
        'neck': (t) => [0, 16 * yaw * env(t), 0],
        'chest': (t) => [0, 8 * yaw * env(t), 0],
      };
    }
    case 'wave': {
      const side = /左手|左臂/.test(clause) ? 'L' : 'R';
      const other = side === 'L' ? 'R' : 'L';
      const sign = side === 'R' ? -1 : 1;
      return {
        [`upperArm.${side}`]: (t: number) => [0, 0, sign * (55 - 20 * Math.sin(TAU * (t + phase)))],
        [`forearm.${side}`]: (t: number) => [0, 0, sign * (20 - 22 * Math.sin(TAU * (2 * t + phase)))],
        [`upperArm.${other}`]: () => [0, 0, 0],
        'head': (t) => [0, 8 * Math.sin(TAU * (t + phase)), 0],
      };
    }
    case 'handoff': {
      const env = (t: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
      return {
        'spine': (t) => [0, 8 * env(t), 0],
        'upperArm.L': (t) => [-28 * env(t), 0, 32 * env(t)],
        'forearm.L': (t) => [-52 * env(t), 0, 0],
        'upperArm.R': (t) => [-28 * env(t), 0, -32 * env(t)],
        'forearm.R': (t) => [-52 * env(t), 0, 0],
      };
    }
    case 'bow':
      return {
        'spine': (t) => [38 * Math.sin(Math.PI * t), 0, 0],
        'head': (t) => [14 * Math.sin(Math.PI * t), 0, 0],
        'upperArm.L': (t) => [12 * Math.sin(Math.PI * t), 0, 0],
        'upperArm.R': (t) => [12 * Math.sin(Math.PI * t), 0, 0],
      };
    case 'march': {
      // 真实步态：左右腿反相半个周期；摆动期膝「先屈后伸」；髋部 2× 步频起伏；
      // 骨盆与胸廓反向扭转；摆臂时肘始终微屈。均来自 core/motion/gaits。
      const period = gaitPeriod({ legLength: 0.85, stride: 0.62 });
      // 段首相位对齐到左脚触地，避免任意起步造成左右脚相位突变
      const legAt = (timeSec: number, side: 'L' | 'R') => {
        const cyc = (timeSec / period) + (side === 'L' ? 0 : 0.5) - phase;
        return gaitLeg(cyc);
      };
      const body = (timeSec: number) => gaitCycle((timeSec / period) - phase);
      return {
        'thigh.L': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'L'); return [s.thigh, 0, 0]; },
        'thigh.R': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'R'); return [s.thigh, 0, 0]; },
        // 负值 = 屈膝（与原模板相反：原来用 max(0,...) 只会单向掰直）
        'shin.L': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'L'); return [-s.knee, 0, 0]; },
        'shin.R': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'R'); return [-s.knee, 0, 0]; },
        'foot.L': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'L'); return [s.ankle, 0, 0]; },
        'foot.R': (_t: number, timeSec = 0) => { const s = legAt(timeSec, 'R'); return [s.ankle, 0, 0]; },
        // 手臂与同侧腿反相
        'upperArm.L': (_t: number, timeSec = 0) => { const s = body(timeSec); return [s.right.armSwing * 0.55, 0, 0]; },
        'upperArm.R': (_t: number, timeSec = 0) => { const s = body(timeSec); return [s.left.armSwing * 0.55, 0, 0]; },
        'forearm.L': (_t: number, timeSec = 0) => { const s = body(timeSec); return [-s.right.elbow, 0, 0]; },
        'forearm.R': (_t: number, timeSec = 0) => { const s = body(timeSec); return [-s.left.elbow, 0, 0]; },
        // 骨盆随步态扭转，胸廓反向（真人走look的核心辨识特征）
        'spine': (_t: number, timeSec = 0) => { const s = body(timeSec); return [2, -s.pelvisYaw * 0.6, 0]; },
        'chest': (_t: number, timeSec = 0) => { const s = body(timeSec); return [0, -s.pelvisYaw, 0]; },
        'hips': (_t: number, timeSec = 0) => { const s = body(timeSec); return [0, s.pelvisYaw, 0]; },
        // 头部保持朝向稳定（抵消骨盆扭转）
        'head': (_t: number, timeSec = 0) => { const s = body(timeSec); return [0, s.pelvisYaw * 0.35, 0]; },
      };
    }
    case 'reach': {
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      const side = /左手|左臂/.test(clause) ? 'L' : 'R';
      const sign = side === 'R' ? -1 : 1;
      const delta = bedInteraction?.handTargetPosition && bedInteraction.interactionPosition
        ? new THREE.Vector3(...bedInteraction.handTargetPosition).sub(new THREE.Vector3(...bedInteraction.interactionPosition))
        : new THREE.Vector3(0, 0, -0.35);
      const horizontal = Math.max(0.08, Math.hypot(delta.x, delta.z));
      const elevationDeg = THREE.MathUtils.radToDeg(Math.atan2(delta.y - 0.34, horizontal));
      const lateral = THREE.MathUtils.clamp(delta.x / horizontal, -1, 1);
      const extension = THREE.MathUtils.clamp((Math.hypot(horizontal, delta.y) - 0.22) / 0.55, 0, 1);
      return {
        'spine': (t: number) => [5 * env(t), 10 * env(t), 0],
        'chest': (t: number) => [3 * env(t), 12 * env(t), 0],
        [`upperArm.${side}`]: (t: number) => [THREE.MathUtils.clamp(-38 - elevationDeg * 0.32, -72, -12) * env(t), 0, sign * (25 + lateral * 18) * env(t)],
        [`forearm.${side}`]: (t: number) => [(-48 + 27 * (1 - extension)) * env(t), 0, 0],
        [`hand.${side}`]: (t: number) => [-12 * env(t), 0, 0],
        'head': (t: number) => [5 * env(t), 5 * env(t), 0],
      };
    }
    case 'look': {
      const env = (t: number) => Math.sin(Math.PI * 0.5 * t);
      return {
        'spine': (t) => [0, 10 * env(t), 0],
        'chest': (t) => [0, 16 * env(t), 0],
        'neck': (t) => [0, 18 * env(t), 0],
        'head': (t) => [0, 30 * env(t), 0],
      };
    }
    case 'turn': {
      const env = (t: number) => Math.sin(Math.PI * 0.5 * t);
      return {
        'hips': (t) => [0, 30 * env(t), 0],
        'spine': (t) => [0, 24 * env(t), 0],
        'chest': (t) => [0, 18 * env(t), 0],
        'head': (t) => [0, 18 * env(t), 0],
      };
    }
    case 'orient': {
      const yaw = (bedInteraction?.yawRadians ?? Math.PI / 2) / D2R;
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      if (/翻身|侧卧|侧身/.test(clause)) {
        return {
          'hips': (t) => [-62 * env(t), 0, 42 * env(t)],
          'spine': (t) => [-12 * env(t), 0, 20 * env(t)],
          'head': (t) => [-8 * env(t), 0, -12 * env(t)],
          'upperArm.L': (t) => [-58 * env(t), 0, 34 * env(t)],
          'forearm.L': (t) => [-78 * env(t), 0, 0],
          'upperArm.R': (t) => [-24 * env(t), 0, -22 * env(t)],
          'forearm.R': (t) => [-54 * env(t), 0, 0],
        };
      }
      return { 'hips': (t) => [0, yaw * env(t), 0], 'spine': (t) => [0, yaw * 0.15 * env(t), 0] };
    }
    case 'sit': {
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      // 坐在地面（无椅子/床）时腿要盘在地上： thighs 近乎水平、小腿收拢。
      // 若沿用椅姿角度（大腿 -72°、小腿 +68°，脚垂直落地），
      // 坐地面时脚会插进地面约 0.65m。
      const floor = onBareGround;
      /**
       * 椅/凳坐姿：腿角由 sitPose 按**真实骨长 + 实际座高**解出，
       * 不再用固定欧拉角 —— 固定角只对单一座高成立，实测脚骨落到 y=−0.49m。
       * 地面盘腿是平面两连杆无法表达的姿态，仍用专门角度（sitLeg 为空时）。
       */
      const thigh = sitLeg ? sitLeg.thighDeg : (floor ? -84 : -72);
      const shin = sitLeg ? sitLeg.shinDeg : (floor ? 84 : 68);
      const foot = sitLeg ? sitLeg.footDeg : 0;
      return {
        // 有 sitLeg 解时髋俯仰必须为 0：sitSolve 的闭式解以「髋不俯仰」为前提，
        // 实测加 38° 髋俯仰会让脚底再陷 10cm（0.0037 → −0.099）。
        // 坐姿本就应是挺直的，改为用 spine 前倾表达，避免与腿解算打架。
        'hips': (t) => [(floor ? 14 : (sitLeg ? 0 : 38)) * env(t), 0, 0],
        'spine': (t) => [(sitLeg ? 18 : 12) * env(t), 0, 0],
        'head': (t) => [-4 * env(t), 0, 0],
        'thigh.L': (t) => [thigh * env(t), 0, 0],
        'thigh.R': (t) => [thigh * env(t), 0, 0],
        'shin.L': (t) => [shin * env(t), 0, 0],
        'shin.R': (t) => [shin * env(t), 0, 0],
        'foot.L': (t) => [foot * env(t), 0, 0],
        'foot.R': (t) => [foot * env(t), 0, 0],
        'upperArm.L': (t) => [0, 0, 12 * env(t)],
        'upperArm.R': (t) => [0, 0, -12 * env(t)],
      };
    }
    case 'squat': {
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      return {
        'hips': (t) => [28 * env(t), 0, 0],
        'spine': (t) => [15 * env(t), 0, 0],
        'thigh.L': (t) => [-78 * env(t), 0, 0],
        'thigh.R': (t) => [-78 * env(t), 0, 0],
        'shin.L': (t) => [92 * env(t), 0, 0],
        'shin.R': (t) => [92 * env(t), 0, 0],
        'upperArm.L': (t) => [-18 * env(t), 0, 15 * env(t)],
        'upperArm.R': (t) => [-18 * env(t), 0, -15 * env(t)],
      };
    }
    case 'kneel': {
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      const legFold = (t: number) => { const x = Math.max(0, Math.min(1, t / 0.55)); return x * x * (3 - 2 * x); };
      const handsDown = /扶地|撑地/.test(clause);
      return {
        'hips': (t) => [28 * env(t), 0, 0],
        'spine': (t) => [(handsDown ? 66 : 24) * env(t), 0, 0],
        'head': (t) => [(handsDown ? -24 : -10) * env(t), 0, 0],
        'thigh.L': (t) => [-92 * legFold(t), 0, 0],
        'thigh.R': (t) => [-92 * legFold(t), 0, 0],
        'shin.L': (t) => [169 * legFold(t), 0, 0],
        'shin.R': (t) => [169 * legFold(t), 0, 0],
        'upperArm.L': (t) => [(handsDown ? -60 : -38) * env(t), 0, 24 * env(t)],
        'upperArm.R': (t) => [(handsDown ? -60 : -38) * env(t), 0, -24 * env(t)],
        'forearm.L': (t) => [(handsDown ? 35 : -78) * env(t), 0, 0],
        'forearm.R': (t) => [(handsDown ? 35 : -78) * env(t), 0, 0],
      };
    }
    case 'lie': {
      const env = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
      /**
       * 是否走「从站立倒到地面」的编排（先屈膝缓冲再倒）。
       * 判据是**有没有支撑面**（床/椅），而不是子句里有没有「地面」二字：
       * 原来靠子句正则，导致英文 "lie down" 等无「地面」的子句走 else 分支，
       * 拿「已经躺好」的直腿（thigh -8°/shin 0°）配「站立离地 13cm」的髋高，
       * 过渡期穿地 0.42m。
       */
      const groundedFall = onBareGround || /地面/.test(clause);
      const legEnv = (t: number) => { const x = Math.max(0, Math.min(1, (t - 0.42) / 0.58)); return x * x * (3 - 2 * x); };
      return {
        // With +Z facing forward, negative X rotates the face upward.
        'hips': (t) => [groundedFall ? 28 - 110 * env(t) : -82 * env(t), 0, 0],
        'spine': (t) => [groundedFall ? 66 - 71 * env(t) : -5 * env(t), 0, 0],
        'head': (t) => [groundedFall ? -24 + 16 * env(t) : -8 * env(t), 0, 0],
        'upperArm.L': (t) => [groundedFall ? -60 * env(t) : 0, 0, (groundedFall ? 24 : 18) * env(t)],
        'upperArm.R': (t) => [groundedFall ? -60 * env(t) : 0, 0, (groundedFall ? -24 : -18) * env(t)],
        'thigh.L': (t) => [groundedFall ? -92 + 84 * legEnv(t) : -8 * env(t), 0, 0],
        'thigh.R': (t) => [groundedFall ? -92 + 84 * legEnv(t) : -8 * env(t), 0, 0],
        'shin.L': (t) => [groundedFall ? 169 * (1 - legEnv(t)) : 0, 0, 0],
        'shin.R': (t) => [groundedFall ? 169 * (1 - legEnv(t)) : 0, 0, 0],
      };
    }
    case 'stand':
      return {
        'hips': () => [0, 0, 0],
        'spine': () => [0, 0, 0],
        'head': () => [0, 0, 0],
        'thigh.L': () => [0, 0, 0],
        'thigh.R': () => [0, 0, 0],
        'shin.L': () => [0, 0, 0],
        'shin.R': () => [0, 0, 0],
      };
    case 'sleep':
      return {
        'hips': () => [-82, 0, 0],
        'spine': () => [-5, 0, 0],
        'head': () => [-8, 0, 0],
        'upperArm.L': () => [0, 0, 18],
        'upperArm.R': () => [0, 0, -18],
        'thigh.L': () => [-8, 0, 0],
        'thigh.R': () => [-8, 0, 0],
        'shin.L': () => [0, 0, 0],
        'shin.R': () => [0, 0, 0],
        'chest': (t) => [1.2 * Math.sin(Math.PI * 2 * t), 0, 0],
      };
    // 武侠单发包络：预备(反向蓄力)→发力(近端先动)→跟随(轻微过冲)，段内回到起点，可循环拼接
    case 'sword': {
      // 发力类用非对称包络：蓄力 14%、快速出剑、收势带过冲
      const env = (t: number) => anticipationEnvelope(t, { windup: 0.14, settle: 0.22, windupAmount: 0.2, overshoot: 0.1 });
      const leftHanded = bedInteraction?.wieldingHand === 'L';
      const main = leftHanded ? 'upperArm.L' : 'upperArm.R';
      const mainFore = leftHanded ? 'forearm.L' : 'forearm.R';
      const off = leftHanded ? 'upperArm.R' : 'upperArm.L';
      return {
        'spine': (t) => [6 * env(t), (leftHanded ? -28 : 28) * env(t), 0],
        [main]: (t: number) => [-115 * env(t), 0, (leftHanded ? 35 : -35) * env(t)],
        // 前臂延迟启动（近端先动：肩→肘）
        [mainFore]: (t: number) => [-25 * env(proximalDelay(t, 0.08)), 0, 0],
        [off]: (t: number) => [0, 0, (leftHanded ? -12 : 12) * env(t)],
        'head': (t: number) => [0, (leftHanded ? 12 : -12) * env(t), 0],
      };
    }
    case 'block': {
      const env = (t: number) => anticipationEnvelope(t, { windup: 0.12, settle: 0.2, windupAmount: 0.16, overshoot: 0.08 });
      return {
        'spine': (t) => [10 * env(t), 0, 0],
        'upperArm.L': (t) => [-30 * env(t), 0, -25 * env(t)],
        'upperArm.R': (t) => [-30 * env(t), 0, 25 * env(t)],
        'forearm.L': (t) => [-75 * env(t), 0, 0],
        'forearm.R': (t) => [-75 * env(t), 0, 0],
        'head': (t) => [6 * env(t), 0, 0],
      };
    }
    case 'kick': {
      // 踢腿：先收腿蓄力（预备），再快速踢出，收腿带轻微过冲
      const env = (t: number) => anticipationEnvelope(t, { windup: 0.18, settle: 0.24, windupAmount: 0.3, overshoot: 0.12 });
      const lead = /左(?:腿|脚)/.test(clause) ? 'L' : 'R';
      const guard = lead === 'L' ? 'R' : 'L';
      const leftArmSign = lead === 'R' ? -1 : 1;
      return {
        [`thigh.${lead}`]: (t: number) => [-70 * env(t), 0, 0],
        // 小腿延后启动（髋→膝），踢出后伸膝发力
        [`shin.${lead}`]: (t: number) => {
          const e = env(proximalDelay(t, 0.1));
          return [35 * e * e, 0, 0];
        },
        [`thigh.${guard}`]: () => [0, 0, 0],
        'upperArm.L': (t: number) => [25 * leftArmSign * env(t), 0, 0],
        'upperArm.R': (t: number) => [-25 * leftArmSign * env(t), 0, 0],
        'spine': (t) => [0, 12 * env(t), 0],
      };
    }
    case 'punch': {
      // 出拳：肩先动、肘后动（近端→远端），预备反向蓄力
      const env = (t: number) => anticipationEnvelope(t, { windup: 0.16, settle: 0.2, windupAmount: 0.24, overshoot: 0.1 });
      const lead = /左手/.test(clause) ? 'L' : 'R';
      const guard = lead === 'L' ? 'R' : 'L';
      const leadSign = lead === 'R' ? -1 : 1;
      const guardSign = guard === 'R' ? -1 : 1;
      return {
        'spine': (t: number) => [0, 12 * env(t), 0],
        [`upperArm.${lead}`]: (t: number) => [-18 * env(t), 0, 62 * leadSign * env(t)],
        [`forearm.${lead}`]: (t: number) => [-8 * env(t), 0, -14 * leadSign * env(proximalDelay(t, 0.1))],
        [`upperArm.${guard}`]: (t: number) => [-22 * env(t), 0, -18 * guardSign * env(t)],
        [`forearm.${guard}`]: (t: number) => [-55 * env(t), 0, 0],
        'head': (t) => [3 * env(t), 0, 0],
      };
    }
    case 'breath': {
      // 待机呼吸：按真实时钟 0.25Hz（15次/分），由胸廓带动肩与头微动（Breath Coupling）
      const b = (_t: number, timeSec = 0) => breathSignal(timeSec, { hz: 0.25, amount: 1 });
      return {
        'chest': (t, s) => [1.8 * b(t, s), 0, 0],
        'spine': (t, s) => [1.0 * b(t, s), 0, 0],
        'upperArm.L': (t, s) => [0.7 * b(t, s), 0, 0],
        'upperArm.R': (t, s) => [0.7 * b(t, s), 0, 0],
        'head': (t, s) => [0.5 * b(t, s), 0, 0],
      };
    }
    default:
      return {
        'spine': (t) => [0, 0, 5 * Math.sin(TAU * (t + phase))],
        'upperArm.L': (t) => [0, 0, 6 * Math.sin(TAU * (t + phase))],
        'upperArm.R': (t) => [0, 0, -6 * Math.sin(TAU * (t + phase))],
        'head': (t) => [0, 0, -4 * Math.sin(TAU * (t + phase))],
      };
  }
}

/**
 * 过程式模板生成 rotation 轨道（MOCK 质量；规划 heuristic，P6 LLM 在后端）。
 * 模板输出相对静息的偏移量，rest 缺失时退化为绝对欧拉（旧行为）并警告。
 */
export function generateProceduralTracks(
  bones: BoneMap,
  opts: ProcOptions,
  rest: RestMap = {},
  restPositions: RestPositionMap = {},
  /** 实测腿连杆；坐姿按真实骨长解腿角时需要（见 measureLegChain）。 */
  legChain?: LegChain | null,
): ProcTracks {
  const segments = applyMotionModifiers(opts.segments ?? planClauses(opts.prompt, opts.duration), opts.prompt);
  return generatePlannedTracks(bones, segments, opts.duration, opts.seed ?? 0, rest, restPositions, opts.bedInteraction, opts.worldInteractions, opts.segmentInteractions, opts.groundY, opts.groundHipLocalOffset, legChain);
}

export function applyMotionModifiers(segments: PlanSegment[], prompt: string): PlanSegment[] {
  const modifiers = motionModifiers(prompt);
  return segments.map((segment) => ({
    ...segment,
    intensity: segment.intensity ?? motionModifiers(segment.clause).intensity ?? modifiers.intensity ?? 1,
    speed: segment.speed ?? motionModifiers(segment.clause).speed ?? modifiers.speed ?? 1,
  }));
}

/** 按标点和叙事连接词切分动作子句，启发式规划均分时长。 */
export function planClauses(prompt: string, duration: number): PlanSegment[] {
  const normalized = positiveIntent(prompt)
    .replace(/(?:然后|接着|随后|之后|最后|再|并且|并)\s*/g, '，')
    // Treat 后 as temporal only before a recognizable action, not in locations like 门后/桌后.
    .replace(/(?<!门|墙|床|桌|椅|树)后(?=(?:回头|回眸|鞠躬|点头|看|望|注视|拿|拾|抓|走|跑|坐|躺|卧|睡|起身|站|挥|举|抬|踢|出拳|格挡|招架|转身|开门|推门|拉门|放下|放回|递给|接过|休息))/g, '，')
  const clauses = normalized.split(/[，。！？、；\n,.!?;]+/).map((s) => s.trim()).filter(Boolean);
  const list = clauses.length > 0 ? clauses : ['保持当前姿势'];
  const expanded = list.flatMap((clause) => /睡|休息/.test(clause)
    ? [
        { template: 'lie', clause: `${clause}（躺下）`, weight: 0.65 },
        { template: 'sleep', clause: `${clause}（安静呼吸）`, weight: 0.35 },
      ]
    : [{ template: clause === '保持当前姿势' ? 'stand' : pickTemplate(clause), clause, weight: 1 }]);
  const totalWeight = expanded.reduce((sum, segment) => sum + segment.weight, 0);
  let cursor = 0;
  return expanded.map((segment, index) => {
    const t0 = cursor;
    cursor = index === expanded.length - 1 ? duration : round3(cursor + duration * segment.weight / totalWeight);
    return { t0, t1: cursor, template: segment.template, clause: segment.clause };
  });
}

function motionModifiers(prompt: string): { intensity?: number; speed?: number } {
  const intensity = /轻柔|轻微|小幅|克制|慢慢抬/.test(prompt) ? 0.65
    : /大幅|用力|猛烈|强烈|夸张|猛地/.test(prompt) ? 1.35 : undefined;
  const speed = /慢动作|缓慢|慢慢|放慢/.test(prompt) ? 0.7
    : /快速|迅速|急促|突然|加速/.test(prompt) ? 1.4 : undefined;
  return { intensity, speed };
}

const TIME_EPS = 1e-4;

const KNOWN_TEMPLATES = ['wave', 'bow', 'march', 'reach', 'look', 'look_left', 'look_right', 'raise_left', 'raise_right', 'turn', 'orient', 'sit', 'squat', 'kneel', 'lie', 'sleep', 'stand', 'sword', 'handoff', 'block', 'kick', 'punch', 'breath', 'sway'];

export function isKnownTemplate(t: string): boolean {
  return KNOWN_TEMPLATES.includes(t);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function samplePolyline(points: Vec3Tuple[], progress: number): Vec3Tuple {
  if (points.length < 2) return [...(points[0] ?? [0, 0, 0])];
  const lengths = points.slice(1).map((point, index) => new THREE.Vector3(...point).distanceTo(new THREE.Vector3(...points[index])));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total < 1e-8) return [...points.at(-1)!];
  let remaining = total * Math.min(Math.max(progress, 0), 1);
  for (let index = 0; index < lengths.length; index++) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const ratio = lengths[index] > 1e-8 ? remaining / lengths[index] : 1;
      return points[index].map((value, axis) => value + (points[index + 1][axis] - value) * ratio) as Vec3Tuple;
    }
    remaining -= lengths[index];
  }
  return [...points.at(-1)!];
}

export function generatePlannedTracks(
  bones: BoneMap,
  segments: PlanSegment[],
  duration: number,
  seed = 0,
  rest: RestMap = {},
  restPositions: RestPositionMap = {},
  bedInteraction?: WorldInteractionFrame | null,
  worldInteractions: Record<string, WorldInteractionFrame> = {},
  segmentInteractions: Record<number, WorldInteractionFrame> = {},
  groundY = 0,
  groundHipLocalOffset?: Vec3Tuple,
  /**
   * 实测腿连杆（由 measureLegChain 从骨架快照量出）。
   * 坐姿需要它才能按真实骨长解腿角 —— 没有时退回旧的固定角。
   */
  legChain?: LegChain | null,
): ProcTracks {
  const warnings: string[] = [];
  const templates: string[] = [];
  const phase = (seed % 100) / 100;
  const perBone = new Map<string, Keyframe<QuatTuple>[]>();
  const perBonePosition = new Map<string, Keyframe<Vec3Tuple>[]>();
  let walkedZ = 0;
  let rootOffset: Vec3Tuple = [0, 0, 0];
  let interactionPosition: Vec3Tuple | null = restPositions.hips ? [...restPositions.hips] : null;
  // Every participating bone has keys in every segment, preventing interpolation
  // across an unrelated action and holding the previous pose at each boundary.
  const semantics = new Set(segments.flatMap((seg) => Object.keys(schedules(seg.template, phase, bedInteraction, seg.clause))) as HumanoidSemantic[]);

  for (const [segmentIndex, seg] of segments.entries()) {
    const interaction = segmentInteractions[segmentIndex]
      ?? (seg.targetPropId ? worldInteractions[seg.targetPropId] : undefined)
      ?? bedInteraction;
    const template = isKnownTemplate(seg.template) ? seg.template : 'sway';
    if (template !== seg.template) warnings.push(`未知模板 ${seg.template}，已按 sway 处理`);
    templates.push(template);
    if (template === 'sway' && seg.clause.trim()) {
      warnings.push(`子句“${seg.clause}”未识别关键词，已用站立摇摆占位`);
    }
    if (template === 'reach' && interaction?.armReach) {
      const side = /左手|左臂/.test(seg.clause) ? 'L' : 'R';
      const reach = interaction.armReach[side];
      if (reach && !reach.reachable) {
        const sideLabel = side === 'L' ? '左' : '右';
        warnings.push(reach.minDistanceMeters !== undefined && reach.distanceMeters < reach.minDistanceMeters
          ? `第 ${segmentIndex + 1} 段伸手目标距${sideLabel}肩 ${reach.distanceMeters.toFixed(2)}m，小于估算手臂最短可达距离 ${reach.minDistanceMeters.toFixed(2)}m；当前姿态会近似折叠，不能保证接触`
          : `第 ${segmentIndex + 1} 段伸手目标距${sideLabel}肩 ${reach.distanceMeters.toFixed(2)}m，超过估算臂展 ${reach.maxDistanceMeters.toFixed(2)}m；当前姿态会近似伸展，不能保证接触`);
      }
    }
    let segmentInteraction = interaction;
    if (template === 'sword' && seg.targetPropId && interaction?.wieldingHand) {
      const startingHand = interaction.wieldingHand === 'L' ? 'hand.L' : 'hand.R';
      const attachment = sampleWeaponAttachment({ id: seg.targetPropId, attachTo: startingHand }, segments, seg.t0);
      const effectiveHand = attachment.blend < 0.5 ? attachment.from : attachment.to;
      if (effectiveHand) segmentInteraction = { ...interaction, wieldingHand: effectiveHand === 'hand.L' ? 'L' : 'R' };
    }
    const onBareGround = !segmentInteraction
      && (template === 'sit' || template === 'lie' || template === 'sleep');
    /**
     * 坐姿腿角/髋高解算：有座面道具时按**真实骨长 + 实际座高**解，
     * 取代原先的固定欧拉角（那只对单一座高成立，实测脚骨落到 y=−0.49m）。
     * 地面盘腿（onBareGround）是平面两连杆无法表达的姿态，保持原有角度。
     */
    const sitSolution = template === 'sit' && !onBareGround && legChain
      ? sitPoseAt({
        chain: legChain,
        seatY: segmentInteraction?.sitPosition?.[1] ?? groundY,
        groundY,
        progress: 1,
      })
      : null;
    if (template === 'sit' && sitSolution?.degraded === 'seat-too-high') {
      warnings.push(`座面高于腿长可达范围（超出 ${(sitSolution.solution?.float ?? 0).toFixed(2)}m），坐姿将双脚悬空`);
    }
    let sched = schedules(template, phase, segmentInteraction, seg.clause, onBareGround, sitSolution);
    if (template === 'wave') {
      const requestedSide = /左手|左臂/.test(seg.clause) ? 'L' : 'R';
      const fallbackSide = requestedSide === 'L' ? 'R' : 'L';
      if (!bones[`upperArm.${requestedSide}`] && bones[`upperArm.${fallbackSide}`]) {
        warnings.push(`缺少${requestedSide === 'L' ? '左' : '右'}臂，挥手已镜像到${fallbackSide === 'L' ? '左' : '右'}臂`);
        sched = mirrorWave(sched, requestedSide, fallbackSide);
      }
    }
    if (segments.length > 1) {
      for (const semantic of semantics) sched[semantic] ??= () => [0, 0, 0];
    }
    const span = Math.max(seg.t1 - seg.t0, 1e-6);
    const n = Math.max(2, Math.floor(span / STEP) + 1);
    for (const [semantic, fn] of Object.entries(sched) as Array<[HumanoidSemantic, ScheduleFn]>) {
      const boneName = bones[semantic];
      if (!boneName) {
        warnings.push(`缺少 ${semantic}，已跳过`);
        continue;
      }
      const ks: Keyframe<QuatTuple>[] = [];
      const restQ = rest[semantic];
      const previous = perBone.get(boneName)?.at(-1)?.value;
      const blendSpan = Math.min(0.35, span * 0.3);
      const intensity = Math.min(Math.max(seg.intensity ?? 1, 0.4), 1.6);
      const speed = Math.min(Math.max(seg.speed ?? 1, 0.5), 2);
      // rest 缺失时退化为绝对欧拉（旧行为，如后端无静息数据时）
      for (let i = 0; i < n; i++) {
        const time = Math.min(seg.t0 + i * STEP, seg.t1);
        const progress = Math.min(Math.max((time - seg.t0) / span, 0), 1);
        const motionProgress = Math.pow(progress, 1 / speed);
        const off = fn(motionProgress, time).map((value) => value * intensity) as EulerDeg;
        let value = restQ ? composeRestOffset(restQ, off) : eulerXyzToQuat(off);
        if (previous && time - seg.t0 < blendSpan) {
          const q = new THREE.Quaternion(...previous).slerp(new THREE.Quaternion(...value), (time - seg.t0) / blendSpan);
          value = [q.x, q.y, q.z, q.w];
        }
        ks.push({ time: round3(time), value, interp: 'linear' });
      }
      const lastT = ks[ks.length - 1].time;
      if (lastT < seg.t1 - TIME_EPS) {
        ks.push({ time: seg.t1, value: restQ ? composeRestOffset(restQ, fn(1, seg.t1)) : eulerXyzToQuat(fn(1, seg.t1)), interp: 'linear' });
      }
      const arr = perBone.get(boneName) ?? [];
      arr.push(...ks);
      perBone.set(boneName, arr);
    }
    if (interaction && ['march', 'orient', 'sit', 'lie', 'sleep', 'reach', 'stand'].includes(template)) {
      const hipsName = bones.hips;
      const target = template === 'march'
        ? (interaction.interactionPosition ?? interaction.approachPosition)
        : template === 'orient'
          ? (/翻身|侧卧|侧身/.test(seg.clause) ? interaction.liePosition : (interaction.interactionPosition ?? interaction.approachPosition))
        : template === 'sit'
          ? (() => {
            /**
             * 坐姿：髋**骨中心**应落在座面上方一个骨盆半径处，
             * 而不是把骨中心直接塞进座面（那等于把骨盆埋进椅子里）。
             * 座面高度来自道具，骨盆半径来自实测腿链 —— 两者同源，腿角才不会打架。
             */
            const seat = interaction.sitPosition ?? interaction.interactionPosition;
            /**
             * 只有**解算器真的跑过且有解**才抬骨盆半径。
             * 无 legChain（无法量骨长）时保持旧行为：髋骨落在座面上，
             * 免得凭一个猜出来的 16cm 把骨盆悬空（实测那是回归）。
             */
            if (!sitSolution || sitSolution.degraded) return seat;
            const lift = sitSolution.boneHipY - seat[1];
            return [seat[0], seat[1] + Math.max(0, lift), seat[2]] as Vec3Tuple;
          })()
          : template === 'lie' || template === 'sleep' ? (interaction.liePosition ?? interaction.interactionPosition)
            : template === 'stand' ? interaction.approachPosition
            : interaction.interactionPosition;
      if (!hipsName || !interactionPosition) {
        warnings.push('床边动作缺少髋部骨骼或静息位置，无法对齐场景支撑面');
      } else {
        const from = interactionPosition;
        const routeMatchesStart = interaction.approachPath?.length
          && new THREE.Vector3(...from).distanceTo(new THREE.Vector3(...interaction.approachPath[0])) < 0.15;
        const blockedMarch = template === 'march' && interaction.pathObstructed && !routeMatchesStart;
        const route = template === 'march' && routeMatchesStart
          ? interaction.approachPath!
          : blockedMarch ? [from, from] : [from, target];
        const destination = blockedMarch ? from : target;
        if (template === 'march' && interaction.pathObstructed) {
          warnings.push(blockedMarch
            ? `第 ${segmentIndex + 1} 段走位没有可从当前起点使用的安全路线，角色保持原位`
            : `第 ${segmentIndex + 1} 段走位已绕开静态道具占地；未计算全身及动态障碍碰撞`);
        }
        const keys: Keyframe<Vec3Tuple>[] = [];
        for (let i = 0; i < n; i++) {
          const time = Math.min(seg.t0 + i * STEP, seg.t1);
          const progress = Math.pow(Math.min(Math.max((time - seg.t0) / span, 0), 1), 1 / Math.min(Math.max(seg.speed ?? 1, 0.5), 2));
          const smooth = progress * progress * (3 - 2 * progress);
          keys.push({ time: round3(time), value: template === 'march'
            ? samplePolyline(route, smooth)
            : [
              from[0] + (target[0] - from[0]) * smooth,
              from[1] + (target[1] - from[1]) * smooth,
              from[2] + (target[2] - from[2]) * smooth,
            ], interp: 'linear' });
        }
        if (keys.at(-1)!.time < seg.t1 - TIME_EPS) keys.push({ time: seg.t1, value: [...destination], interp: 'linear' });
        const arr = perBonePosition.get(hipsName) ?? [];
        arr.push(...keys);
        perBonePosition.set(hipsName, arr);
        interactionPosition = [...destination];
      }
    } else if (
      // 蹲/跪永远按**地面**支撑面下沉，不受场景道具影响（没有"蹲在桌子上"这种语义）。
      // 之前这条守卫对全部模板统一要求 !bedInteraction，导致场景里一旦有床/椅，
      // squat/kneel 连根骨位移轨道都不生成 —— 角色原地深蹲、大腿穿过桌面。
      template === 'squat' || template === 'kneel'
        ? true
        : !bedInteraction && segments.some((s) => ['march', 'lie', 'sleep', 'stand', 'squat', 'kneel', 'sit', 'orient'].includes(s.template))
    ) {
      const hipsName = bones.hips;
      const restPosition = restPositions.hips;
      if (!hipsName || !restPosition) {
        if (segments.some((s) => s.template === 'march')) warnings.push('走路缺少髋部静息位置，已保留原地步态');
        if (template === 'lie' || template === 'sleep') warnings.push('躺倒缺少髋部静息位置，无法贴近地面');
      } else {
        const distance = template === 'march' ? Math.max(0.35, Math.min(1.2, span * 0.22)) : 0;
        const fromOffset = rootOffset;
        const rootIntensity = Math.min(Math.max(seg.intensity ?? 1, 0.4), 1.6);
        const groundedHipOffset: Vec3Tuple = groundHipLocalOffset ?? [0, groundY + 0.13 - restPosition[1], 0];
        const bracedKneelOffset: Vec3Tuple = groundedHipOffset.map((value, axis) =>
          value + ((axis === 1 ? -0.42 * rootIntensity : 0) - value) * 0.3) as Vec3Tuple;
        /**
         * 坐姿髋高：从**静息髋高**直接落到座面，而非从 groundedHipOffset 再减
         * （后者已经是「站立骨盆离地 13cm」，再减会过头）。
         * 无道具时按坐在地面处理：髋中心降到骨盆半径高度。
         *
         * `sitPoseHipY` 来自 sitSolve 的跨距反解（有解时）—— 必须与腿角同源，
         * 否则会出现「腿按新角转、髋还停在旧高度」导致中途插地。
         */
        const seatedHipOffset = (pelvisRadius: number): Vec3Tuple =>
          [0, groundY + pelvisRadius * rootIntensity - restPosition[1], 0] as Vec3Tuple;
        /**
         * 蹲/跪的髋高**由腿角反解**，不写死深度。
         * 写死 −0.32 / −0.42 只对某一个身高成立（实测身高 1.55→1.95m：
         * squat 脚插地 8.0→1.5cm，kneel 脚悬空 28.4→47.0cm）。
         * 有实测连杆时用 hipHeightForWorldAngles，髋高与腿角必然自洽。
         * 无连杆时退回旧魔数（保持既有行为，不凭猜的骨长造新误差）。
         */
        const foldHipOffset = (
          thighWorldDeg: number,
          shinWorldDeg: number,
          fallback: number,
          /** 跪姿的接触面是小腿/膝，不是脚底。 */
          onShin = false,
        ): Vec3Tuple => legChain
          ? ([0, (onShin
            ? hipHeightForKneel(legChain, thighWorldDeg, shinWorldDeg, groundY)
            : hipHeightForWorldAngles(legChain, thighWorldDeg, shinWorldDeg, groundY)) - restPosition[1], 0] as Vec3Tuple)
          : [0, fallback * rootIntensity, 0] as Vec3Tuple;
        /**
         * 世界前倾角是**实测值**，含髋俯仰的贡献（局部角 ≠ 世界角）：
         * 蹲  = hips +28°、thigh −78°、shin +92°  → 世界 thigh 50°、shin −42°
         * 跪  = hips +28°、thigh −92°、shin +169° → 世界 thigh 64°、shin −75°
         * 扶地跪 = hips +66°（髋先俯）            → 世界 thigh 26°、shin −37°
         * 猜错这几个角会让髋沉到地面以下（实测膝关 → hips.y=−0.012）。
         */
        const handsDownKneel = /扶地|撑地/.test(seg.clause);
        const toOffset = template === 'lie' || template === 'sleep' ? groundedHipOffset
          : template === 'kneel' && handsDownKneel ? bracedKneelOffset
            : template === 'kneel' ? foldHipOffset(64, -75, -0.42, true)
            : template === 'squat' ? foldHipOffset(50, -42, -0.32)
              : template === 'sit'
                ? (sitSolution && !sitSolution.degraded
                  // boneHipY 是髋**骨**中心高度（= 关节高 + hipDrop）
                  ? ([0, sitSolution.boneHipY - restPosition[1], 0] as Vec3Tuple)
                  : seatedHipOffset(0.16))
                : template === 'orient' && /翻身|侧卧|侧身/.test(seg.clause) ? groundedHipOffset
                  : template === 'stand' ? [0, 0, 0] as Vec3Tuple : rootOffset;
        const keys: Keyframe<Vec3Tuple>[] = [];
        for (let i = 0; i < n; i++) {
          const time = Math.min(seg.t0 + i * STEP, seg.t1);
          const progress = (time - seg.t0) / span;
          /**
           * 髋部位移包络必须与**腿的伸展**同步，否则会插地：
           * - 倒地编排（先屈膝 169° 再伸直）：髋必须等腿伸直后才降到底，
           *   故延后到 42% 起步 —— 与 legEnv 的 (t-0.42)/0.58 对齐。
           * - 非倒地（已躺好/在支撑面上）：位移与旋转同速铺满整段，
           *   否则会在腿还没转平时就把髋降下去（实测占穿地量约 70%）。
           */
          const rootProgress = template === 'lie'
            ? (onBareGround || /地面/.test(seg.clause)
              ? Math.max(0, Math.min(1, (progress - 0.42) / 0.58))
              : Math.min(1, progress / 0.9))
            : progress;
          const smooth = rootProgress * rootProgress * (3 - 2 * rootProgress);
          // 步态带来的髋部垂直起伏（2× 步频）。真人行走时骨盆从不静止，
          // 这是"看起来像假人"的常见原因之一。
          // 段首尾都淡入淡出到 0：非 march 段（停顿/坐/躺）的髋部必须完全冻结，
          // 且相邻段之间不能因 bob 产生跳变。
          // 呼吸同样不作用于根节点，只体现在胸/肩/头旋转（见 breath 模板）。
          // 步态带来的髋部垂直起伏（2× 步频）。真人行走时骨盆从不静止，
          // 这是"看起来像假人"的常见原因之一。
          // 减去双支撑相的常量基准，使走路段首尾都归零 —— 这样与后续
          // 「停顿/坐/躺」段（bob=0）天然连续，不会产生段边界跳变。
          const hipBob = template === 'march'
            ? gaitCycle((time - seg.t0) / gaitPeriod({ legLength: 0.85, stride: 0.62 }) - phase).hipLift - GAIT_HIP_BASE
            : 0;
          keys.push({ time: round3(time), value: [
            restPosition[0] + fromOffset[0] + (toOffset[0] - fromOffset[0]) * smooth,
            restPosition[1] + fromOffset[1] + (toOffset[1] - fromOffset[1]) * smooth + hipBob,
            restPosition[2] + fromOffset[2] + (toOffset[2] - fromOffset[2]) * smooth + walkedZ + distance * progress,
          ], interp: 'linear' });
        }
        if (keys[keys.length - 1].time < seg.t1 - TIME_EPS) {
          // 末帧 bob 已淡出为 0，保证与后续静止段连续
          keys.push({ time: seg.t1, value: [restPosition[0] + toOffset[0], restPosition[1] + toOffset[1], restPosition[2] + toOffset[2] + walkedZ + distance], interp: 'linear' });
        }
        const arr = perBonePosition.get(hipsName) ?? [];
        arr.push(...keys);
        perBonePosition.set(hipsName, arr);
        walkedZ += distance;
        rootOffset = toOffset;
      }
    }
    if (template === 'lie' || template === 'sleep') {
      warnings.push(interaction
        ? '床面位置已对齐；背部、头部和腿部仍未运行多点接触/碰撞求解'
        : '当前按地面高度生成仰卧；没有床体碰撞与接触模拟，添加床后可对齐床沿和床面');
    }
  }

  const tracks: BoneTrack[] = [];
  for (const boneName of new Set([...perBone.keys(), ...perBonePosition.keys()])) {
    const ks = perBone.get(boneName) ?? [];
    ks.sort((a, b) => a.time - b.time);
    const merged: Keyframe<QuatTuple>[] = [];
    for (const k of ks) {
      if (merged.length > 0 && Math.abs(k.time - merged[merged.length - 1].time) < TIME_EPS) {
        merged[merged.length - 1] = k; // 段边界：后段衔接优先
      } else {
        merged.push(k);
      }
    }
    const positions = mergeKeyframes(perBonePosition.get(boneName) ?? []);
    tracks.push({ boneName, position: positions, rotation: merged, scale: [] });
  }
  const quality = analyzePrevisTracks(templates, tracks);
  warnings.push(...quality.warnings);
  void duration;
  return { template: templates[0] ?? 'sway', templates, tracks, warnings: [...new Set(warnings)], segments, quality };
}

/** 生成完成后的最低可用性自检；只报告模板事实，不假装做了物理仿真。 */
export function analyzePrevisTracks(templates: string[], tracks: BoneTrack[]): PrevisQuality {
  const warnings: string[] = [];
  const hips = tracks.find((track) => track.boneName && track.position.length > 0);
  const movementMeters = hips && hips.position.length > 1
    ? Math.hypot(
      hips.position.at(-1)!.value[0] - hips.position[0].value[0],
      hips.position.at(-1)!.value[1] - hips.position[0].value[1],
      hips.position.at(-1)!.value[2] - hips.position[0].value[2],
    )
    : 0;
  if (templates.includes('march') && movementMeters < 0.1) warnings.push('走路没有可用的根节点位移，当前仅为原地步态');
  if (templates.includes('reach') && !tracks.some((t) => t.rotation.length > 0 && /forearm|hand/i.test(t.boneName))) {
    warnings.push('拿取缺少前臂或手部轨道，接触动作不完整');
  }
  if (templates.includes('look') && !tracks.some((t) => t.rotation.length > 0 && /head/i.test(t.boneName))) {
    warnings.push('看向缺少头部轨道，视线动作不完整');
  }
  if ((templates.includes('lie') || templates.includes('sleep')) && !tracks.some((t) => t.rotation.length > 0 && /hip|pelvis/i.test(t.boneName))) {
    warnings.push('躺倒动作缺少髋部旋转骨骼，无法形成仰卧姿势');
  }
  return { status: warnings.length > 0 ? 'warning' : 'ready', movementMeters, warnings };
}

function mergeKeyframes<T>(keys: Keyframe<T>[]): Keyframe<T>[] {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const merged: Keyframe<T>[] = [];
  for (const k of sorted) {
    if (merged.length > 0 && Math.abs(k.time - merged[merged.length - 1].time) < TIME_EPS) merged[merged.length - 1] = k;
    else merged.push(k);
  }
  return merged;
}

function mirrorWave(sched: Schedule, sourceSide: 'L' | 'R', destinationSide: 'L' | 'R'): Schedule {
  const out: Schedule = { ...sched };
  const up = sched[`upperArm.${sourceSide}`];
  const fo = sched[`forearm.${sourceSide}`];
  const sign = sourceSide === destinationSide ? 1 : -1;
  if (up) out[`upperArm.${destinationSide}`] = (t) => { const e = up(t); return [e[0], e[1], sign * e[2]]; };
  if (fo) out[`forearm.${destinationSide}`] = (t) => { const e = fo(t); return [e[0], e[1], sign * e[2]]; };
  return out;
}

export function buildBoneMap(obj: { nodes: Record<string, { name: string; semantic: HumanoidSemantic | null }> }): BoneMap {
  const map: BoneMap = {};
  for (const n of Object.values(obj.nodes)) {
    if (n.semantic && !map[n.semantic]) map[n.semantic] = n.name;
  }
  return map;
}

export function buildRestMap(obj: { nodes: Record<string, { semantic: HumanoidSemantic | null; restLocal: { quaternion: QuatTuple } }> }): RestMap {
  const map: RestMap = {};
  for (const n of Object.values(obj.nodes)) {
    if (n.semantic && !map[n.semantic]) map[n.semantic] = [...n.restLocal.quaternion] as QuatTuple;
  }
  return map;
}

export function buildRestPositionMap(obj: { nodes: Record<string, { semantic: HumanoidSemantic | null; restLocal: { position: Vec3Tuple } }> }): RestPositionMap {
  const map: RestPositionMap = {};
  for (const n of Object.values(obj.nodes)) {
    if (n.semantic && !map[n.semantic]) map[n.semantic] = [...n.restLocal.position] as Vec3Tuple;
  }
  return map;
}

export function mulberryPhase(seed: number): number {
  let a = seed >>> 0;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
