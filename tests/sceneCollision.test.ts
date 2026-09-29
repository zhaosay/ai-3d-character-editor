import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEmptyAnimation } from '../src/core/animation/types';
import { formatMotionCollisionWarnings, inspectGroundSupportWarnings, inspectMotionCollisions, inspectPropSupportWarnings, isMotionCollisionWarning } from '../src/core/previs/collision';
import type { StageProp } from '../src/core/previs/world';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';

describe('sampled character and prop collision', () => {
  it('recognizes time-dependent collision warnings so edits can replace stale results', () => {
    expect(isMotionCollisionWarning('动作约 1.2 秒：hand扫掠碰撞检查达到采样上限；无法排除穿过薄物体')).toBe(true);
    expect(isMotionCollisionWarning('动作约 0.4 秒：torso代理估算超出房间边界 12 厘米')).toBe(true);
    expect(isMotionCollisionWarning('动作约 0.8 秒：hand代理与对手 partner的躯干发生估算接触')).toBe(true);
    expect(isMotionCollisionWarning('本地模板动作需要人工复核')).toBe(false);
  });

  it('accepts pelvis support within a rotated bed footprint and warns when it is outside', () => {
    const character = new THREE.Group();
    const pelvis = new THREE.Bone(); pelvis.name = 'pelvis'; pelvis.position.set(0.5, 0.63, 0); character.add(pelvis);
    character.updateWorldMatrix(true, true);
    const bed: StageProp = { id: 'bed', kind: 'bed', position: [0, 0, 0], rotationY: Math.PI / 2, size: { width: 0.6, height: 0.5, length: 1.8 } };
    const animation = createEmptyAnimation('bed support', 30, 1);
    const actions = [{ t0: 0, t1: 1, template: 'lie' }];
    const contacts = [{ phase: 'lie', actionIndex: 0, bodyPart: 'pelvis' as const, propId: bed.id, surface: 'mattress' as const, relation: 'support' as const }];

    expect(inspectPropSupportWarnings(character, animation, actions, contacts, [bed])).toEqual([]);
    pelvis.position.x = 1.2; character.updateWorldMatrix(true, true);
    expect(inspectPropSupportWarnings(character, animation, actions, contacts, [bed])).toEqual([
      expect.stringMatching(/支撑 bed 的床面.*支撑面边界外/),
    ]);
  });

  it('warns when declared seat support floats above the seat surface', () => {
    const character = new THREE.Group();
    const pelvis = new THREE.Bone(); pelvis.name = 'hips'; pelvis.position.set(0, 1.0, 0); character.add(pelvis);
    character.updateWorldMatrix(true, true);
    const chair: StageProp = { id: 'chair-1', kind: 'chair', position: [0, 0, 0], rotationY: 0, size: { width: 0.5, height: 0.9, length: 0.5 } };
    const warnings = inspectPropSupportWarnings(character, createEmptyAnimation('floating sit', 30, 1),
      [{ t0: 0, t1: 1, template: 'sit' }],
      [{ phase: 'sit', actionIndex: 0, bodyPart: 'pelvis', propId: chair.id, surface: 'seat', relation: 'support' }], [chair]);

    expect(warnings).toEqual([expect.stringMatching(/声明pelvis支撑 chair-1.*间隙约 40 厘米/)]);
    expect(pelvis.position.y).toBe(1.0);
  });

  it('reports actual bed-surface penetration depth without adding the tolerance twice', () => {
    const character = new THREE.Group();
    const pelvis = new THREE.Bone(); pelvis.name = 'pelvis'; pelvis.position.set(0, 0.1, 0); character.add(pelvis);
    character.updateWorldMatrix(true, true);
    const bed: StageProp = { id: 'bed-main', kind: 'bed', position: [0, 0, 0], rotationY: 0, size: { width: 1, height: 0.5, length: 2 } };
    const warnings = inspectPropSupportWarnings(character, createEmptyAnimation('penetrating lie', 30, 1),
      [{ t0: 0, t1: 1, template: 'lie' }],
      [{ phase: 'lie', actionIndex: 0, bodyPart: 'pelvis', propId: bed.id, surface: 'mattress', relation: 'support' }], [bed]);

    expect(warnings).toEqual([expect.stringMatching(/穿入床面 53 厘米/)]);
  });

  it('accepts a declared hand support when its capsule reaches the ground plane', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.04, 0); character.add(hand);
    character.updateWorldMatrix(true, true);

    expect(inspectGroundSupportWarnings(character, createEmptyAnimation('grounded hand', 30, 1),
      [{ t0: 0, t1: 1, template: 'kneel' }],
      [{ phase: 'kneel', actionIndex: 0, bodyPart: 'hand', propId: 'ground', surface: 'ground', relation: 'support' }])).toEqual([]);
  });

  it('warns when an explicit ground support remains elevated and does not mutate the live pose', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.4, 0); character.add(hand);
    character.updateWorldMatrix(true, true);

    const warnings = inspectGroundSupportWarnings(character, createEmptyAnimation('floating hand', 30, 1),
      [{ t0: 0, t1: 1, template: 'kneel' }],
      [{ phase: 'kneel', actionIndex: 0, bodyPart: 'hand', propId: 'ground', surface: 'ground', relation: 'support' }]);

    expect(warnings).toEqual([expect.stringMatching(/声明hand支撑地面.*离地 36 厘米/)]);
    expect(hand.position.y).toBe(0.4);
  });

  it('detects an arm bone intersecting the height and footprint of a rotated prop', () => {
    const character = new THREE.Group();
    const shoulder = new THREE.Bone(); shoulder.name = 'shoulder.L'; shoulder.position.set(-0.2, 1.35, 0);
    const arm = new THREE.Bone(); arm.name = 'upperArm.L'; arm.position.set(0.35, 0, 0); shoulder.add(arm);
    const forearm = new THREE.Bone(); forearm.name = 'forearm.L'; forearm.position.set(0.35, 0, 0); arm.add(forearm);
    character.add(shoulder); character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'tall-obstacle', kind: 'table', position: [0.15, 0.7, 0], rotationY: Math.PI / 4, size: { width: 0.25, height: 0.8, length: 0.25 } };
    const animation = createEmptyAnimation('collision', 30, 1);

    const issues = inspectMotionCollisions(character, animation, [prop], [
      { t0: 0, t1: 0.5, template: 'march' }, { t0: 0.5, t1: 1, template: 'reach' },
    ], [{ phase: 'reach', actionIndex: 1, bodyPart: 'hand', propId: prop.id, surface: 'interaction-point', relation: 'rest' }]);

    expect(issues).toEqual([expect.objectContaining({ propId: prop.id, bodyPart: expect.stringMatching(/arm/i) })]);
  });

  it('uses the visible table parts as collision volumes so clear space below the top stays usable', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.3, 0); character.add(hand);
    character.updateWorldMatrix(true, true);
    const table: StageProp = { id: 'desk', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.8, height: 0.75, length: 0.8 } };
    const animation = createEmptyAnimation('reach below desk', 30, 1);
    expect(inspectMotionCollisions(character, animation, [table])).toEqual([]);

    hand.position.y = 0.7;
    character.updateWorldMatrix(true, true);
    expect(inspectMotionCollisions(character, animation, [table])).toEqual([
      expect.objectContaining({ propId: 'desk', bodyPart: 'hand' }),
    ]);
  });

  it('reports the deepest collision time for each body part and prop', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; character.add(hand);
    character.updateWorldMatrix(true, true);
    const table: StageProp = { id: 'depth-table', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.8, height: 0.75, length: 0.8 } };
    const animation = createEmptyAnimation('increasing overlap', 30, 1);
    animation.tracks = [{
      boneName: 'hand.R',
      position: [
        { time: 0, value: [0.54, 0.7, 0], interp: 'linear' },
        { time: 1, value: [0.35, 0.7, 0], interp: 'linear' },
      ],
      rotation: [], scale: [],
    }];

    const finding = inspectMotionCollisions(character, animation, [table])
      .find((issue) => issue.propId === table.id && issue.bodyPart === 'hand');

    expect(finding?.time).toBeCloseTo(1, 1);
    expect(finding?.estimatedOverlapMeters).toBeCloseTo(0.09, 2);
  });

  it('reports maximum penetration for a long bone passing through a thin prop between probe points', () => {
    const character = new THREE.Group();
    const arm = new THREE.Bone(); arm.name = 'upperArm.L'; arm.position.set(-0.93, 0.9, 0);
    const forearm = new THREE.Bone(); forearm.name = 'forearm.L'; forearm.position.set(2, 0, 0); arm.add(forearm);
    character.add(arm); character.updateWorldMatrix(true, true);
    const phone: StageProp = { id: 'thin-phone', kind: 'phone', position: [0, 0.85, 0], rotationY: 0, size: { width: 0.1, height: 0.1, length: 0.1 } };

    const finding = inspectMotionCollisions(character, createEmptyAnimation('deep crossing', 30, 1), [phone])
      .find((item) => item.propId === phone.id && item.bodyPart === 'arm');

    expect(finding?.estimatedOverlapMeters).toBeCloseTo(0.105, 3);
  });

  it('does not report a prop at the same x/z when its height is outside the body', () => {
    const character = new THREE.Group();
    const head = new THREE.Bone(); head.name = 'head'; head.position.set(0, 1.7, 0); character.add(head);
    character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'low-box', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.2, height: 0.3, length: 0.2 } };
    expect(inspectMotionCollisions(character, createEmptyAnimation('clear', 30, 1), [prop])).toEqual([]);
  });

  it('reports body penetration through the ground while tolerating normal foot proxy contact', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, -0.2, 0); character.add(hips);
    const foot = new THREE.Bone(); foot.name = 'Foot_L'; foot.position.set(1, 0.04, 0); character.add(foot);

    const bodyFindings = inspectMotionCollisions(character, createEmptyAnimation('buried body', 30, 1), []);
    expect(bodyFindings).toContainEqual(expect.objectContaining({
      propId: '地面', bodyPart: 'torso', estimatedOverlapMeters: expect.any(Number),
    }));
    expect(formatMotionCollisionWarnings(bodyFindings)).toContainEqual(expect.stringMatching(/torso代理估算穿入地面/));
    foot.position.y = -0.3;
    expect(inspectMotionCollisions(character, createEmptyAnimation('buried foot', 30, 1), [])).toContainEqual(
      expect.objectContaining({ propId: '地面', bodyPart: 'leg' }),
    );
  });

  it('checks body clearance against rotated room walls and ceiling', () => {
    const character = new THREE.Group();
    const head = new THREE.Bone(); head.name = 'head'; head.position.set(0, 1.7, 0); character.add(head);
    const room: StageProp = { id: 'room', kind: 'room', position: [0, 0, 0], rotationY: Math.PI / 2, size: { width: 2, height: 2.4, length: 6 } };
    const animation = createEmptyAnimation('room-clearance', 30, 1);

    expect(inspectMotionCollisions(character, animation, [room])).toEqual([]);

    head.position.set(0, 1.7, 2);
    const wallFindings = inspectMotionCollisions(character, animation, [room]);
    expect(wallFindings).toContainEqual(expect.objectContaining({ propId: '房间边界', bodyPart: 'head' }));
    expect(formatMotionCollisionWarnings(wallFindings)).toContainEqual(expect.stringMatching(/head代理估算超出房间边界/));

    head.position.set(0, 2.35, 0);
    expect(inspectMotionCollisions(character, animation, [room])).toContainEqual(
      expect.objectContaining({ propId: '房间边界', bodyPart: 'head' }),
    );

    const hand = new THREE.Bone(); hand.name = 'Hand_R'; hand.position.set(0, 0.6, 2); character.add(hand);
    const sword: StageProp = { id: 'room-sword', kind: 'sword', position: [0, 0, 0], rotationY: 0, size: { width: 0.04, height: 0.04, length: 0.9 }, attachTo: 'hand.R' };
    expect(inspectMotionCollisions(character, animation, [room, sword], [], [], buildSkeletonTree(character)))
      .toContainEqual(expect.objectContaining({ propId: '房间边界', bodyPart: '剑身 room-sword' }));
  });

  it('labels a planned attack contact with an opponent as contact, not a generic prop collision', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.7, 0); character.add(hand);
    const opponent: StageProp = { id: 'sparring-partner', kind: 'opponent', position: [0, 0, 0], rotationY: 0, size: { width: 0.62, height: 1.72, length: 0.42 } };
    const actions = [{ t0: 0, t1: 1, template: 'punch', clause: '右手出拳', targetPropId: opponent.id }];
    const findings = inspectMotionCollisions(character, createEmptyAnimation('opponent-contact', 30, 1), [opponent], actions);

    expect(findings).toContainEqual(expect.objectContaining({ propId: opponent.id, bodyPart: 'hand', opponentContact: true, opponentZone: 'torso' }));
    expect(formatMotionCollisionWarnings(findings)).toContainEqual(expect.stringMatching(/与对手 sparring-partner的躯干发生估算接触.*区域按占位体估算/));
    const aimedHead = inspectMotionCollisions(character, createEmptyAnimation('opponent-head-contact', 30, 1), [opponent], [
      { ...actions[0], clause: '右手攻击对手头部' },
    ]);
    expect(aimedHead).toContainEqual(expect.objectContaining({ propId: opponent.id, opponentZone: 'torso', requestedOpponentZone: 'head' }));
    expect(formatMotionCollisionWarnings(aimedHead)).toContainEqual(expect.stringMatching(/描述目标为头部，采样接触位置估算为躯干/));
    hand.position.y = 1.5;
    const actualHeadContact = inspectMotionCollisions(character, createEmptyAnimation('actual-head-contact', 30, 1), [opponent], [
      { ...actions[0], clause: '右手攻击对手头部' },
    ]);
    expect(actualHeadContact).toContainEqual(expect.objectContaining({ propId: opponent.id, opponentZone: 'head', requestedOpponentZone: 'head' }));
    const unplanned = inspectMotionCollisions(character, createEmptyAnimation('unplanned-contact', 30, 1), [opponent], [{ ...actions[0], targetPropId: undefined }]);
    expect(unplanned).toContainEqual(expect.objectContaining({ propId: opponent.id, bodyPart: 'hand' }));
    expect(unplanned.find((finding) => finding.propId === opponent.id)?.opponentContact).toBeUndefined();
  });

  it('uses the animated door leaf pose when checking character clearance', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, -0.45); character.add(hips);
    const door: StageProp = { id: 'swing-door', kind: 'door', position: [0, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    const actions = [{ t0: 0, t1: 1, template: 'reach', clause: '打开门', targetPropId: door.id }];

    expect(inspectMotionCollisions(character, createEmptyAnimation('closed-door-clearance', 30, 1), [door])).toEqual([]);
    expect(inspectMotionCollisions(character, createEmptyAnimation('door-swing', 30, 1), [door], actions))
      .toContainEqual(expect.objectContaining({ propId: door.id, bodyPart: 'torso' }));
  });

  it('does not report a capsule that only overlaps the box expanded at a corner', () => {
    const character = new THREE.Group();
    const head = new THREE.Bone(); head.name = 'head'; head.position.set(0.19, 0.29, 0.19); character.add(head);
    character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'corner-box', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.2, height: 0.2, length: 0.2 } };

    expect(inspectMotionCollisions(character, createEmptyAnimation('corner clearance', 30, 1), [prop])).toEqual([]);
  });

  it('detects a fast body proxy sweeping through a prop between clear sampled poses', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(-1, 0.8, 0); character.add(hand);
    character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'thin-obstacle', kind: 'table', position: [0.1, 0.8, 0], rotationY: 0, size: { width: 0.02, height: 0.02, length: 0.02 } };
    const animation = createEmptyAnimation('sweep', 30, 1);
    animation.tracks.push({
      boneName: hand.name,
      position: [
        { time: 0, value: [-1, 0.8, 0], interp: 'linear' },
        { time: 1, value: [1, 0.8, 0], interp: 'linear' },
      ],
      rotation: [], scale: [],
    });

    expect(inspectMotionCollisions(character, animation, [prop])).toContainEqual(
      expect.objectContaining({ propId: prop.id, bodyPart: 'hand', time: expect.any(Number) }),
    );
    expect(hand.position.x).toBe(-1);
  });

  it('samples fast rotational arcs instead of treating a swinging limb as a straight chord', () => {
    const character = new THREE.Group();
    const arm = new THREE.Bone(); arm.name = 'upperArm.L'; arm.position.set(0, 1, 0);
    const forearm = new THREE.Bone(); forearm.name = 'forearm.L'; forearm.position.set(1, 0, 0); arm.add(forearm);
    character.add(arm); character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'arc-obstacle', kind: 'phone', position: [0, 2, 0], rotationY: 0, size: { width: 0.02, height: 0.02, length: 0.02 } };
    const animation = createEmptyAnimation('fast rotational arc', 30, 1);
    animation.tracks.push({
      boneName: arm.name,
      position: [],
      rotation: [
        { time: 0, value: [0, 0, 0, 1], interp: 'linear' },
        { time: 0.02, value: [0, 0, 1, 0], interp: 'linear' },
      ],
      scale: [],
    });

    expect(inspectMotionCollisions(character, animation, [prop])).toContainEqual(
      expect.objectContaining({ propId: prop.id, bodyPart: 'arm', time: expect.any(Number) }),
    );
    expect(arm.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('samples a quickly swinging door even when the character is standing still', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0.186, 1, -0.636); character.add(hand);
    character.updateWorldMatrix(true, true);
    const door: StageProp = { id: 'fast-door', kind: 'door', position: [0, 0, 0], rotationY: 0,
      size: { width: 0.9, height: 2.05, length: 0.08 } };
    const animation = createEmptyAnimation('fast door swing', 30, 1);
    const actions = [{ t0: 0, t1: 0.02, template: 'reach', clause: '伸手触碰门把手并推开门扇', targetPropId: door.id }];

    expect(inspectMotionCollisions(character, animation, [door], actions)).toContainEqual(
      expect.objectContaining({ propId: door.id, bodyPart: 'hand', time: expect.any(Number) }),
    );
    expect(hand.position.toArray()).toEqual([0.186, 1, -0.636]);
  });

  it('checks fast keyframed motion that crosses and returns between uniform samples', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(-1, 0.8, 0); character.add(hand);
    character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'fast-obstacle', kind: 'table', position: [0, 0.8, 0], rotationY: 0, size: { width: 0.02, height: 0.02, length: 0.02 } };
    const animation = createEmptyAnimation('fast-return', 30, 1);
    animation.tracks.push({
      boneName: hand.name,
      position: [
        { time: 0, value: [-1, 0.8, 0], interp: 'linear' },
        { time: 0.02, value: [1, 0.8, 0], interp: 'linear' },
        { time: 0.04, value: [-1, 0.8, 0], interp: 'linear' },
      ],
      rotation: [], scale: [],
    });

    expect(inspectMotionCollisions(character, animation, [prop])).toContainEqual(
      expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }),
    );
  });

  it('warns when an extreme sweep reaches the sampling cap even if only a room is present', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 1, 0); character.add(hand);
    character.updateWorldMatrix(true, true);
    const room: StageProp = { id: 'room', kind: 'room', position: [0, 0, 0], rotationY: 0,
      size: { width: 2000, height: 8, length: 2000 } };
    const animation = createEmptyAnimation('extreme sweep', 30, 1);
    animation.tracks.push({
      boneName: hand.name,
      position: [
        { time: 0, value: [0, 1, 0], interp: 'linear' },
        { time: 1, value: [1000, 1, 0], interp: 'linear' },
      ],
      rotation: [], scale: [],
    });

    const findings = inspectMotionCollisions(character, animation, [room]);
    expect(findings).toContainEqual(expect.objectContaining({ bodyPart: 'hand', sweepSamplingLimited: true }));
    expect(formatMotionCollisionWarnings(findings)).toContainEqual(expect.stringMatching(/达到采样上限.*无法排除穿过薄物体/));
  });

  it('checks attached sword blade sweeps against stage props without requiring a slash effect', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'Hand_R'; hand.position.set(-1, 0.2, 0); character.add(hand);
    character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const obstacle: StageProp = { id: 'pillar', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.08, height: 1.2, length: 0.08 } };
    const sword: StageProp = { id: 'sword', kind: 'sword', position: [0, 0, 0], rotationY: 0, size: { width: 0.04, height: 0.04, length: 0.9 }, attachTo: 'hand.R' };
    const animation = createEmptyAnimation('sword-sweep', 30, 1);
    animation.tracks.push({
      boneName: hand.name,
      position: [
        { time: 0, value: [-1, 0.2, 0], interp: 'linear' },
        { time: 1, value: [1, 0.2, 0], interp: 'linear' },
      ],
      rotation: [], scale: [],
    });

    const findings = inspectMotionCollisions(character, animation, [obstacle, sword],
      [{ t0: 0, t1: 1, template: 'sword', clause: '向前挥剑', targetPropId: sword.id }], [], skeleton);

    expect(findings).toContainEqual(expect.objectContaining({ propId: obstacle.id, bodyPart: expect.stringMatching(/剑身/) }));
  });

  it('allows only the explicitly contacted hand and only during its bound action', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.8, 0); character.add(hand);
    const finger = new THREE.Bone(); finger.name = 'finger.R'; finger.position.set(0.1, 0, 0); hand.add(finger);
    character.updateWorldMatrix(true, true);
    const prop: StageProp = { id: 'phone', kind: 'phone', position: [0.05, 0.8, 0], rotationY: 0, size: { width: 0.1, height: 0.1, length: 0.1 } };
    const animation = createEmptyAnimation('reach', 30, 1);
    const actions = [{ t0: 0, t1: 1, template: 'reach' }];
    const contact = { phase: 'reach', actionIndex: 0, bodyPart: 'hand' as const, propId: prop.id, surface: 'interaction-point' as const, relation: 'rest' as const };

    expect(inspectMotionCollisions(character, animation, [prop], actions, [contact])).toEqual([]);
    expect(inspectMotionCollisions(character, animation, [prop], actions, [])).toContainEqual(expect.objectContaining({ propId: prop.id, bodyPart: 'hand', time: 0 }));
    expect(inspectMotionCollisions(character, animation, [prop], [
      { t0: 0, t1: 0.5, template: 'reach' }, { t0: 0.5, t1: 1, template: 'reach' },
    ], [{ ...contact, actionIndex: undefined }])).toContainEqual(expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }));
  });

  it('scales the body proxy with the character world scale', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0.15, 0.8, 0); character.add(hand);
    const finger = new THREE.Bone(); finger.name = 'finger.R'; finger.position.set(0.01, 0, 0); hand.add(finger);
    const prop: StageProp = { id: 'near-hand', kind: 'phone', position: [0.42, 1.6, 0], rotationY: 0, size: { width: 0.1, height: 0.1, length: 0.1 } };
    const animation = createEmptyAnimation('scale', 30, 1);

    character.updateWorldMatrix(true, true);
    expect(inspectMotionCollisions(character, animation, [prop])).toEqual([]);
    character.scale.setScalar(2); character.updateWorldMatrix(true, true);
    expect(inspectMotionCollisions(character, animation, [prop])).toContainEqual(expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }));
  });

  it('checks terminal hand bones on rigs without finger children', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.L'; hand.position.set(0, 0.8, 0); character.add(hand);
    const prop: StageProp = { id: 'phone', kind: 'phone', position: [0, 0.8, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.14 } };
    expect(inspectMotionCollisions(character, createEmptyAnimation('terminal hand', 30, 1), [prop])).toContainEqual(
      expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }),
    );
  });

  it('samples a carried phone at the same interpolated time as a swept limb', () => {
    const character = new THREE.Group();
    const rightHand = new THREE.Bone(); rightHand.name = 'hand.R'; rightHand.position.set(1, 1.065, 0); character.add(rightHand);
    const leftArm = new THREE.Bone(); leftArm.name = 'upperArm.L'; leftArm.position.set(-1, 1, 0);
    const leftForearm = new THREE.Bone(); leftForearm.name = 'forearm.L'; leftForearm.position.set(0.1, 0, 0); leftArm.add(leftForearm);
    character.add(leftArm); character.updateWorldMatrix(true, true);
    const phone: StageProp = { id: 'phone', kind: 'phone', position: [1, 1, 0], rotationY: 0, size: { width: 0.1, height: 0.1, length: 0.02 } };
    const animation = createEmptyAnimation('crossing carry', 30, 1);
    animation.tracks.push(
      {
        boneName: rightHand.name,
        position: [
          { time: 0, value: [1, 1.065, 0], interp: 'linear' },
          { time: 0.1, value: [-1, 1.065, 0], interp: 'linear' },
        ], rotation: [], scale: [],
      },
      {
        boneName: leftArm.name,
        position: [
          { time: 0, value: [-1, 1, 0], interp: 'linear' },
          { time: 0.1, value: [1, 1, 0], interp: 'linear' },
        ], rotation: [], scale: [],
      },
    );
    const actions = [{ t0: 0, t1: 0.1, template: 'reach', clause: '拿起手机', targetPropId: phone.id }];
    const contacts = [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand' as const, propId: phone.id, surface: 'interaction-point' as const, relation: 'support' as const }];

    const findings = inspectMotionCollisions(character, animation, [phone], actions, contacts, buildSkeletonTree(character));

    const sweptContact = findings.find((finding) => finding.propId === phone.id && finding.bodyPart === 'arm');
    expect(sweptContact).toBeDefined();
    expect(sweptContact!.time).toBeGreaterThan(0.04);
    expect(sweptContact!.time).toBeLessThan(0.07);
  });

  it('warns instead of reporting clean when the rig has no recognized body semantics', () => {
    const character = new THREE.Group();
    const bone = new THREE.Bone(); bone.name = 'mixamorig:Bone_02'; character.add(bone);

    expect(formatMotionCollisionWarnings(inspectMotionCollisions(character, createEmptyAnimation('unmapped', 30, 1), []), character))
      .toEqual([expect.stringMatching(/碰撞检查未生效.*未识别到人体语义骨骼/)]);
  });

  it('does not let an expected hand interaction hide deep object penetration', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.5, 0); character.add(hand);
    const finger = new THREE.Bone(); finger.name = 'finger.R'; finger.position.set(0.1, 0, 0); hand.add(finger);
    const prop: StageProp = { id: 'oversized-phone', kind: 'phone', position: [0.05, 0, 0], rotationY: 0, size: { width: 1, height: 1, length: 1 } };
    const findings = inspectMotionCollisions(character, createEmptyAnimation('deep hand', 30, 1), [prop],
      [{ t0: 0, t1: 1, template: 'reach' }],
      [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand', propId: prop.id, surface: 'interaction-point', relation: 'rest' }]);

    expect(findings).toContainEqual(expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }));
  });

  it('keeps an interaction-point contact from hiding a hand passing through a small prop', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'hand.R'; hand.position.set(0, 0.5, 0); character.add(hand);
    const prop: StageProp = { id: 'phone', kind: 'phone', position: [0, 0.45, 0], rotationY: 0, size: { width: 0.1, height: 0.1, length: 0.1 } };
    const actions = [{ t0: 0, t1: 1, template: 'reach' }];
    const contact = [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand' as const, propId: prop.id, surface: 'interaction-point' as const, relation: 'rest' as const }];

    expect(inspectMotionCollisions(character, createEmptyAnimation('through phone', 30, 1), [prop], actions, contact))
      .toContainEqual(expect.objectContaining({ propId: prop.id, bodyPart: 'hand' }));

    hand.position.x = 0.09;
    expect(inspectMotionCollisions(character, createEmptyAnimation('touch phone edge', 30, 1), [prop], actions, contact)).toEqual([]);
  });
});
