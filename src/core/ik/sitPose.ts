import * as THREE from 'three';
import type { SkeletonSnapshot } from '../skeleton/types';
import { hipHeightFromLegSpan, solveSitLeg, type LegChain, type SitSolution } from './sitSolve';
import { measureSoleDrop } from './footLock';

/**
 * 坐姿姿态适配：把「座面高度 + 真实骨长」解成 procedural 需要的每帧腿角。
 *
 * 解决的问题：`sit` 模板原用**固定欧拉角**（thigh −72° / shin +68°）
 * 且**固定座高 16cm**。但髋目标高度随座面变化（地面 0.13m、椅 0.45m、高凳 0.8m），
 * 固定角只可能对**一个**座高正确 —— 实测脚骨落到 y=−0.49m。
 *
 * 这里不改 procedural 的整体结构，只提供两件事：
 *   1. `measureLegChain`：从真实骨架量出两段腿长与髋高偏移（不假设命名/比例）
 *   2. `sitPoseAt`：给定进度与座高，返回该帧的 thigh/shin/foot 角与髋高
 *
 * 关键点：髋高与腿角**必须同源**（都用 solveSitLeg 的跨距反解），
 * 否则会出现「终态脚贴地、过渡中途插地」。
 */

/**
 * 踝高（脚骨原点到脚底）的**回退**值。
 * 真实值用 measureSoleDrop 从绑定到脚骨的网格顶点实测 —— 不同资产的鞋底
 * 厚度差很多（内置示例角色实测 1.47cm），硬编码会带来数厘米系统误差。
 */
const ANKLE_ABOVE_SOLE_FALLBACK = 0.02;

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 从骨架快照量出一条腿的连杆参数。
 * 左右腿分别量（体型/姿态可能不对称），量不到返回 null 而非编造。
 */
export function measureLegChain(
  snapshot: SkeletonSnapshot,
  side: 'L' | 'R',
  /** 传入场景根节点才能实测脚底高度；不给则用回退值。 */
  root?: THREE.Object3D,
): LegChain | null {
  const nodes = Object.values(snapshot.nodes);
  const hips = nodes.find((n) => n.semantic === 'hips');
  const thigh = nodes.find((n) => n.semantic === `thigh.${side}`);
  const shin = nodes.find((n) => n.semantic === `shin.${side}`);
  const foot = nodes.find((n) => n.semantic === `foot.${side}`);
  if (!hips || !thigh || !shin || !foot) return null;
  const upper = dist(thigh.world.position, shin.world.position);
  const lower = dist(shin.world.position, foot.world.position);
  // 骨长为 0 说明快照退化（骨骼重合），此时不给出链
  if (!(upper > 0.05) || !(lower > 0.05)) return null;
  /**
   * 踝高：脚底是**网格顶点**而非骨骼，骨快照里没有这个概念，
   * 只能用 measureSoleDrop 从绑定到脚骨的蒙皮网格实测。
   * 拿脚骨原点 y 当踝高是错的（实测 1.93cm 是「踝离地」不是「踝离脚底」）。
   */
  const footBone = root?.getObjectByName(foot.name);
  const measured = root && footBone instanceof THREE.Bone ? measureSoleDrop(root, footBone) : 0;
  const ankleAboveSole = measured > 0.002 ? measured : ANKLE_ABOVE_SOLE_FALLBACK;
  return {
    upper,
    lower,
    hipDrop: hips.world.position[1] - thigh.world.position[1],
    shinBiasDeg: 0,
    ankleAboveSole,
  };
}

/** 坐姿的期望脚前伸量（米）：脚落在髋前方约一掌宽。 */
const DEFAULT_REACH = 0.35;

/**
 * 骨盆半径：髋**中心**高于座面的量。真实值随体型变化，这里用
 * 髋骨到 thigh 关节的垂直距离近似（见 measureLegChain 的 hipDrop），
 * 但座面到髋中心的距离需要独立估计 —— 用髋到膝的垂直分量的一半做保守估计。
 */
export function pelvisRadiusOf(chain: LegChain): number {
  // 髋中心到髋关节的垂直距离 + 髋关节处的组织厚度估计
  return Math.max(0.10, Math.min(0.20, chain.hipDrop + 0.06));
}

export interface SitPoseInput {
  chain: LegChain;
  /** 座面世界高度（地面 0、椅座 0.45…） */
  seatY: number;
  /** 地面世界高度，默认 0 */
  groundY?: number;
  /** 脚前伸量，默认 0.35m */
  reach?: number;
  /** 进度 0..1（0 = 站立，1 = 完全坐好） */
  progress: number;
}

export interface SitPoseOutput {
  thighDeg: number;
  shinDeg: number;
  footDeg: number;
  /**
   * 该帧应有的**髋骨中心**世界高度（可直接作为 hips 骨的世界 Y）。
   * `hipHeightFromLegSpan` 内部已把 hipDrop 计入（骨在关节上方 hipDrop），
   * 所以这里**不能再加一次** hipDrop。
   */
  hipY: number;
  /** 与 hipY 相同，语义别名：明确表达「摆放 hips 骨用这个」。 */
  boneHipY: number;
  /** 终帧解；进度 < 1 时角按进度插值，髋高仍由跨距反解 */
  solution: SitSolution | null;
  degraded: SitSolution['degraded'];
}

/**
 * 求某一进度的坐姿。
 *
 * 先解**终帧**（progress=1）的姿态，再用 hipHeightFromLegSpan 反解该进度的髋高 ——
 * 这样过渡全程脚底都贴地，而不是只在终点贴地。
 */
export function sitPoseAt(input: SitPoseInput): SitPoseOutput | null {
  const { chain, seatY, groundY = 0, reach = DEFAULT_REACH, progress } = input;
  const p = Math.max(0, Math.min(1, progress));
  // 目标髋高 = 座面 + 骨盆半径（髋中心坐在座面上）
  const pelvisR = pelvisRadiusOf(chain);
  const solution = solveSitLeg(chain, { groundY, hipY: seatY + pelvisR, reach });
  if (!solution) return null;

  // hipHeightFromLegSpan 已含 hipDrop，返回的就是髋**骨**中心高度
  const boneY = hipHeightFromLegSpan(chain, p, solution, groundY);
  const thighDeg = solution.thighDeg * p;
  const shinDeg = solution.shinDeg * p;
  const footDeg = solution.footDeg * p;
  return {
    thighDeg,
    shinDeg,
    footDeg,
    hipY: boneY,
    boneHipY: boneY,
    solution,
    degraded: solution.degraded,
  };
}

/** 终帧坐姿（供只需静态坐姿的调用方，如坐姿待机）。 */
export function seatedLegPose(
  chain: LegChain,
  seatY: number,
  groundY = 0,
  reach = DEFAULT_REACH,
): { thighDeg: number; shinDeg: number; footDeg: number; degraded: SitSolution['degraded'] } | null {
  const pelvisR = pelvisRadiusOf(chain);
  const solution = solveSitLeg(chain, { groundY, hipY: seatY + pelvisR, reach });
  if (!solution) return null;
  return { thighDeg: solution.thighDeg, shinDeg: solution.shinDeg, footDeg: solution.footDeg, degraded: solution.degraded };
}
