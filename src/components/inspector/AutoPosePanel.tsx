import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { applyAutoposeLive, resolveTorsoBones } from '../../core/autoposing/autopose';
import { indexBonesByName } from '../../core/animation/applyPose';
import type { IKChainDef, IKChainId } from '../../core/ik/types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { AutoPoseParams } from '../../core/autoposing/types';
import { ProviderBadge } from '../ai/ProviderBadge';

type EntryPose = Map<string, { position: Vec3Tuple; quaternion: QuatTuple }>;

function captureAll(root: THREE.Object3D): EntryPose {
  const out: EntryPose = new Map();
  for (const [, b] of indexBonesByName(root)) {
    out.set(b.name, {
      position: [b.position.x, b.position.y, b.position.z],
      quaternion: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    });
  }
  return out;
}

function restoreAll(root: THREE.Object3D, entry: EntryPose) {
  const bones = indexBonesByName(root);
  entry.forEach((t, name) => {
    const b = bones.get(name);
    if (b) {
      b.position.fromArray(t.position);
      b.quaternion.fromArray(t.quaternion);
    }
  });
  root.updateWorldMatrix(true, true);
}

const DEFAULTS: AutoPoseParams = { hipsDrop: 0, leanXDeg: 0, leanZDeg: 0, pinFeet: true, pinHands: false };

export function AutoPosePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const playing = useAnimationStore((s) => s.playing);
  const active = useAnimationStore((s) => s.active());
  const currentTime = useAnimationStore((s) => s.currentTime);
  const bakePoseKeys = useAnimationStore((s) => s.bakePoseKeys);

  const [params, setParams] = useState<AutoPoseParams>(DEFAULTS);
  const [lastResult, setLastResult] = useState<{ adjusted: number; warnings: string[] } | null>(null);
  const entryRef = useRef<EntryPose | null>(null);

  const torso = snapshot ? resolveTorsoBones(snapshot) : null;
  const usable = !playing && sceneObject && torso?.hips;

  const runApply = (p: AutoPoseParams) => {
    if (!sceneObject || !snapshot) return;
    if (!entryRef.current) entryRef.current = captureAll(sceneObject);
    restoreAll(sceneObject, entryRef.current);
    const ik = useIKStore.getState().chains;
    const chains = {} as Record<IKChainId, { def: IKChainDef; polePoint: Vec3Tuple } | undefined>;
    (Object.keys(ik) as IKChainId[]).forEach((id) => {
      const c = ik[id];
      chains[id] = c ? { def: c.def, polePoint: [...c.polePoint] as Vec3Tuple } : undefined;
    });
    const r = applyAutoposeLive(sceneObject, snapshot, chains, p);
    setLastResult({ adjusted: r.adjusted.length, warnings: r.warnings });
  };

  const onParam = (patch: Partial<AutoPoseParams>) => {
    const next = { ...params, ...patch };
    setParams(next);
    runApply(next);
  };

  const onReset = () => {
    if (sceneObject && entryRef.current) {
      restoreAll(sceneObject, entryRef.current);
      entryRef.current = null;
    }
    setParams(DEFAULTS);
    setLastResult(null);
  };

  const onBake = () => {
    if (!sceneObject || !active) return;
    const bones = indexBonesByName(sceneObject);
    const rot: Array<{ boneName: string; time: number; value: QuatTuple }> = [];
    const pos: Array<{ boneName: string; time: number; value: Vec3Tuple }> = [];
    bones.forEach((b, name) => {
      rot.push({ boneName: name, time: currentTime, value: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w] });
    });
    if (torso?.hips) {
      const h = bones.get(torso.hips);
      if (h) pos.push({ boneName: torso.hips, time: currentTime, value: [h.position.x, h.position.y, h.position.z] });
    }
    bakePoseKeys(rot, pos);
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        AutoPosing <ProviderBadge source="real" label="P8 重心+保脚" />
      </div>
      {!snapshot && <div className="text-zinc-500">先加载角色</div>}
      {snapshot && !torso?.hips && <div className="text-amber-400">未找到 hips 骨骼，AutoPose 不可用</div>}
      {playing && <div className="text-amber-400">播放中锁定，先暂停</div>}
      <Slider label="重心高度" min={-0.4} max={0.15} step={0.01} unit="m" value={params.hipsDrop}
        disabled={!usable} onChange={(v) => onParam({ hipsDrop: v })} />
      <Slider label="躯干前倾" min={-25} max={25} step={1} unit="°" value={params.leanXDeg}
        disabled={!usable} onChange={(v) => onParam({ leanXDeg: v })} />
      <Slider label="躯干侧倾" min={-15} max={15} step={1} unit="°" value={params.leanZDeg}
        disabled={!usable} onChange={(v) => onParam({ leanZDeg: v })} />
      <label className="flex items-center gap-2 text-zinc-600">
        <input type="checkbox" checked={params.pinFeet} disabled={!usable}
          onChange={(e) => onParam({ pinFeet: e.target.checked })} />
        固定双脚（下压时膝盖自动弯曲）
      </label>
      <label className="flex items-center gap-2 text-zinc-600">
        <input type="checkbox" checked={params.pinHands} disabled={!usable}
          onChange={(e) => onParam({ pinHands: e.target.checked })} />
        固定双手
      </label>
      {lastResult && (
        <div className="rounded bg-zinc-100 p-2 text-[11px] text-zinc-600">
          <div>已调整 {lastResult.adjusted} 块骨骼</div>
          {lastResult.warnings.map((w, i) => (
            <div key={i} className="text-amber-400">⚠ {w}</div>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button onClick={onReset} disabled={!usable && !entryRef.current}
          className="flex-1 rounded bg-zinc-200 px-2 py-1 disabled:text-zinc-600">
          重置
        </button>
        <button onClick={onBake} disabled={!usable || !active}
          title={!active ? '先创建动画' : '把当前全身姿势写入关键帧'}
          className="flex-1 rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500">
          ◆ 全身打关键帧
        </button>
      </div>
      <div className="text-[11px] text-zinc-500">只调重心与躯干，四肢由 IK 自动跟随；满意后 bake 入 Timeline（可撤销）。</div>
    </div>
  );
}

function Slider({
  label, min, max, step, unit, value, disabled, onChange,
}: {
  label: string; min: number; max: number; step: number; unit: string;
  value: number; disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <label className="block text-zinc-600">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-zinc-800">{value.toFixed(2)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </label>
  );
}
