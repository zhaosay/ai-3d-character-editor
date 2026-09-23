import { useState } from 'react';
import { PROVIDER_LABELS, useAgentStore, type AgentProvider } from '../../stores/agentStore';
import { executeActions } from '../../services/agent/toolRegistry';
import { READONLY_TOOLS, type AgentAction } from '../../services/agent/toolTypes';
import { planMock } from '../../services/agent/mockAgent';
import { listOllamaModels, planWithLLM, type LLMKind } from '../../services/agent/llmClient';
import { ProviderBadge } from './ProviderBadge';

const ORDER: AgentProvider[] = ['mock', 'anthropic', 'openai', 'ollama', 'custom'];

const HINTS: Record<AgentProvider, string> = {
  mock: '确定性规则（MOCK 智能），离线可用',
  anthropic: 'Claude 原生 API（/v1/messages），Key 仅内存',
  openai: 'OpenAI 兼容接口（Codex 模型），Key 仅内存',
  ollama: '本机 Ollama（/v1），免 Key；跨域被拒设 OLLAMA_ORIGINS',
  custom: '任意 OpenAI-compatible 三方地址',
};

function toKind(p: AgentProvider): LLMKind | null {
  return p === 'mock' ? null : (p as LLMKind);
}

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
  const pushLog = useAgentStore((s) => s.pushLog);
  const clearLog = useAgentStore((s) => s.clearLog);

  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ reply: string; actions: AgentAction[]; planner: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);

  const cfg = provider === 'mock' ? null : configs[provider];
  const apiKey = provider === 'mock' ? '' : (keys[provider] ?? '');

  const finish = async (text: string, reply: string, actions: AgentAction[], planner: string, warnSuffix: string) => {
    if (actions.length === 0) {
      pushLog({ input: text, reply: reply || warnSuffix, actions: [], results: [], planner });
    } else if (actions.every((a) => READONLY_TOOLS.has(a.tool))) {
      const results = await executeActions(actions);
      pushLog({ input: text, reply, actions, results, planner });
    } else {
      setPending({ reply: warnSuffix ? `${reply}（${warnSuffix}）` : reply, actions, planner });
    }
  };

  const plan = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const kind = toKind(provider);
      if (!kind || !cfg) {
        const r = planMock(text);
        await finish(text, r.reply, r.actions, 'mock', '');
      } else {
        if (kind !== 'ollama' && !apiKey) {
          setError(`${PROVIDER_LABELS[provider]} 需要 API Key（仅内存，不保存）`);
          return;
        }
        const r = await planWithLLM(text, { kind, baseUrl: cfg.baseUrl, model: cfg.model, apiKey });
        const planner = `${provider}:${cfg.model || '?'}`;
        await finish(text, r.reply, r.actions, planner, r.warnings.join('；'));
      }
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '规划失败');
    } finally {
      setBusy(false);
    }
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const results = await executeActions(pending.actions);
      pushLog({ input, reply: pending.reply, actions: pending.actions, results, planner: pending.planner });
      setPending(null);
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
    <div className="space-y-2 border-b border-zinc-800 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-300">
        AI 助手 <ProviderBadge source={provider === 'mock' ? 'mock' : 'real'} label={provider === 'mock' ? '规则规划' : `${PROVIDER_LABELS[provider]}规划+工具执行`} />
      </div>
      <div className="grid grid-cols-5 gap-1">
        {ORDER.map((p) => (
          <button
            key={p}
            onClick={() => pickProvider(p)}
            title={HINTS[p]}
            className={`rounded px-1 py-1 ${provider === p ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
          >
            {PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500">{HINTS[provider]}</div>
      {cfg && (
        <div className="space-y-1">
          <input
            value={cfg.baseUrl}
            onChange={(e) => setConfig(provider as Exclude<AgentProvider, 'mock'>, { baseUrl: e.target.value })}
            placeholder="Base URL"
            className="w-full rounded bg-zinc-900 px-2 py-1 font-mono outline-none ring-1 ring-zinc-800"
          />
          <div className="flex gap-1">
            {provider === 'ollama' && ollamaModels.length > 0 ? (
              <select
                value={cfg.model}
                onChange={(e) => setConfig('ollama', { model: e.target.value })}
                className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono outline-none ring-1 ring-zinc-800"
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
                className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono outline-none ring-1 ring-zinc-800"
              />
            )}
            {provider === 'ollama' ? (
              <button onClick={() => void refreshOllama()} disabled={listing} className="rounded bg-zinc-800 px-2 py-1 disabled:text-zinc-600">
                {listing ? '…' : '模型列表'}
              </button>
            ) : (
              <input
                value={apiKey}
                onChange={(e) => setApiKey(provider as Exclude<AgentProvider, 'mock'>, e.target.value)}
                type="password" placeholder="API Key（不保存）"
                className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono outline-none ring-1 ring-zinc-800"
              />
            )}
          </div>
        </div>
      )}
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void plan(); }}
          placeholder="左手抬高 / 下蹲 / 检查脚滑 / 生成挥手动作…"
          className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1.5 outline-none ring-1 ring-zinc-800"
        />
        <button onClick={() => void plan()} disabled={busy || !input.trim()} className="rounded bg-emerald-600 px-3 py-1 text-white disabled:bg-zinc-800 disabled:text-zinc-500">
          发送
        </button>
      </div>
      {error && <div className="text-red-400">{error}</div>}
      <div className="flex flex-wrap gap-1">
        {['左手抬高', '下蹲', '生成挥手动作', '检查脚滑', '补帧'].map((cmd) => (
          <button
            key={cmd}
            onClick={() => void plan(cmd)}
            disabled={busy}
            title={`一键发送：${cmd}`}
            className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            {cmd}
          </button>
        ))}
      </div>
      {pending && (
        <div className="space-y-1 rounded bg-zinc-900 p-2">
          <div className="text-zinc-200">{pending.reply}</div>
          {pending.actions.map((a, i) => (
            <div key={i} className="font-mono text-[11px] text-zinc-400">
              {a.tool} {JSON.stringify(a.args)}
            </div>
          ))}
          <div className="flex gap-1">
            <button onClick={() => void runPending()} disabled={busy} className="flex-1 rounded bg-emerald-600 px-2 py-1 text-white">
              确认执行（可撤销）
            </button>
            <button onClick={() => setPending(null)} className="rounded bg-zinc-800 px-2 py-1">取消</button>
          </div>
        </div>
      )}
      {log.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center">
            <span className="text-zinc-500">历史</span>
            <button onClick={clearLog} className="ml-auto text-zinc-600 hover:text-zinc-300">清空</button>
          </div>
          {log.slice(0, 5).map((e) => (
            <div key={e.id} className="rounded bg-zinc-900 p-1.5 text-[11px]">
              <div className="text-zinc-300">“{e.input}”</div>
              <div className="text-zinc-500">{e.reply || '—'}</div>
              {e.results.map((r, i) => (
                <div key={i} className={r.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {r.ok ? '✓' : '✗'} {e.actions[i]?.tool}
                  {!r.ok && r.error ? `: ${r.error.code} ${r.error.message}` : ''}
                  {r.ok && e.actions[i]?.tool === 'check_physics'
                    ? `：${((r.data as { issues?: unknown[] })?.issues ?? []).length} 个问题` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="text-[11px] text-zinc-500">
        变更类操作需确认后执行（逐步可撤销）；只读检查自动执行。模型只经工具改动画，Key 不落盘。
      </div>
    </div>
  );
}
