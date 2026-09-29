import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_PRESETS, BASE_HEIGHT, DEFAULT_APPEARANCE, RANGES, buildFactors,
  clampAppearance, getPreset, isValidHexColor, sameAppearance,
} from '../src/core/character/appearance';

describe('clampAppearance', () => {
  it('默认值合法且等于自身', () => {
    expect(clampAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(clampAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it('数值钳制到范围', () => {
    const a = clampAppearance({ ...DEFAULT_APPEARANCE, height: 99, build: -3, eyeSize: 0, skinRoughness: 5 });
    expect(a.height).toBe(RANGES.height.max);
    expect(a.build).toBe(RANGES.build.min);
    expect(a.eyeSize).toBe(RANGES.eyeSize.min);
    expect(a.skinRoughness).toBe(RANGES.skinRoughness.max);
  });

  it('NaN/Infinity 回退默认而非 0', () => {
    const a = clampAppearance({ ...DEFAULT_APPEARANCE, height: Number.NaN, build: Number.POSITIVE_INFINITY });
    expect(a.height).toBe(DEFAULT_APPEARANCE.height);
    expect(a.build).toBe(DEFAULT_APPEARANCE.build);
  });

  it('非法枚举/颜色回退默认', () => {
    const a = clampAppearance({
      ...DEFAULT_APPEARANCE,
      gender: 'alien' as never, faceShape: 'nope' as never, hairStyle: 'mohawk' as never,
      skinColor: 'red', hairColor: '#12345', clothColor: 123 as never,
    });
    expect(a.gender).toBe(DEFAULT_APPEARANCE.gender);
    expect(a.faceShape).toBe(DEFAULT_APPEARANCE.faceShape);
    expect(a.hairStyle).toBe(DEFAULT_APPEARANCE.hairStyle);
    expect(a.skinColor).toBe(DEFAULT_APPEARANCE.skinColor);
    expect(a.hairColor).toBe(DEFAULT_APPEARANCE.hairColor);
    expect(a.clothColor).toBe(DEFAULT_APPEARANCE.clothColor);
  });

  it('部分输入只覆盖给定字段', () => {
    expect(clampAppearance({ build: 0.9 })).toEqual({ ...DEFAULT_APPEARANCE, build: 0.9 });
  });
});

describe('isValidHexColor', () => {
  it('接受 6 位 hex，拒绝其它', () => {
    expect(isValidHexColor('#d0a080')).toBe(true);
    expect(isValidHexColor('#D0A080')).toBe(true);
    expect(isValidHexColor('#d0a08')).toBe(false);
    expect(isValidHexColor('d0a080')).toBe(false);
    expect(isValidHexColor('#d0a08g')).toBe(false);
    expect(isValidHexColor(0xd0a080)).toBe(false);
  });
});

describe('buildFactors', () => {
  it('默认身高 → 缩放 1', () => {
    const f = buildFactors({ ...DEFAULT_APPEARANCE, height: BASE_HEIGHT });
    expect(f.heightScale).toBeCloseTo(1, 6);
    expect(f.girth).toBeCloseTo(1, 6);
  });

  it('身高单调；体型单调', () => {
    const short = buildFactors({ ...DEFAULT_APPEARANCE, height: RANGES.height.min });
    const tall = buildFactors({ ...DEFAULT_APPEARANCE, height: RANGES.height.max });
    expect(short.heightScale).toBeLessThan(1);
    expect(tall.heightScale).toBeGreaterThan(1);
    expect(buildFactors({ ...DEFAULT_APPEARANCE, build: 0 }).girth)
      .toBeLessThan(buildFactors({ ...DEFAULT_APPEARANCE, build: 1 }).girth);
  });

  it('默认体型 → girth 1（基础网格就是中性体型）', () => {
    expect(buildFactors(DEFAULT_APPEARANCE).girth).toBeCloseTo(1, 6);
  });

  it('头颈吸收的比例小于身高/体型（避免巨人小头、巨头）', () => {
    const tall = buildFactors({ ...DEFAULT_APPEARANCE, height: 1.95 });
    expect(tall.headScale).toBeGreaterThan(1);
    expect(tall.headScale).toBeLessThan(tall.heightScale);
    const heavy = buildFactors({ ...DEFAULT_APPEARANCE, build: 1 });
    expect(heavy.headGirth).toBeGreaterThan(1);
    expect(heavy.headGirth).toBeLessThan(heavy.girth);
  });

  it('脸型轮廓可区分且均为正', () => {
    const shapes = ['oval', 'round', 'square', 'heart', 'long'] as const;
    const seen = new Set<string>();
    for (const faceShape of shapes) {
      const p = buildFactors({ ...DEFAULT_APPEARANCE, faceShape }).faceProfile;
      for (const v of Object.values(p)) expect(v).toBeGreaterThan(0);
      seen.add(JSON.stringify(p));
    }
    expect(seen.size).toBe(shapes.length);
  });

  it('眼/眉/鼻/嘴系数直传', () => {
    const f = buildFactors({ ...DEFAULT_APPEARANCE, eyeSize: 1.3, browThickness: 0.5, noseSize: 0.6, mouthWidth: 1.35 });
    expect(f.eyeScale).toBeCloseTo(1.3, 6);
    expect(f.browScale).toBeCloseTo(0.5, 6);
    expect(f.noseScale).toBeCloseTo(0.6, 6);
    expect(f.mouthScale).toBeCloseTo(1.35, 6);
  });

  it('非法输入不抛错（内部规范化）', () => {
    expect(() => buildFactors({ height: Number.NaN, faceShape: 'x' as never })).not.toThrow();
  });
});

describe('presets', () => {
  it('全部预设都能通过规范化且 id 唯一', () => {
    const ids = new Set<string>();
    for (const p of APPEARANCE_PRESETS) {
      expect(p.appearance).toEqual(clampAppearance(p.appearance));
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(getPreset(p.id)).toEqual(p.appearance);
    }
  });

  it('未知 id 返回 null', () => {
    expect(getPreset('nope')).toBeNull();
  });

  it('预设覆盖男女与多发型', () => {
    expect(APPEARANCE_PRESETS.some((p) => p.appearance.gender === 'male')).toBe(true);
    expect(APPEARANCE_PRESETS.some((p) => p.appearance.gender === 'female')).toBe(true);
    expect(new Set(APPEARANCE_PRESETS.map((p) => p.appearance.hairStyle)).size).toBeGreaterThan(2);
  });
});

describe('sameAppearance', () => {
  it('等价输入视为相同，差异视为不同', () => {
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE })).toBe(true);
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, build: 0.9 })).toBe(false);
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, height: 99 })).toBe(false);
  });
});
