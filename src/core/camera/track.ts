import type { Vec3Tuple } from '../../types/global';

export interface CameraKeyframe {
  time: number;
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov: number;
}

export interface CameraPose {
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov: number;
}

export const DEFAULT_CAMERA_POSE: CameraPose = {
  position: [2.5, 1.8, 3.2],
  target: [0, 1, 0],
  fov: 45,
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** 按播放时间采样相机；边界时间保持首尾机位，便于镜头段之间稳定衔接。 */
export function sampleCameraTrack(keys: CameraKeyframe[], time: number): CameraPose | null {
  if (keys.length === 0) return null;
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return { ...sorted[0], position: [...sorted[0].position], target: [...sorted[0].target] };
  const last = sorted.at(-1)!;
  if (time >= last.time) return { ...last, position: [...last.position], target: [...last.target] };
  const nextIndex = sorted.findIndex((key) => key.time >= time);
  const a = sorted[nextIndex - 1];
  const b = sorted[nextIndex];
  const progress = (time - a.time) / Math.max(b.time - a.time, 1e-6);
  return { position: lerpVec(a.position, b.position, progress), target: lerpVec(a.target, b.target, progress), fov: lerp(a.fov, b.fov, progress) };
}

export function sanitizeCameraKeyframe(key: CameraKeyframe, duration: number): CameraKeyframe {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  return {
    time: clamp(finite(key.time, 0), 0, duration),
    position: key.position.map((value, i) => finite(value, DEFAULT_CAMERA_POSE.position[i])) as Vec3Tuple,
    target: key.target.map((value, i) => finite(value, DEFAULT_CAMERA_POSE.target[i])) as Vec3Tuple,
    fov: clamp(finite(key.fov, DEFAULT_CAMERA_POSE.fov), 15, 100),
  };
}

