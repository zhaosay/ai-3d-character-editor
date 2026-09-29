import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applySampledPose } from '../src/core/animation/applyPose';
import { sampleAnimation } from '../src/core/animation/sampler';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { bakeDoorHandleContacts } from '../src/core/previs/doorContact';
import { doorHandleWorldPositionAt, sampleDoorOpenAngle, type StageProp } from '../src/core/previs/world';
import { createEmptyAnimation } from '../src/core/animation/types';

describe('baked moving door handle contact', () => {
  it('bakes a reachable hand chain to follow the handle as the door opens', () => {
    const character = new THREE.Group();
    const arm = new THREE.Bone(); arm.name = 'UpperArm_R'; arm.position.set(0.15, 1.15, 0); character.add(arm);
    const forearm = new THREE.Bone(); forearm.name = 'Forearm_R'; forearm.position.set(0.3, 0, 0); arm.add(forearm);
    const hand = new THREE.Bone(); hand.name = 'Hand_R'; hand.position.set(0.3, 0, 0); forearm.add(hand);
    character.updateWorldMatrix(true, true);
    const door: StageProp = { id: 'door', kind: 'door', position: [0, 0, 0], rotationY: Math.PI / 2, size: { width: 0.9, height: 2, length: 0.08 } };
    const actions = [{ t0: 0, t1: 2, template: 'reach', clause: '右手拉门把手', targetPropId: door.id }];
    const contacts = [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand' as const, propId: door.id, surface: 'handle' as const, relation: 'support' as const }];
    const input = createEmptyAnimation('open door', 30, 2);
    const originalArmRotation = arm.quaternion.clone();

    const result = bakeDoorHandleContacts(character, input, buildSkeletonTree(character), [door], actions, contacts);

    expect(result.warnings).toEqual([]);
    expect(result.animation.tracks.map((track) => track.boneName)).toEqual(expect.arrayContaining(['UpperArm_R', 'Forearm_R']));
    expect(arm.quaternion.angleTo(originalArmRotation)).toBe(0);
    const sampleTime = 1.5;
    applySampledPose(character, sampleAnimation(result.animation, sampleTime));
    character.updateWorldMatrix(true, true);
    const handPosition = hand.getWorldPosition(new THREE.Vector3());
    const target = new THREE.Vector3(...doorHandleWorldPositionAt(door, sampleDoorOpenAngle(actions, door.id, sampleTime)));
    expect(handPosition.distanceTo(target)).toBeLessThan(0.01);
  });

  it('bakes a reach-stage hand onto the front edge of a table', () => {
    const character = new THREE.Group();
    const arm = new THREE.Bone(); arm.name = 'UpperArm_R'; arm.position.set(0.15, 1.15, 0); character.add(arm);
    const forearm = new THREE.Bone(); forearm.name = 'Forearm_R'; forearm.position.set(0.3, 0, 0); arm.add(forearm);
    const hand = new THREE.Bone(); hand.name = 'Hand_R'; hand.position.set(0.3, 0, 0); forearm.add(hand);
    character.updateWorldMatrix(true, true);
    const table: StageProp = { id: 'table', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.8, height: 0.75, length: 0.6 } };
    const actions = [{ t0: 0, t1: 2, template: 'reach', clause: '右手把物品放到桌上', targetPropId: table.id }];
    const contacts = [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand' as const, propId: table.id, surface: 'interaction-point' as const, relation: 'support' as const }];
    const result = bakeDoorHandleContacts(character, createEmptyAnimation('place on table', 30, 2), buildSkeletonTree(character), [table], actions, contacts);

    expect(result.warnings).toEqual([]);
    applySampledPose(character, sampleAnimation(result.animation, 1.5));
    character.updateWorldMatrix(true, true);
    const handPosition = hand.getWorldPosition(new THREE.Vector3());
    expect(handPosition.distanceTo(new THREE.Vector3(0, table.size.height, table.size.length / 2))).toBeLessThan(0.01);
  });
});
