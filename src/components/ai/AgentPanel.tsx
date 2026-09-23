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

const CHIPS = ['左手抬高', '下蹲', '生成挥手动作', '检查脚滑', '补帧'];

function toKind(p: AgentProvider): LLMKind | null {
  return p === 'mock' ? null : (p as LLMKind);
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
  const pushLog = useAgentStore((s) => s.pushLog);
  const clearLog = useAgentStore((s) => s.clearLog);

  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ reply: string; actions: AgentAction[]; planner: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const cfg = provider === 'mock' ? null : configs[provider];
  const apiKey = provider === 'mock' ? '' : (keys[provider] ?? '');

  const finish = async (text: string, reply: string, actions: AgentAction[], planner: string, warnSuffix: string) => {
    if (actions.length === 0) {
      pushLog({ input: text, reply: reply || warnSuffix, actions: [], results: [], planner });
      setShowLog(true);
    } else if (actions.every((a) => READONLY_TOOLS.has(a.tool))) {
      const results = await executeActions(actions);
      pushLog({ input: text, reply, actions, results, planner });
      setShowLog(true);
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
          setShowConfig(true);
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
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1.5 font-bold text-zinc-800">
          🤖 AI
          <ProviderBadge source={provider === 'mock' ? 'mock' : 'real'} label={PROVIDER_LABELS[provider]} />
        </span>
        <select
          value={provider}
          onChange={(e) => pickProvider(e.target.value as AgentProvider)}
          title={HINTS[provider]}
          className="shrink-0 rounded bg-zinc-100 px-1.5 py-1.5 text-zinc-700 outline-none ring-1 ring-zinc-300"
        >
          {ORDER.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void plan(); }}
          placeholder="让左手抬高 / 下蹲 / 检查脚滑 / 生成拔剑连招…（空格=播放/暂停）"
          className="min-w-0 flex-1 rounded bg-zinc-100 px-2 py-1.5 text-zinc-800 outline-none ring-1 ring-zinc-300 placeholder:text-zinc-400"
        />
        <button onClick={() => void plan()} disabled={busy || !input.trim()} className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-white disabled:bg-zinc-100 disabled:text-zinc-400">
          发送
        </button>
        {cfg && (
          <button onClick={() => setShowConfig((v) => !v)} title="连接配置" className="shrink-0 rounded bg-zinc-100 px-2 py-1.5 text-zinc-600 ring-1 ring-zinc-300">
            ⚙️
          </button>
        )}
        <button onClick={() => setShowLog((v) => !v)} title="历史记录" className="shrink-0 rounded bg-zinc-100 px-2 py-1.5 text-zinc-600 ring-1 ring-zinc-300">
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
                <span key={i} className={r.ok ? 'text-emerald-600' : 'text-red-500'}>
                  {' '}{r.ok ? '✓' : `✗${r.error ? `:${r.error.code}` : ''}`}{e.actions[i]?.tool ?? ''}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
