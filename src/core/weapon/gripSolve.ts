import * as THREE from 'three';
import { applyIKChain } from '../ik/applyIK';
import { indexBonesByName } from '../animation/applyPose';
import type { IKChainDef, IKChainId } from '../ik/types';
import type { StageProp } from '../previs/world';
import type { Vec3Tuple } from '../../types/global';
import {
  GUARD_SPEC,
  aimHandBladeAxis,
  facingBasis,
  guardBladeAxis,
  guardTarget,
  offHandGripTarget,
  swordAnchorsWorld,
  type SwordGuardSpec,
} from './grip';

export interface GripSolveResult {
  /** 副手所在侧 */
  offSide: 'L' | 'R';
  /** 主肩到主手的伸展率（0=贴肩，1=完全伸直） */
  mainExtension: number;
  /** 副肩到副手的伸展率 */
  offExtension: number;
  /** 双手沿柄的间距（米） */
  spanM: number;
  /** 主手落点与握点偏差（米） */
  mainToGripM: number;
  /** 副手落点与柄尾偏差（米）——**这就是「有没有握住」的数字** */
  offToPommelM: number;
  reached: boolean;
  clamped: boolean;
  hingeDeg: number;
  /** 期望刃向与实际刃向的夹角（度）：0=完全达成，受手腕活动度限制 */
  bladeAxisErrDeg: number;
}

const armChainId = (side: 'L' | 'R'): IKChainId => (side === 'L' ? 'arm.L' : 'arm.R');
const opposite = (side: 'L' | 'R'): 'L' | 'R' => (side === 'L' ? 'R' : 'L');

/**
 * 双手握持解算：主手 IK 到护手位 → 剑随主手 → 副手 IK 到柄尾。
 *
 * ## 良构性（为什么不会自激）
 *
 * 依赖是**单向链**，没有回边：
 *
 *     GUARD_SPEC ──→ 主手 IK ──→ 剑变换（WorldStage 读主手 FK）
 *                                   └──→ 柄尾锚点 ──→ 副手 IK
 *
 * 主手只被护手规格驱动、不被剑驱动；副手只被剑驱动、不回写主手。
 * 因此无论 useFrame 执行顺序如何都不成环，也不需要 R3F renderPriority。
 *
 * ## 为什么不能反过来
 *
 * 若两只手都由剑决定、而剑又由手决定，就是循环依赖（无解或抖动）。
 * 报告已明确标注此陷阱；本函数是唯一良构的分解方式。
 *
 * ## 朝向：主手解了，副手没解（诚实边界）
 *
 * **主手**：位置由 `applyIKChain` 解出后，再用 `aimHandBladeAxis` 转手腕，
 * 使剑刃指向规格要求的刃向（实测误差 GUARD 43.7° / STRIKE 26.3°，
 * 受腕部活动度钳制）。
 *
 * **副手**：仍只解位置。`applyIKChain` 不管末端朝向（applyIK.ts:45-46），
 * 所以副手能准确握住柄尾，但手腕角度不贴合剑柄轴向。
 * 这是已知限制，需要给副手也加一次腕部定向才能消除。
 *
 * @param spec 护手规格（归一化臂长，故体型自适应）；省略时用预备式
 */
export function solveTwoHandedGrip(
  root: THREE.Object3D,
  chains: IKChainDef[],
  hipsBone: THREE.Bone | null,
  sword: Pick<StageProp, 'attachTo' | 'attachOffset' | 'rotationY' | 'size'>,
  spec: SwordGuardSpec = GUARD_SPEC,
): GripSolveResult | null {
  if (!sword.attachTo) return null;
  const mainSide: 'L' | 'R' = sword.attachTo === 'hand.L' ? 'L' : 'R';
  const offSide = opposite(mainSide);

  const bones = indexBonesByName(root);
  const mainChain = chains.find((c) => c.id === armChainId(mainSide));
  const offChain = chains.find((c) => c.id === armChainId(offSide));
  if (!mainChain || !offChain) return null;

  const mainShoulder = bones.get(mainChain.rootBone);
  const mainHand = bones.get(mainChain.endBone);
  const offShoulder = bones.get(offChain.rootBone);
  const offHand = bones.get(offChain.endBone);
  if (!mainShoulder || !mainHand || !offShoulder || !offHand) return null;

root.updateWorldMatrix(true, true);

  // 朝向基：由解剖（左右肩 + 脊柱方向）决定，不假设「面朝 +Z」。
  // up 取主肩→髋的反向，即脊柱向上方向；左右肩由语义侧别给出。
  const mainSh = mainShoulder.getWorldPosition(new THREE.Vector3());
  const offSh = offShoulder.getWorldPosition(new THREE.Vector3());
  const mainIsLeft = mainSide === 'L';
  const leftSh = mainIsLeft ? mainSh : offSh;
  const rightSh = mainIsLeft ? offSh : mainSh;
  const hips = hipsBone ? hipsBone.getWorldPosition(new THREE.Vector3()) : null;
  const up = hips ? mainSh.clone().sub(hips) : new THREE.Vector3(0, 1, 0);
  const basis = facingBasis(leftSh, rightSh, up);

  const midline = mainSh.clone().add(offSh).multiplyScalar(0.5);
  const armLen = mainChain.upperLen + mainChain.lowerLen;

  // 外侧方向（水平面，由肩指向中线的反向），对左右镜像的导入骨骼同样成立，
  // 不依赖 demo rig 的 _L=+X / _R=−X 约定。
  const outwardOf = (shoulder: THREE.Vector3): THREE.Vector3 => {
    const v = new THREE.Vector3(shoulder.x - midline.x, 0, shoulder.z - midline.z);
    if (v.lengthSq() < 1e-8) return new THREE.Vector3(0, 0, 0);
    return v.normalize();
  };

  // 1) 主手 → 护手位
  const mainTarget = guardTarget(mainSh, armLen, basis, midline, spec);
  const mainOut = outwardOf(mainSh);
  const mainPole = mainSh.clone()
    .addScaledVector(mainOut, spec.poleOut * armLen)
    .addScaledVector(basis.up, -spec.poleDown * armLen)
    .toArray() as Vec3Tuple;
  const mainApplied = applyIKChain(bones, mainChain, mainTarget.toArray() as Vec3Tuple, mainPole);
  if (!mainApplied) return null;

  // 1b) 腕部定向：把刃向转到规格要求的方向。
  //     必须夹在主手定位之后、剑锚点计算之前 —— 锚点依赖手的朝向，
  //     而朝向正是这里才定下来的。
  root.updateWorldMatrix(true, true);
  const forearm = bones.get(mainChain.midBone);
  if (!forearm) return null;
  const bladeAxis = aimHandBladeAxis(mainHand, forearm, guardBladeAxis(basis, spec));

  // 2) 剑锚点（只依赖主手 FK —— 与 WorldStage / 碰撞 / 特效三条路径同源）
  root.updateWorldMatrix(true, true);
  const anchors = swordAnchorsWorld(mainHand, sword);

  // 3) 副手 → 柄尾
  const offTarget = offHandGripTarget(anchors);
  const offPole = offSh.clone()
    .addScaledVector(outwardOf(offSh), spec.poleOut * armLen)
    .addScaledVector(basis.up, -spec.poleDown * armLen)
    .toArray() as Vec3Tuple;
  const offApplied = applyIKChain(bones, offChain, offTarget.toArray() as Vec3Tuple, offPole);
  if (!offApplied) return null;

  // 4) 自检：两只手的实际落点偏差与伸展率
  root.updateWorldMatrix(true, true);
  const mainPos = mainHand.getWorldPosition(new THREE.Vector3());
  const offPos = offHand.getWorldPosition(new THREE.Vector3());
  const mainShoulderNow = mainShoulder.getWorldPosition(new THREE.Vector3());
  const offShoulderNow = offShoulder.getWorldPosition(new THREE.Vector3());

  return {
    offSide,
    bladeAxisErrDeg: THREE.MathUtils.radToDeg(
      Math.acos(THREE.MathUtils.clamp(bladeAxis.dot(guardBladeAxis(basis, spec)), -1, 1)),
    ),
    mainExtension: mainPos.distanceTo(mainShoulderNow) / armLen,
    offExtension: offPos.distanceTo(offShoulderNow) / (offChain.upperLen + offChain.lowerLen),
    spanM: anchors.grip.distanceTo(anchors.pommel),
    mainToGripM: mainPos.distanceTo(anchors.grip),
    offToPommelM: offPos.distanceTo(anchors.pommel),
    reached: mainApplied.reached && offApplied.reached,
    clamped: mainApplied.clamped || offApplied.clamped,
    hingeDeg: mainApplied.hingeDeg,
  };
}