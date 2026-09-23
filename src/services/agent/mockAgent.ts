import { useAnimationStore } from '../../stores/animationStore';
import { useIKStore } from '../../stores/ikStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import type { IKChainId } from '../../core/ik/types';
import type { AgentAction } from './toolTypes';

export interface PlanResult {
  actions: AgentAction[];
  reply: string;
  /** planner 读取了哪些状态（诚实记录） */
  reads: string[];
}

let seq = 0;
function act(tool: AgentAction['tool'], args: Record<string, unknown>): AgentAction {
  seq += 1;
  return { tool, args, idempotencyKey: `mock-${Date.now()}-${seq}` };
}

function semanticName(sem: string): string | null {
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return null;
  const n = Object.values(snap.nodes).find((x) => x.semantic === sem);
  return n ? n.name : null;
}

function chainState(id: IKChainId) {
  return useIKStore.getState().chains[id] ?? null;
}

const LIMB: Record<string, { chain: IKChainId; bones: [string, string, string]; side: 'L' | 'R'; kind: 'arm' | 'leg' }> = {
  左手: { chain: 'arm.L', bones: ['upperArm.L', 'forearm.L', 'hand.L'], side: 'L', kind: 'arm' },
  右手: { chain: 'arm.R', bones: ['upperArm.R', 'forearm.R', 'hand.R'], side: 'R', kind: 'arm' },
  左脚: { chain: 'leg.L', bones: ['thigh.L', 'shin.L', 'foot.L'], side: 'L', kind: 'leg' },
  右脚: { chain: 'leg.R', bones: ['thigh.R', 'shin.R', 'foot.R'], side: 'R', kind: 'leg' },
  左腿: { chain: 'leg.L', bones: ['thigh.L', 'shin.L', 'foot.L'], side: 'L', kind: 'leg' },
  右腿: { chain: 'leg.R', bones: ['thigh.R', 'shin.R', 'foot.R'], side: 'R', kind: 'leg' },
  左臂: { chain: 'arm.L', bones: ['upperArm.L', 'forearm.L', 'hand.L'], side: 'L', kind: 'arm' },
  右臂: { chain: 'arm.R', bones: ['upperArm.R', 'forearm.R', 'hand.R'], side: 'R', kind: 'arm' },
};

/** 方向 → IK 目标增量（面向 +Z 约定）或回退欧拉增量 */
function limbPlan(limb: (typeof LIMB)[string], dir: string, deg: number): PlanResult {
  const reads = [`ik:${limb.chain}`];
  const c = chainState(limb.chain);
  const keyframes = limb.bones.map((b) => act('create_keyframe', { bone: b }));
  if (c) {
    // 有 IK 链： rig 无关的末端平移（REAL）
    const d = deg / 20; // 20° ≈ 0.25m，便于“抬高一点/很多”按比例
    let delta: [number, number, number] = [0, 0.25 * d, 0];
    if (dir === '放下' || dir === '下') delta = [0, -0.25 * d, 0];
    else if (dir === '前') delta = [0, 0, 0.25 * d];
    else if (dir === '后') delta = [0, 0, -0.25 * d];
    else if (dir === '左') delta = [0.25 * d, 0, 0];
    else if (dir === '右') delta = [-0.25 * d, 0, 0];
    return {
      actions: [act('apply_ik', { chain: limb.chain, enable: true, targetDelta: delta }), ...keyframes],
      reply: `末端 IK 平移 ${delta.map((x) => x.toFixed(2)).join(',')}m（面向 +Z 约定），已打整链关键帧`,
      reads,
    };
  }
  // 无链回退：局部系欧拉（A-pose XYZ 假设，面板已声明近似）
  const s = limb.side === 'L' ? 1 : -1;
  let delta: [number, number, number] = [0, 0, 25 * s * (deg / 20)];
  if (dir === '放下' || dir === '下') delta = [0, 0, -25 * s * (deg / 20)];
  else if (dir === '前') delta = [-20 * (deg / 20), 0, 0];
  else if (dir === '后') delta = [20 * (deg / 20), 0, 0];
  return {
    actions: [act('modify_bone', { bone: limb.bones[0], rotationDeltaDeg: delta }), ...keyframes.slice(0, 1)],
    reply: `无 IK 链，回退局部旋转近似（A-pose 假设）`,
    reads,
  };
}

const DEG_RE = /(\d+)\s*度?/;

export function planMock(text: string): PlanResult {
  const t = text.trim();
  const reads: string[] = [];
  const degMatch = t.match(DEG_RE);
  const deg = degMatch ? Math.min(Math.max(Number(degMatch[1]), 5), 90) : 20;

  // 生成动作（四肢指令优先，已在下方处理；此处处理剩余的生成意图）
  if (/生成|做个|来个|跳个|表演/.test(t) && !LIMB_PART(t)) {
    const prompt = t
      .replace(/^(请|帮我|让角色|让人物)?(生成|做|来|跳|表演)(一个|一段|个)?/, '')
      .replace(/(吧|一下|呢)?$/, '')
      .trim();
    if (prompt) {
      return { actions: [act('generate_motion', { prompt, duration: 4 })], reply: `调用动作生成：${prompt}`, reads };
    }
  }

  // 新建动画
  {
    const nm = t.match(/新建(?:动画)?\s*(\S+)?/);
    if (nm) {
      return { actions: [act('create_animation', { name: (nm[1] ?? 'Take').slice(0, 32) })], reply: '新建动画', reads };
    }
  }

  // 物理检查
  if (/检查|脚滑|穿透|物理|落地|重心/.test(t)) {
    return { actions: [act('check_physics', {})], reply: '检查当前动画的物理问题', reads };
  }

  // 补帧
  if (/补帧|加密|插值|平滑/.test(t)) {
    return { actions: [act('apply_inbetween', { density: 12, ease: 'linear' })], reply: '整段数学补帧', reads };
  }

  // 导出
  if (/导出|GLB/.test(t)) {
    return { actions: [act('export_animation', {})], reply: '导出 GLB（含全部动画）', reads };
  }

  // 下蹲 / 站直
  if (/下蹲|蹲下|降低重心|重心低/.test(t)) {
    reads.push('ik:leg.L', 'ik:leg.R');
    const hasLegs = chainState('leg.L') && chainState('leg.R');
    const actions: AgentAction[] = [
      act('apply_ik', { chain: 'leg.L', enable: true }),
      act('apply_ik', { chain: 'leg.R', enable: true }),
      act('modify_bone', { bone: 'hips', positionDelta: [0, -0.2, 0] }),
      act('create_keyframe', { bone: 'hips', includePosition: true }),
    ];
    return {
      actions,
      reply: hasLegs ? '启用双腿 IK 后下压髋部 0.2m（脚由 IK 保持）' : '无腿 IK 链，仅下压髋部（脚会跟随移动）',
      reads,
    };
  }
  if (/站直|站起|起身/.test(t)) {
    return {
      actions: [
        act('modify_bone', { bone: 'hips', positionDelta: [0, 0.2, 0] }),
        act('create_keyframe', { bone: 'hips', includePosition: true }),
      ],
      reply: '髋部上抬 0.2m',
      reads,
    };
  }

  // 头
  if (/头/.test(t)) {
    let delta: [number, number, number] | null = null;
    let label = '';
    if (/左/.test(t)) { delta = [0, 20 * (deg / 20), 0]; label = '向左转'; }
    else if (/右/.test(t)) { delta = [0, -20 * (deg / 20), 0]; label = '向右转'; }
    else if (/抬|仰/.test(t)) { delta = [-15 * (deg / 20), 0, 0]; label = '抬头'; }
    else if (/低|点/.test(t)) { delta = [15 * (deg / 20), 0, 0]; label = '低头'; }
    if (delta) {
      const head = semanticName('head') ?? 'head';
      return {
        actions: [act('modify_bone', { bone: head, rotationDeltaDeg: delta }), act('create_keyframe', { bone: head })],
        reply: `头${label}`,
        reads,
      };
    }
  }

  // 腰 / 身体
  if (/腰|身体|躯干/.test(t)) {
    let delta: [number, number, number] | null = null;
    if (/前倾|弯腰|前/.test(t)) delta = [15 * (deg / 20), 0, 0];
    else if (/后仰|后/.test(t)) delta = [-15 * (deg / 20), 0, 0];
    else if (/左/.test(t)) delta = [0, 0, 10 * (deg / 20)];
    else if (/右/.test(t)) delta = [0, 0, -10 * (deg / 20)];
    if (delta) {
      const spine = semanticName('spine') ?? 'spine';
      return {
        actions: [act('modify_bone', { bone: spine, rotationDeltaDeg: delta }), act('create_keyframe', { bone: spine })],
        reply: '调整躯干',
        reads,
      };
    }
  }

  // 四肢（方向判断时去掉肢体名本身，避免“左手”误判方向）
  for (const key of Object.keys(LIMB)) {
    if (t.includes(key)) {
      const rest = t.replace(key, '');
      let dir = '上';
      if (/放下|下降/.test(rest)) dir = '放下';
      else if (/向前|往前/.test(rest)) dir = '前';
      else if (/向后|往后/.test(rest)) dir = '后';
      else if (/向左|往左|左/.test(rest)) dir = '左';
      else if (/向右|往右|右/.test(rest)) dir = '右';
      else if (/前/.test(rest)) dir = '前';
      else if (/后/.test(rest)) dir = '后';
      return limbPlan(LIMB[key], dir, deg);
    }
  }

  // 打关键帧（选中骨骼）
  if (/关键帧|定帧|打帧|记录/.test(t)) {
    const sel = useSelectionStore.getState().selectedBoneId;
    const snap = useSkeletonStore.getState().snapshot;
    const node = sel && snap ? snap.nodes[sel] : null;
    if (!node) {
      return { actions: [], reply: '请先在左侧选中一块骨骼，再说“打关键帧”', reads };
    }
    const time = useAnimationStore.getState().currentTime;
    return {
      actions: [act('create_keyframe', { bone: node.name, time })],
      reply: `在 @${time.toFixed(2)}s 为 ${node.name} 打关键帧`,
      reads,
    };
  }

  return {
    actions: [],
    reply: '没理解。试试：“左手抬高”“下蹲”“头向左转”“新建动画 连招”“生成挥手动作”“检查脚滑”“补帧”“导出”',
    reads,
  };
}

function LIMB_PART(t: string): boolean {
  return Object.keys(LIMB).some((k) => t.includes(k));
}
