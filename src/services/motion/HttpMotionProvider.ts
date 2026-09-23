import type { AnimationData } from '../../core/animation/types';
import { buildBoneMap, buildRestMap } from './procedural';
import { clampDuration } from './MockMotionProvider';
import type { MotionProvider, MotionRequest, MotionResult } from './types';
import type { HonestySource } from '../../types/honesty';

/**
 * HTTP Provider：传输 REAL（fetch 后端），动作质量以后端返回的 source 为准
 *（P5 后端返回 source=mock；P6 接真实模型后返回 real，无需改编辑器）。
 */
export class HttpMotionProvider implements MotionProvider {
  id = 'http';
  baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  describe(): string {
    return `HTTP 后端 ${this.baseUrl}/motion/generate`;
  }

  async generateMotion(req: MotionRequest): Promise<MotionResult> {
    const t0 = performance.now();
    const duration = clampDuration(req.duration);
    const fps = req.fps ?? 30;
    const bones = req.skeleton ? buildBoneMap(req.skeleton) : {};
    const rest = req.skeleton ? buildRestMap(req.skeleton) : {};
    const base = this.baseUrl.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/motion/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: req.prompt, duration, fps, bones, rest, seed: req.seed ?? 0 }),
      });
    } catch {
      throw new Error(`连不上后端 ${base}（确认已运行 uvicorn，见 backend/README.md）`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`后端 ${res.status}：${text.slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error('后端返回了非 JSON');
    }
    const animation = toAnimationData(data);
    const meta = (data as { meta?: Record<string, unknown> }).meta ?? {};
    const source: HonestySource = meta['source'] === 'real' ? 'real' : 'mock';
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      animation,
      meta: {
        provider: str(meta['provider']) ?? 'backend',
        source,
        latencyMs: Math.round(performance.now() - t0),
        template: str(meta['template']),
        templates: Array.isArray(meta['templates']) ? (meta['templates'] as string[]) : undefined,
        planner: str(meta['planner']),
        model: str(meta['model']),
        segments: Array.isArray(meta['segments'])
          ? (meta['segments'] as Array<{ t0: number; t1: number; template: string; clause: string }>)
          : undefined,
        warnings: Array.isArray(meta['warnings']) ? (meta['warnings'] as string[]) : [],
      },
    };
  }
}

function toAnimationData(data: unknown): AnimationData {
  const anim = (data as { animation?: unknown }).animation;
  if (typeof anim !== 'object' || anim === null) throw new Error('后端返回缺少 animation 字段');
  const a = anim as Record<string, unknown>;
  if (!Array.isArray(a['tracks']) || typeof a['duration'] !== 'number' || typeof a['fps'] !== 'number') {
    throw new Error('后端 animation 字段不完整');
  }
  return anim as AnimationData;
}
