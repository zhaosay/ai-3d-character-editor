import { useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { sampleAnimation } from '../../core/animation/sampler';
import { applySampledPose } from '../../core/animation/applyPose';

/** Canvas 内：播放时推进时间并应用 pose。时间写入 store，Timeline/Inspector 跟随。 */
export function PlaybackEngine() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);

  useFrame((_, delta) => {
    const st = useAnimationStore.getState();
    if (!st.playing || !sceneObject) return;
    const active = st.active();
    if (!active || active.tracks.length === 0) {
      // 无 key 时只推进时间轴，不改 pose
      const dur = active?.duration ?? 4;
      st.setTime(st.currentTime + Math.min(delta, 0.1));
      if (st.currentTime >= dur) {
        if (st.loop) st.setTime(0);
        else st.setPlaying(false);
      }
      return;
    }
    let t = st.currentTime + Math.min(delta, 0.1);
    if (t >= active.duration) {
      if (st.loop) t = t % active.duration;
      else {
        t = active.duration;
        st.setPlaying(false);
      }
    }
    st.setTime(t);
    try {
      const pose = sampleAnimation(active, t);
      applySampledPose(sceneObject, pose);
    } catch (e) {
      // cubic 等未实现时停播并报错，避免刷屏
      st.setPlaying(false);
      console.error(e);
    }
  });
  return null;
}

/** Canvas 外：暂停时 scrub 也要应用 pose（订阅 time 变化）。 */
export function ScrubApplier() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const currentTime = useAnimationStore((s) => s.currentTime);
  const animations = useAnimationStore((s) => s.animations);
  const activeId = useAnimationStore((s) => s.activeId);
  const playing = useAnimationStore((s) => s.playing);

  useEffect(() => {
    if (!sceneObject || playing) return;
    const active = animations.find((a) => a.id === activeId) ?? animations[0];
    if (!active || active.tracks.length === 0) return;
    try {
      const pose = sampleAnimation(active, currentTime);
      if (pose.size > 0) applySampledPose(sceneObject, pose);
    } catch (e) {
      console.error(e);
    }
  }, [sceneObject, currentTime, animations, activeId, playing]);

  return null;
}
