import { describe, expect, it, vi, afterEach } from 'vitest';
import { listOllamaModels, planWithLLM } from '../src/services/agent/llmClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

const OK_CHOICES = {
  ok: true,
  json: () =>
    Promise.resolve({
      choices: [{ message: { content: '{"reply":"ok","actions":[{"tool":"check_physics","args":{}}]}' } }],
    }),
};

describe('llmClient 多通道', () => {
  it('OpenAI兼容：带 key 时 Authorization + 正确地址', async () => {
    const fetch = vi.fn().mockResolvedValue(OK_CHOICES);
    vi.stubGlobal('fetch', fetch);
    const r = await planWithLLM('检查', { kind: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5-codex', apiKey: 'sk-x' });
    expect(r.actions[0].tool).toBe('check_physics');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-x');
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe('gpt-5-codex');
  });

  it('Ollama：无 key 时不带 Authorization（CORS 需要）', async () => {
    const fetch = vi.fn().mockResolvedValue(OK_CHOICES);
    vi.stubGlobal('fetch', fetch);
    await planWithLLM('检查', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
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
});
