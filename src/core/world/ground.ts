import * as THREE from 'three';

/**
 * 地面高度场（Foot IK 的投射目标）。
 *
 * 只做「点 → 高度 + 法线」的解析查询，不做物理：
 * - 基准平面（y = groundY）
 * - 若干轴对齐盒（台阶/平台/桌面/床垫），取最高的支撑面
 *
 * 参考解析式步态的通行做法：地形是函数，足部 IK 直接采样该函数，
 * 避免每帧 raycast 带来的开销与抖动。
 */

export interface GroundBox {
  /** 诊断用标识 */
  id?: string;
  /** 世界中心 */
  center: Vec3Like;
  /** 世界尺寸（旋转前，假设 yaw=0） */
  size: Vec3Like;
  /** 绕 Y 的旋转（弧度），台阶平台一般 0 */
  rotationY?: number;
  /** 只有顶面可站立 */
  walkable?: boolean;
}

export type Vec3Like = [number, number, number] | readonly number[];

export interface GroundSample {
  /** 支撑面高度 */
  height: number;
  /** 支撑面法线（台阶为 +Y，斜面为倾斜） */
  normal: THREE.Vector3;
  /** 命中来源说明（诊断/测试用） */
  source: 'plane' | 'box' | null;
  /** 命中的盒子 id */
  boxId?: string;
}

export interface GroundFieldOptions {
  groundY: number;
  boxes?: Array<GroundBox & { id?: string }>;
  /** 采样点上方多少米内寻找支撑面（避免吸到远处的桌沿） */
  probeUp?: number;
  /** 采样点下方多少米内寻找（默认给足部留的容差） */
  probeDown?: number;
}

export const DEFAULT_PROBE_UP = 0.35;
export const DEFAULT_PROBE_DOWN = 0.6;

/** 点是否落在盒的水平投影内（考虑 yaw 旋转）。 */
function insideBoxXZ(x: number, z: number, box: GroundBox): boolean {
  const yaw = box.rotationY ?? 0;
  const dx = x - box.center[0];
  const dz = z - box.center[2];
  if (yaw === 0) {
    return Math.abs(dx) <= box.size[0] / 2 && Math.abs(dz) <= box.size[2] / 2;
  }
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= box.size[0] / 2 && Math.abs(lz) <= box.size[2] / 2;
}

export class GroundField {
  private readonly groundY: number;
  private readonly boxes: Array<GroundBox & { id?: string }>;
  private readonly probeUp: number;
  private readonly probeDown: number;

  constructor(opts: GroundFieldOptions) {
    this.groundY = opts.groundY;
    this.boxes = (opts.boxes ?? []).filter((b) => b.walkable !== false);
    this.probeUp = opts.probeUp ?? DEFAULT_PROBE_UP;
    this.probeDown = opts.probeDown ?? DEFAULT_PROBE_DOWN;
  }

  /**
   * 采样 (x,z) 处的支撑面。originY 是脚的当前高度，用于限定探测窗口：
   * 只接受与 originY 相差在 [−probeDown, +probeUp] 内的高度，
   * 否则会把远处高台"吸"上来。
   */
  sample(x: number, z: number, originY: number): GroundSample {
    const minY = originY - this.probeDown;
    const maxY = originY + this.probeUp;
    let best: GroundSample = {
      height: this.groundY,
      normal: new THREE.Vector3(0, 1, 0),
      source: 'plane',
    };
    if (this.groundY < minY || this.groundY > maxY) {
      // 基准平面在探测窗口外：仍以它为兜底，但标记出来
      best.height = this.groundY;
    }
    let bestHeight = this.groundY;

    for (const box of this.boxes) {
      if (!insideBoxXZ(x, z, box)) continue;
      const top = box.center[1] + box.size[1] / 2;
      if (top < minY || top > maxY) continue;
      if (top > bestHeight) {
        bestHeight = top;
        best = {
          height: top,
          normal: new THREE.Vector3(0, 1, 0),
          source: 'box',
          boxId: box.id,
        };
      }
    }
    return best;
  }

  /** 采样法线：在采样点周围取差分，斜坡会得到倾斜法线。 */
  sampleNormal(x: number, z: number, originY: number, eps = 0.05): THREE.Vector3 {
    const hx = this.sample(x + eps, z, originY).height;
    const h0 = this.sample(x, z, originY).height;
    const hz = this.sample(x, z + eps, originY).height;
    // 法线 = normalize(-dh/dx, 1, -dh/dz)
    return new THREE.Vector3(-(hx - h0) / eps, 1, -(hz - h0) / eps).normalize();
  }

  /** 该点是否有高于基准平面的支撑（用于判断是否踩上台阶）。 */
  isElevated(x: number, z: number, originY: number): boolean {
    return this.sample(x, z, originY).height > this.groundY + 1e-4;
  }

  /** 设置台阶：便捷方法（世界坐标盒）。 */
  addBox(box: GroundBox & { id?: string }): void {
    this.boxes.push(box);
  }

  clearBoxes(): void {
    this.boxes.length = 0;
  }
}

/** 由道具列表构造高度场：只有「可站立」的道具参与（床/桌/椅子等）。 */
const WALKABLE_KINDS = new Set(['bed', 'chair', 'sofa', 'table', 'room']);

export function groundFieldFromProps(
  groundY: number,
  props: Array<{ id: string; kind: string; position: readonly number[]; rotationY: number; size: { width: number; height: number; length: number } }>,
): GroundField {
  const boxes = props
    .filter((p) => WALKABLE_KINDS.has(p.kind))
    .map((p) => ({
      id: p.id,
      center: [p.position[0], p.position[1] + p.size.height / 2, p.position[2]] as Vec3Like,
      size: [p.size.width, p.size.height, p.size.length] as Vec3Like,
      rotationY: p.rotationY,
      walkable: true,
    }));
  return new GroundField({ groundY, boxes });
}
