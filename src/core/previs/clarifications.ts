import type { StageProp } from './world';

const CLARIFICATION_START = '[预演澄清]';
const ORIGINAL_PREFIX = '原始描述(JSON)：';
const ANSWER_PREFIX = '用户选择(JSON)：';

export interface ClarificationRequest {
  originalPrompt: string;
  answer: string;
}

export function buildClarificationRequest(originalPrompt: string, question: string, answer: string): string {
  return [
    CLARIFICATION_START,
    `${ORIGINAL_PREFIX}${JSON.stringify(originalPrompt)}`,
    `澄清问题(JSON)：${JSON.stringify(question)}`,
    `${ANSWER_PREFIX}${JSON.stringify(answer)}`,
    '请只针对用户选择重新规划；缺少物体时先提出 set_scene_prop，再生成动作。',
  ].join('\n');
}

export function parseClarificationRequest(input: string): ClarificationRequest | null {
  if (!input.startsWith(`${CLARIFICATION_START}\n`)) return null;
  const originalLine = input.split('\n').find((line) => line.startsWith(ORIGINAL_PREFIX));
  const answerLine = input.split('\n').find((line) => line.startsWith(ANSWER_PREFIX));
  if (!originalLine || !answerLine) return null;
  try {
    const originalPrompt: unknown = JSON.parse(originalLine.slice(ORIGINAL_PREFIX.length));
    const answer: unknown = JSON.parse(answerLine.slice(ANSWER_PREFIX.length));
    return typeof originalPrompt === 'string' && typeof answer === 'string' && originalPrompt.trim() && answer.trim()
      ? { originalPrompt, answer }
      : null;
  } catch {
    return null;
  }
}

/** Offers concrete, scene-aware choices while retaining free text for questions outside known cases. */
export function clarificationChoices(question: string, props: StageProp[]): string[] {
  if (/目标不明确|有多个/.test(question)) {
    const ids = question.match(/(?:[\w.-]+)(?:、[\w.-]+)+/)?.[0].split('、');
    if (ids?.length) return ids.map((id) => `使用道具 ${id}`);
  }
  if (/床|躺卧支撑|支撑面/.test(question)) return ['按地面仰卧预演', '在场景添加床并躺到床面'];
  if (/手机|电话/.test(question)) return ['在桌面添加手机并规划拿起', '不添加手机，只保留伸手动作'];
  if (/门/.test(question)) return ['添加门并规划走到门前开门', '不添加门，只回头看向门口'];
  if (/方向|左还是右|朝向/.test(question)) return ['向左', '向右', '保持当前朝向'];
  if (/目标|哪个物体|哪件道具/.test(question)) {
    const choices = props.filter((prop) => prop.kind !== 'room').map((prop) => `以${prop.kind}（${prop.id}）为目标`);
    if (choices.length > 1) return choices;
  }
  return [];
}
