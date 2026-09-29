import type { Vec3Tuple } from '../../types/global';
import type { HumanoidSemantic } from '../skeleton/types';

export type PhysicsIssueKind = 'penetration' | 'footSlide' | 'accelSpike' | 'balance' | 'jointLimit';

export interface PhysicsIssue {
  kind: PhysicsIssueKind;
  /** footSlide / penetration 所属的脚 */
  foot?: 'L' | 'R';
  boneName?: string;
  limit?: number;
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
  /** Horizontal toe direction for each mapped foot, used to estimate its support footprint. */
  footForward?: { L?: [number, number]; R?: [number, number] };
  /** Approximate whole-body center of mass from available humanoid joint positions. */
  centerOfMass?: Vec3Tuple;
  /** Fraction of the expected semantic body-mass weights represented by mapped bones. */
  massCoverage?: number;
  /** Angular distance in degrees from each configured bone's rest-local rotation. */
  jointAngles?: Record<string, number>;
}

export interface JointLimit {
  semantic: HumanoidSemantic;
  boneName: string;
  restQuaternion: [number, number, number, number];
  maxDegrees: number;
}

export interface BoneNames {
  hips: string;
  footL: string | null;
  footR: string | null;
  massBones?: Partial<Record<HumanoidSemantic, string>>;
  jointLimits?: JointLimit[];
}
