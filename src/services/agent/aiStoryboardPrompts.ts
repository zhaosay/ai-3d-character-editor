import type { StoryboardPromptDetail, StoryboardShot } from '../../core/previs/storyboard';
import type { LLMConfig } from './llmClient';
import { fetchWithTimeout, isRequestTimeout } from '../httpTransport';

function extractJson(text: string): unknown {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('AI 分镜润色未返回 JSON');
  try { return JSON.parse(text.slice(first, last + 1)) as unknown; }
  catch { throw new Error('AI 分镜润色返回了无效 JSON'); }
}

function validateDetails(value: unknown, shots: StoryboardShot[], sourcePrompt: string): StoryboardPromptDetail[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>)['shots'])) {
    throw new Error('AI 分镜润色缺少 shots 数组');
  }
  const rawShots = (value as { shots: unknown[] }).shots;
  const mapped = new Map<number, StoryboardPromptDetail>();
  for (const item of rawShots) {
    if (typeof item !== 'object' || item === null) continue;
    const shot = item as Record<string, unknown>;
    if (!Number.isInteger(shot['index']) || typeof shot['visualStyle'] !== 'string') continue;
    const visualStyle = shot['visualStyle'].trim().slice(0, 400);
    if (visualStyle) mapped.set(shot['index'] as number, { index: shot['index'] as number, visualStyle, continuity: '' });
  }
  const result = shots.map((shot) => mapped.get(shot.index));
  if (result.some((detail) => !detail)) throw new Error('AI 分镜润色结果缺少镜头或连续性信息，请重试');
  const setup = sourcePrompt.trim().slice(0, 800) || '仅使用各镜头提供的角色设定';
  const scenes = [...new Set(shots.map((shot) => shot.scene.trim()).filter(Boolean))].join('；').slice(0, 600);
  const continuity = `跨镜连续性：保持同一人物身份、脸型、发型和服装；人物、道具、场景布局及光线只采用原始设定与各镜头明确事实。原始设定：${setup}。${scenes ? `场景事实：${scenes}。` : ''}不得新增或推断表情、动作、道具、布景、天气或时间变化。`;
  return (result as StoryboardPromptDetail[]).map((detail) => ({ ...detail, continuity }));
}

/** Ask a configured text model only for style/continuity details; timing and action facts remain editor-owned. */
export async function generateAIStoryboardPrompts(
  shots: StoryboardShot[],
  sourcePrompt: string,
  cfg: LLMConfig,
): Promise<StoryboardPromptDetail[]> {
  if (shots.length === 0) return [];
  const system = '你是影视预演提示词的视觉风格编辑。只根据输入为每个镜头补充 visualStyle，内容只写画风、色彩和材质表现；不要写人物表情、动作、服装、道具、布景、天气或镜头信息，也不得改变动作、时间、场景、特效或相机事实。只输出 JSON：{"shots":[{"index":1,"visualStyle":"..."}]}。';
  const input = JSON.stringify({ sourcePrompt, shots: shots.map(({ index, t0, t1, action, shot, camera, scene, effects }) => ({ index, t0, t1, action, shot, camera, scene, effects })) });
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base || !cfg.model) throw new Error('请先配置 AI 服务地址和模型');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  let response: Response;
  try {
    if (cfg.kind === 'anthropic') {
      if (!cfg.apiKey) throw new Error('Claude 通道需要 API Key');
      response = await fetchWithTimeout(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 3000, system, messages: [{ role: 'user', content: input }] }),
      });
    } else {
      response = await fetchWithTimeout(`${base}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: cfg.model, temperature: 0.35, max_tokens: 2048, messages: [{ role: 'system', content: system }, { role: 'user', content: input }] }),
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('API Key')) throw error;
    if (isRequestTimeout(error)) throw new Error('分镜 AI 请求超过 120 秒，已停止等待；请检查模型负载或选择更快的模型');
    throw new Error(`无法连接分镜 AI：${base}`);
  }
  if (!response.ok) throw new Error(`分镜 AI 请求失败（HTTP ${response.status}）`);
  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch (error) {
    if (isRequestTimeout(error)) throw new Error('分镜 AI 响应超过 120 秒，已停止等待；请检查模型负载或选择更快的模型');
    throw new Error('分镜 AI 返回了无效 JSON');
  }
  const text = cfg.kind === 'anthropic'
    ? ((data['content'] as Array<{ text?: string }> | undefined) ?? []).map((block) => block.text ?? '').join('\n')
    : (((data['choices'] as Array<{ message?: { content?: string } }> | undefined) ?? [])[0]?.message?.content ?? '');
  return validateDetails(extractJson(text), shots, sourcePrompt);
}
