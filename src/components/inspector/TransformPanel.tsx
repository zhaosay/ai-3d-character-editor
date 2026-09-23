import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { setBoneLocal } from '../../core/animation/applyPose';
import type { QuatTuple } from '../../types/global';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/** P2 重点支持 Rotation（欧拉度数编辑 → 四元数存储），Position/Scale 只读。 */
export function TransformPanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const currentTime = useAnimationStore((s) => s.currentTime);
  const playing = useAnimationStore((s) => s.playing);
  const active = useAnimationStore((s) => s.active());
  const upsertRotationKey = useAnimationStore((s) => s.upsertRotationKey);
  const [interp, setInterp] = useState<'linear' | 'step'>('linear');

  const boneName = selectedBoneId && snapshot ? snapshot.nodes[selectedBoneId]?.name : undefined;

  // 从 live three 对象读取当前旋转（订阅 currentTime 以便 scrub/播放时刷新）
  const euler = useMemo(() => {
    void currentTime;
    if (!sceneObject || !boneName) return null;
    let found: THREE.Bone | null = null;
    sceneObject.traverse((o) => {
      if (!found && (o as THREE.Bone).isBone && o.name === boneName) found = o as THREE.Bone;
    });
    if (!found) return null;
    const e = new THREE.Euler().setFromQuaternion((found as THREE.Bone).quaternion, 'XYZ');
    return { x: e.x * RAD2DEG, y: e.y * RAD2DEG, z: e.z * RAD2DEG };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneObject, boneName, currentTime, selectedBoneId]);

  if (!boneName || !euler) {
    return <div className="p-3 text-xs text-zinc-500">选中骨骼后可编辑旋转（P2 仅 Rotation）</div>;
  }

  const setAxis = (axis: 'x' | 'y' | 'z', deg: number) => {
    if (!sceneObject || !boneName || playing) return;
    const e = new THREE.Euler(
      (axis === 'x' ? deg : euler.x) * DEG2RAD,
      (axis === 'y' ? deg : euler.y) * DEG2RAD,
      (axis === 'z' ? deg : euler.z) * DEG2RAD,
      'XYZ',
    );
    const q = new THREE.Quaternion().setFromEuler(e);
    const quat: QuatTuple = [q.x, q.y, q.z, q.w];
    setBoneLocal(sceneObject, boneName, { quaternion: quat });
  };

  const addKey = () => {
    if (!sceneObject || !boneName || !active) return;
    let found: THREE.Bone | null = null;
    sceneObject.traverse((o) => {
      if (!found && (o as THREE.Bone).isBone && o.name === boneName) found = o as THREE.Bone;
    });
    if (!found) return;
    const q = (found as THREE.Bone).quaternion;
    upsertRotationKey(boneName, currentTime, [q.x, q.y, q.z, q.w], interp);
  };

  const keys = active?.tracks.find((t) => t.boneName === boneName)?.rotation.length ?? 0;

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="font-bold text-zinc-700">Pose Editing · Rotation {playing && <span className="text-amber-400">（播放中锁定）</span>}</div>
      {(['x', 'y', 'z'] as const).map((ax) => (
        <label key={ax} className="flex items-center gap-2 text-zinc-600">
          <span className="w-6 uppercase">{ax}</span>
          <input
            type="number"
            step={1}
            value={Number(euler[ax].toFixed(1))}
            disabled={playing}
            onChange={(e) => setAxis(ax, Number(e.target.value))}
            className="w-full rounded bg-zinc-100 px-2 py-1 font-mono text-zinc-800 outline-none ring-1 ring-zinc-300 disabled:opacity-50"
          />
          <span>°</span>
        </label>
      ))}
      <div className="flex items-center gap-2">
        <select value={interp} onChange={(e) => setInterp(e.target.value as 'linear' | 'step')} className="rounded bg-zinc-100 px-1 py-1 outline-none ring-1 ring-zinc-300">
          <option value="linear">linear</option>
          <option value="step">step</option>
        </select>
        <button onClick={addKey} disabled={playing} className="flex-1 rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500">
          ◆ 打关键帧 ({keys})
        </button>
      </div>
      <div className="text-[11px] text-zinc-500">Position / Scale 本阶段只读，cubic/bezier 在 P7。</div>
    </div>
  );
}
