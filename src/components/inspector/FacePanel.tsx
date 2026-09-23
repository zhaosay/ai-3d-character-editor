import { useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { hasMorphTargets, listMorphTargets, resetMorphs, setMorphInfluence } from '../../core/face/morphs';

/** 表情面板：仅当模型自带 morph target 时出现；权重为实时预览，不进关键帧。 */
export function FacePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (!sceneObject || !hasMorphTargets(sceneObject)) return null;
  const morphs = listMorphTargets(sceneObject);

  const set = (meshUuid: string, index: number, v: number) => {
    try {
      setMorphInfluence(sceneObject, meshUuid, index, v);
      setError(null);
      tick((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败');
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        表情
        <button
          onClick={() => {
            resetMorphs(sceneObject);
            tick((x) => x + 1);
          }}
          className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600"
        >
          中性脸
        </button>
      </div>
      {morphs.slice(0, 24).map((m) => (
        <label key={`${m.meshUuid}-${m.index}`} className="block text-zinc-600">
          <div className="flex justify-between">
            <span className="truncate" title={`${m.meshName} · ${m.name}`}>{m.name}</span>
            <span className="font-mono text-zinc-800">{m.value.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.01} value={m.value}
            onChange={(e) => set(m.meshUuid, m.index, Number(e.target.value))}
            className="w-full accent-emerald-600"
          />
        </label>
      ))}
      {morphs.length > 24 && <div className="text-[11px] text-zinc-400">共 {morphs.length} 个，仅显示前 24 个</div>}
      {error && <div className="text-red-500">{error}</div>}
      <div className="text-[11px] text-zinc-400">实时预览，不写入关键帧（动画系统仅存骨骼变换）。</div>
    </div>
  );
}
