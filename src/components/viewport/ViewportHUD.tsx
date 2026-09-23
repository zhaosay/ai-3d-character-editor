import { useViewportStore } from '../../stores/viewportStore';
import { useCharacterStore } from '../../stores/characterStore';

/** 信息条：FPS + 角色信息。显示开关已收拢到右侧主题面板。 */
export function ViewportHUD() {
  const fps = useViewportStore((s) => s.fps);
  const meta = useCharacterStore((s) => s.meta);

  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700">
      <span className="rounded bg-zinc-200 px-2 py-0.5 font-mono">FPS {fps}</span>
      {meta && (
        <span className="truncate text-zinc-600">
          {meta.fileName} · {meta.gltfInfo.bones} bones · {meta.gltfInfo.meshes} meshes
          {meta.gltfInfo.bones === 0 && <span className="text-amber-400">（无骨骼，仅预览）</span>}
        </span>
      )}
      <span className="ml-auto text-[11px] text-zinc-400">显示设置 → 右侧主题</span>
    </div>
  );
}
