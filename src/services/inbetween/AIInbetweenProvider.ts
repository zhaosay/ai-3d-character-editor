import type { InbetweenProvider, InbetweenRequest, InbetweenResult } from './types';

/** AI 版接口预留（P9+/实际模型可用时仅替换实现）。当前输出与原动画等价并明确标注 mock。 */
export class AIInbetweenProvider implements InbetweenProvider {
  id = 'ai';

  describe(): string {
    return 'AI 补帧（未接入模型，当前与原图严格一致回退）';
  }

  async runInbetween(req: InbetweenRequest): Promise<InbetweenResult> {
    const t0 = performance.now();
    return {
      animation: req.animation,
      meta: {
        provider: 'ai-not-implemented',
        source: 'mock',
        addedKeys: 0,
        latencyMs: Math.round(performance.now() - t0),
        warnings: ['AI 补帧未实现，已回退：不改变动画。如需真实 AI，请替换 AIInbetweenProvider.runInbetween。'],
      },
    };
  }
}
