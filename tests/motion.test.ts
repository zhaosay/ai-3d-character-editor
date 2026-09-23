import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildBoneMap,
  eulerXyzToQuat,
  generatePlannedTracks,
  generateProceduralTracks,
  pickTemplate,
  planClauses,
} from '../src/services/motion/procedural';
import { MockMotionProvider } from '../src/services/motion/MockMotionProvider';
import { HttpMotionProvider } from '../src/services/motion/HttpMotionProvider';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import * as THREE from 'three';

afterEach(() => {
  vi.unstubAllGlobals();
});

function limb(parent: THREE.Object3D, name: string, pos: [number, number, number]): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  parent.add(b);
  return b;
}

function humanoidSnap() {
  const g = new THREE.Group();
  const hips = limb(g, 'Hips', [0, 1, 0]);
  const ua = limb(hips, 'UpperArm_R', [-0.2, 0.4, 0]);
  const fa = limb(ua, 'Forearm_R', [0, -0.3, 0]);
  limb(fa, 'Hand_R', [0, -0.25, 0]);
  limb(hips, 'Head', [0, 0.6, 0]);
  return buildSkeletonTree(g);
}

describe('procedural', () => {
  it('关键词选模板', () => {
    expect(pickTemplate('挥手')).toBe('wave');
    expect(pickTemplate('wave hello')).toBe('wave');
    expect(pickTemplate('鞠躬')).toBe('bow');
    expect(pickTemplate('踏步走')).toBe('march');
    expect(pickTemplate('拔剑')).toBe('sword');
    expect(pickTemplate('挥剑斩')).toBe('sword');
    expect(pickTemplate('格挡防御')).toBe('block');
    expect(pickTemplate('踢腿')).toBe('kick');
    expect(pickTemplate('qwerty')).toBe('sway');
  });

  it('euler 转 quat 已知值', () => {
    const q = eulerXyzToQuat([90, 0, 0]);
    expect(q[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('wave 生成归一化四元数轨道', () => {
    const bones = {
      'upperArm.R': 'UpperArm_R',
      'forearm.R': 'Forearm_R',
      'upperArm.L': 'UpperArm_L',
      'head': 'Head',
    } as never;
    const { template, tracks, warnings } = generateProceduralTracks(bones, { prompt: '挥手', duration: 4 });
    expect(template).toBe('wave');
    expect(warnings).toEqual([]);
    expect(tracks.length).toBe(4);
    for (const t of tracks) {
      expect(t.rotation.length).toBe(17);
      for (let i = 1; i < t.rotation.length; i++) {
        expect(t.rotation[i].time).toBeGreaterThan(t.rotation[i - 1].time);
      }
      for (const k of t.rotation) {
        const n = Math.hypot(...k.value);
        expect(n).toBeCloseTo(1, 5);
      }
    }
  });

  it('缺右臂镜像到左臂并警告', () => {
    const bones = { 'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L' } as never;
    const { tracks, warnings } = generateProceduralTracks(bones, { prompt: 'wave', duration: 1 });
    expect(tracks.map((t) => t.boneName)).toContain('UpperArm_L');
    expect(warnings.join()).toMatch(/镜像/);
  });

  it('武侠模板生成有效轨道（归一化+峰值包络）', () => {
    const bones = {
      'spine': 'S',
      'upperArm.R': 'UR',
      'forearm.R': 'FR',
      'upperArm.L': 'UL',
      'forearm.L': 'FL',
      'head': 'H',
      'thigh.R': 'TR',
      'thigh.L': 'TL',
      'shin.R': 'SR',
    } as never;
    for (const [prompt, template, probe] of [
      ['拔剑', 'sword', 'UR'],
      ['格挡', 'block', 'FL'],
      ['踢腿', 'kick', 'TR'],
    ] as Array<[string, string, string]>) {
      const r = generateProceduralTracks(bones, { prompt, duration: 2 });
      expect(r.template).toBe(template);
      expect(r.warnings).toEqual([]);
      const track = r.tracks.find((t) => t.boneName === probe)!;
      expect(track).toBeDefined();
      for (const k of track.rotation) {
        expect(Math.hypot(...k.value)).toBeCloseTo(1, 5);
      }
      // 中段 rotation 偏离起点（包络峰值），首尾回到起点
      const first = track.rotation[0].value;
      const mid = track.rotation[Math.floor(track.rotation.length / 2)].value;
      const dist = Math.hypot(mid[0] - first[0], mid[1] - first[1], mid[2] - first[2], mid[3] - first[3]);
      expect(dist).toBeGreaterThan(0.1);
    }
  });

  it('武侠连招分段：拔剑→格挡→踢腿', () => {
    const segs = planClauses('拔剑，然后格挡，最后踢腿', 6);
    expect(segs.map((s) => s.template)).toEqual(['sword', 'block', 'kick']);
    expect(segs[0].t0).toBe(0);
    expect(segs[2].t1).toBe(6);
  });

  it('多子句分段合成：模板序列+时间合并有序', () => {
    const bones = {
      'upperArm.R': 'UR',
      'forearm.R': 'FR',
      'upperArm.L': 'UL',
      'head': 'H',
      'spine': 'S',
    } as never;
    const segs = planClauses('挥手，再鞠躬', 4);
    expect(segs.map((s) => s.template)).toEqual(['wave', 'bow']);
    expect(segs[0].t0).toBe(0);
    expect(segs[1].t1).toBe(4);
    const { templates, tracks } = generatePlannedTracks(bones, segs, 4);
    expect(templates).toEqual(['wave', 'bow']);
    for (const t of tracks) {
      const times = t.rotation.map((k) => k.time);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThan(1e-5);
      }
    }
  });
});

describe('MockMotionProvider', () => {
  it('由快照生成动画并标注 mock', async () => {
    const snap = humanoidSnap();
    expect(buildBoneMap(snap)['upperArm.R']).toBe('UpperArm_R');
    const r = await new MockMotionProvider().generateMotion({ prompt: '挥手', skeleton: snap, duration: 2, fps: 30 });
    expect(r.meta.source).toBe('mock');
    expect(r.meta.template).toBe('wave');
    expect(r.meta.planner).toBe('heuristic');
    expect(r.animation.duration).toBe(2);
    expect(r.animation.tracks.length).toBeGreaterThan(0);
  });

  it('无骨骼快照抛错（不假装成功）', async () => {
    await expect(new MockMotionProvider().generateMotion({ prompt: 'wave', skeleton: null })).rejects.toThrow();
  });
});

describe('HttpMotionProvider', () => {
  it('成功解析后端结果', async () => {
    const anim = { id: 'a', name: 'AI:wave', duration: 2, fps: 30, tracks: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ animation: anim, meta: { provider: 'backend-mock', source: 'mock', template: 'wave' } }),
      }),
    );
    const r = await new HttpMotionProvider('http://x').generateMotion({ prompt: 'wave', skeleton: null });
    expect(r.animation.name).toBe('AI:wave');
    expect(r.meta.source).toBe('mock');
  });

  it('断网抛友好错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(new HttpMotionProvider('http://x').generateMotion({ prompt: 'w', skeleton: null })).rejects.toThrow(/连不上/);
  });

  it('坏形状抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ nope: 1 }) }));
    await expect(new HttpMotionProvider('http://x').generateMotion({ prompt: 'w', skeleton: null })).rejects.toThrow(/缺少 animation/);
  });
});
