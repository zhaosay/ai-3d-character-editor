import type { HonestySource } from '../../types/honesty';
import type { AnimationData } from '../../core/animation/types';

export interface InbetweenRequest {
  animation: AnimationData;
  minTime: number;
  maxTime: number;
  /** 每秒插入多少 key，30≈30fps 密度，5≈平缓插值 */
  density: number;
  ease: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeOutIn';
}

export interface InbetweenMeta {
  provider: string;
  source: HonestySource;
  addedKeys: number;
  latencyMs: number;
  warnings: string[];
}

export interface InbetweenResult {
  animation: AnimationData;
  meta: InbetweenMeta;
}

export interface InbetweenProvider {
  id: string;
  describe(): string;
  runInbetween(req: InbetweenRequest): Promise<InbetweenResult>;
}
