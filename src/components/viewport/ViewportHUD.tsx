import { useViewportStore } from '../../stores/viewportStore';
import { useCharacterStore } from '../../stores/characterStore';

export function ViewportHUD() {
  const fps = useViewportStore((s) => s.fps);
  const showSkeleton = useViewportStore((s) => s.showSkeleton);
  const showGrid = useViewportStore((s) => s.showGrid);
  const shadows = useViewportStore((s) => s.shadows);
  const toggleSkeleton = useViewportStore((s) => s.toggleSkeleton);
  const toggleGrid = useViewportStore((s) => s.toggleGrid);
  const toggleShadows = useViewportStore((s) => s.toggleShadows);
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
      <div className="ml-auto flex gap-1">
        <Toggle label="骨骼" on={showSkeleton} onClick={toggleSkeleton} />
        <Toggle label="网格" on={showGrid} onClick={toggleGrid} />
        <Toggle label="阴影" on={shadows} onClick={toggleShadows} />
      </div>
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 ${on ? 'bg-emerald-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}
    >
      {label}
    </button>
  );
}
