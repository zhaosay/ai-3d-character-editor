import type { Keyframe } from '../animation/types';

export type EaseMode = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeOutIn';

export interface InbetweenRequest {
  /** 输入稀疏 keys（未必相邻，按 time 升序） */
  keys: Keyframe<number>[] | Keyframe<number[] | unknown[]>[] | Keyframe<unknown>[];
  /** 每秒插入的 key 数（区间长度/(1/fps)等效控制密度） */
  density: number;
  /** 在 [minTime, maxTime] 区间内补，区间外保留 */
  minTime: number;
  maxTime: number;
  /** 缓动模式（仅连续/向量值适用；quaternion 内部仍走 slerp） */
  ease: EaseMode;
  /** 标量/向量入口判定：true=quaternion（按分量 slerp） */
  isQuat?: boolean;
}

export interface InbetweenMeta {
  added: number;
  provider: string;
  source: 'real' | 'mock';
  warnings: string[];
}
