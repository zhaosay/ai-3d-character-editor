import { runInbetweenOnAnimation } from '../../core/inbetween/runInbetween';
import type { InbetweenProvider, InbetweenRequest, InbetweenResult } from './types';

/** 本地数学补帧：REAL（实现真实），稀疏采样为密集 key。 */
export class MathInbetweenProvider implements InbetweenProvider {
  id = 'math';

  describe(): string {
    return '本地数学补帧（标量 lerp / 四元数 slerp）+ 缓动';
  }

  async runInbetween(req: InbetweenRequest): Promise<InbetweenResult> {
    const t0 = performance.now();
    const { animation, addedKeys, warnings } = runInbetweenOnAnimation({
      animation: req.animation,
      minTime: req.minTime,
      maxTime: req.maxTime,
      density: req.density,
      ease: req.ease,
    });
    return {
      animation,
      meta: {
        provider: 'local-math',
        source: 'real',
        addedKeys,
        latencyMs: Math.round(performance.now() - t0),
        warnings,
      },
    };
  }
}
