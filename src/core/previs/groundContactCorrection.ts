import * as THREE from 'three';
import type { AnimationData, BoneTrack } from '../animation/types';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { sampleAnimation } from '../animation/sampler';
import type { HumanoidSemantic } from '../skeleton/types';
import type { ContactConstraint } from './world';
import type { QuatTuple } from '../../types/global';

type GroundedAction = { t0: number; t1: number; template: string; clause?: string; actionIndex?: number };

/** Small offline knee corrections keep the procedural preview leg proxies above a declared floor. */
export function correctGroundedLegTracks(
  character: THREE.Object3D,
  animation: AnimationData,
  boneMap: Partial<Record<HumanoidSemantic, string>>,
  actions: GroundedAction[],
  contacts: ContactConstraint[],
  groundY = 0,
): BoneTrack[] {
  const grounded = new Set(contacts.flatMap((contact) => {
    if (contact.propId !== 'ground' || contact.surface !== 'ground' || contact.relation === 'approach') return [];
    const explicitIndex = contact.actionIndex;
    if (explicitIndex !== undefined) return [explicitIndex];
    const matches = actions.flatMap((action, actionIndex) => action.template === contact.phase ? [actionIndex] : []);
    return matches.length === 1 ? matches : [];
  }));
  const targetActions = actions.flatMap((action, index) => grounded.has(index) ? [{ action, index }] : []);
  if (targetActions.length === 0 || !(animation.duration > 0)) return animation.tracks;

  const bones = indexBonesByName(character);
  const legPairs = (['L', 'R'] as const).map((side) => ({
    thigh: bones.get(boneMap[`thigh.${side}`] ?? ''),
    shin: bones.get(boneMap[`shin.${side}`] ?? ''),
  })).filter((pair): pair is { thigh: THREE.Bone; shin: THREE.Bone } => Boolean(pair.thigh && pair.shin));
  if (legPairs.length === 0) return animation.tracks;

  const saved = new Map([...bones].map(([name, bone]) => [name, {
    position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
  }]));
  const corrections = new Map<string, Map<number, QuatTuple>>();
  const step = 1 / 30;
  const candidates = Array.from({ length: 17 }, (_, index) => (index - 8) * 15);
  const localTurn = (base: THREE.Quaternion, degrees: number) => base.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(degrees)),
  );
  const legBottom = (thigh: THREE.Bone, shin: THREE.Bone) => {
    const members = new Set<THREE.Bone>([thigh, shin, ...shin.children.filter((child) => (child as THREE.Bone).isBone) as THREE.Bone[]]);
    const segments = [thigh, shin].flatMap((bone) => bone.children.filter((child): child is THREE.Bone =>
      (child as THREE.Bone).isBone && members.has(child as THREE.Bone)).map((child) => [bone, child] as const));
    return segments.reduce((bottom, [a, b]) => {
      const radius = 0.075 * Math.max(...a.getWorldScale(new THREE.Vector3()).toArray().map(Math.abs));
      return Math.min(bottom, a.getWorldPosition(new THREE.Vector3()).y, b.getWorldPosition(new THREE.Vector3()).y) - radius;
    }, Infinity);
  };

  try {
    for (const { action } of targetActions) {
      if (!Number.isFinite(action.t0) || !Number.isFinite(action.t1) || action.t1 <= action.t0) continue;
      const count = Math.max(2, Math.ceil((action.t1 - action.t0) / step) + 1);
      for (let frame = 0; frame < count; frame++) {
        const time = action.t0 + (action.t1 - action.t0) * frame / (count - 1);
        applySampledPose(character, sampleAnimation(animation, time));
        const timeCorrections = new Map<string, QuatTuple>();
        for (const { thigh, shin } of legPairs) {
          const baseThigh = thigh.quaternion.clone();
          const baseShin = shin.quaternion.clone();
          character.updateWorldMatrix(true, true);
          const originalBottom = legBottom(thigh, shin);
          if (originalBottom >= groundY - 0.08) {
            timeCorrections.set(thigh.name, [baseThigh.x, baseThigh.y, baseThigh.z, baseThigh.w]);
            timeCorrections.set(shin.name, [baseShin.x, baseShin.y, baseShin.z, baseShin.w]);
            continue;
          }

          let best = { thighDelta: 0, shinDelta: 0, bottom: originalBottom, cost: Infinity };
          for (const thighDelta of candidates) {
            thigh.quaternion.copy(localTurn(baseThigh, thighDelta));
            for (const shinDelta of candidates) {
              shin.quaternion.copy(localTurn(baseShin, shinDelta));
              character.updateWorldMatrix(true, true);
              const bottom = legBottom(thigh, shin);
              const penetration = Math.max(0, groundY - 0.08 - bottom);
              const cost = penetration * 100000000 + thighDelta * thighDelta * 1.5 + shinDelta * shinDelta;
              if (cost < best.cost) best = { thighDelta, shinDelta, bottom, cost };
            }
          }
          thigh.quaternion.copy(localTurn(baseThigh, best.thighDelta));
          shin.quaternion.copy(localTurn(baseShin, best.shinDelta));
          character.updateWorldMatrix(true, true);
          timeCorrections.set(thigh.name, [thigh.quaternion.x, thigh.quaternion.y, thigh.quaternion.z, thigh.quaternion.w]);
          timeCorrections.set(shin.name, [shin.quaternion.x, shin.quaternion.y, shin.quaternion.z, shin.quaternion.w]);
        }
        timeCorrections.forEach((quaternion, boneName) => {
          const keys = corrections.get(boneName) ?? new Map<number, QuatTuple>();
          keys.set(Math.round(time * 1000) / 1000, quaternion);
          corrections.set(boneName, keys);
        });
      }
    }
  } finally {
    saved.forEach((pose, name) => {
      const bone = bones.get(name);
      if (!bone) return;
      bone.position.copy(pose.position);
      bone.quaternion.copy(pose.quaternion);
      bone.scale.copy(pose.scale);
    });
    character.updateWorldMatrix(true, true);
  }

  if (corrections.size === 0) return animation.tracks;
  const tracks = animation.tracks.map((track) => {
    const additions = corrections.get(track.boneName);
    if (!additions) return track;
    const rotations = new Map(track.rotation
      .filter((key) => !targetActions.some(({ action }) => key.time >= action.t0 - 1e-4 && key.time <= action.t1 + 1e-4))
      .map((key) => [Math.round(key.time * 1000) / 1000, key]));
    additions.forEach((value, time) => rotations.set(time, { time, value, interp: 'linear' }));
    return { ...track, rotation: [...rotations.values()].sort((a, b) => a.time - b.time) };
  });
  for (const [boneName, additions] of corrections) {
    if (tracks.some((track) => track.boneName === boneName)) continue;
    tracks.push({ boneName, position: [], rotation: [...additions].map(([time, value]) => ({ time, value, interp: 'linear' as const })).sort((a, b) => a.time - b.time), scale: [] });
  }
  return tracks;
}
