import { useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useMotionStore } from '../../stores/motionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { HttpMotionProvider } from '../../services/motion/HttpMotionProvider';
import { MockMotionProvider } from '../../services/motion/MockMotionProvider';
import { indexBonesByName } from '../../core/animation/applyPose';
import type { MotionMeta } from '../../services/motion/types';
import { ProviderBadge } from './ProviderBadge';
import { usePrevisStore } from '../../stores/previsStore';
import { useWorldStore } from '../../stores/worldStore';
import { decomposeSceneAction, defaultInteractionDistance, estimateCharacterHeight, estimateGroundHipLocalOffset, resolveBedInteractionFrame, resolvePropInteractionFrame, resolveSequentialInteractionFrames } from '../../core/previs/world';
import { applyAIPreviewSuggestions } from '../../services/motion/aiSuggestions';
import { createScenePlan } from '../../core/previs/scenePlan';
import { useCameraStore } from '../../stores/cameraStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { formatMotionCollisionWarnings, inspectGroundSupportWarnings, inspectMotionCollisions, inspectPropSupportWarnings } from '../../core/previs/collision';
import { bakeDoorHandleContacts } from '../../core/previs/doorContact';
import { correctGroundedLegTracks } from '../../core/previs/groundContactCorrection';
import { buildBoneMap } from '../../services/motion/procedural';
import { inspectCameraSubjectFraming } from '../../core/previs/cameraFraming';

const mock = new MockMotionProvider();

export function MotionPanel() {
  const providerId = useMotionStore((s) => s.providerId);
  const setProvider = useMotionStore((s) => s.setProvider);
  const baseUrl = useMotionStore((s) => s.baseUrl);
  const setBaseUrl = useMotionStore((s) => s.setBaseUrl);
  const skeleton = useSkeletonStore((s) => s.snapshot);
  const stageProps = useWorldStore((s) => s.props);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const characterMeta = useCharacterStore((s) => s.meta);
  const createAnimation = useAnimationStore((s) => s.createAnimation);
  const setActionPrevis = usePrevisStore((s) => s.setActionPrevis);

  const [prompt, setPrompt] = useState('人物走到桌前，回头看向门口');
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = useState<12 | 24 | 30 | 60>(30);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const [meta, setMeta] = useState<MotionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bindReport, setBindReport] = useState<{ ok: number; total: number; missing: string[] } | null>(null);

  const checkHealth = async () => {
    setHealth('检测中…');
    try {
      const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { providers?: string[] };
      setHealth(`后端在线（${(j.providers ?? []).join(',')}）`);
    } catch (e) {
      setHealth(e instanceof Error ? e.message : '连接失败');
    }
  };

  const generate = async () => {
    if (!skeleton || !sceneObject) {
      setError('请先加载角色');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const provider = providerId === 'http' ? new HttpMotionProvider(baseUrl) : mock;
      const actor = { position: [sceneObject.position.x, sceneObject.position.y, sceneObject.position.z] as [number, number, number], forward: [Math.sin(sceneObject.rotation.y), Math.cos(sceneObject.rotation.y)] as [number, number] };
      const plan = decomposeSceneAction(prompt, duration, stageProps, actor);
      const target = plan?.targetPropId ? stageProps.find((prop) => prop.id === plan.targetPropId) : undefined;
      const bedInteraction = target && sceneObject && skeleton
        ? target.kind === 'bed' ? resolveBedInteractionFrame(target, sceneObject, skeleton, stageProps) : resolvePropInteractionFrame(target, sceneObject, skeleton, stageProps)
        : null;
      const segmentInteractions = sceneObject && skeleton && plan
        ? resolveSequentialInteractionFrames(plan.segments, sceneObject, skeleton, stageProps)
        : {};
      const result = await provider.generateMotion({ prompt, skeleton, duration, fps, seed: 7, stageProps, bedInteraction, segmentInteractions,
        sceneObject,
        groundHipLocalOffset: sceneObject && skeleton ? estimateGroundHipLocalOffset(sceneObject, skeleton, stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0) : undefined });
      const groundY = stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0;
      const groundedAnimation = { ...result.animation, tracks: correctGroundedLegTracks(sceneObject, result.animation,
        buildBoneMap(skeleton), result.meta.segments ?? [], result.meta.contacts ?? [], groundY) };
      const doorContactBake = bakeDoorHandleContacts(sceneObject, groundedAnimation, skeleton, stageProps, result.meta.segments ?? [], result.meta.contacts ?? []);
      const playableAnimation = doorContactBake.animation;
      // create 已 push 一次 history；轨道直接写入 → 一次 Undo 整体撤销本次生成
      const id = createAnimation(playableAnimation.name);
      useAnimationStore.setState((s) => {
        const anims = structuredClone(s.animations);
        const a = anims.find((x) => x.id === id);
        if (a) {
          a.duration = playableAnimation.duration;
          a.fps = playableAnimation.fps;
          a.tracks = structuredClone(playableAnimation.tracks);
        }
        // 新草案立即播放，生成动作就是一次可见的预演反馈。
        return { animations: anims, activeId: id, currentTime: 0, playing: true };
      });
      const collisionFindings = inspectMotionCollisions(sceneObject, playableAnimation, stageProps, result.meta.segments ?? [], result.meta.contacts ?? [], skeleton);
      const collisionWarnings = formatMotionCollisionWarnings(collisionFindings, sceneObject);
      const suggested = applyAIPreviewSuggestions({ animationId: id, duration: playableAnimation.duration, segments: result.meta.segments ?? [], prompt, stageProps, character: sceneObject, skeleton, animation: playableAnimation, collisionFindings });
      const groundSupportWarnings = inspectGroundSupportWarnings(sceneObject, playableAnimation, result.meta.segments ?? [], result.meta.contacts ?? [],
        stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0);
      const propSupportWarnings = inspectPropSupportWarnings(sceneObject, playableAnimation, result.meta.segments ?? [], result.meta.contacts ?? [], stageProps);
      const cameraState = useCameraStore.getState();
      const framingWarnings = cameraState.enabled
        ? inspectCameraSubjectFraming(sceneObject, playableAnimation, cameraState.keyframes, playableAnimation.duration) : [];
      const warnings = [...(result.meta.warnings ?? []), ...doorContactBake.warnings, ...suggested, ...collisionWarnings, ...groundSupportWarnings, ...propSupportWarnings, ...framingWarnings];
      const scenePlan = createScenePlan({
        animationId: id, prompt, duration: playableAnimation.duration,
        character: { id: characterMeta?.id, label: characterMeta?.fileName ?? '主角', heightMeters: estimateCharacterHeight(sceneObject) },
        source: result.meta.planner === 'llm' ? 'model' : 'rules', model: result.meta.model, props: stageProps,
        actions: result.meta.segments ?? [], contacts: result.meta.contacts,
        effects: useEffectsStore.getState().events.filter((event) => event.animationId === id),
        cameraKeyframes: cameraState.keyframes,
        cameraEnabled: cameraState.enabled,
        cameraAutoGenerated: cameraState.autoGenerated,
        target: {
          ...(plan?.targetPropId ? { propId: plan.targetPropId } : {}),
          ...(target ? { distanceMeters: defaultInteractionDistance(target) } : {}),
          ...(bedInteraction?.pathObstructed && !bedInteraction.approachPath ? { obstructed: true } : {}),
        },
        warnings,
      });
      setActionPrevis(id, { prompt, segments: result.meta.segments ?? [], contacts: result.meta.contacts ?? [], warnings, scenePlan });
      setMeta({ ...result.meta, warnings: [...(result.meta.warnings ?? []), ...suggested] });
      // 绑定自检：轨道骨骼名在当前场景能否找到，找不到播放时无动作
      const live = indexBonesByName(sceneObject);
      const names = [...new Set(result.animation.tracks.map((t) => t.boneName))];
      const missing = names.filter((n) => !live.has(n));
      setBindReport({ ok: names.length - missing.length, total: names.length, missing });
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="font-bold text-zinc-700">预演草案（模板动作）</div>
      <div className="flex gap-1">
        <button
          onClick={() => setProvider('mock')}
          className={`flex-1 rounded px-2 py-1 ${providerId === 'mock' ? 'bg-emerald-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}
        >
          本地Mock
        </button>
        <button
          onClick={() => setProvider('http')}
          className={`flex-1 rounded px-2 py-1 ${providerId === 'http' ? 'bg-emerald-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}
        >
          HTTP后端
        </button>
      </div>
      {providerId === 'http' && (
        <div className="space-y-1">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="w-full rounded bg-zinc-100 px-2 py-1 font-mono outline-none ring-1 ring-zinc-300"
          />
          <button onClick={() => void checkHealth()} className="rounded bg-zinc-200 px-2 py-1">
            测试连接
          </button>
          {health && <div className="text-zinc-600">{health}</div>}
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="描述行为，如：走到桌前，回头看门口"
        className="w-full rounded bg-zinc-100 px-2 py-1 outline-none ring-1 ring-zinc-300"
      />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-zinc-600">
          时长
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-14 rounded bg-zinc-100 px-1 py-0.5 outline-none ring-1 ring-zinc-300"
          />
        </label>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value) as 12 | 24 | 30 | 60)} className="rounded bg-zinc-100 px-1 py-1 outline-none ring-1 ring-zinc-300">
          {[12, 24, 30, 60].map((f) => (
            <option key={f} value={f}>{f}fps</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => void generate()}
        disabled={busy || !sceneObject}
        title={!sceneObject ? '先加载角色' : '生成并写入新动画'}
        className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-200 disabled:text-zinc-500"
      >
        {busy ? '生成中…' : '生成并播放预演'}
      </button>
      {meta && (
        <div className="space-y-1 rounded bg-zinc-100 p-2 text-[11px] text-zinc-600">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderBadge source={meta.source} label={`${meta.provider}·动作`} />
            <ProviderBadge source={meta.planner === 'llm' ? 'real' : 'mock'} label={`规划:${meta.planner ?? '?'}${meta.model ? ` ${meta.model}` : ''}`} />
            <span>{meta.latencyMs}ms</span>
          </div>
          {(meta.segments ?? []).length > 1 && (
            <div className="space-y-0.5 font-mono">
              {(meta.segments ?? []).map((s, i) => (
                <div key={i}>{s.t0.toFixed(1)}–{s.t1.toFixed(1)}s {s.template} {s.clause}</div>
              ))}
            </div>
          )}
          {(meta.warnings ?? []).map((w, i) => (
            <div key={i} className="text-amber-400">⚠ {w}</div>
          ))}
          {meta.quality && (
            <div className={meta.quality.status === 'ready' ? 'text-emerald-600' : 'text-amber-600'}>
              {meta.quality.status === 'ready' ? '预演检查通过' : '预演需要检查'}：位移 {meta.quality.movementMeters.toFixed(2)}m
            </div>
          )}
          {bindReport && (
            <div className={bindReport.missing.length > 0 ? 'text-red-500' : 'text-emerald-600'}>
              {bindReport.ok}/{bindReport.total} 轨道已绑定到当前角色
              {bindReport.missing.length > 0 && `；找不到：${bindReport.missing.join('、')}（换角色后需重新生成）`}
            </div>
          )}
        </div>
      )}
      {error && <div className="text-red-400">{error}</div>}
      <div className="text-[11px] text-zinc-500">
        规划 heuristic=确定性代码（MOCK 智能），配 LLM key 后为真实模型；合成均为过程式模板。配 key 见 backend/README.md。
      </div>
    </div>
  );
}
