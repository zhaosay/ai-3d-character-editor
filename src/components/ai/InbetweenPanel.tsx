import { useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useInbetweenStore } from '../../stores/inbetweenStore';
import { MathInbetweenProvider } from '../../services/inbetween/MathInbetweenProvider';
import { AIInbetweenProvider } from '../../services/inbetween/AIInbetweenProvider';
import type { InbetweenResult } from '../../services/inbetween/types';
import { ProviderBadge } from './ProviderBadge';

const math = new MathInbetweenProvider();
const ai = new AIInbetweenProvider();

export function InbetweenPanel() {
  const providerId = useInbetweenStore((s) => s.providerId);
  const setProvider = useInbetweenStore((s) => s.setProvider);
  const active = useAnimationStore((s) => s.active());
  const replaceAll = useAnimationStore((s) => s.replaceAll);
  const activeId = useAnimationStore((s) => s.activeId);

  const [density, setDensity] = useState(12);
  const [ease, setEase] = useState<'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeOutIn'>('easeInOut');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InbetweenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeChoice, setRangeChoice] = useState<'all' | 'from-0-1'>('all');

  if (!active) {
    return (
      <div className="space-y-2 border-b border-zinc-800 p-3 text-xs">
        <div className="font-bold text-zinc-300">AI Inbetween</div>
        <div className="text-zinc-500">先创建动画</div>
      </div>
    );
  }

  const totalKeys = active.tracks.reduce((s, t) => s + t.rotation.length + t.position.length + t.scale.length, 0);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = providerId === 'math' ? math : ai;
      const minTime = rangeChoice === 'all' ? 0 : 0;
      const maxTime = rangeChoice === 'all' ? active.duration : Math.min(active.duration, active.duration * 0.5);
      const r = await provider.runInbetween({ animation: active, minTime, maxTime, density, ease });
      // 单次 history 即可整体撤销替换
      replaceAll([r.animation, ...useAnimationStore.getState().animations.filter((a) => a.id !== activeId)], activeId);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '补帧失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-800 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-300">
        AI Inbetween
        <ProviderBadge source={providerId === 'math' ? 'real' : 'mock'} label={providerId === 'math' ? '数学补帧' : 'AI(占位)'} />
      </div>
      <div className="rounded bg-zinc-900 p-2 font-mono text-[11px] text-zinc-400">
        当前动画 {totalKeys} keys · {active.tracks.length} tracks · {active.duration.toFixed(1)}s
      </div>
      <div className="flex gap-1">
        <button onClick={() => setProvider('math')} className={`flex-1 rounded px-2 py-1 ${providerId === 'math' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
          数学(REAL)
        </button>
        <button onClick={() => setProvider('ai')} className={`flex-1 rounded px-2 py-1 ${providerId === 'ai' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
          AI(MOCK)
        </button>
      </div>
      <label className="flex items-center justify-between gap-2 text-zinc-400">
        密度
        <input type="number" min={2} max={120} step={1} value={density} onChange={(e) => setDensity(Number(e.target.value))} className="w-16 rounded bg-zinc-900 px-1 py-0.5 text-right font-mono outline-none ring-1 ring-zinc-800" />
        keys/s
      </label>
      <label className="flex items-center justify-between gap-2 text-zinc-400">
        缓动
        <select value={ease} onChange={(e) => setEase(e.target.value as never)} className="rounded bg-zinc-900 px-1 py-0.5 outline-none ring-1 ring-zinc-800">
          <option value="linear">linear</option>
          <option value="easeIn">easeIn</option>
          <option value="easeOut">easeOut</option>
          <option value="easeInOut">easeInOut</option>
          <option value="easeOutIn">easeOutIn</option>
        </select>
      </label>
      <div className="flex gap-1">
        <button onClick={() => setRangeChoice('all')} className={`flex-1 rounded px-2 py-1 ${rangeChoice === 'all' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
          整段补
        </button>
        <button onClick={() => setRangeChoice('from-0-1')} className={`flex-1 rounded px-2 py-1 ${rangeChoice === 'from-0-1' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
          前半段
        </button>
      </div>
      <button onClick={() => void run()} disabled={busy || totalKeys === 0} className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-800 disabled:text-zinc-500">
        {busy ? '补帧中…' : '一键补帧（可撤销）'}
      </button>
      {result && (
        <div className="rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <ProviderBadge source={result.meta.source} label={`${result.meta.provider} · +${result.meta.addedKeys} keys`} />
            <span>{result.meta.latencyMs}ms</span>
          </div>
          {result.meta.warnings.map((w, i) => (
            <div key={i} className="text-amber-400">⚠ {w}</div>
          ))}
        </div>
      )}
      {error && <div className="text-red-400">{error}</div>}
      <div className="text-[11px] text-zinc-500">数学版走 lerp + quat slerp + 缓动；AI 版位预留（MOCK）。</div>
    </div>
  );
}
