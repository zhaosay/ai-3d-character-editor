import { isKnownTemplate, pickTemplate, type PlanSegment } from '../../services/motion/procedural';

export interface PlanIssue { level: 'error' | 'warning'; message: string; }

/** 把可编辑动作段规整为连续、可执行的预演计划。 */
export function normalizePlan(segments: PlanSegment[], duration: number): PlanSegment[] {
  const valid = segments.filter((segment) => segment.t1 > segment.t0).map((segment) => ({ ...segment, clause: segment.clause.trim() }));
  if (valid.length === 0) return [];
  return valid.map((segment, index) => {
    const t0 = index === 0 ? 0 : valid[index - 1].t1;
    const t1 = index === valid.length - 1 ? duration : Math.min(Math.max(segment.t1, t0 + 0.1), duration);
    return { ...segment, t0, t1, template: isKnownTemplate(segment.template) ? segment.template : pickTemplate(segment.clause) };
  });
}

/** 本地智能优化：从修改后的自然语言重新识别模板，并保留镜头/动作时间结构。 */
export function optimizePlan(segments: PlanSegment[], duration: number): PlanSegment[] {
  return normalizePlan(segments.map((segment) => ({ ...segment, template: pickTemplate(segment.clause) })), duration);
}

export function validatePlan(segments: PlanSegment[], duration: number): PlanIssue[] {
  const issues: PlanIssue[] = [];
  let previousEnd = 0;
  for (const [index, segment] of segments.entries()) {
    if (!segment.clause.trim()) issues.push({ level: 'error', message: `动作 ${index + 1} 缺少文字描述` });
    if (!isKnownTemplate(segment.template)) issues.push({ level: 'error', message: `动作 ${index + 1} 使用未知模板 ${segment.template}` });
    if (segment.t1 <= segment.t0) issues.push({ level: 'error', message: `动作 ${index + 1} 的结束时间必须晚于开始时间` });
    if (segment.t0 < previousEnd - 1e-4) issues.push({ level: 'error', message: `动作 ${index + 1} 与前一段时间重叠` });
    if (segment.template === 'sway') issues.push({ level: 'warning', message: `动作 ${index + 1} 未识别为具体动作，将使用站立占位` });
    previousEnd = segment.t1;
  }
  if (segments.length > 0 && Math.abs(segments[0].t0) > 1e-4) issues.push({ level: 'warning', message: '第一段未从 0 秒开始' });
  if (segments.length > 0 && Math.abs(segments.at(-1)!.t1 - duration) > 1e-4) issues.push({ level: 'warning', message: '最后一段未覆盖动画结尾' });
  return issues;
}
