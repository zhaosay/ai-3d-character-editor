import { useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useMotionStore } from '../../stores/motionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { HttpMotionProvider } from '../../services/motion/HttpMotionProvider';
import { MockMotionProvider } from '../../services/motion/MockMotionProvider';
import type { MotionMeta } from '../../services/motion/types';
import { ProviderBadge } from './ProviderBadge';

const mock = new MockMotionProvider();

export function MotionPanel() {
  const providerId = useMotionStore((s) => s.providerId);
  const setProvider = useMotionStore((s) => s.setProvider);
  const baseUrl = useMotionStore((s) => s.baseUrl);
  const setBaseUrl = useMotionStore((s) => s.setBaseUrl);
  const skeleton = useSkeletonStore((s) => s.snapshot);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const createAnimation = useAnimationStore((s) => s.createAnimation);

  const [prompt, setPrompt] = useState('挥手');
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = useState<12 | 24 | 30 | 60>(30);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const [meta, setMeta] = useState<MotionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const result = await provider.generateMotion({ prompt, skeleton, duration, fps, seed: 7 });
      // create 已 push 一次 history；轨道直接写入 → 一次 Undo 整体撤销本次生成
      const id = createAnimation(result.animation.name);
      useAnimationStore.setState((s) => {
        const anims = structuredClone(s.animations);
        const a = anims.find((x) => x.id === id);
        if (a) {
          a.duration = result.animation.duration;
          a.fps = result.animation.fps;
          a.tracks = structuredClone(result.animation.tracks);
        }
        return { animations: anims, activeId: id, currentTime: 0 };
      });
      setMeta(result.meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-800 p-3 text-xs">
      <div className="font-bold text-zinc-300">AI Motion 生成</div>
      <div className="flex gap-1">
        <button
          onClick={() => setProvider('mock')}
          className={`flex-1 rounded px-2 py-1 ${providerId === 'mock' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          本地Mock
        </button>
        <button
          onClick={() => setProvider('http')}
          className={`flex-1 rounded px-2 py-1 ${providerId === 'http' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          HTTP后端
        </button>
      </div>
      {providerId === 'http' && (
        <div className="space-y-1">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="w-full rounded bg-zinc-900 px-2 py-1 font-mono outline-none ring-1 ring-zinc-800"
          />
          <button onClick={() => void checkHealth()} className="rounded bg-zinc-800 px-2 py-1">
            测试连接
          </button>
          {health && <div className="text-zinc-400">{health}</div>}
        </div>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="挥手 / 拔剑 / 格挡 / 踢腿 / 踏步（模板关键词）"
        className="w-full rounded bg-zinc-900 px-2 py-1 outline-none ring-1 ring-zinc-800"
      />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-zinc-400">
          时长
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-14 rounded bg-zinc-900 px-1 py-0.5 outline-none ring-1 ring-zinc-800"
          />
        </label>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value) as 12 | 24 | 30 | 60)} className="rounded bg-zinc-900 px-1 py-1 outline-none ring-1 ring-zinc-800">
          {[12, 24, 30, 60].map((f) => (
            <option key={f} value={f}>{f}fps</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => void generate()}
        disabled={busy || !sceneObject}
        title={!sceneObject ? '先加载角色' : '生成并写入新动画'}
        className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        {busy ? '生成中…' : '生成动作 → 新动画'}
      </button>
      {meta && (
        <div className="space-y-1 rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
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
        </div>
      )}
      {error && <div className="text-red-400">{error}</div>}
      <div className="text-[11px] text-zinc-500">
        规划 heuristic=确定性代码（MOCK 智能），配 LLM key 后为真实模型；合成均为过程式模板。配 key 见 backend/README.md。
      </div>
    </div>
  );
}
