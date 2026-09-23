import type { AgentAction } from './toolTypes';
import { parseAction } from './toolRegistry';

/** LLM 通道：anthropic（Claude 原生）/ openai（Codex）/ ollama（本地）/ custom（三方兼容）。 */
export type LLMKind = 'anthropic' | 'openai' | 'ollama' | 'custom';

export interface LLMConfig {
  kind: LLMKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LLMPlan {
  reply: string;
  actions: AgentAction[];
  warnings: string[];
}

export const SYSTEM = `你是 3D 角色动画编辑器的动作规划器。只允许调用以下工具：
inspect_skeleton, select_bone, modify_bone, create_keyframe, delete_keyframe,
create_animation, generate_motion, apply_ik, apply_inbetween, check_physics, export_animation.
（load_character 需用户传文件、retarget_motion 已内建，均不可用）

只输出 JSON 对象：{"reply":"一句话说明","actions":[{"tool":"...","args":{...}}]}，不输出其他文字。
- modify_bone 的 bone 可用骨骼名或语义（如 upperArm.L）；旋转用 rotationDeltaDeg（度，局部系）或 rotationEulerDeg；位移用 positionDelta。
- 四肢优先用 apply_ik：{"chain":"arm.L","enable":true,"targetDelta":[0,0.25,0]}，再对整链三块骨骼 create_keyframe。
- 不要编造骨骼名；不确定时先 inspect_skeleton。`;

function newKey(prefix: string, n: number): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${n}`;
}

/** 模型输出 → 校验后的 actions（非法逐个丢弃并警告，不整体失败）。 */
export function toPlan(content: string, keyPrefix: string): LLMPlan {
  const warnings: string[] = [];
  const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  let parsed: { reply?: unknown; actions?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { reply?: unknown; actions?: unknown };
  } catch {
    throw new Error('LLM 返回了非 JSON（已拒绝执行，换个说法重试）');
  }
  if (!Array.isArray(parsed.actions)) throw new Error('LLM 返回缺少 actions 数组');
  const actions: AgentAction[] = [];
  for (const raw of parsed.actions as unknown[]) {
    const r = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
    if (typeof r['idempotencyKey'] !== 'string') r['idempotencyKey'] = newKey(keyPrefix, actions.length);
    const { action, error } = parseAction(r);
    if (!action) {
      warnings.push(`丢弃非法 action：${error}`);
      continue;
    }
    actions.push(action);
  }
  return { reply: typeof parsed.reply === 'string' ? parsed.reply : '', actions, warnings };
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/** OpenAI-compatible（含 Ollama /v1 与 Codex / 三方）：无 key 时不带 Authorization（Ollama CORS 需要）。 */
export async function planOpenAICompatible(input: string, cfg: LLMConfig): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 Base URL');
  if (!cfg.model) throw new Error('请先填写模型名');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: input },
        ],
      }),
    });
  } catch {
    throw new Error(
      cfg.kind === 'ollama'
        ? `连不上 ${base}（确认 ollama serve 在运行；浏览器跨域需 OLLAMA_ORIGINS 包含本页地址）`
        : `连不上 ${base}（检查地址与网络）`,
    );
  }
  if (!res.ok) throw new Error(`LLM ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  return toPlan(data?.choices?.[0]?.message?.content ?? '', 'http');
}

/** Claude 原生 Messages API（浏览器直调用 bearer 风格 x-api-key + 显式 CORS 许可头）。 */
export async function planAnthropic(input: string, cfg: LLMConfig): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 Base URL');
  if (!cfg.model) throw new Error('请先填写模型名');
  if (!cfg.apiKey) throw new Error('Claude 通道需要 API Key（仅内存，不保存）');
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: input }],
      }),
    });
  } catch {
    throw new Error(`连不上 ${base}（检查网络；浏览器直连需该头被允许，失败可改走后端代理）`);
  }
  if (!res.ok) throw new Error(`Claude ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>;
  } | null;
  const text = (data?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  return toPlan(text, 'claude');
}

export async function planWithLLM(input: string, cfg: LLMConfig): Promise<LLMPlan> {
  if (cfg.kind === 'anthropic') return planAnthropic(input, cfg);
  return planOpenAICompatible(input, cfg);
}

/** Ollama 本地模型列表（GET /api/tags，无需 key；base 形如 http://host:port/v1）。 */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('请先填写 Ollama 地址');
  let res: Response;
  try {
    res = await fetch(`${base}/api/tags`);
  } catch {
    throw new Error(`连不上 ${base}（确认 ollama serve 在运行）`);
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
  return (data?.models ?? []).map((m) => m.name ?? '').filter(Boolean);
}
