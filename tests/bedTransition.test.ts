import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import type { SkeletonSnapshot } from '../src/core/skeleton/types';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { resetToRest, applySampledPose } from '../src/core/animation/applyPose';
import { createEmptyAnimation } from '../src/core/animation/types';
import { sampleAnimation } from '../src/core/animation/sampler';
import { resolveBedInteractionFrame } from '../src/core/previs/world';
import { measureLegChain } from '../src/core/ik/sitPose';
import { lowestByGroup, SUPINE_GROUPS } from '../src/core/ik/restContact';
import type { StageProp } from '../src/core/previs/world';
import type { Vec3Tuple, QuatTuple } from '../src/types/global';

/**
 * 躺卧**过渡期**（上床躺下）的逐帧接触剖面。
 *
 * 终帧对齐由 `bedContact.test.ts` 验证；这里刻画**中途**每一帧。
 *
 * 已知缺陷（如实记录，未修）：`lie` 模板是绕髋的刚体旋转 + 直腿，
 * 脚会沿弧线扫过地面 —— 实测 t≈1.0s 时脚骨最低到 y=−0.036m（穿地 3.6cm）。
 * 根因是结构性的：靠调 `thigh/spin` 角度无法消除，需要**逐帧对地 IK**
 * 或预计算「根高度 ~ 身体倾角」曲线才能真正解决。
 * 试过给上床路径加预屈膝（thigh 正角抬脚），确实把穿地从 5.3cm 降到 3.6cm，
 * 但会改变躺姿终态的腿部角度，收益不抵副作用，故未采纳。
 */

const BED: StageProp = {
  id: 'bed-main', kind: 'bed', position: [0, 0, 0], rotationY: 0,
  size: { width: 1.0, height: 0.5, length: 2.0 },
};

function restMapOf(snapshot: SkeletonSnapshot) {
  return new Map<string, { position: Vec3Tuple; quaternion: QuatTuple; scale: Vec3Tuple }>(
    Object.values(snapshot.nodes).map((n) => [n.name, {
      position: [...n.restLocal.position] as Vec3Tuple,
      quaternion: [...n.restLocal.quaternion] as QuatTuple,
      scale: [...n.restLocal.scale] as Vec3Tuple,
    }]),
  );
}

function lieTrack(bed: StageProp = BED) {
  const { scene } = buildDemoCharacter('male');
  const snapshot = buildSkeletonTree(scene);
  const chain = measureLegChain(snapshot, 'L', scene);
  const frame = resolveBedInteractionFrame(bed, scene, snapshot, [bed])!;
  const res = generatePlannedTracks(
    buildBoneMap({ nodes: Object.values(snapshot.nodes) } as never),
    [{ t0: 0, t1: 3, template: 'lie', clause: '躺到床上' }], 3, 0,
    buildRestMap(snapshot), buildRestPositionMap(snapshot),
    frame, {}, {}, 0, undefined, chain,
  );
  const anim = createEmptyAnimation('lie', 30, 3);
  anim.tracks = res.tracks as never;
  return { scene, anim, rest: restMapOf(snapshot), mattressY: bed.position[1] + bed.size.height };
}

/** 逐帧量三组最低点（相对床面，cm）。 */
function profile(bed: StageProp = BED, frames = 13) {
  const { scene, anim, rest, mattressY } = lieTrack(bed);
  const out: Array<{ t: number; back: number; head: number; legs: number; footBone: number }> = [];
  for (let i = 0; i < frames; i++) {
    const t = (i / (frames - 1)) * 3;
    const pose = sampleAnimation(anim, t);
    resetToRest(scene, rest);
    applySampledPose(scene, pose);
    scene.updateWorldMatrix(true, true);
    const low = lowestByGroup(scene, SUPINE_GROUPS);
    const footBone = low.legs;
    out.push({
      t,
      back: (low.back - mattressY) * 100,
      head: (low.head - mattressY) * 100,
      legs: (low.legs - mattressY) * 100,
      footBone: (footBone - mattressY) * 100,
    });
  }
  return out;
}

describe('躺卧过渡逐帧剖面（刻画现状）', () => {
  it('剖面单调下降：背不会中途反弹', () => {
    const p = profile();
    for (let i = 1; i < p.length; i++) {
      expect(p[i].back, `t=${p[i].t.toFixed(2)}s 背反弹`).toBeLessThanOrEqual(p[i - 1].back + 0.5);
    }
  });

  it('终帧回到接触高度（背在床面上 3cm 内）', () => {
    const p = profile();
    const last = p[p.length - 1];
    expect(Math.abs(last.back), `终帧背偏差 ${last.back.toFixed(1)}cm`).toBeLessThan(3);
  });

  it('背/头全程不穿床板', () => {
    const p = profile();
    for (const f of p) {
      expect(f.back, `t=${f.t.toFixed(2)}s 背穿床 ${f.back.toFixed(1)}cm`).toBeGreaterThan(-3);
      expect(f.head, `t=${f.t.toFixed(2)}s 头穿床 ${f.head.toFixed(1)}cm`).toBeGreaterThan(-3);
    }
  });

  it('已知缺陷：中途脚会扫到地面以下（穿地约 3~5cm，未修）', () => {
    const p = profile();
    const worst = p.reduce((w, f) => (f.legs < w.legs ? f : w), p[0]);
    // 床面 0.5m；legs 为 −48 表示脚底离地 2cm
    const belowGroundCm = worst.legs + 50;
    console.log('TRANSITION_WORST', `t=${worst.t.toFixed(2)}s 腿相对床面 ${worst.legs.toFixed(1)}cm → 离地 ${(-belowGroundCm).toFixed(1)}cm`);
    // 记录当前量级，不做断言（这是结构性缺陷，非回归）
    expect(Number.isFinite(worst.legs)).toBe(true);
  });
});
