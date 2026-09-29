import { useEffect, useState } from 'react';
import { buildRestMap, buildRestPositionMap, buildBoneMap, generatePlannedTracks, type PlanSegment } from '../../services/motion/procedural';
import { optimizePlan, validatePlan } from '../../core/previs/plan';
import { useAnimationStore } from '../../stores/animationStore';
import { usePrevisStore } from '../../stores/previsStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useWorldStore } from '../../stores/worldStore';
import { decomposeSceneAction, estimateGroundHipLocalOffset, resolveBedInteractionFrame, resolvePropInteractionFrame, resolveSequentialInteractionFrames } from '../../core/previs/world';
import { validateScenePlan } from '../../core/previs/scenePlan';
import { formatMotionCollisionWarnings, inspectGroundSupportWarnings, inspectMotionCollisions, inspectPropSupportWarnings, isMotionCollisionWarning } from '../../core/previs/collision';
import { useAgentStore } from '../../stores/agentStore';
import { buildClarificationRequest, clarificationChoices } from '../../core/previs/clarifications';
import { bakeDoorHandleContacts } from '../../core/previs/doorContact';
import { correctGroundedLegTracks } from '../../core/previs/groundContactCorrection';
import { inspectCameraSubjectFraming } from '../../core/previs/cameraFraming';
import { useCameraStore } from '../../stores/cameraStore';
import { buildActionRepairPrompt } from '../../services/agent/sceneContext';

const TEMPLATE_OPTIONS = ['march', 'orient', 'sit', 'squat', 'kneel', 'lie', 'sleep', 'reach', 'look', 'look_left', 'look_right', 'raise_left', 'raise_right', 'turn', 'wave', 'bow', 'sword', 'handoff', 'block', 'kick', 'punch', 'breath', 'sway'];
const PLAN_LOCK_FIELDS = [
  ['actions', '动作'], ['environment', '场景'], ['target', '目标/距离'], ['contacts', '接触'], ['weapons', '武器'], ['events', '事件'], ['camera', '镜头'], ['effects', '特效'], ['storyboard', '分镜提示词'],
] as const;

/** 逐段动作编辑器：改描述/模板后，按同一时间计划重新生成当前预演轨道。 */
export function ActionPlanPanel() {
  const id = useAnimationStore((s) => s.active()?.id);
  return <ActionPlanEditor key={id} />;
}

function ActionPlanEditor() {
  const active = useAnimationStore((s) => s.active());
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const character = useCharacterStore((s) => s.sceneObject);
  const stageProps = useWorldStore((s) => s.props);
  const cameraKeyframes = useCameraStore((s) => s.keyframes);
  const cameraEnabled = useCameraStore((s) => s.enabled);
  const source = usePrevisStore((s) => active ? s.byAnimationId[active.id] : undefined);
  const updateSegments = usePrevisStore((s) => s.updateSegments);
  const togglePlanLock = usePrevisStore((s) => s.togglePlanLock);
  const replaceTracks = useAnimationStore((s) => s.replaceActiveTracks);
  const queuePrompt = useAgentStore((s) => s.queuePrompt);
  const collisionContextKey = JSON.stringify({
    props: stageProps,
    actions: source?.segments,
    contacts: source?.scenePlan?.contacts ?? source?.contacts,
    camera: cameraEnabled ? cameraKeyframes : [],
  });
  useEffect(() => {
    if (!active || !character || !source) return;
    const timeout = window.setTimeout(() => {
      const latest = usePrevisStore.getState().byAnimationId[active.id];
      if (!latest) return;
      const contacts = latest.scenePlan?.contacts ?? latest.contacts ?? [];
      const collisionWarnings = formatMotionCollisionWarnings(inspectMotionCollisions(
        character, active, stageProps, latest.segments, contacts, snapshot ?? undefined,
      ), character).concat(inspectGroundSupportWarnings(character, active, latest.segments, contacts,
        stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0), inspectPropSupportWarnings(character, active, latest.segments, contacts, stageProps),
      ...(cameraEnabled
        ? inspectCameraSubjectFraming(character, active, cameraKeyframes, active.duration) : []));
      const priorWarnings = latest.warnings ?? [];
      const warnings = [...new Set([
        ...priorWarnings.filter((warning) => !isMotionCollisionWarning(warning) && !/(?:动作(?:约 .*秒|段 .*声明).*(?:支撑|离地.*厘米|穿入地面)|镜头约 .*人物.*超出)/.test(warning)),
        ...collisionWarnings,
      ])];
      const cameraSnapshotChanged = latest.scenePlan && (latest.scenePlan.camera.enabled !== cameraEnabled
        || JSON.stringify(latest.scenePlan.camera.keyframes) !== JSON.stringify(cameraKeyframes));
      if (JSON.stringify(warnings) === JSON.stringify(priorWarnings) && !cameraSnapshotChanged) return;
      const oldCollisionWarnings = new Set(priorWarnings.filter((warning) => isMotionCollisionWarning(warning) || /(?:动作(?:约 .*秒|段 .*声明).*(?:支撑|离地.*厘米|穿入地面)|镜头约 .*人物.*超出)/.test(warning)));
      const scenePlan = latest.scenePlan ? {
        ...latest.scenePlan,
        camera: { ...latest.scenePlan.camera, keyframes: cameraKeyframes, enabled: cameraEnabled },
        interpretation: {
          ...latest.scenePlan.interpretation,
          reasons: [...latest.scenePlan.interpretation.reasons.filter((reason) => !oldCollisionWarnings.has(reason)), ...collisionWarnings],
        },
      } : undefined;
      usePrevisStore.getState().setActionPrevis(active.id, { ...latest, warnings, scenePlan });
    }, 100);
    return () => window.clearTimeout(timeout);
  // The serialized context key covers stage props, actions, and contacts without rerunning on warning-only store updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.duration, active?.tracks, character, snapshot, collisionContextKey, cameraEnabled, cameraKeyframes]);
  const [draft, setDraft] = useState<PlanSegment[] | null>(null);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<number, string>>({});
  const [acceptedIssues, setAcceptedIssues] = useState<string[]>([]);
  const segments = draft ?? source?.segments ?? [];
  const issues = active ? validatePlan(segments, active.duration) : [];
  const sceneIssues = source?.scenePlan ? validateScenePlan(source.scenePlan) : [];
  if (!active || !source) return null;

  const update = (index: number, field: keyof PlanSegment, value: string | number) => setDraft((old) => {
    const next = structuredClone(old ?? source.segments);
    next[index] = { ...next[index], [field]: value };
    if (field === 'targetPropId' && value === '') delete next[index].targetPropId;
    return next;
  });
  const optimize = () => setDraft(optimizePlan(segments, active.duration));
  const apply = () => {
    if (!snapshot || issues.some((issue) => issue.level === 'error')) return;
    const normalized = segments.map((segment) => ({ ...segment, clause: segment.clause.trim() }));
    const actor = character ? { position: [character.position.x, character.position.y, character.position.z] as [number, number, number], forward: [Math.sin(character.rotation.y), Math.cos(character.rotation.y)] as [number, number] } : undefined;
    const scenePlan = decomposeSceneAction(source.prompt, active.duration, stageProps, actor);
    const currentTarget = source.scenePlan?.target;
    const targetPropId = currentTarget?.propId ?? scenePlan?.targetPropId;
    const target = targetPropId ? stageProps.find((prop) => prop.id === targetPropId) : undefined;
    const targetDistance = currentTarget && currentTarget.propId === targetPropId ? currentTarget.distanceMeters : undefined;
    const bedInteraction = target && character
      ? target.kind === 'bed'
        ? resolveBedInteractionFrame(target, character, snapshot, stageProps, targetDistance)
        : resolvePropInteractionFrame(target, character, snapshot, stageProps, targetDistance)
      : null;
    const worldInteractions = Object.fromEntries([...new Set(normalized.flatMap((segment) => segment.targetPropId ? [segment.targetPropId] : []))]
      .flatMap((propId) => {
        const prop = stageProps.find((item) => item.id === propId);
        if (!prop || !character) return [];
        const distance = currentTarget && propId === currentTarget.propId ? currentTarget.distanceMeters : undefined;
        const frame = prop.kind === 'bed'
          ? resolveBedInteractionFrame(prop, character, snapshot, stageProps, distance)
          : resolvePropInteractionFrame(prop, character, snapshot, stageProps, distance);
        return frame ? [[propId, frame] as const] : [];
      }));
    const segmentInteractions = character ? resolveSequentialInteractionFrames(normalized, character, snapshot, stageProps,
      currentTarget?.propId ? { [currentTarget.propId]: currentTarget.distanceMeters } : undefined) : {};
    const result = generatePlannedTracks(buildBoneMap(snapshot), normalized, active.duration, 7, buildRestMap(snapshot), buildRestPositionMap(snapshot), bedInteraction, worldInteractions, segmentInteractions,
      stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0,
      character ? estimateGroundHipLocalOffset(character, snapshot, stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0) : undefined);
    updateSegments(active.id, normalized);
    const latest = usePrevisStore.getState().byAnimationId[active.id];
    const contacts = latest?.scenePlan?.contacts ?? latest?.contacts ?? [];
    const groundedTracks = character ? correctGroundedLegTracks(character, { ...active, tracks: result.tracks },
      buildBoneMap(snapshot), normalized, contacts, stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0) : result.tracks;
    const doorContactBake = character ? bakeDoorHandleContacts(character, { ...active, tracks: groundedTracks }, snapshot, stageProps, normalized, contacts)
      : { animation: { ...active, tracks: groundedTracks }, warnings: [] };
    replaceTracks(doorContactBake.animation.tracks);
    if (latest) {
      const collisionWarnings = character ? formatMotionCollisionWarnings(inspectMotionCollisions(
        character, doorContactBake.animation, stageProps, latest.segments,
        contacts, snapshot,
      ), character).concat(inspectGroundSupportWarnings(character, doorContactBake.animation, latest.segments, contacts,
        stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0), inspectPropSupportWarnings(character, doorContactBake.animation, latest.segments, contacts, stageProps)) : [];
      const routeWarnings = result.warnings.filter((warning) => /段走位(?:已绕开|没有可从当前起点)/.test(warning));
      const propSupportWarnings = character ? inspectPropSupportWarnings(character, doorContactBake.animation, latest.segments, contacts, stageProps) : [];
      const warnings = [...new Set([...(latest.warnings ?? []).filter((warning) => !/段走位(?:已绕开|没有可从当前起点)/.test(warning) && !isMotionCollisionWarning(warning) && !/(?:动作(?:约 .*秒|段 .*声明).*(?:支撑|离地.*厘米|穿入地面)|第 .* 段(?:开门|交互).*(?:IK 骨架链|可达范围))/.test(warning)), ...routeWarnings, ...doorContactBake.warnings, ...collisionWarnings, ...propSupportWarnings])];
      usePrevisStore.getState().setActionPrevis(active.id, { ...latest, warnings });
    }
    setDraft(null);
  };
  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="font-bold text-zinc-700">逐段动作修改</div>
      <div className="text-[11px] text-zinc-500">改一段只重建当前预演动画；时间、镜头轨道和其他动作段保持不变。</div>
      {source.scenePlan && <div className="space-y-1 rounded bg-sky-50 p-2 text-[10px] text-sky-800">
        <div>统一预演方案 · {source.scenePlan.interpretation.source === 'model' ? '模型解析' : '规则解析'} · 置信度{({ high: '高', medium: '中', low: '低' })[source.scenePlan.interpretation.certainty]}</div>
        <div>场景 {source.scenePlan.environment.props.length} 项 · 接触 {source.scenePlan.contacts.length} 项 · 事件 {source.scenePlan.events.length} 项 · 武器 {source.scenePlan.weapons.length} 项 · 特效 {source.scenePlan.effects.length} 项 · 镜头关键帧 {source.scenePlan.camera.keyframes.length} 个</div>
        {source.scenePlan.events.length > 0 && <div className="space-y-0.5 border-t border-sky-100 pt-1">
          {source.scenePlan.events.map((event, index) => <div key={`${index}-${event.actionIndex}-${event.time}`}>
            {index}. {event.time.toFixed(2)}s · 动作段 {event.actionIndex + 1} · {event.label}
          </div>)}
        </div>}
        <div className="flex flex-wrap items-center gap-1">
          <span>锁定 AI 改动：</span>
          {PLAN_LOCK_FIELDS.map(([field, label]) => {
            const locked = source.scenePlan!.lockedFields.includes(field);
            return <button
              key={field}
              type="button"
              aria-pressed={locked}
              onClick={() => { useAnimationStore.getState().checkpoint(); togglePlanLock(active.id, field); }}
              className={`rounded px-1.5 py-0.5 ring-1 ${locked ? 'bg-amber-700 text-white ring-amber-700' : 'bg-white text-zinc-600 ring-zinc-200'}`}
            >{locked ? `🔒${label}` : label}</button>;
          })}
        </div>
        {sceneIssues.map((issue) => {
          const key = `${issue.path}:${issue.message}`;
          if (acceptedIssues.includes(key)) return null;
          return <div key={key} className={`flex items-start gap-1 ${issue.level === 'error' ? 'text-red-600' : 'text-amber-700'}`}>
            <span className="min-w-0 flex-1">{issue.message}</span>
            <button
              type="button"
              className="shrink-0 rounded bg-white px-1.5 py-0.5 text-sky-700 ring-1 ring-sky-200"
              onClick={() => queuePrompt(buildActionRepairPrompt(source.prompt, `${issue.path}: ${issue.message}`, '只修改解决这条校验所需的当前动作/场景字段，保留其他预演内容。'), true)}
            >AI 修复</button>
            <button
              type="button"
              className="shrink-0 rounded bg-white px-1.5 py-0.5 text-zinc-600 ring-1 ring-zinc-200"
              onClick={() => setAcceptedIssues((accepted) => accepted.includes(key) ? accepted : [...accepted, key])}
            >接受现状</button>
          </div>;
        })}
        {source.scenePlan.interpretation.reasons.map((reason, index) => <div key={index}>待确认：{reason}</div>)}
        {(source.scenePlan.interpretation.missingInfo ?? []).map((item, index) => <div key={`missing-${index}`}>缺少信息：{item}</div>)}
        {source.scenePlan.interpretation.questions.map((question, index) => <div key={index} className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
          <div className="font-medium">需要确认：{question}</div>
          {clarificationChoices(question, stageProps).length > 0 && <div className="flex flex-wrap gap-1">
            {clarificationChoices(question, stageProps).map((choice) => <button
              key={choice}
              type="button"
              aria-pressed={clarificationAnswers[index] === choice}
              onClick={() => setClarificationAnswers((answers) => ({ ...answers, [index]: choice }))}
              className={`rounded px-2 py-1 ring-1 ${clarificationAnswers[index] === choice ? 'bg-amber-800 text-white ring-amber-800' : 'bg-white text-amber-900 ring-amber-200'}`}
            >{choice}</button>)}
          </div>}
          <div className="flex gap-1">
            <input
              value={clarificationAnswers[index] ?? ''}
              onChange={(event) => setClarificationAnswers((answers) => ({ ...answers, [index]: event.target.value }))}
              placeholder="填写你的选择或补充"
              aria-label={`澄清问题 ${index + 1} 的回答`}
              className="min-w-0 flex-1 rounded bg-white px-2 py-1 text-zinc-800 ring-1 ring-amber-200"
            />
            <button
              disabled={!clarificationAnswers[index]?.trim()}
              onClick={() => queuePrompt(buildClarificationRequest(source.prompt, question, clarificationAnswers[index].trim()), true)}
              className="shrink-0 rounded bg-amber-700 px-2 py-1 text-white disabled:bg-zinc-300"
            >AI 重新规划</button>
          </div>
        </div>)}
        {source.scenePlan.interpretation.fieldEvidence && <details className="pt-1">
          <summary className="cursor-pointer font-medium">查看各项来源与可信度</summary>
          <div className="mt-1 space-y-0.5">
            {Object.entries(source.scenePlan.interpretation.fieldEvidence).map(([field, evidence]) => <div key={field}>
              {({ prompt: '原始描述', actions: '动作分段', environment: '场景物体', contacts: '接触关系', camera: '镜头' } as Record<string, string>)[field] ?? field}：
              {({ user: '用户', model: '模型', editor: '编辑器', rules: '规则' })[evidence.source]} ·
              {({ high: '高', medium: '中', low: '低' })[evidence.certainty]}（{evidence.reason}）
            </div>)}
          </div>
        </details>}
      </div>}
      {source.contacts && source.contacts.length > 0 && <div className="rounded-md bg-sky-50 p-2 text-[10px] text-sky-800">
        支撑目标：{[...new Set(source.contacts.map((contact) => `${contact.bodyPart} → ${contact.surface}`))].join(' · ')}
      </div>}
      {source.warnings?.map((warning, index) => {
        const collisionWarning = /动作约 .*可能与道具 .*相交/.test(warning);
        const groundPenetrationWarning = /动作约 .*代理估算穿入地面/.test(warning);
        const groundSupportWarning = /动作(?:约 .*秒|段 .*声明).*支撑地面/.test(warning);
        const propSupportWarning = /动作约 .*声明.*(?:支撑 .* 的(?:床面|座面)|支撑 .*，但)/.test(warning) && /床面|座面|支撑面/.test(warning);
        return <div key={index} className="flex items-start gap-2 text-[10px] text-amber-700">
          <span className="min-w-0 flex-1">⚠ {warning}</span>
          {(collisionWarning || groundPenetrationWarning || groundSupportWarning || propSupportWarning) && <button type="button" className="shrink-0 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-50"
            onClick={() => queuePrompt(buildActionRepairPrompt(source.prompt, warning,
              groundPenetrationWarning
                ? '请修复这条身体穿入地面的预警。只调整碰撞时刻关联动作段的髋部位置、身体姿态或动作幅度，使身体代理保持在地面上方；允许脚底/手掌等明确支撑部位轻触地面。保持其他动作段、时间、道具、镜头、事件、特效及锁定字段不变；修复后重新检查地面碰撞，无法避免时明确说明。'
                : groundSupportWarning
                ? '请修复这条地面支撑预警。只调整关联动作阶段的髋部/身体姿态或动作幅度，使声明的接触部位在阶段结束时接近地面；保持其他动作段、时间、场景、镜头、事件、特效及已锁定字段不变。修复后重新检查地面支撑；若当前动作模板不能做到，请明确说明，不要声称已通过。'
                : propSupportWarning
                  ? '请修复这条床面/座面支撑预警。先只调整关联动作阶段的髋部位置、朝向或姿态，使声明的身体部位落在目标床垫/座面高度与范围内；只有动作无法适配当前尺寸时才建议调整物体。保持其他动作段、时间、接触关系、镜头、事件、特效及已锁定字段不变；修复后重新检查支撑关系，无法做到时明确说明，不要声称已通过。'
                  : '请修复这条人物与道具相交预警。优先只调整碰撞时间附近的动作段走位或幅度，必要时才改目标道具位置/尺寸；保持其他动作段、时间、镜头、事件、特效及已锁定字段不变。修复后重新检查碰撞；若无法在保留这些约束的前提下修复，请说明原因，不要声称已通过。'), true)}>
            AI 修复
          </button>}
        </div>;
      })}
      <div className="space-y-2">
        {segments.map((segment, index) => <div key={index} className="rounded bg-zinc-50 p-2 ring-1 ring-zinc-200">
          <div className="mb-1 flex gap-1"><span className="font-mono text-zinc-500">{segment.t0.toFixed(1)}–{segment.t1.toFixed(1)}s</span><select value={segment.template} onChange={(e) => update(index, 'template', e.target.value)} className="ml-auto rounded bg-white px-1 ring-1 ring-zinc-300">{TEMPLATE_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></div>
          <input value={segment.clause} onChange={(e) => update(index, 'clause', e.target.value)} className="w-full rounded bg-white px-1 py-1 ring-1 ring-zinc-300" aria-label={`动作 ${index + 1} 描述`} />
          <label className="mt-1 block text-[10px] text-zinc-500">交互目标
            <select value={segment.targetPropId ?? ''} onChange={(event) => update(index, 'targetPropId', event.target.value)} className="ml-1 rounded bg-white px-1 py-1 ring-1 ring-zinc-300" aria-label={`动作 ${index + 1} 交互目标`}>
              <option value="">不绑定物体</option>
              {stageProps.map((prop) => <option key={prop.id} value={prop.id}>{prop.kind} · {prop.id}</option>)}
            </select>
          </label>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
            <label>幅度 {Math.round((segment.intensity ?? 1) * 100)}%<input type="range" min={0.4} max={1.6} step={0.05} value={segment.intensity ?? 1} onChange={(e) => update(index, 'intensity', Number(e.target.value))} className="w-full accent-emerald-600" /></label>
            <label>速度 {Math.round((segment.speed ?? 1) * 100)}%<input type="range" min={0.5} max={2} step={0.05} value={segment.speed ?? 1} onChange={(e) => update(index, 'speed', Number(e.target.value))} className="w-full accent-sky-600" /></label>
          </div>
        </div>)}
      </div>
      {issues.map((issue, index) => <div key={index} className={issue.level === 'error' ? 'text-red-600' : 'text-amber-600'}>{issue.level === 'error' ? '×' : '⚠'} {issue.message}</div>)}
      <div className="flex gap-1"><button onClick={optimize} className="flex-1 rounded bg-sky-50 px-2 py-1 text-sky-700">本地智能优化</button><button onClick={apply} disabled={!snapshot || issues.some((issue) => issue.level === 'error')} className="flex-1 rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500">应用到预演</button></div>
      <div className="text-[10px] text-zinc-400">本地智能优化会重新识别描述对应的动作模板并修正时间连续性；配置真实 Agent Provider 后可继续让模型改写故事和镜头文案。</div>
    </div>
  );
}
