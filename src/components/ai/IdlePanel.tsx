import { useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIdleStore } from '../../stores/idleStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { buildBoneMap, buildRestMap, generateProceduralTracks } from '../../services/motion/procedural';
import { findBlinkTargets, listMorphTargets } from '../../core/face/morphs';
import { ProviderBadge } from '../ai/ProviderBadge';

/** 待机律动：呼吸生成进时间轴（可播放/导出）+ 自动眨眼实时层（需模型自带 blink morph）。 */
export function IdlePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const createAnimation = useAnimationStore((s) => s.createAnimation);
  const bakePoseKeys = useAnimationStore((s) => s.bakePoseKeys);
  const blinkEnabled = useIdleStore((s) => s.blinkEnabled);
  const setBlinkEnabled = useIdleStore((s) => s.setBlinkEnabled);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const blinkTargets = sceneObject ? findBlinkTargets(listMorphTargets(sceneObject)).length : 0;

  const genBreath = () => {
    if (!sceneObject || !snapshot) {
      setMsg('先加载角色');
      return;
    }
    setBusy(true);
    try {
      const { tracks, warnings } = generateProceduralTracks(
        buildBoneMap(snapshot),
        { prompt: '呼吸', duration: 4, seed: 1 },
        buildRestMap(snapshot),
      );
      const id = createAnimation('待机呼吸');
      bakePoseKeys(
        tracks.flatMap((t) => t.rotation.map((k) => ({ boneName: t.boneName, time: k.time, value: k.value, interp: k.interp }))),
        [],
      );
      useAnimationStore.setState({ activeId: id, currentTime: 0, playing: false });
      setMsg([`已生成 4s 呼吸待机（${tracks.length} 轨，可撤销）`, ...warnings].join('；'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        待机律动 <ProviderBadge source="real" label="呼吸+眨眼" />
      </div>
      <button
        onClick={genBreath}
        disabled={busy || !sceneObject}
        title={!sceneObject ? '先加载角色' : '新建 4s 呼吸动画并写入关键帧'}
        className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-200 disabled:text-zinc-500"
      >
        {busy ? '生成中…' : '生成呼吸待机 → 新动画'}
      </button>
      <label className="flex items-center gap-2 text-zinc-600">
        <input
          type="checkbox"
          checked={blinkEnabled}
          disabled={!sceneObject || blinkTargets === 0}
          onChange={(e) => setBlinkEnabled(e.target.checked)}
        />
        自动眨眼
        <span className="text-[11px] text-zinc-400">
          {!sceneObject ? '（先加载角色）' : blinkTargets === 0 ? '（当前模型无 blink morph，不可用）' : `（${blinkTargets} 个目标）`}
        </span>
      </label>
      {msg && <div className="text-[11px] text-zinc-600">{msg}</div>}
      <div className="text-[11px] text-zinc-400">呼吸进时间轴可导出；眨眼为实时层，不进关键帧。</div>
    </div>
  );
}
