import type { AnimationData } from '../../core/animation/types';

/** Uniformly retime provider keyframes to the requested timeline without changing pose values. */
export function retimeMotion(animation: AnimationData, duration: number, fps: number): { animation: AnimationData; warning?: string } {
  if (Math.abs(animation.duration - duration) < 1e-4) {
    if (animation.fps === fps) return { animation };
    return { animation: { ...animation, fps } };
  }
  const sourceDuration = animation.duration;
  const factor = duration / sourceDuration;
  const retimed = structuredClone(animation);
  retimed.duration = duration;
  retimed.fps = fps;
  for (const track of retimed.tracks) {
    for (const key of [...track.position, ...track.rotation, ...track.scale]) key.time *= factor;
  }
  for (const track of retimed.faceTracks ?? []) for (const key of track.keys) key.time *= factor;
  return {
    animation: retimed,
    warning: `远程动作时长 ${sourceDuration.toFixed(2)} 秒已按请求重定时为 ${duration.toFixed(2)} 秒；关键帧相对时间比例保持不变`,
  };
}
