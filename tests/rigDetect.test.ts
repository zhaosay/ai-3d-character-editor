import { describe, expect, it } from 'vitest';
import { guessSemantic } from '../src/core/skeleton/humanoidMap';
import { suggestHumanoidRig } from '../src/core/skeleton/rigDetect';
import type { HumanoidSemantic } from '../src/core/skeleton/types';

/**
 * 真实骨架家族样本。用它们守住「换了陌生 GLB 仍能自动绑定」这条底线 ——
 * 之前的单条正则实现在 VRoid/Rigify/CC4/Unity 上大面积错判。
 */
const FAMILIES: Array<{ name: string; bones: Array<[string, HumanoidSemantic]> }> = [
  {
    name: 'Mixamo',
    bones: [
      ['mixamorig:Hips', 'hips'], ['mixamorig:Spine', 'spine'], ['mixamorig:Spine2', 'chest'],
      ['mixamorig:Neck', 'neck'], ['mixamorig:Head', 'head'],
      ['mixamorig:LeftArm', 'upperArm.L'], ['mixamorig:LeftForeArm', 'forearm.L'], ['mixamorig:LeftHand', 'hand.L'],
      ['mixamorig:RightArm', 'upperArm.R'], ['mixamorig:RightForeArm', 'forearm.R'], ['mixamorig:RightHand', 'hand.R'],
      // Mixamo 特例：UpLeg=大腿，Leg=小腿
      ['mixamorig:LeftUpLeg', 'thigh.L'], ['mixamorig:LeftLeg', 'shin.L'], ['mixamorig:LeftFoot', 'foot.L'],
      ['mixamorig:RightUpLeg', 'thigh.R'], ['mixamorig:RightLeg', 'shin.R'], ['mixamorig:RightFoot', 'foot.R'],
    ],
  },
  {
    name: 'VRoid',
    bones: [
      ['J_Bip_C_Hips', 'hips'], ['J_Bip_C_Spine', 'spine'], ['J_Bip_C_Chest', 'chest'],
      ['J_Bip_C_Neck', 'neck'], ['J_Bip_C_Head', 'head'],
      ['J_Bip_L_UpperArm', 'upperArm.L'], ['J_Bip_L_LowerArm', 'forearm.L'], ['J_Bip_L_Hand', 'hand.L'],
      ['J_Bip_R_UpperArm', 'upperArm.R'], ['J_Bip_R_LowerArm', 'forearm.R'], ['J_Bip_R_Hand', 'hand.R'],
      ['J_Bip_L_UpperLeg', 'thigh.L'], ['J_Bip_L_LowerLeg', 'shin.L'], ['J_Bip_L_Foot', 'foot.L'],
      ['J_Bip_R_UpperLeg', 'thigh.R'], ['J_Bip_R_LowerLeg', 'shin.R'], ['J_Bip_R_Foot', 'foot.R'],
    ],
  },
  {
    name: 'Rigify',
    bones: [
      // Rigify 躯干是 spine 链 + 独立 chest/neck/head 骨。
      // 链上多段（.001/.004）无法可靠区分 spine 与 chest，保守归 spine 并由
      // suggestHumanoidRig 降级置信度提示复核 —— 猜错胸腔位置的代价高于漏判。
      ['DEF-spine', 'spine'], ['DEF-spine.001', 'spine'], ['DEF-spine.004', 'spine'],
      ['DEF-chest', 'chest'], ['DEF-neck', 'neck'], ['DEF-head', 'head'],
      ['DEF-upper_arm.L', 'upperArm.L'], ['DEF-forearm.L', 'forearm.L'], ['DEF-hand.L', 'hand.L'],
      ['DEF-upper_arm.R', 'upperArm.R'], ['DEF-forearm.R', 'forearm.R'], ['DEF-hand.R', 'hand.R'],
      ['DEF-thigh.L', 'thigh.L'], ['DEF-shin.L', 'shin.L'], ['DEF-foot.L', 'foot.L'],
      ['DEF-thigh.R', 'thigh.R'], ['DEF-shin.R', 'shin.R'], ['DEF-foot.R', 'foot.R'],
    ],
  },
  {
    name: 'Character Creator 4',
    bones: [
      ['CC_Base_Hips', 'hips'], ['CC_Base_Spine01', 'spine'], ['CC_Base_Spine02', 'chest'],
      ['CC_Base_Neck', 'neck'], ['CC_Base_Head', 'head'],
      ['CC_Base_LeftShoulder', 'shoulder.L'], ['CC_Base_LeftArm', 'upperArm.L'],
      ['CC_Base_LeftForearm', 'forearm.L'], ['CC_Base_LeftHand', 'hand.L'],
      ['CC_Base_RightArm', 'upperArm.R'], ['CC_Base_RightForearm', 'forearm.R'], ['CC_Base_RightHand', 'hand.R'],
      ['CC_Base_LeftUpLeg', 'thigh.L'], ['CC_Base_LeftLeg', 'shin.L'], ['CC_Base_LeftFoot', 'foot.L'],
      ['CC_Base_RightUpLeg', 'thigh.R'], ['CC_Base_RightLeg', 'shin.R'], ['CC_Base_RightFoot', 'foot.R'],
    ],
  },
  {
    name: 'Unity / Unreal',
    bones: [
      ['pelvis', 'hips'], ['spine_01', 'spine'], ['spine_02', 'chest'],
      ['neck_01', 'neck'], ['head', 'head'],
      ['upperarm_l', 'upperArm.L'], ['lowerarm_l', 'forearm.L'], ['hand_l', 'hand.L'],
      ['upperarm_r', 'upperArm.R'], ['lowerarm_r', 'forearm.R'], ['hand_r', 'hand.R'],
      ['thigh_l', 'thigh.L'], ['calf_l', 'shin.L'], ['ball_l', 'foot.L'],
      ['thigh_r', 'thigh.R'], ['calf_r', 'shin.R'], ['ball_r', 'foot.R'],
    ],
  },
  {
    name: 'Quaternius（内置动作库）',
    bones: [
      ['hips', 'hips'], ['spine', 'spine'], ['chest', 'chest'], ['neck', 'neck'], ['head', 'head'],
      ['leftUpperArm', 'upperArm.L'], ['leftLowerArm', 'forearm.L'], ['leftHand', 'hand.L'],
      ['rightUpperArm', 'upperArm.R'], ['rightLowerArm', 'forearm.R'], ['rightHand', 'hand.R'],
      ['leftUpperLeg', 'thigh.L'], ['leftLowerLeg', 'shin.L'], ['leftFoot', 'foot.L'],
      ['rightUpperLeg', 'thigh.R'], ['rightLowerLeg', 'shin.R'], ['rightFoot', 'foot.R'],
    ],
  },
  {
    // 节点名与层级取自本仓库 public/samples/CesiumMan.glb 实测，非记忆。
    name: 'CesiumMan',
    bones: [
      ['Skeleton_torso_joint_1', 'hips'], ['Skeleton_torso_joint_2', 'spine'], ['torso_joint_3', 'chest'],
      ['Skeleton_neck_joint_1', 'neck'], ['Skeleton_neck_joint_2', 'head'],
      // 左臂：L__2_=手 → L__3_=前臂 → L__4_=上臂
      ['Skeleton_arm_joint_L__4_', 'upperArm.L'], ['Skeleton_arm_joint_L__3_', 'forearm.L'], ['Skeleton_arm_joint_L__2_', 'hand.L'],
      // 右臂数字相反：R=上臂 → R__2_=前臂 → R__3_=手
      ['Skeleton_arm_joint_R', 'upperArm.R'], ['Skeleton_arm_joint_R__2_', 'forearm.R'], ['Skeleton_arm_joint_R__3_', 'hand.R'],
      ['leg_joint_L_1', 'thigh.L'], ['leg_joint_L_2', 'shin.L'], ['leg_joint_L_3', 'foot.L'],
      ['leg_joint_R_1', 'thigh.R'], ['leg_joint_R_2', 'shin.R'], ['leg_joint_R_3', 'foot.R'],
    ],
  },
];

describe('骨骼名自动识别（多家族）', () => {
  for (const family of FAMILIES) {
    it(`${family.name}：全部正确`, () => {
      const wrong = family.bones.filter(([name, want]) => guessSemantic(name) !== want)
        .map(([name, want]) => `${name} → ${guessSemantic(name)}（期望 ${want}）`);
      expect(wrong, `${family.name} 识别错误：\n  ${wrong.join('\n  ')}`).toEqual([]);
    });
  }
});

describe('无法识别时返回 null（不猜）', () => {
  it('纯编号骨骼不臆测', () => {
    for (const n of ['Bone.001', 'Bone.002', 'joint042', 'Object7', 'node_12']) {
      expect(guessSemantic(n), `${n} 不应被识别`).toBeNull();
    }
  });

  it('无侧别的肢体名不臆测左右', () => {
    // 单侧模型交给 IK 检测纠正，比猜错方向安全
    expect(guessSemantic('Arm')).toBeNull();
    expect(guessSemantic('Leg')).toBeNull();
  });

  it('非字符串输入安全返回 null', () => {
    expect(guessSemantic('' as unknown as string)).toBeNull();
    expect(guessSemantic(undefined as unknown as string)).toBeNull();
  });
});

describe('左右不混淆', () => {
  it('RightXxx 不被判成左', () => {
    expect(guessSemantic('RightArm')).toBe('upperArm.R');
    expect(guessSemantic('arm.R')).toBe('upperArm.R');
    expect(guessSemantic('J_Bip_R_UpperArm')).toBe('upperArm.R');
  });

  it('同一部位不同侧得到不同语义', () => {
    expect(guessSemantic('thigh_l')).not.toBe(guessSemantic('thigh_r'));
  });
});

describe('suggestHumanoidRig 骨架诊断', () => {
  it('完整骨架 → certain，核心无缺失', () => {
    const names = FAMILIES[4].bones.map(([n]) => n);
    const r = suggestHumanoidRig(names);
    expect(r.missingCore).toEqual([]);
    expect(r.map.hips).toBe('pelvis');
    expect(r.confidence).toBe('certain');
  });

  it('缺失核心语义 → none 并点名', () => {
    const r = suggestHumanoidRig(['pelvis', 'spine_01', 'head']);
    expect(r.confidence).toBe('none');
    expect(r.missingCore).toContain('upperArm.L');
    expect(r.missingCore).toContain('thigh.R');
  });

  it('有未识别骨骼 → heuristic（提示复核，不假装确定）', () => {
    const r = suggestHumanoidRig(['pelvis', 'spine_01', 'spine_02', 'neck_01', 'head', 'weird_bone']);
    expect(r.unmapped).toContain('weird_bone');
  });

  it('同一语义多次命中（多段脊柱）→ 取第一条且降级置信度', () => {
    const r = suggestHumanoidRig(['spine', 'spine.001', 'spine.003', 'spine2']);
    expect(r.map.spine).toBeDefined();
    expect(r.confidence).not.toBe('certain');
  });

  it('空骨架不崩', () => {
    const r = suggestHumanoidRig([]);
    expect(r.map).toEqual({});
    expect(r.confidence).toBe('none');
  });
});
