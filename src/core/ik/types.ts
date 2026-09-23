import type { Vec3Tuple } from '../../types/global';

export type IKChainId = 'arm.L' | 'arm.R' | 'leg.L' | 'leg.R';

export interface IKChainDef {
  id: IKChainId;
  label: string;
  type: 'arm' | 'leg';
  /** 骨骼名（非 id，便于 retarget 后仍可用） */
  rootBone: string;
  midBone: string;
  endBone: string;
  upperLen: number;
  lowerLen: number;
  /** 加载时刻的默认目标/极向量点（世界坐标） */
  defaultTarget: Vec3Tuple;
  defaultPolePoint: Vec3Tuple;
}

export interface IKSolveInfo {
  reached: boolean;
  hingeDeg: number;
  clamped: boolean;
}
