export interface AutoPoseParams {
  /** 髋部下压（米，负=下蹲）。钳制 [-0.5, 0.3]。 */
  hipsDrop: number;
  /** 躯干前倾（度，+前）。钳制 [-30, 30]。 */
  leanXDeg: number;
  /** 躯干侧倾（度）。钳制 [-20, 20]。 */
  leanZDeg: number;
  /** 下压/倾斜时保持双脚世界位置（腿 IK 重解） */
  pinFeet: boolean;
  /** 保持双手世界位置（臂 IK 重解） */
  pinHands: boolean;
}

export interface AutoPoseResult {
  adjusted: string[];
  warnings: string[];
}

export const AUTOPOSE_LIMITS = {
  hipsDrop: [-0.5, 0.3] as const,
  leanX: [-30, 30] as const,
  leanZ: [-20, 20] as const,
} as const;
