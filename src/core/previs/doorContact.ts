import * as THREE from 'three';
import type { AnimationData, BoneTrack, Keyframe } from '../animation/types';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { sampleAnimation } from '../animation/sampler';
import { applyIKChain } from '../ik/applyIK';
import { detectIKChains } from '../ik/chains';
import type { SkeletonSnapshot } from '../skeleton/types';
import type { QuatTuple } from '../../types/global';
import { doorHandleWorldPositionAt, propInteractionWorldPoint, sampleDoorOpenAngle, type ContactConstraint, type StageProp } from './world';

export interface DoorContactBake {
  animation: AnimationData;
  warnings: string[];
}

function upsertRotationKeys(track: BoneTrack, start: number, end: number, keys: Keyframe<QuatTuple>[]): BoneTrack {
  const kept = track.rotation.filter((key) => key.time < start - 1e-4 || key.time > end + 1e-4);
  const byTime = new Map<number, Keyframe<QuatTuple>>();
  for (const key of [...kept, ...keys]) byTime.set(Math.round(key.time * 1000) / 1000, key);
  return { ...track, rotation: [...byTime.values()].sort((a, b) => a.time - b.time) };
}

/** Bake hand IK for door handles and ordinary prop interaction points into bone tracks. */
export function bakeDoorHandleContacts(
  character: THREE.Object3D,
  animation: AnimationData,
  skeleton: SkeletonSnapshot,
  props: StageProp[],
  actions: Array<{ t0: number; t1: number; template: string; clause: string; targetPropId?: string }>,
  contacts: ContactConstraint[],
): DoorContactBake {
  const warnings: string[] = [];
  const chains = new Map(detectIKChains(skeleton).map((chain) => [chain.id, chain]));
  const bones = indexBonesByName(character);
  const candidates = contacts.flatMap((contact) => {
    const handleContact = contact.surface === 'handle';
    const propContact = contact.surface === 'interaction-point' && contact.relation === 'support';
    if ((!handleContact && !propContact) || contact.bodyPart !== 'hand' || contact.relation === 'approach') return [];
    let actionIndex = contact.actionIndex;
    if (actionIndex === undefined) {
      const matching = actions.flatMap((action, index) => action.template === contact.phase ? [index] : []);
      if (matching.length !== 1) return [];
      actionIndex = matching[0];
    }
    const action = actions[actionIndex];
    const prop = props.find((item) => item.id === contact.propId && item.kind !== 'room');
    if (!action || action.template !== 'reach' || action.targetPropId !== prop?.id || !prop) return [];
    if (handleContact && prop.kind !== 'door') return [];
    const side: 'L' | 'R' = /左手|左臂/.test(action.clause) ? 'L' : 'R';
    return [{ actionIndex, action, prop, side, handleContact }];
  }).sort((a, b) => a.actionIndex - b.actionIndex);
  if (candidates.length === 0) return { animation, warnings };

  const saved = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  bones.forEach((bone, name) => saved.set(name, { position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }));
  let output: AnimationData = { ...animation, tracks: animation.tracks.map((track) => structuredClone(track)) };
  const completed = new Set<string>();
  try {
    for (const candidate of candidates) {
      const { actionIndex, action, prop, side, handleContact } = candidate;
      const chain = chains.get(side === 'L' ? 'arm.L' : 'arm.R');
      const root = bones.get(chain?.rootBone ?? '');
      const mid = bones.get(chain?.midBone ?? '');
      const hand = bones.get(chain?.endBone ?? '');
      if (!chain || !root || !mid || !hand) {
        warnings.push(`第 ${actionIndex + 1} 段交互缺少${side === 'L' ? '左' : '右'}臂完整 IK 骨架链，无法让手部到达目标`);
        continue;
      }
      const span = action.t1 - action.t0;
      if (!Number.isFinite(span) || span <= 0) continue;
      const sampleCount = Math.min(61, Math.max(3, Math.ceil(span * 20) + 1));
      const attachDuration = 0.18;
      const handStart = new THREE.Vector3();
      const bakedRoot: Keyframe<QuatTuple>[] = [];
      const bakedMid: Keyframe<QuatTuple>[] = [];
      let hasStart = false;
      let clampedCount = 0;

      for (let i = 0; i < sampleCount; i++) {
        const time = action.t0 + span * i / (sampleCount - 1);
        applySampledPose(character, sampleAnimation(output, time));
        character.updateWorldMatrix(true, true);
        if (!hasStart) {
          hand.getWorldPosition(handStart);
          hasStart = true;
        }
        const progress = (time - action.t0) / span;
        const handleTarget = handleContact
          ? new THREE.Vector3(...doorHandleWorldPositionAt(prop, sampleDoorOpenAngle(actions, prop.id, time)))
          : new THREE.Vector3(...propInteractionWorldPoint(prop));
        const attachProgress = Math.min(Math.max(progress / attachDuration, 0), 1);
        const easedAttach = attachProgress * attachProgress * (3 - 2 * attachProgress);
        const target = handStart.clone().lerp(handleTarget, easedAttach);
        const middlePosition = mid.getWorldPosition(new THREE.Vector3());
        const midRest = Object.values(skeleton.nodes).find((node) => node.name === chain.midBone)?.world.position;
        const poleOffset = midRest
          ? new THREE.Vector3(...chain.defaultPolePoint).sub(new THREE.Vector3(...midRest))
          : new THREE.Vector3(0, 0, 0.3);
        const pole = middlePosition.add(poleOffset);
        const solved = applyIKChain(bones, chain, [target.x, target.y, target.z], [pole.x, pole.y, pole.z]);
        if (!solved?.reached) clampedCount++;
        bakedRoot.push({ time: Math.round(time * 1000) / 1000, value: [root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w], interp: 'linear' });
        bakedMid.push({ time: Math.round(time * 1000) / 1000, value: [mid.quaternion.x, mid.quaternion.y, mid.quaternion.z, mid.quaternion.w], interp: 'linear' });
      }

      const trackByName = new Map(output.tracks.map((track) => [track.boneName, track]));
      for (const [bone, keys] of [[root, bakedRoot], [mid, bakedMid]] as const) {
        const existing = trackByName.get(bone.name) ?? { boneName: bone.name, position: [], rotation: [], scale: [] };
        trackByName.set(bone.name, upsertRotationKeys(existing, action.t0, action.t1, keys));
      }
      output = { ...output, tracks: [...trackByName.values()] };
      const warningKey = `${actionIndex}:${side}`;
      if (clampedCount > sampleCount * 0.2 && !completed.has(warningKey)) {
        warnings.push(`第 ${actionIndex + 1} 段${handleContact ? '门把手' : '物体交互点'}超出${side === 'L' ? '左' : '右'}臂可达范围，无法保证持续接触`);
      }
      completed.add(warningKey);
    }
  } finally {
    const live = indexBonesByName(character);
    saved.forEach((pose, name) => {
      const bone = live.get(name);
      if (!bone) return;
      bone.position.copy(pose.position);
      bone.quaternion.copy(pose.quaternion);
      bone.scale.copy(pose.scale);
    });
    character.updateWorldMatrix(true, true);
  }
  return { animation: output, warnings };
}
