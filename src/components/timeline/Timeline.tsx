import { useMemo, useRef, useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { captureBoneLocal } from '../../core/animation/applyPose';

export function Timeline() {
  const animations = useAnimationStore((s) => s.animations);
  const activeId = useAnimationStore((s) => s.activeId);
  const currentTime = useAnimationStore((s) => s.currentTime);
  const playing = useAnimationStore((s) => s.playing);
  const loop = useAnimationStore((s) => s.loop);
  const active = useAnimationStore((s) => s.active());

  if (!active) {
    return (
      <div className="flex items-center gap-2 border-t border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
        <span>暂无动画 — 先加载角色，然后新建动画开始打关键帧。</span>
        <CreateButton />
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 bg-white text-zinc-800">
      <TransportBar />
      <Ruler
        duration={active.duration}
        currentTime={currentTime}
        tracks={active.tracks.map((t) => ({ boneName: t.boneName, times: t.rotation.map((k) => k.time) }))}
      />
      <KeyPanel />
      <div className="hidden">
        {animations.length}
        {activeId}
        {loop}
        {playing}
      </div>
    </div>
  );
}

function CreateButton() {
  const createAnimation = useAnimationStore((s) => s.createAnimation);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  return (
    <button
      onClick={() => createAnimation()}
      disabled={!sceneObject}
      title={!sceneObject ? '先加载 GLB 角色' : '新建空动画'}
      className="rounded bg-emerald-600 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500"
    >
      + 新建动画
    </button>
  );
}

function TransportBar() {
  const active = useAnimationStore((s) => s.active());
  const currentTime = useAnimationStore((s) => s.currentTime);
  const playing = useAnimationStore((s) => s.playing);
  const loop = useAnimationStore((s) => s.loop);
  const setPlaying = useAnimationStore((s) => s.setPlaying);
  const setTime = useAnimationStore((s) => s.setTime);
  const toggleLoop = useAnimationStore((s) => s.toggleLoop);
  const setDuration = useAnimationStore((s) => s.setDuration);
  const animations = useAnimationStore((s) => s.animations);
  const activeId = useAnimationStore((s) => s.activeId);
  const selectAnimation = useAnimationStore((s) => s.selectAnimation);
  const createAnimation = useAnimationStore((s) => s.createAnimation);
  const renameAnimation = useAnimationStore((s) => s.renameAnimation);
  const deleteAnimation = useAnimationStore((s) => s.deleteAnimation);
  if (!active) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs">
      <button onClick={() => setPlaying(true)} disabled={playing} className="rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500">
        ▶ 播放
      </button>
      <button onClick={() => setPlaying(false)} disabled={!playing} className="rounded bg-zinc-200 px-2 py-1 disabled:text-zinc-600">
        ⏸ 暂停
      </button>
      <button
        onClick={() => {
          setPlaying(false);
          setTime(0);
        }}
        className="rounded bg-zinc-200 px-2 py-1"
      >
        ⏹ 停止
      </button>
      <button onClick={toggleLoop} className={`rounded px-2 py-1 ${loop ? 'bg-emerald-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}>
        循环
      </button>
      <span className="font-mono text-zinc-700">
        {currentTime.toFixed(2)}s / {active.duration.toFixed(1)}s · {active.fps}fps
      </span>
      <label className="flex items-center gap-1 text-zinc-600">
        时长
        <input
          type="number"
          min={0.5}
          max={120}
          step={0.5}
          value={active.duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="w-16 rounded bg-zinc-100 px-1 py-0.5 text-zinc-800 outline-none ring-1 ring-zinc-300"
        />
        s
      </label>
      <select value={activeId ?? ''} onChange={(e) => selectAnimation(e.target.value)} className="rounded bg-zinc-100 px-1 py-1 text-xs outline-none ring-1 ring-zinc-300">
        {animations.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <input
        value={active.name}
        onChange={(e) => renameAnimation(active.id, e.target.value)}
        title="重命名当前动画"
        className="w-28 rounded bg-zinc-100 px-1 py-1 text-xs outline-none ring-1 ring-zinc-300"
      />
      <button onClick={() => createAnimation()} className="rounded bg-zinc-200 px-2 py-1">
        + 新建
      </button>
      <button
        onClick={() => deleteAnimation(active.id)}
        disabled={animations.length <= 1}
        title={animations.length <= 1 ? '至少保留一个动画' : '删除当前动画（可撤销）'}
        className="rounded bg-zinc-200 px-2 py-1 text-red-600 disabled:text-zinc-600"
      >
        删除
      </button>
    </div>
  );
}

function Ruler({
  duration,
  currentTime,
  tracks,
}: {
  duration: number;
  currentTime: number;
  tracks: Array<{ boneName: string; times: number[] }>;
}) {
  const setTime = useAnimationStore((s) => s.setTime);
  const moveRotationKey = useAnimationStore((s) => s.moveRotationKey);
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const snapshot = useSelectionStoreApi();
  const ref = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [drag, setDrag] = useState<{ boneName: string; from: number } | null>(null);

  const timeAt = (clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return ratio * duration;
  };

  const selectedBoneName = snapshot;
  void selectedBoneId;

  // 聚合所有 key（灰）+ 选中骨骼 key（绿）
  const allTimes = useMemo(() => tracks.flatMap((t) => t.times.map((time) => ({ boneName: t.boneName, time }))), [tracks]);
  const selTimes = useMemo(
    () => tracks.find((t) => t.boneName === selectedBoneName)?.times ?? [],
    [tracks, selectedBoneName],
  );

  return (
    <div className="px-3 py-2">
      <div
        ref={ref}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setScrubbing(true);
          setTime(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (scrubbing && !drag) setTime(timeAt(e.clientX));
          if (drag) {
            // 拖动 key 时不 scrub
          }
        }}
        onPointerUp={(e) => {
          if (drag) {
            const to = timeAt(e.clientX);
            moveRotationKey(drag.boneName, drag.from, to);
            setDrag(null);
          }
          setScrubbing(false);
        }}
        className="relative h-12 cursor-crosshair select-none rounded bg-zinc-100 ring-1 ring-zinc-300"
      >
        {/* 刻度 */}
        {Array.from({ length: Math.floor(duration) + 1 }, (_, s) => (
          <div key={s} className="absolute top-0 bottom-0" style={{ left: `${(s / duration) * 100}%` }}>
            <div className="h-2 w-px bg-zinc-200" />
            <div className="text-[10px] text-zinc-500">{s}s</div>
          </div>
        ))}
        {/* 其他骨骼 key（灰） */}
        {allTimes.map((k, i) => (
          <div
            key={`${k.boneName}-${k.time}-${i}`}
            className="absolute top-6 h-2 w-2 rotate-45 bg-zinc-300"
            style={{ left: `calc(${(k.time / duration) * 100}% - 4px)` }}
            title={`${k.boneName} @${k.time.toFixed(2)}s`}
          />
        ))}
        {/* 选中骨骼 key（绿，可拖） */}
        {selectedBoneName &&
          selTimes.map((t) => (
            <div
              key={`sel-${t}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                setDrag({ boneName: selectedBoneName, from: t });
              }}
              className="absolute top-5 h-3 w-3 rotate-45 cursor-ew-resize bg-emerald-400 ring-1 ring-emerald-200"
              style={{ left: `calc(${(t / duration) * 100}% - 6px)` }}
              title={`拖动移动关键帧 @${t.toFixed(2)}s`}
            />
          ))}
        {/* 播放头 */}
        <div className="absolute top-0 bottom-0 w-px bg-red-500" style={{ left: `${(currentTime / duration) * 100}%` }}>
          <div className="h-2 w-2 -translate-x-1/2 rotate-45 bg-red-500" />
        </div>
      </div>
    </div>
  );
}

// 从 skeleton snapshot 解析选中骨骼名（避免 Timeline 依赖 skeleton store 细节时仍保持解耦）
function useSelectionStoreApi(): string | null {
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const snapshot = useSkeletonStore((s) => s.snapshot);
  if (!selectedBoneId || !snapshot) return null;
  return snapshot.nodes[selectedBoneId]?.name ?? null;
}

function KeyPanel() {
  const active = useAnimationStore((s) => s.active());
  const currentTime = useAnimationStore((s) => s.currentTime);
  const setTime = useAnimationStore((s) => s.setTime);
  const upsertRotationKey = useAnimationStore((s) => s.upsertRotationKey);
  const deleteRotationKey = useAnimationStore((s) => s.deleteRotationKey);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const boneName = useSelectionStoreApi();

  const keys = active?.tracks.find((t) => t.boneName === boneName)?.rotation ?? [];

  const addKey = () => {
    if (!active || !sceneObject || !boneName) return;
    const cap = captureBoneLocal(sceneObject, boneName);
    if (!cap) return;
    upsertRotationKey(boneName, currentTime, cap.quaternion, 'linear');
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-zinc-700">
      <span className="text-zinc-500">
        {boneName ? `选中: ${boneName} · ${keys.length} keys` : '先在左侧选中一块骨骼'}
      </span>
      <button
        onClick={addKey}
        disabled={!boneName || !sceneObject}
        className="rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500"
      >
        ◆ 打关键帧 @ {currentTime.toFixed(2)}s
      </button>
      <button
        onClick={() => boneName && deleteRotationKey(boneName, currentTime)}
        disabled={!boneName}
        className="rounded bg-zinc-200 px-2 py-1"
      >
        删除当前帧
      </button>
      <div className="flex flex-wrap gap-1">
        {[...keys]
          .sort((a, b) => a.time - b.time)
          .map((k) => (
            <button
              key={k.time}
              onClick={() => setTime(k.time)}
              onDoubleClick={() => boneName && deleteRotationKey(boneName, k.time)}
              title="单击跳转，双击删除"
              className={`rounded px-1.5 py-0.5 font-mono ${Math.abs(k.time - currentTime) < 1e-3 ? 'bg-emerald-600 text-white' : 'bg-zinc-200 text-zinc-700'}`}
            >
              {k.time.toFixed(2)}s
            </button>
          ))}
      </div>
    </div>
  );
}
