import type { PlanSegment } from './procedural';

export const ACTION_PRESETS = [
  { template: 'breath', label: '站立 / 停步', clause: '自然站立呼吸', duration: 2 },
  { template: 'march', label: '向前走', clause: '人物向前走', duration: 3 },
  { template: 'wave', label: '挥手招呼', clause: '挥手打招呼', duration: 2 },
  { template: 'reach', label: '伸手拿取', clause: '伸手拿起物品', duration: 2 },
  { template: 'look', label: '回头看', clause: '回头看向身后', duration: 2 },
  { template: 'turn', label: '转身', clause: '转身', duration: 2 },
  { template: 'squat', label: '下蹲', clause: '下蹲并保持平衡', duration: 2 },
  { template: 'bow', label: '鞠躬 / 点头', clause: '鞠躬致意', duration: 2 },
  { template: 'kick', label: '踢腿', clause: '抬腿踢出', duration: 2 },
] as const;
export interface SequenceAction { template: string; clause: string; duration: number; }
export function sequencePlan(actions: SequenceAction[]): PlanSegment[] {
  let time = 0;
  return actions.map((action) => {
    if (!Number.isFinite(action.duration) || action.duration < 0.5 || action.duration > 15) throw new Error('每段时长需要在 0.5–15 秒之间');
    const segment = { t0: time, t1: time + action.duration, template: action.template, clause: action.clause };
    time = segment.t1;
    return segment;
  });
}
