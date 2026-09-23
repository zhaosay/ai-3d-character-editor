import type { Vec3Tuple } from '../../types/global';

export type PhysicsIssueKind = 'penetration' | 'footSlide' | 'accelSpike';

export interface PhysicsIssue {
  kind: PhysicsIssueKind;
  /** footSlide / penetration 所属的脚 */
  foot?: 'L' | 'R';
  t0: number;
  t1: number;
  /** 穿透深度(m) / 滑动距离(m) / 加速度峰值(m/s²) */
  value: number;
  message: string;
}

export interface TrajSample {
  time: number;
  hipsY: number;
  hipsLocal: Vec3Tuple;
  feet: { L: Vec3Tuple | null; R: Vec3Tuple | null };
}

export interface BoneNames {
  hips: string;
  footL: string | null;
  footR: string | null;
}
