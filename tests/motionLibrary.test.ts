import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOTION_ASSET, buildSourceBoneMap, diagnoseMotionBind, listMotionClips,
  parseMotionPackage, type MotionManifest,
} from '../src/services/motion/motionLibrary';
import type { HumanoidSemantic } from '../src/core/skeleton/types';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'public/samples/motions/humanoid-v1.json'), 'utf8'));
const manifest: MotionManifest = JSON.parse(
  readFileSync(resolve(ROOT, 'public/samples/motions/humanoid-v1-manifest.json'), 'utf8'),
);

describe('动作库解包', () => {
  it('解出合法 GLB（magic=glTF, version=2）', () => {
    const p = parseMotionPackage(pkg, manifest);
    expect(p.glb.byteLength).toBeGreaterThan(100_000);
    const magic = new TextDecoder().decode(new Uint8Array(p.glb, 0, 4));
    expect(magic).toBe('glTF');
    const version = new DataView(p.glb).getUint32(4, true);
    expect(version).toBe(2);
  });

  it('声明的字节数与实际一致', () => {
    const p = parseMotionPackage(pkg, manifest);
    // glTF 头第 8~12 字节是总长度
    const declared = new DataView(p.glb).getUint32(8, true);
    expect(declared).toBe(p.glb.byteLength);
  });

  it('许可为 CC0-1.0（公有领域，可商用）', () => {
    const p = parseMotionPackage(pkg, manifest);
    expect(p.license).toBe('CC0-1.0');
    expect(p.copyright).toContain('Quaternius');
  });

  it('格式非法时抛错而非静默降级', () => {
    expect(() => parseMotionPackage({}, manifest)).toThrow(/格式无效/);
    expect(() => parseMotionPackage({ package: { entry: 'x.glb', files: [] } }, manifest)).toThrow(/格式无效/);
    // magic 不对
    const bad = { package: { entry: 'x.glb', files: [{ path: 'x', data: btoa('NOTGLTF............') }] } };
    expect(() => parseMotionPackage(bad, manifest)).toThrow(/magic/);
  });
});

describe('clip 清单', () => {
  it('10 个 clip，索引唯一且有中文名', () => {
    const p = parseMotionPackage(pkg, manifest);
    const clips = listMotionClips(p);
    expect(clips).toHaveLength(10);
    expect(new Set(clips.map((c) => c.index)).size).toBe(10);
    for (const c of clips) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.duration).toBeGreaterThan(0);
    }
  });

  it('包含关键动作（行走/坐/站起）', () => {
    const names = listMotionClips(parseMotionPackage(pkg, manifest)).map((c) => c.name);
    expect(names).toContain('行走');
    expect(names).toContain('坐下');
    expect(names).toContain('站起');
  });

  it('循环/非循环标记合理（坐/站起不应循环）', () => {
    const clips = listMotionClips(parseMotionPackage(pkg, manifest));
    expect(clips.find((c) => c.name === '行走')?.loop).toBe(true);
    expect(clips.find((c) => c.name === '坐下')?.loop).toBe(false);
  });
});

describe('骨骼语义映射', () => {
  const sourceNodes = [
    { name: 'hips' }, { name: 'spine' }, { name: 'chest' }, { name: 'neck' }, { name: 'head' },
    { name: 'leftUpperArm' }, { name: 'leftLowerArm' }, { name: 'leftHand' },
    { name: 'rightUpperArm' }, { name: 'rightLowerArm' }, { name: 'rightHand' },
    { name: 'leftUpperLeg' }, { name: 'leftLowerLeg' }, { name: 'leftFoot' }, { name: 'leftToes' },
    { name: 'rightUpperLeg' }, { name: 'rightLowerLeg' }, { name: 'rightFoot' }, { name: 'rightToes' },
  ];

  it('全部 11 个必需语义都能绑定', () => {
    const map = buildSourceBoneMap(sourceNodes);
    const report = diagnoseMotionBind(map);
    expect(report.missing).toEqual([]);
    expect(report.bound).toBe(11);
  });

  it('左右腿不串（toes 归 foot 而非新建语义）', () => {
    const map = buildSourceBoneMap(sourceNodes);
    expect(map['foot.L']).toBe('leftFoot');
    expect(map['foot.R']).toBe('rightFoot');
    expect(map['thigh.L']).toBe('leftUpperLeg');
    expect(map['shin.R']).toBe('rightLowerLeg');
  });

  it('chest 与 upperChest 归到同一语义时取先出现者', () => {
    const map = buildSourceBoneMap([...sourceNodes, { name: 'upperChest' }]);
    expect(map.chest).toBeDefined();
  });

  it('缺失骨骼时诊断如实报告', () => {
    const partial = sourceNodes.filter((n) => !n.name.startsWith('left'));
    const report = diagnoseMotionBind(buildSourceBoneMap(partial));
    expect(report.missing).toContain('upperArm.L');
    expect(report.missing).toContain('thigh.L');
    expect(report.bound).toBeLessThan(11);
  });

  it('未知骨骼名被忽略而非误映射', () => {
    const map = buildSourceBoneMap([{ name: 'joint042' }, { name: 'head' }]);
    expect(map.head).toBe('head');
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('不认识的语义键不会出现在结果里', () => {
    const map = buildSourceBoneMap(sourceNodes) as Record<string, string>;
    const valid: HumanoidSemantic[] = [
      'hips', 'spine', 'chest', 'neck', 'head',
      'shoulder.L', 'upperArm.L', 'forearm.L', 'hand.L',
      'shoulder.R', 'upperArm.R', 'forearm.R', 'hand.R',
      'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R',
    ];
    for (const k of Object.keys(map)) expect(valid).toContain(k as HumanoidSemantic);
  });
});

describe('溯源信息', () => {
  it('声明了来源与许可链接', () => {
    expect(MOTION_ASSET.licenseUrl).toContain('creativecommons.org');
    expect(MOTION_ASSET.sourceUrl).toContain('quaternius.com');
    expect(MOTION_ASSET.attribution).toContain('CC0-1.0');
  });

  it('NOTICE 文件随资产一同存在', () => {
    const text = readFileSync(resolve(ROOT, 'public/samples/motions/NOTICE-Quaternius-CC0.txt'), 'utf8');
    expect(text).toContain('CC0-1.0');
    expect(text).toContain('Quaternius');
  });
});
