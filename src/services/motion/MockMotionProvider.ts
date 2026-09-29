import { createEmptyAnimation } from '../../core/animation/types';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generateProceduralTracks } from './procedural';
import type { MotionProvider, MotionRequest, MotionResult } from './types';
import { ambiguousSceneObjectWarnings, decomposeSceneAction, missingSceneObjectWarnings } from '../../core/previs/world';

/** 本地过程式 Provider：传输 REAL（纯本地），动作 MOCK（模板正弦，P6 替换）。 */
export class MockMotionProvider implements MotionProvider {
  id = 'mock';

  describe(): string {
    return '本地过程式模板（走、拿取、看向、转身等），无网络，动作质量为预演占位';
  }

  async generateMotion(req: MotionRequest): Promise<MotionResult> {
    const t0 = performance.now();
    const duration = clampDuration(req.duration);
    const fps = req.fps ?? 30;
    const bones = req.skeleton ? buildBoneMap(req.skeleton) : {};
    const rest = req.skeleton ? buildRestMap(req.skeleton) : {};
    const restPositions = req.skeleton ? buildRestPositionMap(req.skeleton) : {};
    const actionPlan = decomposeSceneAction(req.prompt, duration, req.stageProps ?? []);
    const contextWarnings = actionPlan?.targetPropId && !req.bedInteraction
      ? ['已识别场景目标，但角色缺少可用的髋部骨骼父节点，无法把交互点转换到角色坐标']
      : [
        ...(req.bedInteraction?.distanceHeightRatio !== undefined && req.bedInteraction.distanceHeightRatio > 2
          ? [`AI距离检查：目标约在角色 ${req.bedInteraction.distanceHeightRatio.toFixed(1)} 个身高之外，距离可能超出动作可达范围，请复核目标与走位`] : []),
        ...(req.bedInteraction?.pathObstructed ? [req.bedInteraction.approachPath
          ? 'AI路径检查：直线路径受静态道具阻挡，已按扩展占地边界规划绕行；未计算角色全身与动态障碍碰撞'
          : 'AI路径检查：直线路径受阻且未找到可行绕行路线，请调整场景或目标位置'] : []),
        ...ambiguousSceneObjectWarnings(req.prompt, req.stageProps ?? []),
        ...missingSceneObjectWarnings(req.prompt, req.stageProps ?? []),
      ];
    const { template, templates, tracks, warnings, segments, quality } = generateProceduralTracks(bones, {
      prompt: req.prompt,
      duration,
      seed: req.seed ?? 0,
      segments: req.plannedSegments ?? actionPlan?.segments,
      bedInteraction: req.bedInteraction,
      worldInteractions: req.worldInteractions,
      segmentInteractions: req.segmentInteractions,
      groundY: req.stageProps?.find((prop) => prop.kind === 'room')?.position[1] ?? 0,
      groundHipLocalOffset: req.groundHipLocalOffset,
    }, rest, restPositions);
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
        planner: req.planner?.source ?? 'heuristic',
        model: req.planner?.model,
        segments,
        contacts: actionPlan?.contacts,
        warnings: [...(actionPlan?.warnings ?? []), ...contextWarnings, ...warnings],
        quality,
      },
    };
  }
}

export function clampDuration(d: number | undefined): number {
  if (!d || Number.isNaN(d)) return 4;
  return Math.min(Math.max(d, 0.5), 30);
}
