import * as THREE from 'three';
import type { Vec3Tuple } from '../../types/global';
import type { StageProp } from '../previs/world';

/**
 * 持剑锚点、护手规格与双手握持目标。
 *
 * ## 之前的问题
 *
 * `sword` 模板只有单臂摆动：主手 `upperArm −115°`，**副手只摆 ±12°**（procedural.ts:402）。
 * 两只手根本不在同一把剑上，也没有站姿（下肢全空）。真实双手剑术是
 * 「双手握把 + 双脚前后开立 + 重心在前脚」。
 *
 * ## 为什么用「归一化规格 + IK」而不是把角度写死在模板里
 *
 * 实测把护手式烘焙成欧拉角后（`UpperArm_R=[-9.9,-0.2,2.6] Forearm_R=[-64.4,-31.4,48.2]`），
 * 那些数字**只在 demo rig 的骨长上成立**。本项目一贯的做法是体型自适应
 * （坐姿按真实骨长反解、步幅按腿长缩放、床上终帧按承重面对齐），
 * 因此护手位也必须按**臂长比例**定义，在运行时用 IK 解到具体骨骼上。
 *
 * ## 循环依赖陷阱（决定了本方案的形状）
 *
 * 剑的世界变换 = 主手 FK × attachOffset（WorldStage.tsx:94-103）。
 * 若让**两只手都反向由剑决定**，就是循环。
 *
 * 良构的依赖链（单向）：
 *
 *     护手规格 → 主手 IK（世界目标）→ 剑变换（FK 自主手）→ 柄尾锚点 → 副手 IK
 *
 * 主手只被「护手规格」驱动，不被剑驱动，所以无环，
 * 也不需要给 R3F 加 renderPriority。
 */

/**
 * 剑的局部锚点（与 WorldStage 的 JSX 几何对应，单位米）。
 *
 * 几何实测（默认 size.length=0.9）：
 *   握柄 cylinder  pos=[0,-0.04,0] h=0.18 → 局部 y ∈ [-0.13, +0.05]
 *   护手   box      pos=[0, 0.065,0]
 *   剑身   box      pos=[0, L*0.52,0] → 局部 y ∈ [0.02L, 1.02L]
 */
export const SWORD_ANCHORS = {
  /** 主手握点：靠护手一侧（双手握剑时主手在这） */
  grip: [0, -0.02, 0] as Vec3Tuple,
  /** 副手握点：靠柄尾一侧 */
  pommel: [0, -0.11, 0] as Vec3Tuple,
  /** 护手中心 */
  guard: [0, 0.065, 0] as Vec3Tuple,
} as const;

export interface SwordAnchorsWorld {
  grip: THREE.Vector3;
  pommel: THREE.Vector3;
  guard: THREE.Vector3;
  tip: THREE.Vector3;
}

/**
 * 由主手的世界变换求剑上各锚点的世界坐标。
 *
 * 刻意**不复用** WorldStage 里那个 group 对象：那条路径依赖渲染顺序
 * （必须等 R3F 的 useFrame 跑完），而这里只依赖主手 FK，顺序无关。
 *
 * 链路与 WorldStage.tsx:94-103 完全一致：attachOffset(手局部) → 手世界 → rotY → 锚点。
 */
export function swordAnchorsWorld(
  handBone: THREE.Bone,
  prop: Pick<StageProp, 'attachOffset' | 'rotationY' | 'size'>,
): SwordAnchorsWorld {
  handBone.updateWorldMatrix(true, false);
  const base = new THREE.Vector3(...(prop.attachOffset ?? [0, 0, 0])).applyMatrix4(handBone.matrixWorld);
  const rot = handBone.getWorldQuaternion(new THREE.Quaternion())
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY));
  const at = (local: Vec3Tuple): THREE.Vector3 => new THREE.Vector3(...local).applyQuaternion(rot).add(base);
  return {
    grip: at(SWORD_ANCHORS.grip),
    pommel: at(SWORD_ANCHORS.pommel),
    guard: at(SWORD_ANCHORS.guard),
    tip: at([0, prop.size.length * 1.02, 0]),
  };
}

/** 双手间距（世界米）：真实双手握剑两手沿柄距离约 9cm（含掌宽）。 */
export const TWO_HAND_SPAN_MIN = 0.05;
export const TWO_HAND_SPAN_MAX = 0.20;

/** 判断双手间距是否落在真实握剑范围内（供体检与测试）。 */
export function gripSpanIsPlausible(anchors: SwordAnchorsWorld): boolean {
  const span = anchors.grip.distanceTo(anchors.pommel);
  return span >= TWO_HAND_SPAN_MIN && span <= TWO_HAND_SPAN_MAX;
}

/**
 * 护手规格：主手目标相对**主肩**的偏移，**以臂长为单位**（故体型自适应）。
 *
 * 各分量含义（`forward` / `inward` 取角色朝向与中线，均按臂长归一）：
 *   forward — 身前距离倍率
 *   inward  — 向身体中线的内收倍率
 *   down    — 垂直下沉倍率
 *
 * 数值来自实测（demo rig，臂长 0.58m，目标手位中线偏右 6cm、胸腹之间、身前 35cm）：
 *   forward 0.60, inward 0.33, down 0.31 → 肩到手动伸率 0.75，肘内角约 135°（不锁死）。
 */
export interface SwordGuardSpec {
  forward: number;
  inward: number;
  down: number;
  /** 肘部朝向（相对世界）：默认肘下垂并略向外，避免顶胸 */
  poleOut: number;
  poleDown: number;
  /** 期望刃向，在朝向基里以「前/上/左」分量表示 */
  bladeFwd: number;
  bladeUp: number;
  bladeLeft: number;
}

/**
 * 护手（预备式）：双手握剑于身前中线，剑尖斜向前上。
 * 刃向 up 0.84 / fwd 0.54 ≈ 57° 上举，符合剑术预备式「剑尖指天」。
 */
export const GUARD_SPEC: SwordGuardSpec = {
  forward: 0.60, inward: 0.33, down: 0.31, poleOut: 0.30, poleDown: 0.62,
  bladeFwd: 0.54, bladeUp: 0.84, bladeLeft: 0,
};

/**
 * 出剑伸展：双手仍握住（实测柄尾偏差 14mm），手臂前送伸展率 0.881（肘微屈不锁死）。
 *
 * 刃向由「护手斜举」压向「前平举」，实测腕部需补 **26.3°**（在 ±60° 活动度内）。
 * 再往下压（如 bu=−0.4 的下劈）需 90° 以上腕旋转，**解剖上做不到** ——
 * 真实下劈靠的是肩+肘带动的挥击弧线，不是手腕。见 `aimHandBladeAxis` 的说明。
 */
export const STRIKE_SPEC: SwordGuardSpec = {
  forward: 0.68, inward: 0.40, down: 0.25, poleOut: 0.22, poleDown: 0.50,
  bladeFwd: 0.70, bladeUp: 0.60, bladeLeft: 0,
};

/** 剑的期望刃向（世界方向），由朝向基 + 规格求出。 */
export function guardBladeAxis(basis: FacingBasis, spec: SwordGuardSpec): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(basis.forward, spec.bladeFwd)
    .addScaledVector(basis.up, spec.bladeUp)
    .addScaledVector(basis.left, spec.bladeLeft)
    .normalize();
}

/**
 * 腕部定向：把手掌局部 +Y（= 剑刃向）转到期望方向。
 *
 * ## 为什么必须补这一步
 *
 * `applyIKChain` **只解位置，不管末端朝向**（applyIK.ts:45-46）。
 * 而剑的世界朝向 = 手的世界四元数（WorldStage.tsx:102）。
 * 于是剑刃指向是手臂 IK 的**副产品**：实测 STRIKE_SPEC 下副手偏差 **13.9cm**，
 * 因为手臂伸展后手腕翻向不明，剑柄尾落到了够不到的位置。
 *
 * 解法在解剖上成立：**手腕本来就会转**。这里做的正是一次手腕旋转，
 * 只动 Hand 骨、不动前臂，所以手臂解出的位置不受影响。
 *
 * ## 为什么必须钳制
 *
 * 手腕不是球关节。自由旋转会让手以不可能的角度折断，
 * 故按真实活动度分解为「摆动(swing)」与「轴向扭转(twist)」后分别钳制：
 * 摆动 ±60°、扭转 ±80°。达不到期望刃向时返回**实际达成的**方向，
 * 由调用方决定是否接受，而不是硬掰。
 *
 * @param forearm 父骨（前臂），用于求旋转轴
 * @returns 实际达成的刃向（世界坐标，单位向量）
 */
export function aimHandBladeAxis(
  handBone: THREE.Bone,
  forearm: THREE.Bone,
  desiredAxis: THREE.Vector3,
  maxSwingDeg = 60,
  maxTwistDeg = 80,
): THREE.Vector3 {
  // 父子关系是本函数的前提：Hand 必须直接挂在 Forearm 上，否则旋转轴无意义。
  // 这里显式校验而不是默默用 handBone.parent，让错误在调用处暴露。
  if (handBone.parent !== forearm) return currentAxisOf(handBone);
  handBone.updateWorldMatrix(true, false);
  forearm.updateWorldMatrix(true, false);

  const handPos = handBone.getWorldPosition(new THREE.Vector3());
  const curAxis = currentAxisOf(handBone);
  const desired = desiredAxis.clone().normalize();

  if (curAxis.dot(desired) > 1 - 1e-8) return curAxis.clone();

  // 世界系里需要的旋转
  const qWorld = new THREE.Quaternion().setFromUnitVectors(curAxis, desired);
  // 换算到前臂局部系（Hand 是 Forearm 的子骨，局部四元数要乘在左边）
  const forearmQ = forearm.getWorldQuaternion(new THREE.Quaternion());
  const qLocal = forearmQ.clone().invert().multiply(qWorld).multiply(forearmQ);

  // 旋转轴 = 前臂指向手腕的方向（换算到 Hand 的局部系）
  const forearmPos = forearm.getWorldPosition(new THREE.Vector3());
  const axisWorld = handPos.clone().sub(forearmPos).normalize();
  const axis = axisWorld.clone()
    .applyQuaternion(handBone.getWorldQuaternion(new THREE.Quaternion()).invert())
    .normalize();

  // swing-twist 分解
  const twistRad = 2 * Math.atan2(new THREE.Vector3(qLocal.x, qLocal.y, qLocal.z).dot(axis), qLocal.w);
  const twist = new THREE.Quaternion().setFromAxisAngle(axis, clampRad(twistRad, maxTwistDeg));
  const swing = qLocal.clone().multiply(twist.clone().invert());
  const swingAxis = new THREE.Vector3(swing.x, swing.y, swing.z);
  const swingLen = swingAxis.length();
  const swingClamped = swingLen < 1e-8
    ? new THREE.Quaternion()
    : new THREE.Quaternion().setFromAxisAngle(
        swingAxis.normalize(),
        clampRad(2 * Math.atan2(swingLen, Math.abs(swing.w)), maxSwingDeg),
      );

  handBone.quaternion.premultiply(swingClamped.multiply(twist));

  handBone.updateWorldMatrix(true, false);
  return currentAxisOf(handBone);
}

/** 手掌局部 +Y（即剑刃轴）在世界系下的方向。 */
function currentAxisOf(handBone: THREE.Bone): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0)
    .applyQuaternion(handBone.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
}

const clampRad = (rad: number, maxDeg: number): number =>
  Math.max(-THREE.MathUtils.degToRad(maxDeg), Math.min(THREE.MathUtils.degToRad(maxDeg), rad));

/**
 * 角色朝向基。
 *
 * ## 为什么不能假设「面朝 +Z」
 *
 * 先测过 `forward = normalize(shoulder − hips)`：两肩水平投影与髋重合，
 * 该向量只剩**侧向**，forward 退化成 −X（实测 `target.z == 0`）。
 * 「角色面朝 +Z」只是本项目 demo rig 的约定，导入的骨骼不一定如此。
 *
 * ## 解法：由解剖定，不靠命名约定
 *
 * 右手系里，若角色面朝 `f`、上方为 `u`，则**角色左侧 = u × f**。
 * 反解即 `f = left × u`。而「哪侧是左」是语义层已经判定好的
 * （rigDetect 的 L/R 识别），不是命名约定，所以这条式子对任意导入骨骼成立。
 *
 * demo rig 自检：left = L−R = (1,0,0)，up = (0,1,0) → forward = (1,0,0)×(0,1,0) = (0,0,1) ✓
 */
export interface FacingBasis {
  forward: THREE.Vector3;
  left: THREE.Vector3;
  up: THREE.Vector3;
}

export function facingBasis(
  leftShoulder: THREE.Vector3,
  rightShoulder: THREE.Vector3,
  up: THREE.Vector3,
): FacingBasis {
  const left = leftShoulder.clone().sub(rightShoulder);
  const u = up.clone();
  if (left.lengthSq() < 1e-8 || u.lengthSq() < 1e-8) {
    return {
      forward: new THREE.Vector3(0, 0, 1),
      left: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
    };
  }
  left.normalize();
  u.normalize();
  return { forward: new THREE.Vector3().crossVectors(left, u).normalize(), left, up: u };
}

/**
 * 由护手规格求主手世界目标点。
 *
 * @param shoulder 主肩世界位置
 * @param armLength 主臂长（上臂+前臂，IK 可达半径）
 * @param basis    角色朝向基（由左右肩与脊柱方向定）
 * @param midline  身体中线（两肩中点），用于算「向内收」
 */
export function guardTarget(
  shoulder: THREE.Vector3,
  armLength: number,
  basis: FacingBasis,
  midline: THREE.Vector3,
  spec: SwordGuardSpec,
): THREE.Vector3 {
  // 内收方向：水平面上由肩指向中线
  const inward = new THREE.Vector3(midline.x - shoulder.x, 0, midline.z - shoulder.z);
  if (inward.lengthSq() < 1e-8) inward.copy(basis.left).negate();
  else inward.normalize();
  return shoulder.clone()
    .addScaledVector(basis.forward, spec.forward * armLength)
    .addScaledVector(inward, spec.inward * armLength)
    .addScaledVector(basis.up, -spec.down * armLength);
}

/**
 * 副手的 IK 目标点。
 *
 * 取柄尾锚点会把手腕中心放上去，但握拳时手掌在手腕前方约一手长，
 * 所以沿柄向主手方向回退一点，落在「手握住柄尾」该在的位置。
 */
export function offHandGripTarget(anchors: SwordAnchorsWorld): THREE.Vector3 {
  return anchors.pommel.clone().lerp(anchors.grip, 0.15);
}

/** 持剑站姿（真实剑术的预备式），单位度/米。 */
export interface SwordStance {
  /** 后脚后撤量（米，沿角色 -Z） */
  backFootZ: number;
  /** 前脚前移量（米，沿角色 +Z） */
  frontFootZ: number;
  /** 双膝屈曲（度） */
  kneeBend: number;
  /** 髋部下沉（米） */
  hipDrop: number;
  /** 躯干朝目标侧拧（度） */
  torsoYaw: number;
}

/**
 * 默认持剑站姿：前脚承重约六成，膝微屈，双脚前后开立，躯干侧向前脚。
 *
 * 髋部下沉与双脚开立量随腿长缩放（见 `scaleStanceToLeg`），
 * 具体角度属**待实机校准**的量；验收看的是「双脚开立 + 膝不锁死 + 髋下沉」。
 */
export const DEFAULT_SWORD_STANCE: SwordStance = {
  backFootZ: -0.22,
  frontFootZ: 0.16,
  kneeBend: 20,
  hipDrop: 0.05,
  torsoYaw: 18,
};

/**
 * 把站姿按腿长缩放，使高矮胖瘦角色都得到同比例的开立与下沉。
 *
 * 与 `gaits.ts` 的腿长缩放同一原则：写死米数会让 1.6m 与 1.9m 的角色
 * 一个劈叉、一个没站稳。
 */
export function scaleStanceToLeg(stance: SwordStance, legLength: number): SwordStance {
  const k = legLength / 0.86;
  return {
    ...stance,
    backFootZ: stance.backFootZ * k,
    frontFootZ: stance.frontFootZ * k,
    hipDrop: stance.hipDrop * k,
  };
}