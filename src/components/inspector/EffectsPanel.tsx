import { useMemo } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { usePrevisStore } from '../../stores/previsStore';
import type { PrevisEffectEvent, PrevisEffectKind } from '../../core/previs/effects';
import { actionIndexAtTime } from '../../core/previs/effects';

const EMPTY_ACTIONS: Array<{ t0: number; t1: number; clause: string }> = [];

const labels: Record<PrevisEffectKind, string> = {
  slash: '挥砍拖尾', impact: '冲击波', dust: '尘土', spark: '飞散火花', smoke: '烟雾', energy: '能量环',
};

export function EffectsPanel() {
  const animationId = useAnimationStore((state) => state.activeId);
  const allEvents = useEffectsStore((state) => state.events);
  const actions = usePrevisStore((state) => animationId ? state.byAnimationId[animationId]?.segments ?? EMPTY_ACTIONS : EMPTY_ACTIONS);
  const events = useMemo(() => allEvents.filter((event) => !event.animationId || event.animationId === animationId), [allEvents, animationId]);
  return <section className="space-y-2 border-b border-zinc-200 p-3 text-xs">
    <div className="flex items-center gap-2">
      <h2 className="font-semibold text-zinc-800">特效事件</h2>
    </div>
    <AddEffectButtons actions={actions} />
    {events.length === 0 ? <p className="text-[10px] text-zinc-500">拖动时间轴到动作的发力或命中时刻，再添加对应效果。</p> : events.map((event) => <EffectRow key={event.id} event={event} actions={actions} />)}
    <p className="text-[10px] leading-relaxed text-zinc-500">轻量程序化占位效果，用于检查时机与位置；可在后续视频生成阶段替换为正式素材。</p>
  </section>;
}

function AddEffectButtons({ actions }: { actions: Array<{ t0: number; t1: number }> }) {
  const add = useEffectsStore((state) => state.add);
  const time = useAnimationStore((state) => state.currentTime);
  const animationId = useAnimationStore((state) => state.activeId);
  const checkpoint = useAnimationStore((state) => state.checkpoint);
  return <div className="flex flex-wrap items-center gap-1.5">
    <span className="mr-auto text-[10px] text-zinc-500">在播放头 {time.toFixed(2)}s 添加</span>
    {(Object.keys(labels) as PrevisEffectKind[]).map((kind) => <button key={kind} onClick={() => { checkpoint(); add(kind, time, animationId ?? undefined, undefined, actionIndexAtTime(actions, time)); }} className="rounded-md bg-amber-50 px-2 py-1 text-amber-800">+ {labels[kind]}</button>)}
  </div>;
}

function EffectRow({ event, actions }: { event: PrevisEffectEvent; actions: Array<{ t0: number; t1: number; clause: string }> }) {
  const update = useEffectsStore((state) => state.update);
  const remove = useEffectsStore((state) => state.remove);
  const checkpoint = useAnimationStore((state) => state.checkpoint);
  return <div className="space-y-1.5 rounded-lg bg-zinc-50 p-2 ring-1 ring-zinc-200">
    <div className="flex items-center gap-2 font-medium text-zinc-700">
      <span>{labels[event.kind]}</span>
      <button onClick={() => { checkpoint(); remove(event.id); }} className="ml-auto text-red-600">删除</button>
    </div>
    <div className="grid grid-cols-3 gap-1.5">
      {(['time', 'duration', 'scale'] as const).map((field) => <label key={field} className="space-y-1 text-[10px] text-zinc-500">
        {{ time: '时间 s', duration: '持续 s', scale: '大小' }[field]}
        <input type="number" min={0} step={field === 'time' ? 0.05 : 0.1} value={event[field]} onFocus={checkpoint} onChange={(e) => {
          const value = Number(e.target.value);
          const actionIndex = field === 'time' ? actionIndexAtTime(actions, value) : event.actionIndex;
          update(event.id, { [field]: value, ...(field === 'time' ? { actionIndex } : {}) });
        }} className="w-full rounded bg-white px-1.5 py-1 text-zinc-800 ring-1 ring-zinc-200" />
      </label>)}
    </div>
    {actions.length > 0 && <label className="block text-[10px] text-zinc-500">关联动作段
      <select value={event.actionIndex ?? actionIndexAtTime(actions, event.time) ?? ''} onFocus={checkpoint} onChange={(e) => {
        const actionIndex = Number(e.target.value);
        const next = actions[actionIndex];
        if (!next) return;
        const current = event.actionIndex === undefined ? undefined : actions[event.actionIndex];
        const ratio = current ? Math.min(Math.max((event.time - current.t0) / Math.max(current.t1 - current.t0, 1e-6), 0), 1) : 0.5;
        update(event.id, { actionIndex, time: next.t0 + ratio * (next.t1 - next.t0) });
      }} className="ml-2 max-w-full rounded bg-white px-1.5 py-1 text-zinc-800 ring-1 ring-zinc-200">
        {actions.map((action, index) => <option key={index} value={index}>动作 {index + 1} · {action.clause}</option>)}
      </select>
    </label>}
    <div className="grid grid-cols-3 gap-1.5">
      {(['x', 'y', 'z'] as const).map((axis, index) => <label key={axis} className="space-y-1 text-[10px] text-zinc-500">
        位置 {axis.toUpperCase()}
        <input type="number" step={0.1} value={event.position[index]} onFocus={checkpoint} onChange={(e) => {
          const position = [...event.position] as PrevisEffectEvent['position'];
          position[index] = Number(e.target.value);
          update(event.id, { position });
        }} className="w-full rounded bg-white px-1.5 py-1 text-zinc-800 ring-1 ring-zinc-200" />
      </label>)}
    </div>
    <label className="flex items-center gap-2 text-[10px] text-zinc-500">颜色 <input type="color" value={event.color} onFocus={checkpoint} onChange={(e) => update(event.id, { color: e.target.value })} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" /></label>
  </div>;
}
