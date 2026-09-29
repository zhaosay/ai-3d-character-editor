import { useMemo, useState } from 'react';
import { DEFAULT_CAMERA_POSE, sampleCameraTrack, type CameraKeyframe } from '../../core/camera/track';
import { useAnimationStore } from '../../stores/animationStore';
import { useCameraStore } from '../../stores/cameraStore';

function createDraft(keyframes: CameraKeyframe[]): CameraKeyframe {
  const first = keyframes[0] ?? DEFAULT_CAMERA_POSE;
  return { time: keyframes[0]?.time ?? 0, position: [...first.position], target: [...first.target], fov: first.fov };
}

export function CameraPanel() {
  const active = useAnimationStore((s) => s.active());
  const currentTime = useAnimationStore((s) => s.currentTime);
  const checkpoint = useAnimationStore((s) => s.checkpoint);
  const enabled = useCameraStore((s) => s.enabled);
  const keyframes = useCameraStore((s) => s.keyframes);
  const setEnabled = useCameraStore((s) => s.setEnabled);
  const upsert = useCameraStore((s) => s.upsertKeyframe);
  const remove = useCameraStore((s) => s.deleteKeyframe);
  const createDefaultPath = useCameraStore((s) => s.createDefaultPath);
  const clear = useCameraStore((s) => s.clear);
  const activationRevision = useCameraStore((s) => s.activationRevision);
  const duration = active?.duration ?? 4;
  const [draftState, setDraftState] = useState(() => ({ revision: activationRevision, value: createDraft(keyframes) }));
  const draft = draftState.revision === activationRevision ? draftState.value : createDraft(keyframes);
  const sampled = useMemo(() => sampleCameraTrack(keyframes, currentTime), [keyframes, currentTime]);
  const setDraft = (next: CameraKeyframe | ((current: CameraKeyframe) => CameraKeyframe)) => setDraftState((state) => {
    const current = state.revision === activationRevision ? state.value : createDraft(keyframes);
    return { revision: activationRevision, value: typeof next === 'function' ? next(current) : next };
  });

  const addAtPlayhead = () => {
    const base = sampled ?? DEFAULT_CAMERA_POSE;
    const key = { time: currentTime, position: [...base.position] as [number, number, number], target: [...base.target] as [number, number, number], fov: base.fov };
    setDraft(key);
    checkpoint();
    upsert(key, duration);
  };
  const setVector = (field: 'position' | 'target', index: number, value: number) => {
    setDraft((old) => {
      const next = [...old[field]] as [number, number, number];
      next[index] = value;
      return { ...old, [field]: next };
    });
  };
  const select = (key: CameraKeyframe) => setDraft({ time: key.time, position: [...key.position], target: [...key.target], fov: key.fov });

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        镜头预演
        <button onClick={() => { checkpoint(); setEnabled(!enabled); }} className={`ml-auto rounded px-2 py-1 text-[11px] ${enabled ? 'bg-sky-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}>
          {enabled ? '路径已启用' : '启用路径'}
        </button>
      </div>
      <div className="text-[11px] text-zinc-500">相机和动作共用播放头；启用后播放时锁定轨道，暂停后可关闭路径继续自由查看。</div>
      <div className="flex gap-1">
        <button onClick={() => { checkpoint(); createDefaultPath(duration); }} className="flex-1 rounded bg-sky-50 px-2 py-1 text-sky-700">创建推近路径</button>
        <button onClick={addAtPlayhead} className="flex-1 rounded bg-zinc-200 px-2 py-1">当前帧加机位</button>
        <button onClick={() => { checkpoint(); clear(); }} className="rounded bg-zinc-200 px-2 py-1 text-zinc-600">清除</button>
      </div>
      {keyframes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {keyframes.map((key) => <button key={key.time} onClick={() => select(key)} className={`rounded px-1.5 py-0.5 font-mono ${Math.abs(draft.time - key.time) < 1e-4 ? 'bg-sky-600 text-white' : 'bg-sky-50 text-sky-700'}`}>{key.time.toFixed(2)}s</button>)}
        </div>
      )}
      <div className="grid grid-cols-4 gap-1 text-[11px]">
        <label className="text-zinc-500">时间<input type="number" min={0} max={duration} step={0.1} value={draft.time} onChange={(e) => setDraft({ ...draft, time: Number(e.target.value) })} className="mt-0.5 w-full rounded bg-zinc-100 px-1 py-0.5 ring-1 ring-zinc-300" /></label>
        {(['X', 'Y', 'Z'] as const).map((label, index) => <label key={label} className="text-zinc-500">机位 {label}<input type="number" step={0.1} value={draft.position[index]} onChange={(e) => setVector('position', index, Number(e.target.value))} className="mt-0.5 w-full rounded bg-zinc-100 px-1 py-0.5 ring-1 ring-zinc-300" /></label>)}
        {(['X', 'Y', 'Z'] as const).map((label, index) => <label key={label} className="text-zinc-500">看向 {label}<input type="number" step={0.1} value={draft.target[index]} onChange={(e) => setVector('target', index, Number(e.target.value))} className="mt-0.5 w-full rounded bg-zinc-100 px-1 py-0.5 ring-1 ring-zinc-300" /></label>)}
        <label className="text-zinc-500">焦距<input type="number" min={15} max={100} value={draft.fov} onChange={(e) => setDraft({ ...draft, fov: Number(e.target.value) })} className="mt-0.5 w-full rounded bg-zinc-100 px-1 py-0.5 ring-1 ring-zinc-300" /></label>
      </div>
      <div className="flex gap-1"><button onClick={() => { checkpoint(); upsert(draft, duration); }} className="flex-1 rounded bg-sky-600 px-2 py-1 text-white">保存机位</button>{keyframes.some((key) => Math.abs(key.time - draft.time) < 1e-4) && <button onClick={() => { checkpoint(); remove(draft.time); }} className="rounded bg-zinc-200 px-2 py-1 text-red-600">删除</button>}</div>
    </div>
  );
}
