import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAIStoryboardPrompts } from '../src/services/agent/aiStoryboardPrompts';
import type { StoryboardShot } from '../src/core/previs/storyboard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const shot: StoryboardShot = { index: 1, t0: 0, t1: 2, action: '走向桌子', shot: '中全景', camera: '缓慢推近', comfyPrompt: '', vpipePrompt: '', effects: '', scene: '桌子' };

describe('AI storyboard prompt generation', () => {
  it('uses the configured OpenAI-compatible model and validates per-shot continuity fields', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '{"shots":[{"index":1,"visualStyle":"暖色日光","continuity":"桌子与衣着保持一致"}]}' } }] }) });
    vi.stubGlobal('fetch', fetch);
    const result = await generateAIStoryboardPrompts([shot], '人物走到桌前', { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '' });
    expect(result[0]).toMatchObject({ index: 1, visualStyle: '暖色日光' });
    expect(result[0].continuity).toMatch(/保持同一人物身份/);
    expect(result[0].continuity).toMatch(/场景事实：桌子/);
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ max_tokens: 2048 });
  });

  it('ignores model-invented continuity and shot facts, deriving continuity from the source and scene', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ shots: [
      { index: 1, visualStyle: '柔和暖色调', continuity: '人物从专注变警惕，头发随风飘动', camera: '改为俯拍' },
      { index: 2, visualStyle: '细腻胶片颗粒', continuity: '衣服变成红色' },
    ] }) } }] }) }));
    const second = { ...shot, index: 2, t0: 2, t1: 4, action: '拿起手机', scene: '桌子与手机' };
    const details = await generateAIStoryboardPrompts([shot, second], '中国男性，黑色短发，浅灰衬衫', {
      kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKey: '',
    });
    expect(details.map((detail) => detail.visualStyle)).toEqual(['柔和暖色调', '细腻胶片颗粒']);
    expect(details[0].continuity).toBe(details[1].continuity);
    expect(details[0].continuity).toMatch(/黑色短发，浅灰衬衫/);
    expect(details[0].continuity).not.toMatch(/警惕|飘动|红色|俯拍/);
  });

  it('rejects partial results rather than silently losing a storyboard shot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '{"shots":[]}' } }] }) }));
    await expect(generateAIStoryboardPrompts([shot], '描述', { kind: 'custom', baseUrl: 'http://localhost/v1', model: 'm', apiKey: '' })).rejects.toThrow(/缺少镜头/);
  });

  it('stops waiting when storyboard generation hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const pending = generateAIStoryboardPrompts([shot], '描述', { kind: 'custom', baseUrl: 'http://localhost/v1', model: 'm', apiKey: '' });
    const rejected = expect(pending).rejects.toThrow(/超过 120 秒/);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
  });

  it('keeps the timeout active while the model response body is still streaming', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    })));
    const pending = generateAIStoryboardPrompts([shot], '描述', { kind: 'custom', baseUrl: 'http://localhost/v1', model: 'm', apiKey: '' });
    const rejected = expect(pending).rejects.toThrow(/响应超过 120 秒/);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
  });
});
