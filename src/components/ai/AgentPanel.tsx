import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVIDER_LABELS, useAgentStore, type AgentProvider } from '../../stores/agentStore';
import { executeActions } from '../../services/agent/toolRegistry';
import { READONLY_TOOLS, type AgentAction } from '../../services/agent/toolTypes';
import { planMock } from '../../services/agent/mockAgent';
import { listOllamaModels, planWithLLM, summarizePhysicsResult, type LLMKind } from '../../services/agent/llmClient';
import { ProviderBadge } from './ProviderBadge';
import * as THREE from 'three';
import { useWorldStore } from '../../stores/worldStore';
import { useAnimationStore } from '../../stores/animationStore';
import { usePrevisStore } from '../../stores/previsStore';
import { useCameraStore } from '../../stores/cameraStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useShallow } from 'zustand/react/shallow';
import { listMorphTargets } from '../../core/face/morphs';
import { parseClarificationRequest } from '../../core/previs/clarifications';
import { awaitWithPlanningRevision, createPlanningRevision, formatEffectsContext, formatSceneIssuesContext, isPlanningRevisionCurrent } from '../../services/agent/sceneContext';
import { validateScenePlan } from '../../core/previs/scenePlan';
import { useSkeletonStore } from '../../stores/skeletonStore';

const ORDER: AgentProvider[] = ['mock', 'anthropic', 'openai', 'ollama', 'custom'];

const HINTS: Record<AgentProvider, string> = {
  mock: '本地规则，未调用 AI；复杂描述需连接模型',
  anthropic: 'Claude 原生 API（/v1/messages），Key 仅内存',
  openai: 'OpenAI 兼容接口（Codex 模型），Key 仅内存',
  ollama: '本机 Ollama 原生 API（/api/chat），免 Key；跨域被拒设 OLLAMA_ORIGINS',
  custom: '任意 OpenAI-compatible 三方地址',
};

const CHIPS = ['人物走向桌前，拿起手机，回头看门口', '生成挥手动作', '左手抬高', '检查脚滑', '补帧'];

function toKind(p: AgentProvider): LLMKind | null {
  return p === 'mock' ? null : (p as LLMKind);
}

function resultWarnings(data: unknown): string[] {
  if (!data || typeof data !== 'object' || !('warnings' in data)) return [];
  const warnings = (data as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string') : [];
}

/** 顶部 AI 命令条：横向布局，配置/历史可折叠。 */
export function AgentPanel() {
  const provider = useAgentStore((s) => s.provider);
  const setProvider = useAgentStore((s) => s.setProvider);
  const configs = useAgentStore((s) => s.configs);
  const setConfig = useAgentStore((s) => s.setConfig);
  const keys = useAgentStore((s) => s.keys);
  const setApiKey = useAgentStore((s) => s.setApiKey);
  const ollamaModels = useAgentStore((s) => s.ollamaModels);
  const setOllamaModels = useAgentStore((s) => s.setOllamaModels);
  const log = useAgentStore((s) => s.log);
  const queuedPrompt = useAgentStore((s) => s.queuedPrompt);
  const runQueuedPromptId = useAgentStore((s) => s.runQueuedPromptId);
  const consumeQueuedPrompt = useAgentStore((s) => s.consumeQueuedPrompt);
  const pushLog = useAgentStore((s) => s.pushLog);
  const clearLog = useAgentStore((s) => s.clearLog);
  const stageProps = useWorldStore((s) => s.props);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const activeAnimation = useAnimationStore((s) => s.active());
  const activePrevis = usePrevisStore((s) => activeAnimation ? s.byAnimationId[activeAnimation.id] : undefined);
  const cameraKeys = useCameraStore((s) => s.keyframes);
  const effectEvents = useEffectsStore(useShallow((s) => s.events.filter((event) => !activeAnimation || !event.animationId || event.animationId === activeAnimation.id)));

  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ reply: string; actions: AgentAction[]; planner: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const cfg = provider === 'mock' ? null : configs[provider];
  const apiKey = provider === 'mock' ? '' : (keys[provider] ?? '');

  const finish = useCallback(async (text: string, reply: string, actions: AgentAction[], planner: string, warnSuffix: string, revision: string) => {
    const visibleReply = warnSuffix ? `${reply || 'AI 规划完成'}（模型输出校正：${warnSuffix}）` : reply;
    if (actions.length === 0) {
      pushLog({ input: text, reply: visibleReply || 'AI 没有生成可执行操作', actions: [], results: [], planner });
      setShowLog(true);
    } else if (actions.every((a) => READONLY_TOOLS.has(a.tool) || a.tool === 'generate_motion')) {
      // 用户明确输入的预演描述直接生成草案；其它改姿势、导出等动作仍需确认。
      const results = await executeActions(actions);
      pushLog({ input: text, reply: visibleReply, actions, results, planner });
      setShowLog(true);
    } else {
      setPending({ reply: warnSuffix ? `${reply}（${warnSuffix}）` : reply, actions, planner, revision });
    }
  }, [pushLog]);

  const currentPlanningRevision = () => {
    const animationState = useAnimationStore.getState();
    const animation = animationState.active();
    const animationId = animation?.id ?? null;
    const character = useCharacterStore.getState();
    const camera = useCameraStore.getState();
    const agent = useAgentStore.getState();
    const activeProvider = agent.provider;
    return createPlanningRevision({
      animation,
      character: { uuid: character.sceneObject?.uuid ?? null, meta: character.meta },
      skeleton: useSkeletonStore.getState().snapshot,
      props: useWorldStore.getState().props,
      previs: animationId ? usePrevisStore.getState().byAnimationId[animationId] ?? null : null,
      camera: { activeAnimationId: camera.activeAnimationId, enabled: camera.enabled, autoGenerated: camera.autoGenerated, keyframes: camera.keyframes },
      effects: useEffectsStore.getState().events.filter((event) => !animationId || !event.animationId || event.animationId === animationId),
      provider: activeProvider,
      config: activeProvider === 'mock' ? null : agent.configs[activeProvider],
      hasApiKey: activeProvider === 'mock' || activeProvider === 'ollama' || Boolean(agent.keys[activeProvider]),
    });
  };

  const plan = useCallback(async (override?: string) => {
    const text = (override ?? queuedPrompt ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const kind = toKind(provider);
      if (!kind || !cfg) {
        const clarification = parseClarificationRequest(text);
        const mockInput = clarification ? `${clarification.originalPrompt}，用户选择：${clarification.answer}` : text;
        const r = planMock(mockInput);
        await finish(text, `本地规则（未调用 AI）：${r.reply}`, r.actions, 'mock', '', currentPlanningRevision());
      } else {
        if (kind !== 'ollama' && !apiKey) {
          setError(`${PROVIDER_LABELS[provider]} 需要 API Key（仅内存，不保存）`);
          setShowConfig(true);
          return;
        }
        const bounds = sceneObject ? new THREE.Box3().setFromObject(sceneObject) : null;
        const height = bounds ? Math.max(0, bounds.max.y - bounds.min.y) : 0;
        const propsContext = stageProps.map((prop) => `${prop.kind} id=${prop.id} position=${prop.position.map((value) => value.toFixed(2)).join(',')} size=${prop.size.width.toFixed(2)}x${prop.size.height.toFixed(2)}x${prop.size.length.toFixed(2)}m`).join('; ');
        const segmentsContext = activePrevis?.segments.map((segment, index) => `第${index + 1}段(零基索引${index}) ${segment.t0.toFixed(2)}-${segment.t1.toFixed(2)}秒 ${segment.template}：${segment.clause}，目标道具=${segment.targetPropId ?? '无'}，幅度${segment.intensity ?? 1}，速度${segment.speed ?? 1}`).join('；');
        const cameraContext = cameraKeys.map((key) => `${key.time.toFixed(2)}秒 position=${key.position.join(',')} target=${key.target.join(',')} fov=${key.fov}`).join('；');
        const effectsContext = formatEffectsContext(effectEvents);
        const issuesContext = activePrevis?.scenePlan
          ? formatSceneIssuesContext(validateScenePlan(activePrevis.scenePlan), activePrevis.warnings ?? [])
          : formatSceneIssuesContext([], activePrevis?.warnings ?? []);
        const eventsContext = activePrevis?.scenePlan?.events.map((event, index) => `事件${index}(关联动作段${event.actionIndex}) ${event.time.toFixed(2)}秒：${event.label}`).join('；');
        const morphContext = sceneObject ? listMorphTargets(sceneObject).slice(0, 100).map((morph) => `${morph.meshPath}#${morph.name}`).join('；') : '';
        const sceneContext = [
          `角色身高约${height > 0 ? height.toFixed(2) : '未知'}m`,
          propsContext ? `当前道具：${propsContext}` : '当前场景未放置道具',
          activeAnimation ? `当前动画：${activeAnimation.name}，时长${activeAnimation.duration}秒` : '当前无活动动画',
          segmentsContext ? `当前预演动作段：${segmentsContext}` : '当前动画没有已保存的预演分段',
          activePrevis?.scenePlan ? `预演理解来源=${activePrevis.scenePlan.interpretation.source}，确定度=${activePrevis.scenePlan.interpretation.certainty}` : '',
          activePrevis?.scenePlan ? `当前预演目标：道具=${activePrevis.scenePlan.target.propId ?? '未指定'}，距离=${activePrevis.scenePlan.target.distanceMeters?.toFixed(2) ?? '未知'}米` : '',
          eventsContext ? `当前预演事件：${eventsContext}` : '当前没有独立预演事件',
          issuesContext ? `当前校验问题与生成警告：${issuesContext}` : '当前预演没有已知校验问题或生成警告',
          cameraContext ? `当前镜头关键帧：${cameraContext}` : '当前没有镜头关键帧',
          effectsContext ? `当前特效：${effectsContext}` : '当前没有特效事件',
          morphContext ? `当前角色表情目标（meshPath#targetName）：${morphContext}` : '当前角色没有可用 morph 表情目标',
        ].join('；');
        const revision = currentPlanningRevision();
        const r = await awaitWithPlanningRevision(
          planWithLLM(text, { kind, baseUrl: cfg.baseUrl, model: cfg.model, apiKey }, sceneContext), revision, currentPlanningRevision,
        );
        if (!r) {
          throw new Error('等待 AI 规划期间角色、场景、动画或预演方案已变化；本次结果已丢弃，请重新发送描述');
        }
        const planner = `${provider}:${cfg.model || '?'}`;
        if (r.actions.length === 1 && r.actions[0].tool === 'check_physics') {
          const results = await executeActions(r.actions);
          if (!isPlanningRevisionCurrent(revision, currentPlanningRevision())) {
            throw new Error('物理检查期间场景、角色或动画已变化；已保留检查结果，但取消过期 AI 解读，请重新检查');
          }
          let reply = r.reply;
          try {
            reply = await summarizePhysicsResult(text, results[0], { kind, baseUrl: cfg.baseUrl, model: cfg.model, apiKey });
          } catch (error) {
            const detail = error instanceof Error ? error.message : '未知错误';
            reply = `${r.reply || '物理检查完成'}；AI 解读失败：${detail}，请查看下方工具诊断结果`;
          }
          if (!isPlanningRevisionCurrent(revision, currentPlanningRevision())) {
            throw new Error('等待 AI 解读期间场景、角色或动画已变化；本次结论已丢弃，请重新检查');
          }
          pushLog({ input: text, reply, actions: r.actions, results, planner });
          setShowLog(true);
        } else {
          await finish(text, r.reply, r.actions, planner, r.warnings.join('；'), revision);
        }
      }
      setInput('');
      if (queuedPrompt) consumeQueuedPrompt();
    } catch (e) {
      setError(e instanceof Error ? e.message : '规划失败');
    } finally {
      setBusy(false);
    }
  }, [activeAnimation, activePrevis, apiKey, busy, cameraKeys, cfg, consumeQueuedPrompt, effectEvents, finish, input, provider, queuedPrompt, sceneObject, stageProps]);

  const lastAutoRunId = useRef(0);
  useEffect(() => {
    if (!queuedPrompt || !runQueuedPromptId || runQueuedPromptId <= lastAutoRunId.current || busy) return;
    lastAutoRunId.current = runQueuedPromptId;
    const prompt = queuedPrompt;
    consumeQueuedPrompt();
    setInput('');
    void plan(prompt);
  }, [busy, consumeQueuedPrompt, plan, queuedPrompt, runQueuedPromptId]);

  const runPending = async () => {
    if (!pending) return;
    if (!isPlanningRevisionCurrent(pending.revision, currentPlanningRevision())) {
      setPending(null);
      setError('等待确认期间角色、场景、动画或预演方案已变化；为保护最新编辑，已取消这批 AI 操作，请重新发送描述');
      return;
    }
    setBusy(true);
    try {
      const results = await executeActions(pending.actions);
      pushLog({ input, reply: pending.reply, actions: pending.actions, results, planner: pending.planner });
      setPending(null);
      setShowLog(true);
    } finally {
      setBusy(false);
    }
  };

  const refreshOllama = async (silent = false) => {
    if (useAgentStore.getState().provider !== 'ollama') return;
    setListing(true);
    if (!silent) setError(null);
    try {
      const models = await listOllamaModels(useAgentStore.getState().configs.ollama.baseUrl);
      setOllamaModels(models);
      if (models.length > 0 && !models.includes(useAgentStore.getState().configs.ollama.model)) {
        setConfig('ollama', { model: models[0] });
      }
      if (models.length === 0 && !silent) setError('Ollama 在线但无本地模型（先 ollama pull 一个）');
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : '获取失败');
    } finally {
      setListing(false);
    }
  };

  const pickProvider = (p: AgentProvider) => {
    setProvider(p);
    if (p === 'ollama') void refreshOllama(true);
  };

  return (
    <div className="border-b border-zinc-200 bg-white px-3 py-1.5 text-xs">
      <div className="agent-command-row flex items-center gap-2">
        <span className="agent-command-title flex shrink-0 items-center gap-1.5 font-bold text-zinc-800">
          🤖 一句话预演
          <ProviderBadge source={provider === 'mock' ? 'mock' : 'real'} label={PROVIDER_LABELS[provider]} />
        </span>
        <select
          value={provider}
          onChange={(e) => pickProvider(e.target.value as AgentProvider)}
          title={HINTS[provider]}
          className="agent-provider-select shrink-0 rounded bg-zinc-100 px-1.5 py-1.5 text-zinc-700 outline-none ring-1 ring-zinc-300"
        >
          {ORDER.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        <input
          value={queuedPrompt ?? input}
          onChange={(e) => {
            if (queuedPrompt) consumeQueuedPrompt();
            setInput(e.target.value);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') void plan(); }}
          placeholder={provider === 'mock' ? '本地规则模式（未调用 AI）；复杂描述请连接模型…' : '描述人物行为：从窗边走到桌前，拿起手机，回头看门口…'}
          className="agent-prompt-input min-w-0 flex-1 rounded bg-zinc-100 px-2 py-1.5 text-zinc-800 outline-none ring-1 ring-zinc-300 placeholder:text-zinc-400"
        />
        <button onClick={() => void plan()} disabled={busy || !(queuedPrompt ?? input).trim()} className="agent-run-button shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-white disabled:bg-zinc-100 disabled:text-zinc-400">
          生成预演
        </button>
        {cfg && (
          <button onClick={() => setShowConfig((v) => !v)} title="连接配置" className="agent-config-toggle shrink-0 rounded bg-zinc-100 px-2 py-1.5 text-zinc-600 ring-1 ring-zinc-300">
            ⚙️
          </button>
        )}
        <button onClick={() => setShowLog((v) => !v)} title="历史记录" className="agent-history-toggle shrink-0 rounded bg-zinc-100 px-2 py-1.5 text-zinc-600 ring-1 ring-zinc-300">
          🕘{log.length > 0 ? ` ${Math.min(log.length, 99)}` : ''}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {CHIPS.map((cmd) => (
          <button
            key={cmd}
            onClick={() => void plan(cmd)}
            disabled={busy}
            className="rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-200 disabled:opacity-50"
          >
            {cmd}
          </button>
        ))}
        <span className="ml-1 text-[11px] text-zinc-400">{HINTS[provider]}</span>
      </div>
      {error && <div className="mt-1 text-red-500">{error}</div>}
      {showConfig && cfg && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input
            value={cfg.baseUrl}
            onChange={(e) => setConfig(provider as Exclude<AgentProvider, 'mock'>, { baseUrl: e.target.value })}
            placeholder="Base URL"
            className="min-w-40 flex-1 rounded bg-zinc-100 px-2 py-1 font-mono text-zinc-700 outline-none ring-1 ring-zinc-300"
          />
          {provider === 'ollama' && ollamaModels.length > 0 ? (
            <select
              value={cfg.model}
              onChange={(e) => setConfig('ollama', { model: e.target.value })}
              className="rounded bg-zinc-100 px-2 py-1 font-mono text-zinc-700 outline-none ring-1 ring-zinc-300"
            >
              {ollamaModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              value={cfg.model}
              onChange={(e) => setConfig(provider as Exclude<AgentProvider, 'mock'>, { model: e.target.value })}
              placeholder={provider === 'custom' ? 'model（如 deepseek-chat）' : 'model'}
              className="min-w-32 flex-1 rounded bg-zinc-100 px-2 py-1 font-mono text-zinc-700 outline-none ring-1 ring-zinc-300"
            />
          )}
          {provider === 'ollama' ? (
            <button onClick={() => void refreshOllama()} disabled={listing} className="rounded bg-zinc-100 px-2 py-1 text-zinc-600 ring-1 ring-zinc-300 disabled:text-zinc-400">
              {listing ? '…' : '模型列表'}
            </button>
          ) : (
            <input
              value={apiKey}
              onChange={(e) => setApiKey(provider as Exclude<AgentProvider, 'mock'>, e.target.value)}
              type="password" placeholder="API Key（不保存）"
              className="min-w-32 flex-1 rounded bg-zinc-100 px-2 py-1 font-mono text-zinc-700 outline-none ring-1 ring-zinc-300"
            />
          )}
        </div>
      )}
      {pending && (
        <div className="mt-1 space-y-1 rounded bg-zinc-100 p-2 ring-1 ring-zinc-200">
          <div className="text-zinc-800">{pending.reply}</div>
          <div className="font-mono text-[11px] text-zinc-500">
            {pending.actions.map((a) => a.tool).join(' → ')}
          </div>
          <div className="flex gap-1">
            <button onClick={() => void runPending()} disabled={busy} className="rounded bg-emerald-600 px-3 py-1 text-white">
              确认执行（可撤销）
            </button>
            <button onClick={() => setPending(null)} className="rounded bg-zinc-200 px-2 py-1 text-zinc-700">取消</button>
          </div>
        </div>
      )}
      {showLog && log.length > 0 && (
        <div className="mt-1 max-h-32 space-y-1 overflow-auto">
          <div className="flex items-center">
            <span className="text-zinc-400">历史</span>
            <button onClick={clearLog} className="ml-auto text-zinc-400 hover:text-zinc-700">清空</button>
          </div>
          {log.slice(0, 5).map((e) => (
            <div key={e.id} className="rounded bg-zinc-100 p-1.5 text-[11px] ring-1 ring-zinc-200">
              <span className="text-zinc-700">“{e.input}”</span>
              <span className="text-zinc-400"> {e.reply || '—'}</span>
              {e.results.map((r, i) => (
                <span key={i} className={r.ok ? 'text-emerald-600' : 'text-red-500'} title={!r.ok ? r.error?.message : undefined}>
                  {' '}{r.ok ? '✓' : `✗${r.error ? `:${r.error.code}` : ''}`}{e.actions[i]?.tool ?? ''}
                  {!r.ok && r.error?.message ? `（${r.error.message.slice(0, 180)}${r.error.message.length > 180 ? '…' : ''}）` : ''}
                  {r.ok && e.actions[i]?.tool === 'apply_ik' && (r.data as { clamped?: boolean })?.clamped
                    ? '（目标不可达，已钳制）' : ''}
                  {r.ok && e.actions[i]?.tool === 'check_physics'
                    ? `：${((r.data as { issues?: unknown[] })?.issues ?? []).length} 个轨迹问题，${((r.data as { collisionFindings?: unknown[] })?.collisionFindings ?? []).length} 个碰撞发现，${[...(((r.data as { collisionWarnings?: string[] })?.collisionWarnings ?? [])), ...(((r.data as { supportWarnings?: string[] })?.supportWarnings ?? []))].length} 条物体/支撑告警` : ''}
                  {r.ok && e.actions[i]?.tool === 'generate_motion' && ((r.data as { unbound?: string[] })?.unbound?.length ?? 0) > 0
                    ? `（未绑定：${((r.data as { unbound?: string[] }).unbound ?? []).join('、')}）` : ''}
                  {r.ok && e.actions[i]?.tool === 'generate_motion' && resultWarnings(r.data).length > 0
                    ? `（限制：${resultWarnings(r.data).join('；')}）` : ''}
                  {r.ok && e.actions[i]?.tool === 'generate_motion' && (r.data as { motion?: { source?: string; provider?: string; planner?: string } })?.motion
                    ? `（动作${(r.data as { motion: { source?: string } }).motion.source === 'real' ? 'REAL' : 'MOCK'} · ${(r.data as { motion: { provider?: string; planner?: string } }).motion.provider ?? 'unknown'}${(r.data as { motion: { planner?: string } }).motion.planner ? ` / ${(r.data as { motion: { planner?: string } }).motion.planner}` : ''}）`
                    : ''}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
