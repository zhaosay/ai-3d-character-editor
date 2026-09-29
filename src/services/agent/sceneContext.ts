import type { PrevisEffectEvent } from '../../core/previs/effects';
import type { ScenePlanIssue } from '../../core/previs/scenePlan';

/** Stable serialization for the editor state a pending AI plan was based on. */
export function createPlanningRevision(context: unknown): string {
  return JSON.stringify(context) ?? '';
}

export function isPlanningRevisionCurrent(expected: string, current: string): boolean {
  return expected === current;
}

/** Discard a network response if the editor context changed while awaiting it. */
export async function awaitWithPlanningRevision<T>(
  request: Promise<T>, expected: string, readCurrent: () => string,
): Promise<T | null> {
  const result = await request;
  return isPlanningRevisionCurrent(expected, readCurrent()) ? result : null;
}

/** Describe existing effect IDs and editable world-space paths for precise AI revisions. */
export function formatEffectsContext(events: PrevisEffectEvent[]): string {
  const prioritized = [
    ...events.filter((event) => event.kind === 'slash' && (event.path?.length || event.bladeSweep?.length)),
    ...events.filter((event) => event.kind !== 'slash' || (!event.path?.length && !event.bladeSweep?.length)),
  ].slice(0, 32);
  const rows = prioritized.map((event) => [
    `${event.id} ${event.kind}@${event.time.toFixed(2)}秒`,
    `actionIndex=${event.actionIndex ?? '未绑定'}`,
    `duration=${event.duration}`,
    `position=${event.position.join(',')}`,
    event.path?.length ? `worldPath=${JSON.stringify(event.path)}` : '',
    event.bladeSweep?.length ? `worldBladeSweep=${JSON.stringify(event.bladeSweep)}` : '',
  ].filter(Boolean).join(' '));
  if (events.length > prioritized.length) rows.push(`另有 ${events.length - prioritized.length} 个特效事件未展开`);
  return rows.join('；');
}

/** Preserve validator paths and obstacle identities so the model knows what to repair. */
export function formatSceneIssuesContext(issues: ScenePlanIssue[], warnings: string[] = []): string {
  const rows = issues.slice(0, 24).map((issue) => `${issue.level.toUpperCase()} ${issue.path}: ${issue.message}`);
  if (issues.length > rows.length) rows.push(`另有 ${issues.length - rows.length} 条校验问题未展开`);
  if (warnings.length) rows.push(...warnings.slice(0, Math.max(0, 24 - rows.length)).map((warning) => `预演警告：${warning}`));
  return rows.join('；');
}

/** Keep targeted repair requests on the current edit path instead of re-planning a new animation. */
export function buildActionRepairPrompt(originalPrompt: string, issue: string, instruction: string): string {
  return [
    '请修复当前活动动画对应的预演问题，不要重新生成整条动画。',
    `原始动作描述(JSON)：${JSON.stringify(originalPrompt)}`,
    `当前诊断问题(JSON)：${JSON.stringify(issue)}`,
    instruction,
    '只调用修改当前活动动画/预演所需的最少工具；不要调用 generate_motion、不要新建动画、不要改变未涉及的动作段或锁定字段。',
    '若修改动作段，使用 revise_action_segment 并提供当前零基段索引；若问题需要移动场景物体，只改告警指出的道具 ID，未经用户明确授权不得调整家具位置。',
    '如果现有上下文不足以唯一定位动作段或目标道具，先请求澄清，不要猜测。',
  ].join('\n');
}
