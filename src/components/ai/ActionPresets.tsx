import { useState } from 'react';
import { ACTION_PRESETS, sequencePlan, type SequenceAction } from '../../services/motion/presets';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../../services/motion/procedural';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useAnimationStore } from '../../stores/animationStore';
import { usePrevisStore } from '../../stores/previsStore';
import { useWorldStore } from '../../stores/worldStore';
import { useCharacterStore } from '../../stores/characterStore';
import { estimateGroundHipLocalOffset } from '../../core/previs/world';

export function ActionPresets() {
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const character = useCharacterStore((s) => s.sceneObject);
  const stageProps = useWorldStore((s) => s.props);
  const [actions, setActions] = useState<SequenceAction[]>([]);
  const [message, setMessage] = useState('');
  const generate = () => {
    if (!snapshot || !actions.length) return;
    try {
      const segments = sequencePlan(actions);
      const duration = segments.at(-1)!.t1;
      if (duration > 120) throw new Error('组合总时长不能超过 120 秒');
      const result = generatePlannedTracks(buildBoneMap(snapshot), segments, duration, 0, buildRestMap(snapshot), buildRestPositionMap(snapshot), null, {}, {},
        stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0,
        character ? estimateGroundHipLocalOffset(character, snapshot, stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0) : undefined);
      const id = useAnimationStore.getState().createAnimation('动作组合');
      useAnimationStore.setState((s) => ({ animations: s.animations.map((a) => a.id === id ? { ...a, duration, tracks: result.tracks } : a), currentTime: 0, playing: true, loop: false }));
      usePrevisStore.getState().setActionPrevis(id, { prompt: actions.map((a) => a.clause).join('，'), segments });
      setMessage(result.warnings.length ? [...new Set(result.warnings)].join('；') : '组合已开始播放，可在逐段动作修改中继续编辑');
    } catch (e) { setMessage(e instanceof Error ? e.message : '生成失败'); }
  };
  return <section className="space-y-2 border-b border-zinc-200 p-3 text-xs">
    <h2 className="font-bold">常用动作组合</h2>
    <p className="text-zinc-500">点击动作依次添加，调整顺序与秒数后连续播放。</p>
    <div className="grid grid-cols-2 gap-1">{ACTION_PRESETS.map((p) => <button key={p.template} onClick={() => setActions([...actions, { ...p }])} className="rounded bg-emerald-50 px-2 py-1.5 text-left text-emerald-800">+ {p.label}</button>)}</div>
    <button className="text-emerald-700 underline" onClick={() => setActions([ACTION_PRESETS[1], ACTION_PRESETS[0], ACTION_PRESETS[2], ACTION_PRESETS[4]].map((a) => ({ ...a })))}>载入示例：走路 → 停步 → 挥手 → 回头</button>
    <ol className="space-y-1">{actions.map((action, i) => <li key={i} className="flex items-center gap-1 rounded bg-zinc-50 p-1">
      <span className="min-w-0 flex-1 truncate">{i + 1}. {action.clause}</span>
      <input aria-label={`动作 ${i + 1} 秒数`} type="number" min={0.5} max={15} step={0.5} value={action.duration} onChange={(e) => setActions(actions.map((a, j) => j === i ? { ...a, duration: Number(e.target.value) } : a))} className="w-12 rounded border border-zinc-200 px-1" />秒
      <button aria-label={`上移动作 ${i + 1}`} disabled={i === 0} onClick={() => { const next = [...actions]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setActions(next); }} className="px-1 disabled:opacity-30">↑</button>
      <button aria-label={`删除动作 ${i + 1}`} onClick={() => setActions(actions.filter((_, j) => j !== i))} className="px-1">×</button>
    </li>)}</ol>
    <button disabled={!snapshot || !actions.length} onClick={generate} className="w-full rounded bg-emerald-700 p-2 text-white disabled:opacity-40">生成并连续播放</button>
    {!snapshot && <p className="text-zinc-500">先在左侧选择男性或女性角色。</p>}
    {message && <p role="status" className="text-zinc-600">{message}</p>}
  </section>;
}
