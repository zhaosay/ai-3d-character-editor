import { useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { hasMorphTargets, listMorphTargets, resetMorphs, setMorphInfluence } from '../../core/face/morphs';
import { sampleScalarTrack } from '../../core/animation/sampler';

/** Morph weights preview live and can be keyed on the shared animation timeline. */
export function FacePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const active = useAnimationStore((s) => s.active());
  const currentTime = useAnimationStore((s) => s.currentTime);
  const upsertFaceKey = useAnimationStore((s) => s.upsertFaceKey);
  const deleteFaceKey = useAnimationStore((s) => s.deleteFaceKey);
  const [, tick] = useState(0);
  const [preview, setPreview] = useState<{ targetId: string; time: number; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!sceneObject || !hasMorphTargets(sceneObject)) return null;
  const morphs = listMorphTargets(sceneObject);

  const set = (meshUuid: string, targetId: string, value: number) => {
    try {
      setMorphInfluence(sceneObject, meshUuid, morphs.find((m) => m.targetId === targetId)?.index ?? -1, value);
      setPreview({ targetId, time: currentTime, value });
      setError(null);
      tick((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败');
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        表情关键帧
        <button
          onClick={() => {
            resetMorphs(sceneObject);
            tick((x) => x + 1);
          }}
          className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600"
        >中性脸</button>
      </div>
      {morphs.slice(0, 24).map((m) => {
        const track = active?.faceTracks?.find((item) => item.meshPath === m.meshPath && item.targetName === m.name);
        const keyedValue = track ? sampleScalarTrack(track.keys, currentTime) : undefined;
        const draftValue = preview?.targetId === m.targetId && Math.abs(preview.time - currentTime) < 1e-4 ? preview.value : undefined;
        const value = draftValue ?? keyedValue ?? m.value;
        const keyAtTime = track?.keys.find((key) => Math.abs(key.time - currentTime) < 1e-3);
        return <div key={m.targetId} className="rounded bg-zinc-50 p-2">
          <label className="block text-zinc-600">
            <div className="flex justify-between gap-2">
              <span className="truncate" title={`${m.meshName} · ${m.name}`}>{m.name}</span>
              <span className="font-mono text-zinc-800">{value.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.01} value={value}
              onChange={(event) => set(m.meshUuid, m.targetId, Number(event.target.value))}
              className="w-full accent-emerald-600"
            />
          </label>
          <div className="mt-1 flex items-center gap-1">
            <button
              disabled={!active}
              onClick={() => upsertFaceKey(m.meshPath, m.name, currentTime, value)}
              className="rounded bg-rose-100 px-2 py-0.5 text-rose-700 disabled:text-zinc-400"
            >{keyAtTime ? '更新此帧' : `记录 @${currentTime.toFixed(2)}s`}</button>
            {keyAtTime && <button
              onClick={() => deleteFaceKey(m.meshPath, m.name, keyAtTime.time)}
              className="rounded bg-zinc-200 px-2 py-0.5 text-zinc-600"
            >删除关键帧</button>}
            <span className="ml-auto text-[10px] text-zinc-400">{track?.keys.length ?? 0} 帧</span>
          </div>
        </div>;
      })}
      {morphs.length > 24 && <div className="text-[11px] text-zinc-400">共 {morphs.length} 个，仅显示前 24 个</div>}
      {error && <div className="text-red-500">{error}</div>}
      <div className="text-[11px] text-zinc-400">表情与眨眼关键帧和身体动作共用时间轴；记录、删除均可撤销，并随动画保存。</div>
    </div>
  );
}
