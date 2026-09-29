import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { sampleAnimation } from '../../core/animation/sampler';
import { applySampledPose } from '../../core/animation/applyPose';
import { applyPoseWithIK, type IKPin } from '../../core/ik/applyPoseWithIK';
import { applyFaceTracks } from '../../core/face/morphs';
import { useFootLockStore } from '../../stores/footLockStore';
import { FootLockRuntime } from '../../services/motion/footLockRuntime';
import type { IKChainDef } from '../../core/ik/types';

/** 已检测到的腿 IK 链（过滤掉缺失/未初始化项）。 */
function legChains(): IKChainDef[] {
  return Object.values(useIKStore.getState().chains)
    .map((c) => c?.def)
    .filter((d): d is IKChainDef => Boolean(d));
}

/** Canvas 内：播放时推进时间并应用 pose。时间写入 store，Timeline/Inspector 跟随。 */
export function PlaybackEngine() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const footLockEnabled = useFootLockStore((s) => s.enabled);
  const footLockConfig = useFootLockStore((s) => s.config);
  const setSlip = useFootLockStore((s) => s.setSlip);
  const runtime = useRef<FootLockRuntime | null>(null);

  // 角色或开关变化时重建运行时
  useEffect(() => {
    runtime.current = null;
  }, [sceneObject, footLockEnabled]);

  useFrame((_, delta) => {
    const st = useAnimationStore.getState();
    if (!st.playing || !sceneObject) return;
    const active = st.active();
    if (!active || (active.tracks.length === 0 && !(active.faceTracks?.length))) {
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
      applyFaceTracks(sceneObject, active.faceTracks ?? [], t);
      if (footLockEnabled) {
        if (!runtime.current) runtime.current = new FootLockRuntime(legChains(), footLockConfig);
        // solve() 内部会检测时间回退并重置状态
        setSlip(runtime.current.solve(sceneObject, t, delta));
      }
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
    if (!active || (active.tracks.length === 0 && !(active.faceTracks?.length))) return;
    try {
      const pins: IKPin[] = [];
      for (const c of Object.values(useIKStore.getState().chains)) {
        if (c?.enabled) pins.push({ def: c.def, target: [...c.target], polePoint: [...c.polePoint] });
      }
      const footLockOn = useFootLockStore.getState().enabled;
      if (footLockOn) {
        // 足部锁定是「时间累积」状态：必须从 0 重放到目标时间，
        // 否则拖到任意位置得到的落点都与播放时不一致（scrub 会看到跳变）。
        const runtime = new FootLockRuntime(legChains(), useFootLockStore.getState().config);
        const dt = 1 / 30;
        const steps = Math.max(1, Math.ceil(currentTime / dt));
        for (let i = 1; i <= steps; i++) {
          const t = Math.min(currentTime, i * dt);
          const pose = sampleAnimation(active, t);
          applyPoseWithIK(sceneObject, pose, pins);
          runtime.solve(sceneObject, t, dt);
        }
        useFootLockStore.getState().setSlip(0);
      } else {
        const pose = sampleAnimation(active, currentTime);
        if (pose.size > 0) {
          // 启用的 IK 链跟随求解，避免 FK 覆盖造成闪一帧
          applyPoseWithIK(sceneObject, pose, pins);
        }
      }
      applyFaceTracks(sceneObject, active.faceTracks ?? [], currentTime);
    } catch (e) {
      console.error(e);
    }
  }, [sceneObject, currentTime, animations, activeId, playing]);

  return null;
}
