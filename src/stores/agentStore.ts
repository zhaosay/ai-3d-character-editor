import { create } from 'zustand';
import type { AgentAction, ToolResult } from '../services/agent/toolTypes';
import type { LLMKind } from '../services/agent/llmClient';

export type AgentProvider = 'mock' | 'anthropic' | 'openai' | 'ollama' | 'custom';

export interface AgentLogEntry {
  id: number;
  input: string;
  reply: string;
  actions: AgentAction[];
  results: ToolResult[];
  planner: string;
}

export interface ProviderConfig {
  baseUrl: string;
  model: string;
}

export const PROVIDER_DEFAULTS: Record<Exclude<AgentProvider, 'mock'>, ProviderConfig> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
  custom: { baseUrl: '', model: '' },
};

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  mock: '本地规则',
  anthropic: 'Claude',
  openai: 'Codex',
  ollama: 'Ollama',
  custom: '三方兼容',
};

/** keys 仅内存保存，不持久化、不上报；各通道 baseUrl/model 持久化（兼容旧版 http→custom）。 */
interface AgentState {
  provider: AgentProvider;
  configs: Record<Exclude<AgentProvider, 'mock'>, ProviderConfig>;
  keys: Record<string, string>;
  ollamaModels: string[];
  log: AgentLogEntry[];
  setProvider: (p: AgentProvider) => void;
  setConfig: (p: Exclude<AgentProvider, 'mock'>, c: Partial<ProviderConfig>) => void;
  setApiKey: (p: Exclude<AgentProvider, 'mock'>, k: string) => void;
  setOllamaModels: (m: string[]) => void;
  pushLog: (e: Omit<AgentLogEntry, 'id'>) => void;
  clearLog: () => void;
}

let seq = 0;

function loadSaved(): Record<string, ProviderConfig> {
  try {
    const raw = JSON.parse(localStorage.getItem('agent-config') ?? '{}') as Record<string, unknown>;
    // 旧版：{baseUrl, model} 即三方兼容配置
    if (typeof raw['baseUrl'] === 'string' || typeof raw['model'] === 'string') {
      return {
        custom: {
          baseUrl: typeof raw['baseUrl'] === 'string' ? (raw['baseUrl'] as string) : '',
          model: typeof raw['model'] === 'string' ? (raw['model'] as string) : '',
        },
      };
    }
    const out: Record<string, ProviderConfig> = {};
    for (const k of ['anthropic', 'openai', 'ollama', 'custom']) {
      const v = raw[k] as { baseUrl?: unknown; model?: unknown } | undefined;
      if (v && typeof v === 'object') {
        out[k] = {
          baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : PROVIDER_DEFAULTS[k as LLMKind].baseUrl,
          model: typeof v.model === 'string' ? v.model : PROVIDER_DEFAULTS[k as LLMKind].model,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(configs: AgentState['configs']) {
  try {
    localStorage.setItem('agent-config', JSON.stringify(configs));
  } catch { /* 忽略 */ }
}

export const useAgentStore = create<AgentState>((set) => {
  const saved = loadSaved();
  const configs = { ...PROVIDER_DEFAULTS };
  for (const k of Object.keys(configs) as Array<keyof typeof configs>) {
    if (saved[k]) configs[k] = { ...configs[k], ...saved[k] };
  }
  return {
    provider: 'mock',
    configs,
    keys: {},
    ollamaModels: [],
    log: [],
    setProvider: (provider) => set({ provider }),
    setConfig: (p, c) =>
      set((s) => {
        const configs = { ...s.configs, [p]: { ...s.configs[p], ...c } };
        persist(configs);
        return { configs };
      }),
    setApiKey: (p, k) => set((s) => ({ keys: { ...s.keys, [p]: k } })),
    setOllamaModels: (ollamaModels) => set({ ollamaModels }),
    pushLog: (e) => {
      seq += 1;
      set((s) => ({ log: [{ ...e, id: seq }, ...s.log].slice(0, 30) }));
    },
    clearLog: () => set({ log: [] }),
  };
});
