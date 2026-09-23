import { createEmptyAnimation } from '../../core/animation/types';
import { buildBoneMap, generateProceduralTracks } from './procedural';
import type { MotionProvider, MotionRequest, MotionResult } from './types';

/** 本地过程式 Provider：传输 REAL（纯本地），动作 MOCK（模板正弦，P6 替换）。 */
export class MockMotionProvider implements MotionProvider {
  id = 'mock';

  describe(): string {
    return '本地过程式模板（wave/bow/march/sword/block/kick/sway），无网络，动作质量为占位';
  }

  async generateMotion(req: MotionRequest): Promise<MotionResult> {
    const t0 = performance.now();
    const duration = clampDuration(req.duration);
    const fps = req.fps ?? 30;
    const bones = req.skeleton ? buildBoneMap(req.skeleton) : {};
    const { template, templates, tracks, warnings, segments } = generateProceduralTracks(bones, {
      prompt: req.prompt,
      duration,
      seed: req.seed ?? 0,
    });
    if (tracks.length === 0) {
      throw new Error('骨骼语义映射为空，无法生成（请先加载带命名骨骼的角色）');
    }
    const animation = createEmptyAnimation(`AI:${req.prompt.slice(0, 12) || 'motion'}`, fps, duration);
    animation.tracks = tracks;
    return {
      animation,
      meta: {
        provider: 'local-mock',
        source: 'mock',
        latencyMs: Math.round(performance.now() - t0),
        template,
        templates,
        planner: 'heuristic',
        segments,
        warnings,
      },
    };
  }
}

export function clampDuration(d: number | undefined): number {
  if (!d || Number.isNaN(d)) return 4;
  return Math.min(Math.max(d, 0.5), 30);
}
