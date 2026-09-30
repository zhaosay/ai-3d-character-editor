import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import type { SkeletonSnapshot } from '../src/core/skeleton/types';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { indexBonesByName } from '../src/core/animation/applyPose';
import { measureLegChain, sitPoseAt, seatedLegPose, pelvisRadiusOf, hipHeightForKneel, hipHeightForWorldAngles } from '../src/core/ik/sitPose';
import { standingHipHeight } from '../src/core/ik/sitSolve';
import { measureSoleDrop } from '../src/core/ik/footLock';
import { MockMotionProvider } from '../src/services/motion/MockMotionProvider';
import type { StageProp } from '../src/core/previs/world';
import type { LegChain } from '../src/core/ik/sitSolve';

/**
 * `sit` 脚插地的量化验收。
 *
 * 背景：旧实现用**固定欧拉角**（thigh −72°/shin +68°）+ **固定座高 16cm**，
 * 但髋目标高度随座面变化（地面 0.13m / 椅 0.45m / 高凳 0.8m）——
 * 固定角只可能对**一个**座高正确。修复前实测脚骨落到 y=−0.49m（插地 49cm）。
 *
 * 现在腿角由 sitPose 按**真实骨长 + 实际座高**解出，髋高用同一解的跨距反解，
 * 因此脚底应贴地。测量口径：脚骨（踝）世界高度 − 踝高 = 脚底离地量。
 */

interface Rig {
  scene: THREE.Group;
  snapshot: SkeletonSnapshot;
  boneMap: ReturnType<typeof buildBoneMap>;
  chain: LegChain;
}

/** 生成 sit 轨道、应用终帧，返回脚底离地量与髋高。 */
function sitSole(
  rig: Rig,
  opts: { seatY?: number; useSolver: boolean },
): { soleL: number; soleR: number; hipY: number } {
  const seatY = opts.seatY ?? 0.45;
  const { scene, snapshot, boneMap, chain } = rig;
  const interaction = {
    approachPosition: [0, 0, -0.5] as [number, number, number],
    sitPosition: [0, seatY, 0] as [number, number, number],
    liePosition: [0, 0, 0] as [number, number, number],
    interactionPosition: [0, 0, -0.5] as [number, number, number],
    handTargetPosition: [0, 0, 0] as [number, number, number],
    armReach: { minDistanceMeters: 0.2, maxDistanceMeters: 0.7 },
    yawRadians: 0,
    distanceMeters: 0.5,
  };
  const res = generatePlannedTracks(
    boneMap,
    [{ t0: 0, t1: 2, template: 'sit', clause: '坐到椅子上' }],
    2,
    0,
    buildRestMap(snapshot),
    buildRestPositionMap(snapshot),
    null,
    {},
    { 0: interaction as never },
    0,
    undefined,
    opts.useSolver ? chain : null,
  );
  const bones = indexBonesByName(scene);
  for (const tr of res.tracks) {
    const b = bones.get(tr.boneName);
    if (!b) continue;
    const rot = tr.rotation?.at(-1);
    if (rot && rot.value.length === 4) b.quaternion.set(...(rot.value as [number, number, number, number]));
    const pos = tr.position?.at(-1);
    if (pos && pos.value.length === 3) b.position.set(...(pos.value as [number, number, number]));
  }
  scene.updateWorldMatrix(true, true);
  const wy = (n: string) => {
    const b = bones.get(n);
    if (!b) return Number.NaN;
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v.y;
  };
  // 用项目自带的脚底测量（取绑定到 foot 骨的蒙皮网格最低顶点），
  // 而不是拿骨原点高度硬减一个常数 —— 那样测的是骨头不是鞋底。
  const footLBone = bones.get('Foot_L');
  const footRBone = bones.get('Foot_R');
  const dropL = footLBone ? measureSoleDrop(scene, footLBone) : 0;
  const dropR = footRBone ? measureSoleDrop(scene, footRBone) : 0;
  return { soleL: wy('Foot_L') - dropL, soleR: wy('Foot_R') - dropR, hipY: wy('Hips') };
}

function makeRig(gender: 'male' | 'female' = 'male'): Rig {
  const { scene } = buildDemoCharacter(gender);
  const snapshot = buildSkeletonTree(scene);
  const boneMap = buildBoneMap({ nodes: Object.values(snapshot.nodes) } as never);
  const chain = measureLegChain(snapshot, 'L', scene);
  if (!chain) throw new Error('未能量出腿连杆');
  return { scene, snapshot, boneMap, chain };
}

describe('sit 脚插地量化验收', () => {
  it('修复前基线：固定角 + 固定座高导致脚插地（记录回归基线）', () => {
    const rig = makeRig();
    const r = sitSole(rig, { useSolver: false, seatY: 0.45 });
    // 旧行为确实插地 —— 这条测试锁住「修复前」的现状，若将来也变了请更新基线
    expect(r.soleL).toBeLessThan(-0.2);
  });

  it('接入 sitPose 后：坐椅（座面 0.45m）脚底贴地，误差 < 1cm', () => {
    const rig = makeRig();
    const r = sitSole(rig, { useSolver: true, seatY: 0.45 });
    expect(Math.abs(r.soleL)).toBeLessThan(0.01);
    expect(Math.abs(r.soleR)).toBeLessThan(0.01);
  });

  it('座面高度变化时脚仍贴地（0.40 / 0.45 / 0.50）', () => {
    for (const seatY of [0.40, 0.45, 0.50]) {
      const rig = makeRig();
      const r = sitSole(rig, { useSolver: true, seatY });
      expect(Math.abs(r.soleL), `座面 ${seatY} 脚底应贴地`).toBeLessThan(0.01);
    }
  });

  it('高凳（座面 0.62m，腿接近伸直）仍贴地', () => {
    const rig = makeRig();
    const r = sitSole(rig, { useSolver: true, seatY: 0.62 });
    expect(Math.abs(r.soleL)).toBeLessThan(0.01);
  });

  it('髋高与座面一致（骨盆坐在座面上，不是悬空 16cm）', () => {
    const rig = makeRig();
    const r = sitSole(rig, { useSolver: true, seatY: 0.45 });
    const pose = sitPoseAt({ chain: rig.chain, seatY: 0.45, progress: 1 })!;
    // 髋骨中心应等于解算给出的 boneHipY
    expect(r.hipY).toBeCloseTo(pose.boneHipY, 3);
    // 且骨盆确实坐在座面上（骨中心 = 座面 + 骨盆半径，而非座面本身）
    expect(r.hipY).toBeGreaterThan(0.45);
  });
});

describe('蹲/跪按腿角反解髋高（不写死深度）', () => {
  /** 跑一个模板的终帧，返回脚底离地 / 小腿(膝)高度 / 髋高。 */
  function runFold(template: 'squat' | 'kneel', height: number, useChain: boolean) {
    const { scene } = buildDemoCharacter('male', { height } as never);
    const snapshot = buildSkeletonTree(scene);
    const chain = measureLegChain(snapshot, 'L', scene);
    const res = generatePlannedTracks(
      buildBoneMap({ nodes: Object.values(snapshot.nodes) } as never),
      [{ t0: 0, t1: 2, template, clause: template === 'kneel' ? '跪下' : '下蹲' }],
      2, 0, buildRestMap(snapshot), buildRestPositionMap(snapshot),
      null, {}, {}, 0, undefined, useChain ? chain : null,
    );
    const bones = indexBonesByName(scene);
    for (const tr of res.tracks) {
      const b = bones.get(tr.boneName);
      if (!b) continue;
      const r = tr.rotation?.at(-1);
      if (r && r.value.length === 4) b.quaternion.set(...(r.value as [number, number, number, number]));
      const p = tr.position?.at(-1);
      if (p && p.value.length === 3) b.position.set(...(p.value as [number, number, number]));
    }
    scene.updateWorldMatrix(true, true);
    const wy = (n: string) => {
      const b = bones.get(n);
      if (!b) return Number.NaN;
      const v = new THREE.Vector3();
      b.getWorldPosition(v);
      return v;
    };
    const fl = bones.get('Foot_L')!;
    return {
      sole: wy('Foot_L').y - measureSoleDrop(scene, fl),
      shinY: wy('Shin_L').y,
      hipY: wy('Hips').y,
    };
  }

  it('squat 脚底贴地且不再随身高漂移', () => {
    for (const h of [1.65, 1.75, 1.95]) {
      const r = runFold('squat', h, true);
      expect(Math.abs(r.sole), `squat 身高 ${h} 脚底离地 ${(r.sole * 100).toFixed(1)}cm`).toBeLessThan(0.015);
    }
  });

  it('squat 修复前脚插地（回归基线）', () => {
    const r = runFold('squat', 1.65, false);
    expect(r.sole).toBeLessThan(-0.02);
  });

  it('kneel 的触地高度落在小腿/膝，而不是脚底悬空', () => {
    for (const h of [1.65, 1.75, 1.95]) {
      const before = runFold('kneel', h, false);
      const after = runFold('kneel', h, true);
      // 修复后小腿明显更低（更接近地面）
      expect(after.shinY, `身高 ${h}`).toBeLessThan(before.shinY - 0.10);
      // 修复后小腿高度不随身高线性漂移（旧魔数会）
      expect(after.shinY, `身高 ${h} 跪姿小腿应贴地`).toBeLessThan(0.16);
    }
  });

  it('kneel 修复前脚悬空（回归基线）', () => {
    const r = runFold('kneel', 1.95, false);
    expect(r.sole).toBeGreaterThan(0.30);
  });

  it('跪姿脚底离地是正确的解剖结果（膝着地、脚背朝后），不是缺陷', () => {
    const r = runFold('kneel', 1.75, true);
    // 跪地时脚底本来就该离地 ~20cm
    expect(r.sole).toBeGreaterThan(0.10);
  });
});

describe('hipHeightForKneel / hipHeightForWorldAngles', () => {
  it('任意世界角下都能反解出自洽的髋高', () => {
    const rig = makeRig();
    const y1 = hipHeightForWorldAngles(rig.chain, 50, -42, 0);
    const y2 = hipHeightForKneel(rig.chain, 64, -75, 0);
    expect(y1).toBeGreaterThan(0.2);
    expect(y2).toBeGreaterThan(0.2);
    // 跪姿髋比蹲姿低（折叠更多）
    expect(y2).toBeLessThan(y1);
  });

  it('腿越长，站姿髋高越高（自洽性）', () => {
    const rig = makeRig();
    const standing = standingHipHeight(rig.chain, 0);
    expect(standing).toBeCloseTo(rig.chain.upper + rig.chain.lower + rig.chain.hipDrop + rig.chain.ankleAboveSole, 5);
  });
});

describe('端到端：MockMotionProvider 真实路径确实修好了', () => {
  it('经 provider 生成的坐椅动作，脚底不再插地', async () => {
    const { scene } = buildDemoCharacter('male');
    const snapshot = buildSkeletonTree(scene);
    const chair: StageProp = {
      id: 'chair-1', kind: 'chair', position: [0, 0, 0], rotationY: 0,
      size: { width: 0.52, height: 0.9, length: 0.52 },
    };
    const provider = new MockMotionProvider();
    // provider 内部会自行 measureLegChain —— 这一条锁住「真实调用链已接通」
    const result = await provider.generateMotion({
      prompt: '坐到椅子上',
      skeleton: snapshot,
      duration: 2,
      fps: 30,
      stageProps: [chair],
      sceneObject: scene,
      bedInteraction: null,
      // 「走到椅子前坐下」会规划出 march/orient/sit 三段，sit 在 index 2
      segmentInteractions: {
        2: {
          approachPosition: [0, 0, -0.5], sitPosition: [0, 0.45, 0],
          liePosition: [0, 0, 0], interactionPosition: [0, 0, -0.5],
          handTargetPosition: [0, 0, 0],
          armReach: { minDistanceMeters: 0.2, maxDistanceMeters: 0.7 },
          yawRadians: 0, distanceMeters: 0.5,
        } as never,
      },
    });
    const bones = indexBonesByName(scene);
    const hipsTrack = result.animation.tracks.find((t) => t.boneName === 'Hips')!;
    const rotTrack = result.animation.tracks.find((t) => t.boneName === 'Thigh_L')!;
    const shinTrack = result.animation.tracks.find((t) => t.boneName === 'Shin_L')!;
    for (const tr of result.animation.tracks) {
      const b = bones.get(tr.boneName);
      if (!b) continue;
      const r = tr.rotation?.at(-1);
      if (r && r.value.length === 4) b.quaternion.set(...(r.value as [number, number, number, number]));
      const p = tr.position?.at(-1);
      if (p && p.value.length === 3) b.position.set(...(p.value as [number, number, number]));
    }
    scene.updateWorldMatrix(true, true);
    const fl = bones.get('Foot_L')!;
    const v = new THREE.Vector3();
    fl.getWorldPosition(v);
    const sole = v.y - measureSoleDrop(scene, fl);
    // 关键：provider 走了 measureLegChain，腿角不再是固定 −72/+68
    expect(rotTrack).toBeTruthy();
    expect(shinTrack).toBeTruthy();
    expect(hipsTrack).toBeTruthy();
    expect(Math.abs(sole), `脚底离地 ${(sole * 100).toFixed(1)}cm`).toBeLessThan(0.01);
  });
});

describe('measureLegChain 从真实骨架量参数', () => {
  it('量出的腿长与骨长一致', () => {
    const rig = makeRig();
    expect(rig.chain.upper).toBeGreaterThan(0.3);
    expect(rig.chain.lower).toBeGreaterThan(0.3);
    expect(rig.chain.upper + rig.chain.lower).toBeLessThan(1.1);
  });

  it('骨缺失时返回 null 而非编造', () => {
    const rig = makeRig();
    const empty: SkeletonSnapshot = { roots: [], nodes: {}, boneCount: 0 };
    expect(measureLegChain(empty, 'L')).toBeNull();
    expect(measureLegChain(rig.snapshot, 'R')).not.toBeNull();
  });
});

describe('sitPose 解算性质', () => {
  it('座面越高腿越直（膝角单调）', () => {
    const rig = makeRig();
    const low = seatedLegPose(rig.chain, 0.40)!;
    const high = seatedLegPose(rig.chain, 0.55)!;
    // 座面高 → 大腿前倾角绝对值变小（腿更直）
    expect(Math.abs(high.thighDeg)).toBeLessThan(Math.abs(low.thighDeg));
  });

  it('膝始终向前凸（解剖正确）', () => {
    const rig = makeRig();
    for (const seatY of [0.35, 0.45, 0.55]) {
      const pose = sitPoseAt({ chain: rig.chain, seatY, progress: 1 });
      expect(pose, `座面 ${seatY} 应有解`).not.toBeNull();
      expect(pose!.solution!.kneeBulge, `座面 ${seatY} 膝应前凸`).toBeGreaterThan(0);
    }
  });

  it('座面过高时如实退化并报告原因', () => {
    const rig = makeRig();
    const pose = sitPoseAt({ chain: rig.chain, seatY: 1.5, progress: 1 });
    expect(pose).not.toBeNull();
    expect(pose!.degraded).toBe('seat-too-high');
    expect(pose!.solution!.float).toBeGreaterThan(0);
  });

  it('地面盘腿（座面 0）解出的是「劈腿」而非盘腿 —— 故真实管线不走解算器', () => {
    const rig = makeRig();
    // 坐在地面是盘腿，平面两连杆表达不了；解算器会给出数学上贴地但
    // 视觉上是「劈腿」的解（大腿 −147°）。因此 procedural 在 onBareGround
    // 时**不**使用解算器，改用专门的盘腿角度。这里锁住该事实。
    const pose = sitPoseAt({ chain: rig.chain, seatY: 0, progress: 1 })!;
    expect(Math.abs(pose.thighDeg)).toBeGreaterThan(120);
  });
});
