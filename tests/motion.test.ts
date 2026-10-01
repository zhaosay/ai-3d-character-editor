import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildBoneMap,
  buildRestMap,
  buildRestPositionMap,
  composeRestOffset,
  eulerXyzToQuat,
  generatePlannedTracks,
  generateProceduralTracks,
  pickTemplate,
  planClauses,
} from '../src/services/motion/procedural';
import { MockMotionProvider } from '../src/services/motion/MockMotionProvider';
import { HttpMotionProvider } from '../src/services/motion/HttpMotionProvider';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { sampleAnimation } from '../src/core/animation/sampler';
import { toThreeClip } from '../src/core/animation/toThreeClip';
import * as THREE from 'three';
import type { WorldInteractionFrame } from '../src/core/previs/world';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    expect(pickTemplate('左手抬高')).toBe('raise_left');
    expect(pickTemplate('右手抬高')).toBe('raise_right');
    expect(pickTemplate('头向左转')).toBe('look_left');
    expect(pickTemplate('头向右转')).toBe('look_right');
    expect(pickTemplate('向左转头')).toBe('look_left');
    expect(pickTemplate('向右看')).toBe('look_right');
    expect(pickTemplate('沿着左侧向前走')).toBe('march');
    expect(pickTemplate('下蹲')).toBe('squat');
    expect(pickTemplate('跪下扶地')).toBe('kneel');
    expect(pickTemplate('把剑换到左手')).toBe('handoff');
    expect(pickTemplate('踏步走')).toBe('march');
    expect(pickTemplate('拔剑')).toBe('sword');
    expect(pickTemplate('挥剑斩')).toBe('sword');
    expect(pickTemplate('格挡防御')).toBe('block');
    expect(pickTemplate('踢腿')).toBe('kick');
    expect(pickTemplate('呼吸')).toBe('breath');
    expect(pickTemplate('待机')).toBe('breath');
    expect(pickTemplate('躺倒床上')).toBe('lie');
    expect(pickTemplate('qwerty')).toBe('sway');
  });

  it('本地预演忽略明确否定动作，并保留否定句后的肯定动作', () => {
    expect(planClauses('不要挥剑，也不要踢人', 4).map((segment) => segment.template)).toEqual(['stand']);
    expect(planClauses('不要拿手机，然后回头看门口', 4).map((segment) => segment.template)).toEqual(['look']);
    expect(planClauses('不要挥剑，但是向朋友挥手', 4).map((segment) => segment.template)).toEqual(['wave']);
  });

  it('把坐下再站起解析为连续的坐姿与站立动作，而不是站立占位', () => {
    expect(planClauses('坐下，然后站起来', 4).map((segment) => segment.template)).toEqual(['sit', 'stand']);
  });

  it('把自然方向表达解析成正确先后动作，并能采样出对应骨骼姿势', () => {
    const actor = buildDemoCharacter();
    const snap = buildSkeletonTree(actor.scene);
    const segments = planClauses('先右手抬高，然后向左转头', 4);
    expect(segments.map((segment) => segment.template)).toEqual(['raise_right', 'look_left']);

    const { tracks } = generatePlannedTracks(buildBoneMap(snap), segments, 4, 0, buildRestMap(snap), buildRestPositionMap(snap));
    const animation = { id: 'direction-sequence', name: 'direction-sequence', duration: 4, fps: 30, tracks };
    const raised = sampleAnimation(animation, 1);
    const looking = sampleAnimation(animation, 3);
    const rightArm = new THREE.Quaternion(...raised.get('UpperArm_R')!.quaternion!);
    expect(rightArm.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.3);
    const headEuler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...looking.get('Head')!.quaternion!));
    expect(headEuler.y).toBeLessThan(-0.2);
    actor.dispose();
  });

  it('euler 转 quat 已知值', () => {
    const q = eulerXyzToQuat([90, 0, 0]);
    expect(q[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('静息合成：单位元退化 + 90°自乘=180°', () => {
    const off = composeRestOffset([0, 0, 0, 1], [90, 0, 0]);
    expect(off[0]).toBeCloseTo(Math.SQRT1_2, 5);
    const dbl = composeRestOffset([Math.SQRT1_2, 0, 0, Math.SQRT1_2], [90, 0, 0]);
    expect(dbl[0]).toBeCloseTo(1, 5);
    expect(Math.abs(dbl[3])).toBeLessThan(1e-6);
  });

  it('生成叠加静息：T-pose 手臂不再被钉到天上', () => {
    // T-pose rest：右臂已外展 80°
    const restQ = eulerXyzToQuat([0, 0, -80]);
    const bones = { 'upperArm.R': 'UR', 'forearm.R': 'FR', 'upperArm.L': 'UL', 'head': 'H' } as never;
    const rest = { 'upperArm.R': restQ } as never;
    const { tracks } = generateProceduralTracks(bones, { prompt: '挥手', duration: 2 }, rest);
    const ur = tracks.find((t) => t.boneName === 'UR')!;
    /**
     * 首键必须是**静息姿态**：挥手从站立姿势起手。
     * 旧实现写成 `55 − 20·sin(...)`（常量偏置 + 振荡），手臂永远停在
     * 35~75°，第 0 帧就偏离静息 55°。现在抬臂用包络 lift(0)=0。
     */
    const expected = composeRestOffset(restQ, [0, 0, 0]);
    expect(ur.rotation[0].value[0]).toBeCloseTo(expected[0], 5);
    expect(ur.rotation[0].value[3]).toBeCloseTo(expected[3], 5);
    expect(ur.rotation[0].value[0]).toBeCloseTo(expected[0], 5);
    expect(ur.rotation[0].value[3]).toBeCloseTo(expected[3], 5);
    // 与旧绝对值（-150°）明显不同：证明相对化生效（15°旋转差 ≈ 四元数距离 0.13）
    const absolute = eulerXyzToQuat([0, 0, -150]);
    const dist = Math.hypot(
      ur.rotation[0].value[0] - absolute[0],
      ur.rotation[0].value[1] - absolute[1],
      ur.rotation[0].value[2] - absolute[2],
      ur.rotation[0].value[3] - absolute[3],
    );
    expect(dist).toBeGreaterThan(0.1);
    // 首键贴近静息（手臂从 T-pose 适度抬起，而非被钉到天上）
    const dot = Math.abs(
      ur.rotation[0].value[0] * restQ[0] +
        ur.rotation[0].value[1] * restQ[1] +
        ur.rotation[0].value[2] * restQ[2] +
        ur.rotation[0].value[3] * restQ[3],
    );
    expect(dot).toBeGreaterThan(0.8);
  });

  it('buildRestMap 从快照取静息', () => {
    const snap = humanoidSnap();
    const rest = buildRestMap(snap);
    expect(rest['upperArm.R']).toHaveLength(4);
    const n = Math.hypot(...(rest['upperArm.R'] as number[]));
    expect(n).toBeCloseTo(1, 5);
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

  it('挥手从静息起手、首尾回到静息（不再永远举着手臂）', () => {
    const bones = { 'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R' } as never;
    const { tracks } = generateProceduralTracks(bones, { prompt: '挥手', duration: 2 });
    const arm = tracks.find((t) => t.boneName === 'UpperArm_R')!.rotation;
    const dev = (k: { value: number[] }) => Math.hypot(k.value[0], k.value[1], k.value[2]);
    // 首帧与末帧都应接近静息（arm 被放下）
    expect(dev(arm[0]), '挥手起始应从静息姿势起手').toBeLessThan(1e-6);
    expect(dev(arm[arm.length - 1]), '挥手结束应回到静息').toBeLessThan(1e-6);
    // 中间确实抬起来了
    expect(Math.max(...arm.map(dev)), '挥手中途应抬起手臂').toBeGreaterThan(0.4);
  });

  it('按子句指定的左手生成挥手轨道', () => {
    const bones = {
      'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R',
      'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L',
    } as never;
    const { template, tracks } = generateProceduralTracks(bones, { prompt: '左手挥手', duration: 2 });
    /**
     * 取**最大**幅度而非首帧：挥手现在从静息起手（lift(0)=0），
     * 首帧本来就是零偏；要看的是手臂确实抬起来挥动。
     */
    const maxRotationFromRest = (boneName: string) => {
      const keys = tracks.find((track) => track.boneName === boneName)?.rotation ?? [];
      return keys.reduce((m, k) => Math.max(m, Math.hypot(k.value[0], k.value[1], k.value[2])), 0);
    };
    expect(template).toBe('wave');
    expect(maxRotationFromRest('UpperArm_L')).toBeGreaterThan(0.2);
    expect(maxRotationFromRest('Forearm_L')).toBeGreaterThan(0.1);
    // 右臂不应该跟着动（挥手只动一侧）
    expect(maxRotationFromRest('UpperArm_R')).toBeLessThan(0.01);
    expect(maxRotationFromRest('UpperArm_R')).toBeLessThan(1e-6);
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
      ['出拳', 'punch', 'UR'],
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

  it('punch template follows the requested lead hand', () => {
    const bones = { spine: 'S', 'upperArm.R': 'UR', 'forearm.R': 'FR', 'upperArm.L': 'UL', 'forearm.L': 'FL', head: 'H' } as never;
    const plans = [
      { t0: 0, t1: 2, template: 'punch', clause: '左手出拳并收回防守姿势' },
      { t0: 0, t1: 2, template: 'punch', clause: '右手出拳并收回防守姿势' },
    ];
    const leadArmTwist = plans.map((plan) => {
      const tracks = generatePlannedTracks(bones, [plan], 2).tracks;
      const leadBone = plan.clause.startsWith('左手') ? 'UL' : 'UR';
      const guardBone = plan.clause.startsWith('左手') ? 'UR' : 'UL';
      const twist = (bone: string) => {
        const keys = tracks.find((track) => track.boneName === bone)!.rotation;
        const mid = keys[Math.floor(keys.length / 2)].value;
        return Math.hypot(mid[0], mid[1], mid[2]);
      };
      return [twist(leadBone), twist(guardBone)];
    });
    expect(leadArmTwist[0][0]).toBeGreaterThan(leadArmTwist[0][1]);
    expect(leadArmTwist[1][0]).toBeGreaterThan(leadArmTwist[1][1]);
  });

  it('kick template follows the requested lead leg', () => {
    const bones = { spine: 'S', 'thigh.R': 'TR', 'shin.R': 'SR', 'thigh.L': 'TL', 'shin.L': 'SL' } as never;
    const plans = [
      { t0: 0, t1: 2, template: 'kick', clause: '左腿踢击并收回支撑姿势' },
      { t0: 0, t1: 2, template: 'kick', clause: '右腿踢击并收回支撑姿势' },
    ];
    const leadLegMotion = plans.map((plan) => {
      const tracks = generatePlannedTracks(bones, [plan], 2).tracks;
      const leadBone = plan.clause.startsWith('左腿') ? 'TL' : 'TR';
      const guardBone = plan.clause.startsWith('左腿') ? 'TR' : 'TL';
      const magnitude = (bone: string) => {
        const keys = tracks.find((track) => track.boneName === bone)!.rotation;
        const mid = keys[Math.floor(keys.length / 2)].value;
        return Math.hypot(mid[0], mid[1], mid[2]);
      };
      return [magnitude(leadBone), magnitude(guardBone)];
    });
    expect(leadLegMotion[0][0]).toBeGreaterThan(leadLegMotion[0][1]);
    expect(leadLegMotion[1][0]).toBeGreaterThan(leadLegMotion[1][1]);
  });

  it('weapon handoff phase drives both arms for a readable transfer pose', () => {
    const bones = { spine: 'Spine', 'upperArm.L': 'UL', 'forearm.L': 'FL', 'upperArm.R': 'UR', 'forearm.R': 'FR' } as never;
    const result = generateProceduralTracks(bones, { prompt: '把剑换到左手', duration: 2 });
    expect(result.template).toBe('handoff');
    const tracks = new Map(result.tracks.map((track) => [track.boneName, track]));
    for (const name of ['UL', 'FL', 'UR', 'FR']) {
      const keys = tracks.get(name)?.rotation ?? [];
      expect(keys.length).toBeGreaterThan(1);
      expect(Math.hypot(...keys[4].value.map((value, index) => value - keys[0].value[index]))).toBeGreaterThan(0.1);
    }
  });

  it('武侠连招分段：拔剑→格挡→踢腿', () => {
    const segs = planClauses('拔剑，然后格挡，最后踢腿', 6);
    expect(segs.map((s) => s.template)).toEqual(['sword', 'block', 'kick']);
    expect(segs[0].t0).toBe(0);
    expect(segs[2].t1).toBe(6);
  });

  it('一句话按连接词拆成走、拿取、看向，并保留顺序', () => {
    const segs = planClauses('人物走到桌前，拿起手机，然后回头看向门口', 6);
    expect(segs.map((s) => s.template)).toEqual(['march', 'reach', 'look']);
    expect(segs.map((s) => s.clause)).toEqual(['人物走到桌前', '拿起手机', '回头看向门口']);
  });

  it('splits a temporal 后 connector into ordered, sampleable action phases', () => {
    const bones = {
      hips: 'Hips', spine: 'Spine', chest: 'Chest', neck: 'Neck', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L', 'hand.L': 'Hand_L',
      'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R', 'hand.R': 'Hand_R',
      'thigh.L': 'Thigh_L', 'shin.L': 'Shin_L', 'foot.L': 'Foot_L',
      'thigh.R': 'Thigh_R', 'shin.R': 'Shin_R', 'foot.R': 'Foot_R',
    } as never;
    const result = generateProceduralTracks(bones, { prompt: '先挥手后鞠躬', duration: 4 });
    expect(result.segments.map((segment) => segment.template)).toEqual(['wave', 'bow']);
    expect(result.segments[0].t1).toBe(result.segments[1].t0);
    const animation = { id: 'sequence', name: 'sequence', duration: 4, fps: 30, tracks: result.tracks };
    const start = sampleAnimation(animation, 0);
    const wave = sampleAnimation(animation, 0.5);
    const bow = sampleAnimation(animation, 3);
    const boundary = sampleAnimation(animation, 2);
    const justAfterBoundary = sampleAnimation(animation, 2.01);
    expect(wave.has('UpperArm_R')).toBe(true);
    expect(bow.has('Spine')).toBe(true);
    const difference = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
    expect(difference(wave.get('UpperArm_R')!.quaternion!, start.get('UpperArm_R')!.quaternion!)).toBeGreaterThan(0.1);
    expect(difference(bow.get('Spine')!.quaternion!, boundary.get('Spine')!.quaternion!)).toBeGreaterThan(0.1);
    expect(difference(justAfterBoundary.get('UpperArm_R')!.quaternion!, boundary.get('UpperArm_R')!.quaternion!)).toBeLessThan(0.1);
    expect(result.warnings).toEqual([]);
  });

  it('deduplicates missing-bone warnings across repeated action segments', () => {
    const result = generatePlannedTracks(
      { spine: 'Spine', 'upperArm.R': 'ArmR' },
      [
        { t0: 0, t1: 1, template: 'reach', clause: '右手拿起手机' },
        { t0: 1, t1: 2, template: 'reach', clause: '右手放下手机' },
      ],
      2,
    );
    expect(result.warnings.filter((warning) => warning === '缺少 forearm.R，已跳过')).toHaveLength(1);
    expect(new Set(result.warnings).size).toBe(result.warnings.length);
  });

  it('走到目标有髋部前进位移，采样和 Three 导出均保留它', () => {
    const bones = {
      hips: 'Hips', spine: 'Spine', 'thigh.L': 'TL', 'thigh.R': 'TR', 'shin.L': 'SL', 'shin.R': 'SR',
      'upperArm.L': 'UL', 'upperArm.R': 'UR',
    } as never;
    const restPositions = { hips: [0, 1, 0] as [number, number, number] } as never;
    const result = generateProceduralTracks(bones, { prompt: '走到桌前', duration: 4 }, {}, restPositions);
    const hips = result.tracks.find((t) => t.boneName === 'Hips')!;
    expect(hips.position.length).toBeGreaterThan(1);
    // 髋部叠加了呼吸/步态起伏（真人骨盆从不停止），故首帧 X/Z 精确、Y 允许微幅偏移
    expect(hips.position[0].value[0]).toBeCloseTo(0, 6);
    expect(hips.position[0].value[1]).toBeCloseTo(1, 1);
    expect(hips.position[0].value[2]).toBeCloseTo(0, 6);
    expect(hips.position.at(-1)!.value[2]).toBeGreaterThan(0.6);
    expect(result.quality).toMatchObject({ status: 'ready' });
    const anim = { id: 'walk', name: 'walk', duration: 4, fps: 30, tracks: result.tracks };
    expect(sampleAnimation(anim, 4).get('Hips')!.position![2]).toBeGreaterThan(0.6);
    expect(toThreeClip(anim).clip.tracks.some((t) => t.name === 'Hips.position')).toBe(true);
  });

  it('拿取和看向有对应骨骼动作，不退化为 sway', () => {
    const bones = {
      spine: 'Spine', chest: 'Chest', head: 'Head', 'upperArm.R': 'UR', 'forearm.R': 'FR', 'hand.R': 'Hand',
    } as never;
    const reach = generateProceduralTracks(bones, { prompt: '拿起手机', duration: 2 });
    expect(reach.template).toBe('reach');
    expect(reach.warnings.join()).not.toMatch(/摇摆/);
    expect(reach.tracks.map((t) => t.boneName)).toEqual(expect.arrayContaining(['UR', 'FR', 'Hand']));
    const look = generateProceduralTracks(bones, { prompt: '回头看向门口', duration: 2 });
    expect(look.template).toBe('look');
    expect(look.tracks.map((t) => t.boneName)).toEqual(expect.arrayContaining(['Head', 'Chest']));
  });

  it('伸手按描述选择左右手、朝向交互点，并对超臂展目标发出警告', () => {
    const bones = {
      spine: 'Spine', chest: 'Chest', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L', 'hand.L': 'Hand_L',
      'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R', 'hand.R': 'Hand_R',
    } as never;
    const frame: WorldInteractionFrame = {
      approachPosition: [0, 1, 0], sitPosition: [0, 1, 0], liePosition: [0, 1, 0], yawRadians: 0,
      interactionPosition: [0, 1, 0], handTargetPosition: [-0.5, 0.9, 0.3],
      armReach: { L: { distanceMeters: 1.2, maxDistanceMeters: 0.55, reachable: false } },
    };
    const result = generatePlannedTracks(
      bones, [{ t0: 0, t1: 2, template: 'reach', clause: '左手拿起手机', targetPropId: 'phone-main' }],
      2, 0, {}, { hips: [0, 1, 0] }, null, {}, { 0: frame },
    );

    const names = result.tracks.map((track) => track.boneName);
    expect(names).toEqual(expect.arrayContaining(['UpperArm_L', 'Forearm_L', 'Hand_L']));
    expect(names).not.toContain('UpperArm_R');
    expect(result.warnings.join(' ')).toMatch(/超过估算臂展/);

    const highFrame = { ...frame, handTargetPosition: [-0.5, 1.7, 0.3] };
    const high = generatePlannedTracks(
      bones, [{ t0: 0, t1: 2, template: 'reach', clause: '左手拿起手机', targetPropId: 'phone-main' }],
      2, 0, {}, { hips: [0, 1, 0] }, null, {}, { 0: highFrame },
    );
    const lowPose = result.tracks.find((track) => track.boneName === 'UpperArm_L')!.rotation.at(-1)!.value;
    const highPose = high.tracks.find((track) => track.boneName === 'UpperArm_L')!.rotation.at(-1)!.value;
    expect(highPose).not.toEqual(lowPose);

    const closeFrame = { ...frame, armReach: { L: { distanceMeters: 0.1, minDistanceMeters: 0.2, maxDistanceMeters: 0.55, reachable: false } } };
    const close = generatePlannedTracks(
      bones, [{ t0: 0, t1: 2, template: 'reach', clause: '左手拿起手机', targetPropId: 'phone-main' }],
      2, 0, {}, { hips: [0, 1, 0] }, null, {}, { 0: closeFrame },
    );
    expect(close.warnings.join(' ')).toMatch(/小于估算手臂最短可达距离/);
  });

  it('方向性单项指令驱动指定身体部位，蹲下再站起恢复根节点高度', () => {
    const bones = {
      hips: 'Hips', spine: 'Spine', chest: 'Chest', neck: 'Neck', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L',
      'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R',
      'thigh.L': 'Thigh_L', 'thigh.R': 'Thigh_R', 'shin.L': 'Shin_L', 'shin.R': 'Shin_R',
    } as never;
    const raised = generateProceduralTracks(bones, { prompt: '左手抬高', duration: 2 });
    expect(raised.template).toBe('raise_left');
    expect(raised.tracks.map((track) => track.boneName)).toContain('UpperArm_L');
    expect(raised.tracks.map((track) => track.boneName)).not.toContain('UpperArm_R');

    const left = generateProceduralTracks(bones, { prompt: '头向左转', duration: 2 });
    const leftHead = left.tracks.find((track) => track.boneName === 'Head')!;
    const leftForward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...leftHead.rotation.at(-1)!.value));
    expect(left.template).toBe('look_left');
    expect(leftForward.x).toBeLessThan(0);

    const sequence = generateProceduralTracks(bones, { prompt: '下蹲，然后站起', duration: 4 }, {}, { hips: [0, 1, 0] } as never);
    const hips = sequence.tracks.find((track) => track.boneName === 'Hips')!;
    expect(sequence.templates).toEqual(['squat', 'stand']);
    expect(hips.position.some((key) => key.value[1] < 0.8)).toBe(true);
    expect(hips.position.at(-1)!.value[1]).toBeCloseTo(1);
  });

  it('躺倒生成仰卧骨骼与落位轨道，并说明没有床体接触模拟', () => {
    const bones = {
      hips: 'Hips', spine: 'Spine', chest: 'Chest', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'upperArm.R': 'UpperArm_R',
      'thigh.L': 'Thigh_L', 'thigh.R': 'Thigh_R', 'shin.L': 'Shin_L', 'shin.R': 'Shin_R',
    } as never;
    const result = generateProceduralTracks(
      bones,
      { prompt: '躺倒床上', duration: 3 },
      {},
      { hips: [0, 1, 0] } as never,
    );
    const hips = result.tracks.find((track) => track.boneName === 'Hips')!;
    expect(result.template).toBe('lie');
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...hips.rotation.at(-1)!.value));
    expect(forward.y).toBeGreaterThan(0.9); // +Z face normal points upward in a supine pose.
    expect(hips.position.at(-1)!.value[1]).toBeCloseTo(0.13);
    expect(result.warnings.join()).toMatch(/没有床体碰撞与接触模拟/);

    const sequence = generateProceduralTracks(bones, { prompt: '躺下，然后起身', duration: 4 }, {}, { hips: [0, 1, 0] } as never);
    expect(sequence.templates).toEqual(['lie', 'stand']);
    expect(sequence.tracks.find((track) => track.boneName === 'Hips')!.position.at(-1)!.value[1]).toBeCloseTo(1);

    const sleep = generateProceduralTracks(bones, { prompt: '躺下睡觉', duration: 4 }, {}, { hips: [0, 1, 0] } as never);
    expect(sleep.templates).toEqual(['lie', 'sleep']);
    expect(sleep.tracks.find((track) => track.boneName === 'Chest')?.rotation.length).toBeGreaterThan(0);
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

  it('动作段幅度与速度参数会改变采样姿态', () => {
    const bones = { spine: 'Spine', 'upperArm.R': 'UpperArm_R' } as never;
    const base = [{ t0: 0, t1: 2, template: 'sword', clause: '挥剑', intensity: 1, speed: 1 }];
    const strongFast = [{ ...base[0], intensity: 1.5, speed: 1.8 }];
    const a = generatePlannedTracks(bones, base, 2);
    const b = generatePlannedTracks(bones, strongFast, 2);
    const keyA = a.tracks.find((track) => track.boneName === 'Spine')!.rotation[2].value;
    const keyB = b.tracks.find((track) => track.boneName === 'Spine')!.rotation[2].value;
    expect(keyA).not.toEqual(keyB);
    expect(a.segments[0]).toMatchObject({ intensity: 1, speed: 1 });
    expect(b.segments[0]).toMatchObject({ intensity: 1.5, speed: 1.8 });
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

  it('同类道具无法消歧时生成未绑定的动作草案并带出澄清警告', async () => {
    const phone = { id: 'phone-a', kind: 'phone' as const, position: [0, 0.8, 0] as [number, number, number], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    const phoneB = { ...phone, id: 'phone-b', position: [1, 0.8, 0] as [number, number, number] };
    const result = await new MockMotionProvider().generateMotion({ prompt: '拿起手机', skeleton: humanoidSnap(), duration: 4, stageProps: [phone, phoneB] });
    expect(result.meta.segments?.some((segment) => segment.targetPropId)).toBe(false);
    expect(result.meta.warnings?.join()).toMatch(/目标不明确|多个手机/);
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

  it('真实后端轨道会被保留，不被本地模板覆盖', async () => {
    const remoteTrack = {
      boneName: 'Hips', position: [],
      rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'real', name: 'motion-capture', duration: 2, fps: 30, tracks: [remoteTrack] }, meta: { provider: 'motion-api', source: 'real' } }),
    }));
    const result = await new HttpMotionProvider('http://x').generateMotion({ prompt: '走路', skeleton: null });
    expect(result.meta.source).toBe('real');
    expect(result.animation.tracks).toEqual([remoteTrack]);
  });

  it('把 Provider 语义名与显式骨骼映射绑定到当前角色骨架', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: {
          id: 'mapped', name: 'mapped', duration: 4, fps: 30,
          tracks: [
            { boneName: 'upperArm.R', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
            { boneName: 'mixamorig:RightForeArm', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
          ],
        },
        meta: {
          source: 'real',
          motion_space: { length_unit: 'm', up_axis: 'Y', handedness: 'right' },
          bone_mapping: { 'mixamorig:RightForeArm': 'forearm.R' },
        },
      }),
    }));

    const result = await new HttpMotionProvider('http://x').generateMotion({ prompt: '抬右臂', skeleton: humanoidSnap(), duration: 4 });

    expect(result.animation.tracks.map((track) => track.boneName)).toEqual(['UpperArm_R', 'Forearm_R']);
  });

  it('按真实 Provider 声明把厘米制 Z-up 轨道转为米制 Y-up', async () => {
    const halfTurnAroundSourceZ = Math.SQRT1_2;
    const remoteTrack = {
      boneName: 'Hips',
      position: [{ time: 0, value: [0, 0, 100], interp: 'linear' }],
      rotation: [{ time: 0, value: [0, 0, halfTurnAroundSourceZ, halfTurnAroundSourceZ], interp: 'linear' }],
      scale: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: { id: 'real-z-up', name: 'z-up-cm', duration: 1, fps: 30, tracks: [remoteTrack] },
        meta: { source: 'real', motion_space: { length_unit: 'cm', up_axis: 'Z', handedness: 'right' } },
      }),
    }));

    const result = await new HttpMotionProvider('http://x').generateMotion({ prompt: 'move', skeleton: null });
    const track = result.animation.tracks[0];
    expect(track.position[0].value[1]).toBeCloseTo(1);
    expect(track.position[0].value[2]).toBeCloseTo(0);
    expect(track.rotation[0].value[1]).toBeCloseTo(halfTurnAroundSourceZ);
    expect(track.rotation[0].value[2]).toBeCloseTo(0);
    expect(result.meta.warnings?.some((warning) => /未声明坐标系/.test(warning))).toBe(false);
  });

  it('把真实动作关键帧均匀重定时到请求时长与帧率', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: {
          id: 'short-motion', name: 'short', duration: 2, fps: 30,
          tracks: [{ boneName: 'Hips', position: [{ time: 1, value: [0, 1, 0], interp: 'linear' }], rotation: [], scale: [] }],
          faceTracks: [{ meshPath: 'face', targetName: 'blink', keys: [{ time: 1, value: 1, interp: 'linear' }] }],
        },
        meta: { source: 'real', motion_space: { length_unit: 'm', up_axis: 'Y', handedness: 'right' } },
      }),
    }));

    const result = await new HttpMotionProvider('http://x').generateMotion({ prompt: 'move', skeleton: null, duration: 4, fps: 24 });
    expect(result.animation.duration).toBe(4);
    expect(result.animation.fps).toBe(24);
    expect(result.animation.tracks[0].position[0].time).toBe(2);
    expect(result.animation.faceTracks?.[0].keys[0].time).toBe(2);
    expect(result.meta.warnings).toContain('远程动作时长 2.00 秒已按请求重定时为 4.00 秒；关键帧相对时间比例保持不变');
  });

  it('拒绝含非有限骨骼值的远程动作数据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ animation: {
        id: 'broken', name: 'bad', duration: 2, fps: 30,
        tracks: [{ boneName: 'Hips', position: [], rotation: [{ time: 1, value: [0, 0, Number.NaN, 1], interp: 'linear' }], scale: [] }],
      }, meta: { source: 'real' } }),
    }));
    await expect(new HttpMotionProvider('http://x').generateMotion({ prompt: '走路', skeleton: null })).rejects.toThrow(/动作数据无效/);
  });

  it('断网抛友好错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(new HttpMotionProvider('http://x').generateMotion({ prompt: 'w', skeleton: null })).rejects.toThrow(/连不上/);
  });

  it('动作服务挂起时在超时后中止请求并给出明确错误', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const pending = new HttpMotionProvider('http://x').generateMotion({ prompt: 'w', skeleton: null });
    const rejected = expect(pending).rejects.toThrow(/动作服务请求超过 120 秒/);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
  });

  it('坏形状抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ nope: 1 }) }));
    await expect(new HttpMotionProvider('http://x').generateMotion({ prompt: 'w', skeleton: null })).rejects.toThrow(/缺少 animation/);
  });
});
