import type { QuatTuple, Vec3Tuple } from '../../types/global';

export type HumanoidSemantic =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulder.L'
  | 'shoulder.R'
  | 'upperArm.L'
  | 'upperArm.R'
  | 'forearm.L'
  | 'forearm.R'
  | 'hand.L'
  | 'hand.R'
  | 'thigh.L'
  | 'thigh.R'
  | 'shin.L'
  | 'shin.R'
  | 'foot.L'
  | 'foot.R';

export interface BoneTransform {
  position: Vec3Tuple;
  quaternion: QuatTuple;
  scale: Vec3Tuple;
}

export interface BoneNode {
  id: string;
  name: string;
  index: number;
  parent: string | null;
  children: string[];
  local: BoneTransform;
  world: { position: Vec3Tuple; quaternion: QuatTuple };
  restLocal: BoneTransform;
  depth: number;
  isEndSite: boolean;
  semantic: HumanoidSemantic | null;
}

export interface SkeletonSnapshot {
  roots: string[];
  nodes: Record<string, BoneNode>;
  boneCount: number;
}
