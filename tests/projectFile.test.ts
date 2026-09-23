import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../src/core/project/schema';
import { checkCharacterBind, parseProjectFile, serializeProject } from '../src/core/project/serialize';
import { createEmptyAnimation } from '../src/core/animation/types';
import type { CharacterMeta } from '../src/types/global';

const Q: [number, number, number, number] = [0, 0, 0, 1];

describe('project save/load', () => {
  it('序列化往返保持动画', () => {
    const p = createEmptyProject();
    const a = createEmptyAnimation('挥剑', 30, 3);
    a.tracks.push({ boneName: 'Hips', position: [], rotation: [{ time: 1, value: Q, interp: 'linear' }], scale: [] });
    p.animations.push(a);
    const { project, warnings } = parseProjectFile(serializeProject(p));
    expect(warnings).toEqual([]);
    expect(project.animations.length).toBe(1);
    expect(project.animations[0].name).toBe('挥剑');
    expect(project.animations[0].tracks[0].rotation[0].time).toBe(1);
  });

  it('非法 JSON 与越界 key 分别抛错/警告', () => {
    expect(() => parseProjectFile('not json')).toThrow();
    const p = createEmptyProject();
    const a = createEmptyAnimation('X', 30, 2);
    a.tracks.push({ boneName: 'H', position: [{ time: 9, value: [0, 0, 0], interp: 'linear' }], rotation: [], scale: [] });
    p.animations.push(a);
    const { warnings } = parseProjectFile(serializeProject(p));
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('checkCharacterBind', () => {
  const meta: CharacterMeta = {
    id: 'c1',
    fileName: 'wuxia.glb',
    fileSize: 12345,
    gltfInfo: { meshes: 3, materials: 2, bones: 40, hasSkin: true, hasAnimations: 0 },
  };
  it('一致/缺失/不一致', () => {
    const p = createEmptyProject();
    p.character = meta;
    expect(checkCharacterBind(meta, p)).toBe('match');
    expect(checkCharacterBind(null, p)).toBe('missing');
    expect(checkCharacterBind({ ...meta, fileSize: 1 }, p)).toBe('mismatch');
    expect(checkCharacterBind(meta, createEmptyProject())).toBe('missing');
  });
});
