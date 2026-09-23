import * as THREE from 'three';
import type { HumanoidSemantic } from '../../core/skeleton/types';
import type { BoneTrack, Keyframe } from '../../core/animation/types';
import type { QuatTuple } from '../../types/global';

export type BoneMap = Partial<Record<HumanoidSemantic, string>>;
/** 静息四元数（语义→快照 restLocal），模板偏移量以此为基准合成，适配任意绑定姿势。 */
export type RestMap = Partial<Record<HumanoidSemantic, QuatTuple>>;

export interface ProcOptions {
  prompt: string;
  duration: number;
  seed?: number;
}

export interface ProcTracks {
  template: string;
  templates: string[];
  tracks: BoneTrack[];
  warnings: string[];
  segments: PlanSegment[];
}

export interface PlanSegment {
  t0: number;
  t1: number;
  template: string;
  clause: string;
}

type EulerDeg = [number, number, number];
type Schedule = Partial<Record<HumanoidSemantic, (t: number) => EulerDeg>>;

const D2R = Math.PI / 180;
const STEP = 0.25;

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
  // 武侠优先：避免“挥剑”被 wave 的“挥”截胡（“挥手”不含“剑”，不受影响）
  if (/拔剑|挥剑|刺剑|劈剑|舞剑|剑|sword|slash|draw|stab/.test(p)) return 'sword';
  if (/格挡|防御|抵挡|招架|block|parry|guard|defend/.test(p)) return 'block';
  if (/踢|扫腿|鞭腿|kick/.test(p)) return 'kick';
  if (/挥|抬手|招手|wave|hello|hi\b/.test(p)) return 'wave';
  if (/鞠|躬|bow|点头|nod/.test(p)) return 'bow';
  if (/踏步|走|跑|march|walk|run/.test(p)) return 'march';
  return 'sway';
}

function schedules(template: string, phase: number): Schedule {
  const TAU = Math.PI * 2;
  switch (template) {
    case 'wave': {
      return {
        'upperArm.R': (t) => [0, 0, -55 + 20 * Math.sin(TAU * (t + phase))],
        'forearm.R': (t) => [0, 0, -20 + 22 * Math.sin(TAU * (2 * t + phase))],
        'upperArm.L': () => [0, 0, 0],
        'head': (t) => [0, 8 * Math.sin(TAU * (t + phase)), 0],
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
      const swing = (t: number, off: number) => 26 * Math.sin(TAU * (2 * t + off));
      return {
        'thigh.L': (t) => [swing(t, 0), 0, 0],
        'thigh.R': (t) => [swing(t, 0.5), 0, 0],
        'shin.L': (t) => [Math.max(0, -18 * Math.sin(TAU * (2 * t + 0.25))), 0, 0],
        'shin.R': (t) => [Math.max(0, -18 * Math.sin(TAU * (2 * t + 0.75))), 0, 0],
        'upperArm.L': (t) => [swing(t, 0.5) * 0.6, 0, 0],
        'upperArm.R': (t) => [swing(t, 0) * 0.6, 0, 0],
        'spine': (t) => [3 * Math.sin(TAU * (2 * t)), 0, 0],
      };
    }
    // 武侠单发包络（起势→发力→收势，段内回到起点，可循环拼接）
    case 'sword': {
      const env = (t: number) => Math.sin(Math.PI * t);
      return {
        'spine': (t) => [6 * env(t), 28 * env(t), 0],
        'upperArm.R': (t) => [-115 * env(t), 0, -35 * env(t)],
        'forearm.R': (t) => [-25 * env(t), 0, 0],
        'upperArm.L': (t) => [0, 0, 12 * env(t)],
        'head': (t) => [0, -12 * env(t), 0],
      };
    }
    case 'block': {
      const env = (t: number) => Math.sin(Math.PI * t);
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
      const env = (t: number) => Math.sin(Math.PI * t);
      return {
        'thigh.R': (t) => [-70 * env(t), 0, 0],
        'shin.R': (t) => [35 * env(t) * env(t), 0, 0],
        'thigh.L': () => [0, 0, 0],
        'upperArm.L': (t) => [-25 * env(t), 0, 0],
        'upperArm.R': (t) => [25 * env(t), 0, 0],
        'spine': (t) => [0, 12 * env(t), 0],
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
export function generateProceduralTracks(bones: BoneMap, opts: ProcOptions, rest: RestMap = {}): ProcTracks {
  const segments = planClauses(opts.prompt, opts.duration);
  return generatePlannedTracks(bones, segments, opts.duration, opts.seed ?? 0, rest);
}

/** 按标点切分动作子句，启发式规划均分时长。 */
export function planClauses(prompt: string, duration: number): PlanSegment[] {
  const clauses = prompt.split(/[，。！？、；\n,.!?;]+/).map((s) => s.trim()).filter(Boolean);
  const list = clauses.length > 0 ? clauses : [''];
  return list.map((clause, i) => ({
    t0: round3((duration * i) / list.length),
    t1: round3((duration * (i + 1)) / list.length),
    template: clause ? pickTemplate(clause) : 'sway',
    clause,
  }));
}

const TIME_EPS = 1e-4;

const KNOWN_TEMPLATES = ['wave', 'bow', 'march', 'sword', 'block', 'kick', 'sway'];

export function isKnownTemplate(t: string): boolean {
  return KNOWN_TEMPLATES.includes(t);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function generatePlannedTracks(
  bones: BoneMap,
  segments: PlanSegment[],
  duration: number,
  seed = 0,
  rest: RestMap = {},
): ProcTracks {
  const warnings: string[] = [];
  const templates: string[] = [];
  const phase = (seed % 100) / 100;
  const perBone = new Map<string, Keyframe<QuatTuple>[]>();

  for (const seg of segments) {
    const template = isKnownTemplate(seg.template) ? seg.template : 'sway';
    if (template !== seg.template) warnings.push(`未知模板 ${seg.template}，已按 sway 处理`);
    templates.push(template);
    if (template === 'sway' && seg.clause.trim()) {
      warnings.push(`子句“${seg.clause}”未识别关键词，已用站立摇摆占位`);
    }
    let sched = schedules(template, phase);
    if (template === 'wave' && !bones['upperArm.R'] && bones['upperArm.L']) {
      warnings.push('缺少右臂，wave 已镜像到左臂');
      sched = mirrorWave(sched);
    }
    const span = Math.max(seg.t1 - seg.t0, 1e-6);
    const n = Math.max(2, Math.floor(span / STEP) + 1);
    for (const [semantic, fn] of Object.entries(sched) as Array<[HumanoidSemantic, (t: number) => EulerDeg]>) {
      const boneName = bones[semantic];
      if (!boneName) {
        warnings.push(`缺少 ${semantic}，已跳过`);
        continue;
      }
      const ks: Keyframe<QuatTuple>[] = [];
      const restQ = rest[semantic];
      // rest 缺失时退化为绝对欧拉（旧行为，如后端无静息数据时）
      for (let i = 0; i < n; i++) {
        const time = Math.min(seg.t0 + i * STEP, seg.t1);
        const off = fn((time - seg.t0) / span);
        ks.push({ time: round3(time), value: restQ ? composeRestOffset(restQ, off) : eulerXyzToQuat(off), interp: 'linear' });
      }
      const lastT = ks[ks.length - 1].time;
      if (lastT < seg.t1 - TIME_EPS) {
        ks.push({ time: seg.t1, value: restQ ? composeRestOffset(restQ, fn(1)) : eulerXyzToQuat(fn(1)), interp: 'linear' });
      }
      const arr = perBone.get(boneName) ?? [];
      arr.push(...ks);
      perBone.set(boneName, arr);
    }
  }

  const tracks: BoneTrack[] = [];
  for (const [boneName, ks] of perBone) {
    ks.sort((a, b) => a.time - b.time);
    const merged: Keyframe<QuatTuple>[] = [];
    for (const k of ks) {
      if (merged.length > 0 && Math.abs(k.time - merged[merged.length - 1].time) < TIME_EPS) {
        merged[merged.length - 1] = k; // 段边界：后段衔接优先
      } else {
        merged.push(k);
      }
    }
    tracks.push({ boneName, position: [], rotation: merged, scale: [] });
  }
  void duration;
  return { template: templates[0] ?? 'sway', templates, tracks, warnings, segments };
}

function mirrorWave(sched: Schedule): Schedule {
  const out: Schedule = { ...sched };
  const up = sched['upperArm.R'];
  const fo = sched['forearm.R'];
  if (up) out['upperArm.L'] = (t) => { const e = up(t); return [e[0], e[1], -e[2]]; };
  if (fo) out['forearm.L'] = (t) => { const e = fo(t); return [e[0], e[1], -e[2]]; };
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

export function mulberryPhase(seed: number): number {
  let a = seed >>> 0;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
