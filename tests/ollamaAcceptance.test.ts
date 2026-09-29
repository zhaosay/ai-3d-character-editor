import { describe, expect, it } from 'vitest';
import { planWithLLM, summarizePhysicsResult } from '../src/services/agent/llmClient';
import { buildActionRepairPrompt } from '../src/services/agent/sceneContext';
import type { LLMPlan } from '../src/services/agent/llmClient';

const runLive = process.env['AI3D_RUN_OLLAMA_ACCEPTANCE'] === '1' ? it : it.skip;
const model = process.env['AI3D_OLLAMA_MODEL'] ?? 'qwen3.5:9b';
const config = { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', model, apiKey: '' };

function motionArgs(result: LLMPlan, originalPrompt: string) {
  const action = result.actions.find((item) => item.tool === 'generate_motion');
  expect(action, result.reply).toBeDefined();
  expect(action!.args['prompt']).toBe(originalPrompt);
  const segments = action!.args['segments'];
  expect(Array.isArray(segments)).toBe(true);
  return segments as Array<{ t0: number; t1: number; template: string; clause: string }>;
}

describe('local Ollama motion acceptance (opt-in)', () => {
  runLive('keeps an AI collision repair on the requested current action segment', async () => {
    const prompt = buildActionRepairPrompt('右手挥拳后收势',
      '动作约 0.8 秒：hand 可能与道具 table-main 相交（代理估算交叠 4 厘米）',
      '只把第1段幅度从1调整到0.8，保留其他动作段和时间。');
    const result = await planWithLLM(prompt, config,
      '当前动画：搏击预演，时长4秒；当前预演动作段：第1段(零基索引0) 0-2秒 punch：右手挥拳，目标道具=table-main，幅度1，速度1；第2段(零基索引1) 2-4秒 sway：收势，幅度1，速度1。当前道具：table-main table position=0.5,0,0 size=1.2x0.75x0.8m。');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].tool).toBe('revise_action_segment');
    expect(result.actions[0].args).toEqual({ segmentIndex: 0, intensity: 0.8 });
  }, 180_000);

  runLive('explains a collision finding without claiming a repair', async () => {
    const prompt = '检查挥拳时手臂是否穿过桌子';
    const summary = await summarizePhysicsResult(prompt, { ok: true, data: {
      issues: [],
      collisionFindings: [{ propId: 'table-main', bodyPart: 'hand', time: 0.8, estimatedOverlapMeters: 0.04 }],
      collisionWarnings: ['动作约 0.8 秒：hand 可能与道具 table-main 相交（估算交叠 4 厘米）'],
      supportWarnings: [],
    } }, config);
    expect(summary).toMatch(/桌|table-main/);
    expect(summary).toMatch(/近似|估算|代理/);
    expect(summary).not.toMatch(/已修复|已经修复/);
  }, 180_000);

  runLive('routes an explicit scene collision check to the read-only physics tool', async () => {
    const result = await planWithLLM('检查挥拳时手臂是否穿过桌子', config,
      '当前动画包含挥拳阶段；场景中有 table-main 桌子，尺寸 1.2x0.75x0.8 米。用户只要求检查，不授权移动桌子或改动作。');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].tool).toBe('check_physics');
  }, 180_000);

  runLive('preserves left-side action order and rightward gaze intent', async () => {
    const prompt = '左手挥手，然后头向右转';
    const result = await planWithLLM(prompt, config);
    const segments = motionArgs(result, prompt);
    const templates = segments.map((segment) => segment.template);
    expect(templates.indexOf('wave')).toBeGreaterThanOrEqual(0);
    expect(templates.indexOf('look_right')).toBeGreaterThan(templates.indexOf('wave'));
    expect(templates).not.toContain('look_left');
    expect(segments.find((segment) => segment.template === 'wave')?.clause).toMatch(/左手/);
  }, 180_000);

  runLive('keeps the desk, phone pickup, and door gaze in sequence', async () => {
    const prompt = '人物走到桌前，拿起手机，然后回头看门口';
    const scene = '角色身高约1.70米；当前道具：table-main table position=1.3,0,-0.8 size=1.1x0.75x0.7m；phone-main phone position=1.3,0.75,-0.8 size=0.075x0.018x0.15m；door-main door position=-4,0,0 size=0.9x2.05x0.08m';
    const result = await planWithLLM(prompt, config, scene);
    const segments = motionArgs(result, prompt);
    const templates = segments.map((segment) => segment.template);
    expect(templates).toContain('march');
    expect(templates).toContain('reach');
    expect(templates).toContain('look');
    expect(segments.some((segment) => /手机/.test(segment.clause))).toBe(true);
    expect(segments.at(-1)?.clause).toMatch(/门口/);
  }, 180_000);

  runLive('revises only the requested existing action segment field', async () => {
    const context = '当前预演动作段：第1段 index=0 time=0–2s template=wave clause=左手挥手 intensity=1 speed=1；第2段 index=1 time=2–4s template=bow clause=鞠躬 intensity=0.9 speed=1。动作段索引从0开始。';
    const result = await planWithLLM('只把第2段速度改为0.7，保持动作描述、模板、时间和其他段不变', config, context);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].tool).toBe('revise_action_segment');
    expect(result.actions[0].args).toEqual({ segmentIndex: 1, speed: 0.7 });
  }, 180_000);

  runLive('does not invent standing up after a bed sleep instruction forbids it', async () => {
    const prompt = '躺到床上睡觉，不要起床';
    const scene = '角色身高约1.70米；当前道具：bed-main bed position=-1.25,0,0 size=1.3x0.58x2.1m';
    const result = await planWithLLM(prompt, config, scene);
    const segments = motionArgs(result, prompt);
    const templates = segments.map((segment) => segment.template);
    expect(templates).toContain('lie');
    expect(templates).toContain('sleep');
    expect(templates).not.toContain('stand');
  }, 180_000);
});
