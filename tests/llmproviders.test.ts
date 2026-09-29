import { describe, expect, it, vi, afterEach } from 'vitest';
import { listOllamaModels, planWithLLM, summarizePhysicsResult, toPlan } from '../src/services/agent/llmClient';
import { buildClarificationRequest } from '../src/core/previs/clarifications';
import { buildActionRepairPrompt } from '../src/services/agent/sceneContext';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const OK_CHOICES = {
  ok: true,
  json: () =>
    Promise.resolve({
      choices: [{ message: { content: '{"reply":"ok","actions":[{"tool":"check_physics","args":{}}]}' } }],
    }),
};

describe('llmClient 多通道', () => {
  it('Ollama 动作预演使用 JSON 模式并保留用户原句', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: JSON.stringify({
        reply: '按左手抬高、头部右转分段预演',
        actions: [{ tool: 'generate_motion', args: {
          prompt: '用户希望抬手并转头',
          duration: 4,
          segments: [
            { t0: 0, t1: 2, template: 'raise_left', clause: '左手抬高', intensity: 1, speed: 1 },
            { t0: 2, t1: 4, template: 'look_right', clause: '头部向右转', intensity: 1, speed: 1 },
          ],
        } }],
      }) } }),
    });
    vi.stubGlobal('fetch', request);
    const prompt = '左手抬高，然后头向右转';
    const result = await planWithLLM(prompt, { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b', apiKey: '' }, '当前无场景道具');
    const [, init] = request.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { format?: unknown; think?: boolean; messages: Array<{ content: string }> };

    expect(request.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
    expect(body).toMatchObject({ format: 'json', think: false });
    expect(body.messages[0].content).toMatch(/segment.*t0.*t1/s);
    expect(body.messages[0].content).toContain('intensity 只能是 0.4–1.6');
    expect(body.messages[0].content).toContain('speed 只能是 0.5–2');
    expect(body.messages[0].content).toContain('actions 不能是空数组');
    expect(body.messages[0].content).toContain('action 对象只能有 tool 和 args 两个字段');
    expect(body.messages[0].content).not.toMatch(/repair_physics|set_previs_effect/);
    expect(body.messages[1].content).toContain(prompt);
    expect(result.actions[0].args).toMatchObject({ prompt });
    expect(result.actions[0].args['segments']).toHaveLength(2);
  });

  it('修复模型漏掉的动作外壳并把默认时长与分段同步到4秒', () => {
    const malformed = JSON.stringify({ reply: '已规划动作', actions: [{
      prompt: '用户请求：左手抬高，然后头向右转', duration: 8,
      segments: [
        { t0: 0, t1: 6, template: 'raise_left', clause: '左手抬高' },
        { t0: 6, t1: 12, template: 'look_right', clause: '头向右转' },
      ],
      args: { prompt: '左手抬高，然后头向右转', duration: 8, segments: [
        { t0: 0, t1: 6, template: 'raise_left', clause: '左手抬高' },
        { t0: 6, t1: 12, template: 'look_right', clause: '头向右转' },
      ], interpretation: {
        certainty: 'medium', reasons: '动作方向明确', missingInfo: '未指定速度', questions: '是否需要调整幅度？',
      } },
    }] });

    const result = toPlan(malformed, 'http', 'qwen2.5:3b', '左手抬高，然后头向右转');
    const action = result.actions[0];
    expect(action).toMatchObject({ tool: 'generate_motion', args: { prompt: '左手抬高，然后头向右转', duration: 4 } });
    expect(action.args['segments']).toMatchObject([{ t0: 0, t1: 2 }, { t0: 2, t1: 4 }]);
    expect(result.warnings.join()).toMatch(/结构|时长/);
  });

  it('不把模型臆测的左右注视方向加到没有方向指令的原句', () => {
    const prompt = '人物走到桌前，拿起手机，然后回头看门口';
    const result = toPlan(JSON.stringify({ reply: '完成', actions: [{ tool: 'generate_motion', args: {
      prompt,
      segments: [
        { t0: 0, t1: 2, template: 'march', clause: '走到桌边' },
        { t0: 2, t1: 4, template: 'reach', clause: '拿起手机' },
        { t0: 4, t1: 6, template: 'look_right', clause: '向右看向门口' },
      ],
    } }] }), 'ollama', 'qwen3.5:9b', prompt);
    const segments = result.actions[0].args['segments'] as Array<{ template: string; clause: string }>;
    expect(segments.at(-1)).toMatchObject({ template: 'look', clause: expect.stringMatching(/门口/) });
    expect((result.actions[0].args['segments'] as Array<{ t1: number }>).at(-1)?.t1).toBe(4);
    expect(result.warnings).toContain('模型给未指定方向的注视增加了左右偏向，已按原文改为目标注视');
  });

  it('Ollama 动作规划只发送角色尺寸和道具事实，不把编辑状态噪声塞给模型', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"完成","actions":[{"tool":"generate_motion","args":{"prompt":"左手抬高，然后头向右转","segments":[{"t0":0,"t1":4,"template":"look_right","clause":"头向右转"}]}}]}' } }),
    });
    vi.stubGlobal('fetch', request);
    await planWithLLM('左手抬高，然后头向右转', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b', apiKey: '' }, [
      '角色身高约1.70m',
      '当前道具：table id=t1 position=1.00,0.00,0.00 size=1.00x0.80x0.60m',
      '当前动画：Take 1，时长4秒',
      '当前角色表情目标（meshPath#targetName）：Face#eyeBlinkLeft',
    ].join('；'));

    const [, init] = request.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).toContain('角色身高约1.70m');
    expect(body.messages[1].content).toContain('table id=t1');
    expect(body.messages[1].content).not.toContain('当前动画');
    expect(body.messages[1].content).not.toContain('eyeBlinkLeft');
  });

  it('将动作理解模型来源传入生成工具，避免把模板动作误标为模型生成', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"已拆分","actions":[{"tool":"generate_motion","args":{"prompt":"挥手","segments":[{"t0":0,"t1":4,"template":"wave","clause":"挥手"}]}}]}' } }),
    }));
    const result = await planWithLLM('挥手', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    expect(result.actions[0].args).toMatchObject({ _planner: 'llm', _plannerModel: 'qwen3:8b' });
  });

  it('保留模型输出的结构化动作段，供动作合成器直接使用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"完成","actions":[{"tool":"generate_motion","args":{"prompt":"走到桌边拿起手机","duration":4,"segments":[{"t0":0,"t1":2,"template":"march","clause":"走到桌边"},{"t0":2,"t1":4,"template":"reach","clause":"拿起手机"}]}}]}' } }),
    }));
    const result = await planWithLLM('走到桌边拿起手机', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    expect(result.actions[0].args['segments']).toHaveLength(2);
    expect(result.actions[0].args).toMatchObject({ _planner: 'llm', _plannerModel: 'qwen3:8b' });
  });

  it('Ollama 动作规划拒绝空的最终 JSON 内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '', thinking: '只返回了思考文字' } }),
    }));
    await expect(planWithLLM('挥手', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', apiKey: '' }))
      .rejects.toThrow(/返回空动作 JSON/);
  });

  it('保留模型对缺失信息、置信度和澄清问题的判断', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: JSON.stringify({ reply: '需要补充床的位置', actions: [{ tool: 'generate_motion', args: {
        prompt: '躺下睡觉', segments: [{ t0: 0, t1: 8, template: 'lie', clause: '仰卧休息' }],
        interpretation: { certainty: 'low', reasons: ['场景未摆放床'], missingInfo: ['床的位置'], questions: ['按地面仰卧预演，还是先添加床？'] },
      } }] }) } }),
    }));
    const result = await planWithLLM('躺下睡觉', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    expect(result.actions[0].args['interpretation']).toMatchObject({ certainty: 'low', missingInfo: ['床的位置'] });
  });

  it('澄清重规划固定原始动作文本，并把选择独立传给生成工具', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"按床面规划","actions":[{"tool":"generate_motion","args":{"prompt":"不可信的改写","segments":[{"t0":0,"t1":8,"template":"lie","clause":"仰卧休息"}]}}]}' } }),
    }));
    const request = buildClarificationRequest('躺下睡觉', '按地面还是添加床？', '在场景添加床并躺到床面');
    const result = await planWithLLM(request, { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    expect(result.actions[0].args).toMatchObject({
      prompt: '躺下睡觉',
      clarification: '在场景添加床并躺到床面',
    });
  });

  it('OpenAI兼容：带 key 时 Authorization + 正确地址', async () => {
    const fetch = vi.fn().mockResolvedValue(OK_CHOICES);
    vi.stubGlobal('fetch', fetch);
    const r = await planWithLLM('检查物理', { kind: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5-codex', apiKey: 'sk-x' }, 'table@1,0,0; phone@1,0.7,0');
    expect(r.actions[0].tool).toBe('check_physics');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-x');
    const body = JSON.parse(init.body as string) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('gpt-5-codex');
    expect(body.messages[1].content).toMatch(/table@1,0,0/);
    expect(body.messages[1].content).toMatch(/检查物理/);
  });

  it('Ollama 工具路由使用原生 JSON API 并关闭 thinking', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"检查当前物理状态","actions":[{"tool":"check_physics","args":{}}]}' } }),
    });
    vi.stubGlobal('fetch', fetch);
    await planWithLLM('检查', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(JSON.parse(init.body as string)).toMatchObject({ stream: false, think: false, format: 'json', options: { num_predict: 2048 } });
  });

  it('Ollama 动作规划使用原生 JSON API 并关闭 thinking', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"完成","actions":[{"tool":"generate_motion","args":{"segments":[{"t0":0,"t1":4,"template":"wave","clause":"挥手"}]}}]}' } }),
    });
    vi.stubGlobal('fetch', fetch);
    await planWithLLM('挥手', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', apiKey: '' });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(fetch.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
    expect(JSON.parse(init.body as string)).toMatchObject({ think: false, format: 'json', stream: false });
  });

  it('物理结果解读只发送诊断数据并强制要求 JSON 摘要', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"summary":"约0.8秒，手部代理与桌面发生估算接触；这是近似检查，尚未修复。"}' } }),
    });
    vi.stubGlobal('fetch', fetch);
    const summary = await summarizePhysicsResult('检查手臂是否穿过桌子', { ok: true, data: {
      issues: [], collisionFindings: [{ propId: 'desk-main', bodyPart: 'hand', time: 0.8, estimatedOverlapMeters: 0.04 }],
      collisionWarnings: ['动作约 0.8 秒：hand 可能与道具 desk-main 相交'], supportWarnings: [],
    } }, { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', apiKey: '' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(summary).toMatch(/桌面/);
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(JSON.parse(init.body as string)).toMatchObject({ think: false, format: 'json' });
    expect(init.body).toContain('desk-main');
  });

  it('碰撞修复请求走当前预演的单段修改工具，不触发新动画规划', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '{"reply":"仅调整挥拳段幅度","actions":[{"tool":"revise_action_segment","args":{"segmentIndex":0,"intensity":0.8}}]}' } }),
    });
    vi.stubGlobal('fetch', fetch);
    const prompt = buildActionRepairPrompt('人物走到桌前，挥拳后收势',
      '动作约 0.8 秒：hand 可能与道具 table-main 相交', '只把第1段幅度调为0.8，保持其他段不变。');
    const result = await planWithLLM(prompt, { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', apiKey: '' },
      '当前动画：Take 1；第1段 index=0 template=punch time=0–2s；道具 table-main');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };

    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.messages[0].content).toContain('revise_action_segment');
    expect(body.messages[0].content).not.toContain('你是 3D 视频预演动作规划器');
    expect(body.messages[1].content).toContain('不要调用 generate_motion');
    expect(result.actions).toMatchObject([{ tool: 'revise_action_segment', args: { segmentIndex: 0, intensity: 0.8 } }]);
    expect(result.actions.some((action) => action.tool === 'generate_motion')).toBe(false);
  });

  it('Claude：Messages API 地址/头/体 + content 块拼接', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            { type: 'thinking', thinking: '...' },
            { type: 'text', text: '{"reply":"好","actions":[{"tool":"select_bone","args":{"bone":"Hips"}}]}' },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetch);
    const r = await planWithLLM('选中髋部', { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', apiKey: 'sk-ant' });
    expect(r.reply).toBe('好');
    expect(r.actions[0]).toMatchObject({ tool: 'select_bone' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(init.body as string) as { model: string; max_tokens: number; system: string };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toMatch(/inspect_skeleton/);
  });

  it('Claude 缺 key 直接拒绝（不发请求）', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(planWithLLM('x', { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: '' })).rejects.toThrow(/API Key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('HTTP 错误带状态码，非 JSON 拒绝执行', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('auth err') }));
    await expect(planWithLLM('x', { kind: 'openai', baseUrl: 'http://x', model: 'm', apiKey: 'k' })).rejects.toThrow(/401/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '你好呀' } }] }) }));
    await expect(planWithLLM('x', { kind: 'custom', baseUrl: 'http://x', model: 'm', apiKey: 'k' })).rejects.toThrow(/非 JSON/);
  });
});

describe('listOllamaModels', () => {
  it('去 /v1 后缀调 /api/tags 并返回模型名', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.1' }] }),
    });
    vi.stubGlobal('fetch', fetch);
    const models = await listOllamaModels('http://localhost:11434/v1');
    expect(models).toEqual(['qwen3:8b', 'llama3.1']);
    expect((fetch.mock.calls[0] as [string])[0]).toBe('http://localhost:11434/api/tags');
  });

  it('连不上给友好错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(listOllamaModels('http://localhost:11434/v1')).rejects.toThrow(/ollama serve/);
  });

  it('模型列表请求挂起时在 10 秒后中止并提示超时', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const pending = listOllamaModels('http://localhost:11434/v1');
    const rejected = expect(pending).rejects.toThrow(/模型列表请求超时/);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
  });
});
