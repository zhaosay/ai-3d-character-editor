import type { HumanoidSemantic } from './types';

/**
 * 骨骼名自动识别（独立纯函数，可单测）。
 *
 * 原实现是一堆「单条正则按顺序试」，实测在 VRoid / Rigify / CC4 / Unity 上大面积错判
 * （例如 `mixamorig:Spine2` 被 spine 规则吃掉导致 chest 缺失）。
 *
 * 改为三步判定，顺序不可调换：
 *   1. normalize  剥掉命名空间/序号/前缀，得到可比对的关键词
 *   2. side       独立解析左右（`.L` / `_l` / `Left` / `1` / `-1` / `l_`）
 *   3. part       用「部位关键词 + 是否手/腿末端」消歧，单股优先于双臂
 */

/** 部位关键词 → 语义模板。`L/R` 由 side 填充；无侧别的（躯干）直接用。 */
const PART_RULES: Array<{ re: RegExp; part: string }> = [
  { re: /hips|pelvis|^hip$|root/i, part: 'hips' },
  { re: /chest|upper.?chest|thorax|rib.?cage/i, part: 'chest' },
  { re: /spine/i, part: 'spine' },
  { re: /neck/i, part: 'neck' },
  { re: /head/i, part: 'head' },
  { re: /shoulder|clavicle|collar/i, part: 'shoulder' },
  // 上臂：显式 upper，或去掉侧别后剩余恰为 arm（LeftArm / Arm.L）
  { re: /upper.?arm|uparm|shoulder.?arm/i, part: 'upperArm' },
  { re: /fore.?arm|lower.?arm|elbow/i, part: 'forearm' },
  { re: /hand|palm|wrist/i, part: 'hand' },
  { re: /upper.?leg|upleg|thigh/i, part: 'thigh' },
  { re: /lower.?leg|downleg|calf|shin/i, part: 'shin' },
  { re: /foot|feet|ankle|ball|toe/i, part: 'foot' },
];

/**
 * 侧别剥离后的「剩余名」部位判定。
 * 处理 `LeftArm` / `Arm.L` 这类**没有 upper/lower 前缀**的命名 ——
 * 这在 Mixamo/VRoid/Quaternius 里都是主力写法，只靠 PART_RULES 会漏掉。
 */
const BARE_PART: Array<{ re: RegExp; part: string }> = [
  { re: /^arm$|^arms$|^\w*arm$/i, part: 'upperArm' },
  { re: /^(up)?leg$|^legs$/i, part: 'thigh' },
];

/** 需要「末端」消歧的部位：foot 与 shin 容易互相命中。 */
const TERMINAL_HINTS = /(foot|feet|ankle|ball|toe)/i;

/**
 * 解析左右侧别。
 *
 * 必须处理「侧别紧贴其它字母」的写法（`LeftArm`、`Bip_L_UpperArm`、`R_UpperArm`），
 * 用词边界会全漏。同时要避免 `Right` 里的 `l` 被误判成左 —— 故先查 right 再查 left，
 * 且 right 用整词 `right` 而非裸 `r`，left 用 `\bl\b` 类边界或 `.l`/`_l` 后缀。
 */
function detectSide(normalized: string): 'L' | 'R' | null {
  const lower = normalized.toLowerCase();
  // 明确的单词形式：Left / Right（任意位置）
  if (/right/.test(lower)) return 'R';
  if (/left/.test(lower)) return 'L';
  // 单字母侧别：`.L` `_L` `L_` 前缀，或结尾 `-L` `/L`
  if (/(^|[.\-_:/])l($|[.\-_:/])/i.test(normalized)) return 'L';
  if (/(^|[.\-_:/])r($|[.\-_:/])/i.test(normalized)) return 'R';
  // 裸前缀 L_ / R_（如 J_Bip_L_UpperArm 已被上面 left/right 覆盖，这里兜底）
  if (/^l[_]/i.test(normalized)) return 'L';
  if (/^r[_]/i.test(normalized)) return 'R';
  // 数字侧别：1=左 2=右（部分 DCC 约定）
  if (/(^|[.\-_:/])0*1$/.test(normalized)) return 'L';
  if (/(^|[.\-_:/])0*2$/.test(normalized)) return 'R';
  return null;
}

/** 剥掉命名空间前缀与数字后缀，保留可读关键词。 */
function normalize(boneName: string): string {
  return boneName
    .replace(/^mixamorig[:_]?/i, '')
    .replace(/^skeleton_/i, '')                      // CesiumMan: Skeleton_torso_joint_1
    .replace(/^J_(?:Bip|Bip_C)_/i, 'J_')          // VRoid: J_Bip_C_Hips → J_Hips
    .replace(/^(?:CC_Base_|cc_base_)/i, '')
    .replace(/^DEF-/i, '')
    .replace(/^bone[._-]/i, 'bone')
    .replace(/[._]\d{2,}$/, '')                     // Spine.003 → Spine
    .replace(/[\s_]+(bone|bone\d*)$/i, '')
    .replace(/[-_](twist|roll|propagator)([._]\d+)?$/i, '')
    .replace(/[._]\d+$/, '')                        // spine_01 → spine
    .trim();
}

/** 躯干语义（无侧别）。 */
const TORSO: Record<string, HumanoidSemantic> = {
  hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head',
};

/** 侧别 × 部位 → 语义。 */
const LIMB: Record<'L' | 'R', Record<string, HumanoidSemantic>> = {
  L: {
    shoulder: 'shoulder.L', upperArm: 'upperArm.L', forearm: 'forearm.L', hand: 'hand.L',
    thigh: 'thigh.L', shin: 'shin.L', foot: 'foot.L',
  },
  R: {
    shoulder: 'shoulder.R', upperArm: 'upperArm.R', forearm: 'forearm.R', hand: 'hand.R',
    thigh: 'thigh.R', shin: 'shin.R', foot: 'foot.R',
  },
};

/**
 * 从骨骼名推断语义。无法确定时返回 null（UI 显示"未映射"，不阻塞加载）。
 *
 * 注意：单侧模型（无左右标记）不返回左右肢语义 —— 宁可留空让 IK 检测纠正，
 * 也不要猜错方向导致动作左右镜像。
 */
export function guessSemantic(boneName: string): HumanoidSemantic | null {
  if (typeof boneName !== 'string' || !boneName) return null;
  const normalized = normalize(boneName);

  /**
   * CesiumMan（Khronos glTF-Sample-Assets，本仓库 public/samples/CesiumMan.glb 实测）。
   * 必须在 normalize 之前判断 —— normalize 会剥掉 `_1`/`__2_` 这类尾部序号，
   * 而这里的语义**恰恰依赖序号**。
   * 实测骨骼层级：
   *   躯干  Skeleton_torso_joint_1/2 + torso_joint_3；Skeleton_neck_joint_1/2
   *   左臂  Skeleton_arm_joint_L__2_(手) → __3_(前臂) → __4_(上臂)
   *   右臂  Skeleton_arm_joint_R__3_(手) → __2_(前臂) → R(上臂)
   *   腿    leg_joint_L_1(大腿) → _2(小腿) → _3(脚)
   * 关键坑：**右臂数字与左臂相反**（2 是前臂而非手），且节点带 `Skeleton_` 前缀。
   */
  const raw = boneName.replace(/^skeleton_/i, '').toLowerCase();
  if (/^torso_joint_(\d+)$/.test(raw)) {
    const n = Number(/_(\d+)$/.exec(raw)![1]);
    return n === 1 ? 'hips' : n === 2 ? 'spine' : 'chest';
  }
  if (/^neck_joint_(\d+)$/.test(raw)) {
    return Number(/_(\d+)$/.exec(raw)![1]) === 1 ? 'neck' : 'head';
  }
  if (/^leg_joint_([lr])_(\d+)$/.test(raw)) {
    const side = /_l_/.test(raw) ? 'L' : 'R';
    const n = Number(/_(\d+)$/.exec(raw)![1]);
    return n === 1 ? LIMB[side].thigh : n === 2 ? LIMB[side].shin : LIMB[side].foot;
  }
  if (/^arm_joint_l__(\d+)_$/.test(raw)) {
    const n = Number(/__(\d+)_$/.exec(raw)![1]);
    return n === 4 ? LIMB.L.upperArm : n === 3 ? LIMB.L.forearm : LIMB.L.hand;
  }
  if (/^arm_joint_r(?:__(\d+)_)?$/.test(raw)) {
    const n = Number(/__(\d+)_$/.exec(raw)?.[1] ?? '4');
    return n === 4 ? LIMB.R.upperArm : n === 3 ? LIMB.R.hand : LIMB.R.forearm;
  }

  /**
   * Mixamo/Quaternius 腿部命名特例：`UpLeg`=大腿、`Leg`=**小腿**。
   * 光看 `Leg` 无法区分大腿/小腿，必须按 UpLeg 有无来判。
   * 无侧别的裸 `Leg` 仍返回 null —— 交给 IK 检测纠正，不猜方向。
   */
  if (/^(left|right)?(up)?legs?$/i.test(normalized)) {
    const side = detectSide(normalized);
    if (!side) return null;
    return /up/i.test(normalized) ? LIMB[side].thigh : LIMB[side].shin;
  }

  /**
   * 多段脊柱按序号分配：spine / spine1=spine、spine2/02=chest、spine3+/03+=spine。
   * 必须在 normalize 剥掉序号之前判断（normalize 后都变成 spine）。
   * 序号约定不统一（有的从 0 起、有的从 1 起），故只认「明确等于 2」为 chest，
   * 其余仍归 spine —— 猜错的代价（胸腔错位）高于漏判。
   */
  if (/spine/i.test(boneName) && !/lower|upper/i.test(boneName)) {
    const tail = /spine[._-]?0*(\d+)$/i.exec(boneName);
    if (tail) {
      const n = Number(tail[1]);
      // 0/1 = 下段脊柱(spine)，2 = 中段(chest)，3+ = 上段脊柱
      if (n <= 1) return 'spine';
      if (n === 2) return 'chest';
      if (n >= 3) return 'spine';
    }
  }

  // 部位判定
  const side = detectSide(normalized);
  let part = PART_RULES.find((r) => r.re.test(normalized))?.part;
  if (!part && side) {
    // 剥掉侧别标记后再判部位（LeftArm → arm → upperArm）
    const stripped = normalized
      .replace(/left/gi, '')
      .replace(/right/gi, '')
      .replace(/[.\-_:/]?[lr](?=[.\-_:/]|$)/gi, '')
      .replace(/^[_\-.]+|[_\-.]+$/g, '')
      .trim();
    part = PART_RULES.find((r) => r.re.test(stripped))?.part
      ?? BARE_PART.find((r) => r.re.test(stripped))?.part;
  }
  if (!part) return null;

  // 躯干
  if (TORSO[part]) return TORSO[part];
  if (!side) return null;

  // foot / shin 消歧：出现终端词时优先判 foot
  if ((part === 'foot' || part === 'shin') && TERMINAL_HINTS.test(normalized)) {
    return LIMB[side].foot;
  }
  return LIMB[side][part] ?? null;
}

/** 识别结果的置信度：用于 UI 提示与骨架诊断。 */
export type RigConfidence = 'certain' | 'heuristic' | 'none';

export interface RigSuggestion {
  /** 语义 → 建议的骨骼名 */
  map: Partial<Record<HumanoidSemantic, string>>;
  /** 未能识别的骨骼名 */
  unmapped: string[];
  confidence: RigConfidence;
  /** 核心语义缺失列表（缺这些则动作模板基本不可用） */
  missingCore: HumanoidSemantic[];
}

/**
 * 核心语义：缺了它们 IK 与大部分模板都不可用。
 * 动作库绑定诊断（motionLibrary.diagnoseMotionBind）复用同一份，避免两处漂移。
 */
export const CORE_SEMANTICS: readonly HumanoidSemantic[] = [
  'hips', 'spine', 'head',
  'upperArm.L', 'upperArm.R', 'forearm.L', 'forearm.R',
  'thigh.L', 'thigh.R', 'shin.L', 'shin.R',
] as const;

/**
 * 对整个骨架做识别，产出建议映射与诊断。
 *
 * 同名多骨（如 `Spine`/`Spine1`/`Spine2` 都判为 spine）时**取第一条**，
 * 并把整体置信度降级为 heuristic —— 提示用户复核而不是假装确定。
 */
export function suggestHumanoidRig(boneNames: string[]): RigSuggestion {
  const map: Partial<Record<HumanoidSemantic, string>> = {};
  const unmapped: string[] = [];
  const claimed = new Map<HumanoidSemantic, number>();

  for (const name of boneNames) {
    const semantic = guessSemantic(name);
    if (!semantic) {
      unmapped.push(name);
      continue;
    }
    if (map[semantic]) {
      // 同一语义命中多次（如多段脊柱）：记录争用，降低置信度
      claimed.set(semantic, (claimed.get(semantic) ?? 1) + 1);
      continue;
    }
    map[semantic] = name;
  }

  const missingCore = CORE_SEMANTICS.filter((s) => !map[s]);
  const confidence: RigConfidence =
    unmapped.length === 0 && claimed.size === 0 && missingCore.length === 0
      ? 'certain'
      : missingCore.length > 0 ? 'none' : 'heuristic';

  return { map, unmapped, confidence, missingCore };
}
