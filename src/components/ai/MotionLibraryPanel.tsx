import { useEffect, useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useAnimationStore } from '../../stores/animationStore';
import { buildBoneMap } from '../../services/motion/procedural';
import { getLibraryScene, listLibraryClips, retargetClip } from '../../services/motion/motionRetarget';
import type { MotionClipInfo } from '../../services/motion/motionLibrary';
import { ProviderBadge } from './ProviderBadge';

/**
 * 内置真人动作库（Quaternius / CC0-1.0）。
 * 选中 clip 后 retarget 到当前角色骨架，作为新动画加入时间轴。
 */
export function MotionLibraryPanel() {
  const character = useCharacterStore((s) => s.sceneObject);
  const snapshot = useSkeletonStore((s) => s.snapshot);
  const [clips, setClips] = useState<MotionClipInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLibraryClips()
      .then((list) => { if (!cancelled) setClips(list); })
      .catch((e) => { if (!cancelled) setMessage(`动作库加载失败：${e instanceof Error ? e.message : String(e)}`); });
    return () => { cancelled = true; };
  }, []);

  const apply = async (info: MotionClipInfo) => {
    if (!character || !snapshot) { setMessage('先加载角色'); return; }
    setBusy(info.name);
    try {
      const { scene: sourceScene, animations } = await getLibraryScene();
      const clip = animations[info.index];
      if (!clip) throw new Error(`动作包中找不到第 ${info.index} 个 clip`);
      const result = retargetClip({
        clip,
        sourceScene,
        targetRoot: character,
        targetBoneMap: buildBoneMap(snapshot),
        fps: 30,
      });
      if (result.animation.tracks.length === 0) throw new Error('没有语义成功绑定该动作');
      const id = useAnimationStore.getState().createAnimation(info.name);
      useAnimationStore.setState((s) => ({
        animations: s.animations.map((a) => a.id === id ? { ...a, ...result.animation, id } : a),
        currentTime: 0,
        playing: true,
        loop: info.loop,
      }));
      setMessage(
        `已加入「${info.name}」（${result.animation.tracks.length} 轨，绑定 ${result.bound} 项）`
        + (result.warnings.length ? `；${[...new Set(result.warnings)].join('；')}` : ''),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '应用失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-bold text-zinc-800">真人动作库</span>
        <ProviderBadge source="real" label="Quaternius CC0" />
      </div>
      <div className="text-[11px] text-zinc-500">
        真人动捕动作，重定向到当前角色骨架。资产为 CC0-1.0 公有领域（可商用、无需署名）。
      </div>
      {!character && <div className="text-[11px] text-zinc-400">先加载角色。</div>}
      {clips.length > 0 && (
        <div className="grid grid-cols-2 gap-1">
          {clips.map((c) => (
            <button
              key={c.index}
              onClick={() => apply(c)}
              disabled={!character || busy !== null}
              className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              <span>{c.name}</span>
              <span className="ml-1 shrink-0 font-mono text-[10px] text-zinc-400">
                {busy === c.name ? '…' : `${c.duration.toFixed(1)}s`}
              </span>
            </button>
          ))}
        </div>
      )}
      {message && <div className="text-[11px] text-zinc-600">{message}</div>}
      <div className="text-[11px] text-zinc-400">
        仅重定向骨骼旋转；根部位移仍由髋部管线负责（源是 1m 白模，位移不可直接搬运）。
      </div>
    </div>
  );
}
