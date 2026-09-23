import type { HumanoidSemantic } from './types';

const RULES: Array<{ re: RegExp; semantic: HumanoidSemantic }> = [
  { re: /pelvis|hips|^hip$/i, semantic: 'hips' },
  { re: /spine(?!.*chest)/i, semantic: 'spine' },
  { re: /chest|upper.?chest|thorax/i, semantic: 'chest' },
  { re: /^neck/i, semantic: 'neck' },
  { re: /head(?!.*tip)/i, semantic: 'head' },
  { re: /shoulder.*\.?l|left.?shoulder|shoulderl/i, semantic: 'shoulder.L' },
  { re: /shoulder.*\.?r|right.?shoulder|shoulderr/i, semantic: 'shoulder.R' },
  { re: /upper.?arm.*\.?l|left.?(upper.?arm|shoulder.?arm)|upperarml|mixamo.*:leftarm\b/i, semantic: 'upperArm.L' },
  { re: /upper.?arm.*\.?r|right.?(upper.?arm)/i, semantic: 'upperArm.R' },
  { re: /forearm.*\.?l|left.?(forearm|elbow)|forearml/i, semantic: 'forearm.L' },
  { re: /forearm.*\.?r|right.?(forearm)/i, semantic: 'forearm.R' },
  { re: /hand.*\.?l|left.?hand|handl|wrist.*l/i, semantic: 'hand.L' },
  { re: /hand.*\.?r|right.?hand|handr|wrist.*r/i, semantic: 'hand.R' },
  { re: /thigh.*\.?l|left.?(thigh|upper.?leg)|upperlegl/i, semantic: 'thigh.L' },
  { re: /thigh.*\.?r|right.?(thigh)/i, semantic: 'thigh.R' },
  { re: /shin.*\.?l|calf.*\.?l|lower.?leg.*\.?l|left.?(shin|knee)/i, semantic: 'shin.L' },
  { re: /shin.*\.?r|calf.*\.?r|lower.?leg.*\.?r|right.?(shin)/i, semantic: 'shin.R' },
  // 回退：无左右后缀的小腿/脚命名（单侧模型），默认判左，由 IK 检测纠正
  { re: /^shin\b|\bcalf\b/i, semantic: 'shin.L' },
  { re: /foot.*\.?l|left.?(foot|ankle)/i, semantic: 'foot.L' },
  { re: /foot.*\.?r|right.?(foot)/i, semantic: 'foot.R' },
];

// Mixamo 形如 mixamorigLeftArm / mixamorig:Hips 的回退规则
const MIXAMO_FALLBACK: Array<{ re: RegExp; semantic: HumanoidSemantic }> = [
  { re: /leftarm$/i, semantic: 'upperArm.L' },
  { re: /rightarm$/i, semantic: 'upperArm.R' },
  { re: /leftforearm$/i, semantic: 'forearm.L' },
  { re: /rightforearm$/i, semantic: 'forearm.R' },
  { re: /lefthand$/i, semantic: 'hand.L' },
  { re: /righthand$/i, semantic: 'hand.R' },
  { re: /leftupleg$/i, semantic: 'thigh.L' },
  { re: /rightupleg$/i, semantic: 'thigh.R' },
  { re: /leftleg$/i, semantic: 'shin.L' },
  { re: /rightleg$/i, semantic: 'shin.R' },
  { re: /leftfoot$/i, semantic: 'foot.L' },
  { re: /rightfoot$/i, semantic: 'foot.R' },
  // 单侧模型默认
  { re: /^(shin|calf)\b/i, semantic: 'shin.L' },
  { re: /(foot|ankle)\b/i, semantic: 'foot.L' },
  { re: /hips$/i, semantic: 'hips' },
  { re: /spine\d*$/i, semantic: 'spine' },
  { re: /neck\d*$/i, semantic: 'neck' },
  { re: /head\d*$/i, semantic: 'head' },
];

/** 名称模糊匹配，失败返回 null（UI 显示"未映射"，不阻塞）。 */
export function guessSemantic(boneName: string): HumanoidSemantic | null {
  const normalized = boneName.replace(/^mixamorig[:_]?/i, '');
  for (const r of RULES) if (r.re.test(boneName) || r.re.test(normalized)) return r.semantic;
  for (const r of MIXAMO_FALLBACK) if (r.re.test(normalized)) return r.semantic;
  return null;
}
