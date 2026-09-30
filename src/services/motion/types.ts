import type { AnimationData } from '../../core/animation/types';
import type { HonestySource } from '../../types/honesty';
import type { SkeletonSnapshot } from '../../core/skeleton/types';
import type { WorldInteractionFrame, ContactConstraint, StageProp } from '../../core/previs/world';
import type { PlanSegment } from './procedural';
import type * as THREE from 'three';

export interface MotionRequest {
  prompt: string;
  skeleton: SkeletonSnapshot | null;
  duration?: number;
  fps?: 12 | 24 | 30 | 60;
  seed?: number;
  stageProps?: StageProp[];
  bedInteraction?: WorldInteractionFrame | null;
  worldInteractions?: Record<string, WorldInteractionFrame>;
  /** Per-action interaction frames use the actor position reached by earlier stages. */
  segmentInteractions?: Record<number, WorldInteractionFrame>;
  /** Hips-parent local offset that moves the pelvis proxy vertically onto the world floor. */
  groundHipLocalOffset?: [number, number, number];
  /**
   * 角色场景根节点。用于**实测鞋底高度**（坐姿解算需要脚底到踝的真实距离）。
   * 没有它时退回经验值，坐姿会有数厘米误差。
   */
  sceneObject?: THREE.Object3D | null;
  plannedSegments?: PlanSegment[];
  planner?: { source: 'llm'; model?: string };
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
  segments?: Array<{ t0: number; t1: number; template: string; clause: string; intensity?: number; speed?: number }>;
  warnings?: string[];
  quality?: { status: 'ready' | 'warning'; movementMeters: number; warnings: string[] };
  contacts?: ContactConstraint[];
}

export interface MotionResult {
  animation: AnimationData;
  meta: MotionMeta;
}

/**
 * 统一动作生成 Provider；本地/HTTP 可并存，之后接动捕模型时沿用此请求与结果协议。
 * 动作质量由 source 标注，传输层成功不代表动作由 AI 或动捕模型生成。
 */
export interface MotionProvider {
  id: string;
  describe(): string;
  generateMotion(req: MotionRequest): Promise<MotionResult>;
}
