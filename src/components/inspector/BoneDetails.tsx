import { useSkeletonStore } from '../../stores/skeletonStore';
import { useSelectionStore } from '../../stores/selectionStore';

function fmt(n: number) {
  return n.toFixed(3);
}

export function BoneDetails() {
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const node = selectedBoneId ? snapshot?.nodes[selectedBoneId] : undefined;

  if (!node) return <div className="p-3 text-xs text-zinc-500">点击左侧骨骼查看详情（P1 只读）</div>;

  const parent = node.parent ? snapshot?.nodes[node.parent] : undefined;
  return (
    <div className="space-y-2 p-3 text-xs text-zinc-300">
      <div>
        <div className="text-[11px] text-zinc-500">名称</div>
        <div className="font-mono text-sm text-white">{node.name}</div>
      </div>
      <KV k="Semantic" v={node.semantic ?? '未映射'} />
      <KV k="Depth" v={String(node.depth)} />
      <KV k="父节点" v={parent ? parent.name : '(root)'} />
      <KV k="子节点" v={node.children.length === 0 ? '(末端)' : node.children.map((c) => snapshot?.nodes[c]?.name ?? c).join(', ')} />
      <div>
        <div className="text-[11px] text-zinc-500">Local Position</div>
        <div className="font-mono">{node.local.position.map(fmt).join(', ')}</div>
      </div>
      <div>
        <div className="text-[11px] text-zinc-500">Local Quaternion</div>
        <div className="font-mono">{node.local.quaternion.map(fmt).join(', ')}</div>
      </div>
      <div>
        <div className="text-[11px] text-zinc-500">Rest Pose（加载快照）</div>
        <div className="font-mono">{node.restLocal.position.map(fmt).join(', ')}</div>
      </div>
      <div className="rounded bg-zinc-900 p-2 text-[11px] text-zinc-500">
        Pose 编辑 / IK / Keyframe 在 P2 / P3 实现，本阶段 Transform 只读。
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-14 shrink-0 text-zinc-500">{k}</span>
      <span className="truncate font-mono">{v}</span>
    </div>
  );
}
