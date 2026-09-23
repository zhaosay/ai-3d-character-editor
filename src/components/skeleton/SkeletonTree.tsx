import { useMemo, useState } from 'react';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useSelectionStore } from '../../stores/selectionStore';

export function SkeletonTree() {
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const select = useSelectionStore((s) => s.select);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const q = query.trim().toLowerCase();
    return Object.values(snapshot.nodes)
      .filter((n) => (q ? n.name.toLowerCase().includes(q) : n.parent === null))
      .sort((a, b) => a.index - b.index);
  }, [snapshot, query]);

  if (!snapshot) {
    return <div className="p-3 text-xs text-zinc-500">未加载骨骼（先拖入带骨骼的 GLB）</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索骨骼…"
          className="w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-600"
        />
        <div className="mt-1 text-[11px] text-zinc-500">{snapshot.boneCount} bones</div>
      </div>
      <div className="flex-1 overflow-auto px-1 pb-2">
        {query ? (
          <div>
            {filtered.map((n) => (
              <BoneRow key={n.id} id={n.id} depth={n.depth} selected={n.id === selectedBoneId} onSelect={select} />
            ))}
            {filtered.length === 0 && <div className="p-2 text-xs text-zinc-500">无匹配</div>}
          </div>
        ) : (
          <div>
            {snapshot.roots.map((r) => (
              <BoneSubtree key={r} id={r} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BoneSubtree({ id, depth }: { id: string; depth: number }) {
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const node = snapshot?.nodes[id];
  if (!node) return null;
  return (
    <div>
      <BoneRowWithStore id={id} depth={depth} />
      {node.children.map((c) => (
        <BoneSubtree key={c} id={c} depth={depth + 1} />
      ))}
    </div>
  );
}

function BoneRowWithStore({ id, depth }: { id: string; depth: number }) {
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const select = useSelectionStore((s) => s.select);
  return <BoneRow id={id} depth={depth} selected={id === selectedBoneId} onSelect={select} />;
}

function BoneRow({
  id,
  depth,
  selected,
  onSelect,
}: {
  id: string;
  depth: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const node = snapshot?.nodes[id];
  if (!node) return null;
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs ${
        selected ? 'bg-emerald-600/30 text-emerald-200' : 'text-zinc-300 hover:bg-zinc-800'
      }`}
      style={{ paddingLeft: 6 + depth * 12 }}
      title={node.name}
    >
      <span className="text-zinc-600">{node.children.length > 0 ? '▾' : '·'}</span>
      <span className="truncate">{node.name}</span>
      {node.semantic && <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{node.semantic}</span>}
    </button>
  );
}
