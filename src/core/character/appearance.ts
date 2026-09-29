/**
 * 人物外观定制（纯模块，无 THREE 依赖，可单测）。
 * 只对程序化示例人物生效；外部 GLB 仅支持换色/换材质（见 core/theme）。
 */

/** 程序化人物静置身高（米），用作身高缩放基准。 */
export const BASE_HEIGHT = 1.845;

export type Gender = 'male' | 'female';
export type FaceShape = 'oval' | 'round' | 'square' | 'heart' | 'long';
export type HairStyle = 'bald' | 'buzz' | 'short' | 'bob' | 'long';

export interface Appearance {
  gender: Gender;
  /** 身高（米） */
  height: number;
  /** 体型：0=清瘦 1=壮实 */
  build: number;
  faceShape: FaceShape;
  eyeSize: number;
  browThickness: number;
  noseSize: number;
  mouthWidth: number;
  hairStyle: HairStyle;
  hairColor: string;
  skinColor: string;
  clothColor: string;
  /** 皮肤粗糙度：0.25=油亮 0.85=哑光 */
  skinRoughness: number;
}

export const RANGES = {
  height: { min: 1.55, max: 1.95 },
  build: { min: 0, max: 1 },
  eyeSize: { min: 0.7, max: 1.35 },
  browThickness: { min: 0.5, max: 1.6 },
  noseSize: { min: 0.6, max: 1.4 },
  mouthWidth: { min: 0.7, max: 1.35 },
  skinRoughness: { min: 0.25, max: 0.85 },
} as const;

export const DEFAULT_APPEARANCE: Appearance = {
  gender: 'male',
  height: 1.78,
  build: 0.4,
  faceShape: 'oval',
  eyeSize: 1,
  browThickness: 1,
  noseSize: 1,
  mouthWidth: 1,
  hairStyle: 'short',
  hairColor: '#241c18',
  skinColor: '#d0a080',
  clothColor: '#607979',
  skinRoughness: 0.62,
};

export function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

const GENDERS = ['male', 'female'] as const;
const FACES = ['oval', 'round', 'square', 'heart', 'long'] as const;
const HAIRS = ['bald', 'buzz', 'short', 'bob', 'long'] as const;

/** 规范化外观：非法枚举/颜色回退默认，数值钳制到范围。永远返回可安全使用的值。 */
export function clampAppearance(input: Partial<Appearance> | null | undefined): Appearance {
  const a = input ?? {};
  return {
    gender: oneOf(a.gender, GENDERS, DEFAULT_APPEARANCE.gender),
    height: clampNum(a.height, RANGES.height.min, RANGES.height.max, DEFAULT_APPEARANCE.height),
    build: clampNum(a.build, RANGES.build.min, RANGES.build.max, DEFAULT_APPEARANCE.build),
    faceShape: oneOf(a.faceShape, FACES, DEFAULT_APPEARANCE.faceShape),
    eyeSize: clampNum(a.eyeSize, RANGES.eyeSize.min, RANGES.eyeSize.max, DEFAULT_APPEARANCE.eyeSize),
    browThickness: clampNum(a.browThickness, RANGES.browThickness.min, RANGES.browThickness.max, DEFAULT_APPEARANCE.browThickness),
    noseSize: clampNum(a.noseSize, RANGES.noseSize.min, RANGES.noseSize.max, DEFAULT_APPEARANCE.noseSize),
    mouthWidth: clampNum(a.mouthWidth, RANGES.mouthWidth.min, RANGES.mouthWidth.max, DEFAULT_APPEARANCE.mouthWidth),
    hairStyle: oneOf(a.hairStyle, HAIRS, DEFAULT_APPEARANCE.hairStyle),
    hairColor: isValidHexColor(a.hairColor) ? a.hairColor : DEFAULT_APPEARANCE.hairColor,
    skinColor: isValidHexColor(a.skinColor) ? a.skinColor : DEFAULT_APPEARANCE.skinColor,
    clothColor: isValidHexColor(a.clothColor) ? a.clothColor : DEFAULT_APPEARANCE.clothColor,
    skinRoughness: clampNum(a.skinRoughness, RANGES.skinRoughness.min, RANGES.skinRoughness.max, DEFAULT_APPEARANCE.skinRoughness),
  };
}

export interface AppearanceFactors {
  /** 纵向缩放（身高） */
  heightScale: number;
  /** 横向/厚度缩放（体型） */
  girth: number;
  /** 头颈补偿缩放：头不该随身高等比放大 */
  headScale: number;
  headGirth: number;
  eyeScale: number;
  browScale: number;
  noseScale: number;
  mouthScale: number;
  /** 脸型轮廓半径修正 */
  faceProfile: { jaw: number; cheek: number; chin: number; temple: number };
}

/** 派生几何系数。纯函数，输入非法时先规范化。 */
export function buildFactors(input: Partial<Appearance> | null | undefined): AppearanceFactors {
  const a = clampAppearance(input);
  const heightScale = a.height / BASE_HEIGHT;
  // 体型：默认 build=0.4 为中性点(系数 1.0)，0→清瘦 1→壮实
  const girth = 1 + (a.build - 0.4) * 0.36;
  // 头只吸收 35% 的身高变化、30% 的体型变化，避免"巨人小头/巨头"
  const headScale = 1 + (heightScale - 1) * 0.35;
  const headGirth = 1 + (girth - 1) * 0.3;

  const face: Record<FaceShape, AppearanceFactors['faceProfile']> = {
    oval: { jaw: 1.0, cheek: 1.0, chin: 1.0, temple: 1.0 },
    round: { jaw: 1.12, cheek: 1.14, chin: 0.86, temple: 1.04 },
    square: { jaw: 1.16, cheek: 1.06, chin: 1.12, temple: 1.1 },
    heart: { jaw: 0.86, cheek: 1.08, chin: 1.02, temple: 1.0 },
    long: { jaw: 0.94, cheek: 0.92, chin: 1.08, temple: 0.94 },
  };

  return {
    heightScale,
    girth,
    headScale,
    headGirth,
    eyeScale: a.eyeSize,
    browScale: a.browThickness,
    noseScale: a.noseSize,
    mouthScale: a.mouthWidth,
    faceProfile: face[a.faceShape],
  };
}

export interface AppearancePreset {
  id: string;
  label: string;
  appearance: Appearance;
}

/** 预设：常见体型/发型的起手档位，非特定真人。 */
export const APPEARANCE_PRESETS: AppearancePreset[] = [
  { id: 'male-lean', label: '男·清瘦短发', appearance: { ...DEFAULT_APPEARANCE, gender: 'male', height: 1.76, build: 0.22, faceShape: 'long', eyeSize: 0.95, noseSize: 0.95, hairStyle: 'short' } },
  { id: 'male-steady', label: '男·标准寸头', appearance: { ...DEFAULT_APPEARANCE, gender: 'male', height: 1.8, build: 0.5, faceShape: 'square', eyeSize: 1, browThickness: 1.1, hairStyle: 'buzz', hairColor: '#1b1512' } },
  { id: 'male-broad', label: '男·高大壮实', appearance: { ...DEFAULT_APPEARANCE, gender: 'male', height: 1.9, build: 0.85, faceShape: 'square', browThickness: 1.25, hairStyle: 'bald', skinColor: '#b98a68' } },
  { id: 'female-standard', label: '女·标准中发', appearance: { ...DEFAULT_APPEARANCE, gender: 'female', height: 1.66, build: 0.35, faceShape: 'oval', eyeSize: 1.12, hairStyle: 'bob', clothColor: '#c7bba8', skinColor: '#d4aa8c' } },
  { id: 'female-long', label: '女·高挑长发', appearance: { ...DEFAULT_APPEARANCE, gender: 'female', height: 1.72, build: 0.28, faceShape: 'heart', eyeSize: 1.15, mouthWidth: 0.95, hairStyle: 'long', clothColor: '#8f7f9e', skinColor: '#dcb193' } },
  { id: 'female-athletic', label: '女·运动短发', appearance: { ...DEFAULT_APPEARANCE, gender: 'female', height: 1.7, build: 0.6, faceShape: 'square', browThickness: 0.85, eyeSize: 1.05, hairStyle: 'buzz', clothColor: '#5b6b74', skinColor: '#cfa384' } },
];

export function getPreset(id: string): Appearance | null {
  return APPEARANCE_PRESETS.find((p) => p.id === id)?.appearance ?? null;
}

/** 两个外观是否在可比较范围内相同（用于跳过无谓重建）。 */
export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return JSON.stringify(clampAppearance(a)) === JSON.stringify(clampAppearance(b));
}
