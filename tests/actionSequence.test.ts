import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { sequencePlan, ACTION_PRESETS } from '../src/services/motion/presets';
import { sampleQuatTrack, sampleVec3Track } from '../src/core/animation/sampler';

function generate(indices: number[]) {
  const actor = buildDemoCharacter();
  const snap = buildSkeletonTree(actor.scene);
  const segments = sequencePlan(indices.map((i) => ({ ...ACTION_PRESETS[i] })));
  const result = generatePlannedTracks(buildBoneMap(snap), segments, segments.at(-1)!.t1, 0, buildRestMap(snap), buildRestPositionMap(snap));
  actor.dispose();
  return result;
}
describe('action sequences', () => {
  it('holds the walking endpoint throughout a pause before another walk', () => {
    const result = generate([1, 0, 1]);
    const keys = result.tracks.find((t) => t.boneName === 'Hips')!.position;
    expect(sampleVec3Track(keys, 3)).toEqual(sampleVec3Track(keys, 4));
    expect(sampleVec3Track(keys, 4)).toEqual(sampleVec3Track(keys, 5));
    expect(sampleVec3Track(keys, 8)![2]).toBeGreaterThan(sampleVec3Track(keys, 5)![2]);
  });
  it('has no rotation jump at action boundaries and no duplicate keys', () => {
    const result = generate([1, 0, 2, 4]);
    for (const track of result.tracks) {
      if (!track.rotation.length) continue;
      for (let i = 1; i < track.rotation.length; i++) expect(track.rotation[i].time).toBeGreaterThan(track.rotation[i - 1].time);
      for (const time of [3, 5, 7]) {
        const a = new THREE.Quaternion(...sampleQuatTrack(track.rotation, time - 0.001)!);
        const b = new THREE.Quaternion(...sampleQuatTrack(track.rotation, time + 0.001)!);
        expect(a.angleTo(b)).toBeLessThan(0.03);
      }
    }
  });
  it('rejects invalid segment duration', () => {
    expect(() => sequencePlan([{ ...ACTION_PRESETS[0], duration: NaN }])).toThrow();
  });
});
