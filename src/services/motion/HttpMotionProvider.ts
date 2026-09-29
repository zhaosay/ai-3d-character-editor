import type { AnimationData } from '../../core/animation/types';
import { validateAnimation } from '../../core/animation/types';
import { applyMotionModifiers, buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks, planClauses } from './procedural';
import { clampDuration } from './MockMotionProvider';
import type { MotionProvider, MotionRequest, MotionResult } from './types';
import type { HonestySource } from '../../types/honesty';
import { ambiguousSceneObjectWarnings, decomposeSceneAction, missingSceneObjectWarnings } from '../../core/previs/world';
import { fetchWithTimeout, isRequestTimeout, REQUEST_TIMEOUT_MS } from '../httpTransport';
import { normalizeMotionSpace } from './space';
import { retimeMotion } from './retime';
import { mapMotionBones } from './mapping';

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
    const restPositions = req.skeleton ? buildRestPositionMap(req.skeleton) : {};
    const requestSkeleton = req.skeleton ? {
      roots: req.skeleton.roots.map((id) => req.skeleton!.nodes[id]?.name).filter((name): name is string => Boolean(name)),
      nodes: Object.values(req.skeleton.nodes).map((node) => ({
        name: node.name,
        semantic: node.semantic,
        parentName: node.parent ? req.skeleton!.nodes[node.parent]?.name ?? null : null,
        restLocal: node.restLocal,
        isEndSite: node.isEndSite,
      })),
    } : undefined;
    const heights = Object.values(req.skeleton?.nodes ?? {}).map((node) => node.world.position[1]);
    const height = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
    const sceneContext = [
      `character_height=${height > 0 ? height.toFixed(2) : 'unknown'}m`,
      `stage_props=${(req.stageProps ?? []).map((prop) => `${prop.kind}@${prop.position.map((value) => value.toFixed(2)).join(',')} size=${prop.size.width.toFixed(2)}x${prop.size.height.toFixed(2)}x${prop.size.length.toFixed(2)}m`).join('; ') || 'none'}`,
    ].join('\n');
    const base = this.baseUrl.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetchWithTimeout(`${base}/motion/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: req.prompt, duration, fps, bones, rest, rest_positions: restPositions,
          skeleton: requestSkeleton, seed: req.seed ?? 0, scene_context: sceneContext,
          ...(req.plannedSegments ? { plan: req.plannedSegments } : {}),
        }),
      });
    } catch (error) {
      if (isRequestTimeout(error)) {
        throw new Error(`动作服务请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒，已停止等待；请检查后端或动作模型负载`);
      }
      throw new Error(`连不上后端 ${base}（确认已运行 uvicorn，见 backend/README.md）`);
    }
    if (!res.ok) {
      const text = await res.text().catch((error) => {
        if (isRequestTimeout(error)) throw new Error(`动作服务请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒，已停止等待；请检查后端或动作模型负载`);
        return '';
      });
      throw new Error(`后端 ${res.status}：${text.slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (error) {
      if (isRequestTimeout(error)) {
        throw new Error(`动作服务请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒，已停止等待；请检查后端或动作模型负载`);
      }
      throw new Error('后端返回了非 JSON');
    }
    const meta = (data as { meta?: Record<string, unknown> }).meta ?? {};
    const rawAnimation = toAnimationData(data);
    const source: HonestySource = meta['source'] === 'real' ? 'real' : 'mock';
    const mappedAnimation = source === 'real' ? mapMotionBones(rawAnimation, bones, meta['bone_mapping']) : rawAnimation;
    const mappingErrors = validateAnimation(mappedAnimation);
    if (mappingErrors.length > 0) throw new Error(`后端骨骼映射后动作数据无效：${mappingErrors.slice(0, 4).join('；')}`);
    const normalized = source === 'real' ? normalizeMotionSpace(mappedAnimation, meta['motion_space']) : { animation: mappedAnimation };
    const retimed = source === 'real' ? retimeMotion(normalized.animation, duration, fps) : { animation: normalized.animation };
    const animation = retimed.animation;
    const scenePlan = decomposeSceneAction(req.prompt, duration, req.stageProps ?? []);
    const remoteSegments = Array.isArray(meta['segments'])
      ? meta['segments'] as Array<{ t0: number; t1: number; template: string; clause: string }>
      : planClauses(req.prompt, duration);
    const sourceSegments = req.plannedSegments ?? scenePlan?.segments ?? remoteSegments;
    const segments = applyMotionModifiers(sourceSegments, req.prompt);
    const localPlan = generatePlannedTracks(bones, segments, duration, req.seed ?? 0, rest, restPositions, req.bedInteraction, req.worldInteractions, req.segmentInteractions,
      req.stageProps?.find((prop) => prop.kind === 'room')?.position[1] ?? 0, req.groundHipLocalOffset);
    const contextWarnings = [
      ...(normalized.warning ? [normalized.warning] : []),
      ...(retimed.warning ? [retimed.warning] : []),
      ...(scenePlan?.warnings ?? []),
      ...(req.bedInteraction?.distanceHeightRatio !== undefined && req.bedInteraction.distanceHeightRatio > 2
        ? [`AI距离检查：目标约在角色 ${req.bedInteraction.distanceHeightRatio.toFixed(1)} 个身高之外，距离可能超出动作可达范围，请复核目标与走位`] : []),
      ...(source === 'real' && [req.bedInteraction, ...Object.values(req.segmentInteractions ?? {})]
        .some((frame) => frame?.pathObstructed)
        ? ['AI路径检查：检测到静态道具阻挡；外部动作轨道未应用本地逐段绕行路径，请复核轨迹'] : []),
      ...(source === 'real' ? localPlan.warnings.filter((warning) => /超过估算臂展|小于估算手臂最短可达距离/.test(warning)) : []),
      ...ambiguousSceneObjectWarnings(req.prompt, req.stageProps ?? []),
      ...missingSceneObjectWarnings(req.prompt, req.stageProps ?? []),
    ];
    if (source === 'mock') animation.tracks = localPlan.tracks;
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
        segments,
        warnings: [...(Array.isArray(meta['warnings']) ? meta['warnings'] as string[] : []), ...contextWarnings, ...(source === 'mock' ? localPlan.warnings : [])],
        quality: source === 'mock' ? localPlan.quality : undefined,
        contacts: scenePlan?.contacts,
      },
    };
  }
}

function toAnimationData(data: unknown): AnimationData {
  const anim = (data as { animation?: unknown }).animation;
  if (typeof anim !== 'object' || anim === null) throw new Error('后端返回缺少 animation 字段');
  const a = anim as Record<string, unknown>;
  if (typeof a['id'] !== 'string' || typeof a['name'] !== 'string'
    || !Array.isArray(a['tracks']) || typeof a['duration'] !== 'number' || typeof a['fps'] !== 'number') {
    throw new Error('后端 animation 字段不完整');
  }
  const candidate = anim as AnimationData;
  const errors = validateAnimation(candidate);
  if (errors.length > 0) throw new Error(`后端动作数据无效：${errors.slice(0, 4).join('；')}`);
  return candidate;
}
