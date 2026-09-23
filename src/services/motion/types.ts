import type { AnimationData } from '../../core/animation/types';
import type { HonestySource } from '../../types/honesty';
import type { SkeletonSnapshot } from '../../core/skeleton/types';

export interface MotionRequest {
  prompt: string;
  skeleton: SkeletonSnapshot | null;
  duration?: number;
  fps?: 12 | 24 | 30 | 60;
  seed?: number;
}

export interface MotionMeta {
  provider: string;
  source: HonestySource;
  latencyMs: number;
  template?: string;
  templates?: string[];
  /** 语言理解来源：heuristic（确定性代码）/ llm（真实模型）/ external（调用方指定） */
  planner?: string;
  model?: string;
  segments?: Array<{ t0: number; t1: number; template: string; clause: string }>;
  warnings?: string[];
}

export interface MotionResult {
  animation: AnimationData;
  meta: MotionMeta;
}

/**
 * 动作生成 Provider 接口（P5 冻结，P6 接真实模型时只加新实现）。
 * 注意：动作质量由各实现保证诚实标注，传输层与生成质量分开标注。
 */
export interface MotionProvider {
  id: string;
  describe(): string;
  generateMotion(req: MotionRequest): Promise<MotionResult>;
}
