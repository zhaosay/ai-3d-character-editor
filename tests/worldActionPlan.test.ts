import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { inspectGroundSupportWarnings, inspectMotionCollisions } from '../src/core/previs/collision';
import { correctGroundedLegTracks } from '../src/core/previs/groundContactCorrection';
import { sampleAnimation } from '../src/core/animation/sampler';
import { ambiguousSceneObjectWarnings, ambiguousScenePropIds, decomposeSceneAction, decomposeWorldAction, DOOR_HANDLE_RADIUS, doorHandleLocalHeight, doorHandleLocalPosition, doorHandleWorldPosition, estimateGroundHipLocalOffset, resolveBedInteractionFrame, resolvePropInteractionFrame, resolveSequentialInteractionFrames, sampleDoorOpenAngle, samplePortablePropTransfer, sampleWeaponAttachment, type StageProp } from '../src/core/previs/world';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks } from '../src/services/motion/procedural';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { createScenePlan, validateScenePlan } from '../src/core/previs/scenePlan';

const bed: StageProp = {
  id: 'bed-main', kind: 'bed', position: [1.35, 0, 0], rotationY: 0,
  size: { width: 1.3, height: 0.58, length: 2.1 },
};

describe('world action planning', () => {
  const table: StageProp = { id: 'table-main', kind: 'table', position: [1, 0, 0], rotationY: 0, size: { width: 1.1, height: 0.75, length: 0.7 } };
  const phone: StageProp = { id: 'phone-main', kind: 'phone', position: [1, 0.76, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
  const chair: StageProp = { id: 'chair-main', kind: 'chair', position: [1, 0, 0], rotationY: 0, size: { width: 0.52, height: 0.9, length: 0.52 } };

  it('resolves multi-object language to the object used by the action', () => {
    const plan = decomposeSceneAction('走到桌前，拿起手机，再回头看门口', 4, [table, phone])!;
    expect(plan.targetPropId).toBe('phone-main');
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach', 'look']);
    expect(plan.contacts[0]).toMatchObject({ bodyPart: 'hand', propId: 'phone-main' });
  });

  it('asks which same-kind prop to use instead of selecting the first one silently', () => {
    const phoneB: StageProp = { ...phone, id: 'phone-b', position: [2, 0.76, 0] };
    expect(ambiguousSceneObjectWarnings('拿起手机', [phone, phoneB]).join()).toMatch(/多个手机.*phone-main、phone-b/);
    expect(ambiguousScenePropIds('拿起手机', [phone, phoneB])).toEqual(['phone-main', 'phone-b']);
    expect(ambiguousScenePropIds('拿起手机 phone-b', [phone, phoneB])).toEqual([]);
    expect(decomposeSceneAction('拿起手机', 4, [phone, phoneB])).toBeNull();
    expect(decomposeSceneAction('拿起手机 phone-b', 4, [phone, phoneB])?.targetPropId).toBe('phone-b');
  });

  it('decomposes pickup-and-place into ordered, independently targeted stages', () => {
    const plan = decomposeSceneAction('走到桌前，拿起手机，然后把手机放到桌上', 8, [table, phone])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach', 'march', 'orient', 'reach']);
    expect(plan.segments.map((segment) => segment.targetPropId)).toEqual(['phone-main', 'phone-main', 'phone-main', 'table-main', 'table-main', 'table-main']);
    expect(plan.contacts).toEqual([
      { phase: 'reach', actionIndex: 2, bodyPart: 'hand', propId: 'phone-main', surface: 'interaction-point', relation: 'support' },
      { phase: 'reach', actionIndex: 5, bodyPart: 'hand', propId: 'table-main', surface: 'interaction-point', relation: 'support' },
    ]);
    expect(plan.segments[0].t0).toBe(0);
    expect(plan.segments.at(-1)?.t1).toBe(8);
  });

  it('carries a picked-up phone with the hand and releases it onto the target surface', () => {
    const plan = decomposeSceneAction('走到桌前，拿起手机，然后把手机放到桌上', 8, [table, phone])!;
    const pickup = plan.segments[2];
    const release = plan.segments[5];
    expect(samplePortablePropTransfer(phone, [table, phone], plan.segments, plan.contacts, pickup.t0 - 0.01)).toBeNull();
    expect(samplePortablePropTransfer(phone, [table, phone], plan.segments, plan.contacts, pickup.t1 + 0.1)).toMatchObject({ attachmentWeight: 1, hand: 'hand.R' });
    expect(samplePortablePropTransfer(phone, [table, phone], plan.segments, plan.contacts, release.t1)).toMatchObject({
      attachmentWeight: 0,
      placementPosition: [1, 0.75, 0.35],
    });
  });

  it('keeps a later door destination after the phone pickup stage', () => {
    const plan = decomposeSceneAction('人物走到桌前，拿起手机，然后走到门口', 6, [table, phone, { ...table, id: 'door-main', kind: 'door', position: [-4, 0, 0] }])!;

    expect(plan.segments.map((segment) => [segment.template, segment.targetPropId])).toEqual([
      ['march', phone.id], ['orient', phone.id], ['reach', phone.id], ['march', 'door-main'],
    ]);
    expect(plan.contacts).toMatchObject([{ actionIndex: 2, propId: phone.id, bodyPart: 'hand' }]);
    expect(plan.targetPropId).toBe('door-main');
  });

  it('plans placement onto a named support surface without treating the item as the target', () => {
    const plan = decomposeSceneAction('把手中的手机放到桌上', 4, [table, phone])!;
    expect(plan.targetPropId).toBe('table-main');
    expect(plan.segments.at(-1)).toMatchObject({ template: 'reach', targetPropId: 'table-main' });
    expect(plan.contacts[0]).toMatchObject({ actionIndex: 2, propId: 'table-main', relation: 'support' });
  });

  it('preserves distinct hand choices for pickup and placement phases', () => {
    const plan = decomposeSceneAction('左手拿起手机，然后用右手放到桌上', 6, [table, phone])!;
    expect(plan.segments[2]).toMatchObject({ template: 'reach', clause: expect.stringMatching(/^左手/), targetPropId: phone.id });
    expect(plan.segments[5]).toMatchObject({ template: 'reach', clause: expect.stringMatching(/^右手/), targetPropId: table.id });

    const boneMap = {
      spine: 'Spine', chest: 'Chest', head: 'Head',
      'upperArm.L': 'UpperArmL', 'forearm.L': 'ForearmL', 'hand.L': 'HandL',
      'upperArm.R': 'UpperArmR', 'forearm.R': 'ForearmR', 'hand.R': 'HandR',
    };
    const generated = generatePlannedTracks(boneMap, plan.segments, 6);
    const animation = { id: 'two-handed-transfer', name: 'two-handed-transfer', duration: 6, fps: 30, tracks: generated.tracks };
    const rotationDistance = (boneName: string, time: number) => {
      const q = sampleAnimation(animation, time).get(boneName)!.quaternion!;
      return Math.hypot(q[0], q[1], q[2], q[3] - 1);
    };
    const pickupTime = (plan.segments[2].t0 + plan.segments[2].t1) / 2;
    const placementTime = (plan.segments[5].t0 + plan.segments[5].t1) / 2;
    expect(rotationDistance('UpperArmL', pickupTime)).toBeGreaterThan(rotationDistance('UpperArmR', pickupTime));
    expect(rotationDistance('UpperArmR', placementTime)).toBeGreaterThan(rotationDistance('UpperArmL', placementTime));
  });

  it('does not create a phone pickup when the pickup is explicitly negated', () => {
    const plan = decomposeSceneAction('不要拿手机，只回头看门口', 4, [table, phone]);
    expect(plan).toBeNull();
  });

  it('keeps a positive action after a negated clause', () => {
    const door: StageProp = { id: 'door-main', kind: 'door', position: [1, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    const plan = decomposeSceneAction('不要拿手机，但是走到门口开门', 4, [phone, door])!;
    expect(plan.targetPropId).toBe('door-main');
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach']);
    expect(plan.contacts[0]).toMatchObject({ propId: 'door-main', surface: 'handle' });
  });

  it('plans door opening and closing and samples the door leaf on the action timeline', () => {
    const door: StageProp = { id: 'door-timeline', kind: 'door', position: [1, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    const open = decomposeSceneAction('走到门口开门', 4, [door])!;
    expect(open.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach']);
    expect(open.contacts).toContainEqual(expect.objectContaining({ phase: 'reach', propId: door.id, surface: 'handle' }));
    expect(sampleDoorOpenAngle(open.segments, door.id, 0)).toBe(0);
    expect(sampleDoorOpenAngle(open.segments, door.id, open.segments[2].t0 + (open.segments[2].t1 - open.segments[2].t0) / 2)).toBeGreaterThan(0.4);
    expect(sampleDoorOpenAngle(open.segments, door.id, 4)).toBeCloseTo(Math.PI / 2);

    const close = decomposeSceneAction('走到门前关上门', 3, [door])!;
    const actions = [...open.segments, ...close.segments.map((segment) => ({ ...segment, t0: segment.t0 + 4, t1: segment.t1 + 4 }))];
    expect(sampleDoorOpenAngle(actions, door.id, 5)).toBeCloseTo(Math.PI / 2);
    expect(sampleDoorOpenAngle(actions, door.id, 7)).toBeLessThan(0.1);

    const passThrough = decomposeSceneAction('开门后走进去再关门', 8, [door])!;
    expect(passThrough.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach', 'march', 'reach']);
    expect(passThrough.contacts.map((contact) => contact.actionIndex)).toEqual([2, 4]);
    expect(sampleDoorOpenAngle(passThrough.segments, door.id, passThrough.segments[3].t0)).toBeCloseTo(Math.PI / 2);
    expect(sampleDoorOpenAngle(passThrough.segments, door.id, 8)).toBeCloseTo(0);
  });

  it('aims the hand interaction at the rendered door handle height', () => {
    const door: StageProp = { id: 'door-handle', kind: 'door', position: [1, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips);
    character.updateWorldMatrix(true, true);

    const frame = resolvePropInteractionFrame(door, character, buildSkeletonTree(character))!;

    expect(doorHandleLocalHeight(door)).toBeCloseTo(0.96);
    expect(frame.handTargetPosition).toEqual(doorHandleWorldPosition(door));
    const rotatedDoor = { ...door, rotationY: Math.PI / 2 };
    const rotatedFrame = resolvePropInteractionFrame(rotatedDoor, character, buildSkeletonTree(character))!;
    expect(rotatedFrame.handTargetPosition).toEqual(doorHandleWorldPosition(rotatedDoor));
  });

  it('keeps the door handle mounted to thin and standard-thickness door leaves', () => {
    for (const thickness of [0.02, 0.08]) {
      const door: StageProp = { id: `door-${thickness}`, kind: 'door', position: [0, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: thickness } };
      const handle = doorHandleLocalPosition(door);
      const doorSurface = thickness / 2;

      expect(handle[2] - doorSurface).toBeCloseTo(0.035);
      expect(handle[2] - doorSurface).toBeCloseTo(DOOR_HANDLE_RADIUS);
    }
  });

  it('does not turn a negated pickup followed by a look into a walk-to-door action', () => {
    const door: StageProp = { id: 'door-main', kind: 'door', position: [1, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    expect(decomposeSceneAction('不要拿手机，然后回头看门口', 4, [phone, door])).toBeNull();
  });

  it('plans weapon attacks and guards in order, binds the weapon target, and keeps punch distinct from sword', () => {
    const sword: StageProp = { id: 'sword-main', kind: 'sword', position: [0, 1, 0], rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R' };
    const swordPlan = decomposeSceneAction('挥剑后格挡', 4, [sword])!;
    expect(swordPlan.segments.map((segment) => segment.template)).toEqual(['orient', 'sword', 'block']);
    expect(swordPlan.segments[1].targetPropId).toBe(sword.id);
    expect(swordPlan.contacts).toContainEqual(expect.objectContaining({ phase: 'sword', propId: sword.id, bodyPart: 'hand', actionIndex: 1 }));
    expect(swordPlan.warnings.join()).toMatch(/没有对手目标与碰撞判定/);
    const punchPlan = decomposeSceneAction('出拳后格挡', 4, [])!;
    expect(punchPlan.segments.map((segment) => segment.template)).toEqual(['orient', 'punch', 'block']);
    expect(decomposeSceneAction('先格挡再出拳', 4, [])?.segments.map((segment) => segment.template)).toEqual(['orient', 'block', 'punch']);
    const repeated = decomposeSceneAction('连续挥剑三次后格挡', 6, [sword])!;
    expect(repeated.segments.map((segment) => segment.template)).toEqual(['orient', 'sword', 'sword', 'sword', 'block']);
    expect(repeated.segments.slice(1, 4).map((segment) => segment.clause)).toEqual(['第1次挥剑并回到防守姿势', '第2次挥剑并回到防守姿势', '第3次挥剑并回到防守姿势']);
    expect(repeated.contacts.map((contact) => contact.actionIndex)).toEqual([1, 2, 3]);
    const leftPunch = decomposeSceneAction('左手出拳', 2, [])!;
    expect(leftPunch.segments.at(-1)?.clause).toMatch(/左手出拳/);
    expect(decomposeSceneAction('左腿踢击', 2, [])?.segments.at(-1)?.clause).toMatch(/左腿踢击/);
    expect(decomposeSceneAction('不要挥剑，然后回头看门口', 4, [sword])).toBeNull();
  });

  it('binds attacks to a placed opponent and plans a safe approach before combat', () => {
    const sword: StageProp = { id: 'sword-main', kind: 'sword', position: [0, 1, 0], rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R' };
    const opponent: StageProp = { id: 'opponent-1', kind: 'opponent', position: [0, 0, 1.6], rotationY: Math.PI, size: { width: 0.62, height: 1.72, length: 0.42 } };
    const plan = decomposeSceneAction('挥剑攻击对手后格挡', 5, [sword, opponent])!;

    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sword', 'block']);
    expect(plan.segments.slice(0, 3).map((segment) => segment.targetPropId)).toEqual([opponent.id, opponent.id, opponent.id]);
    expect(plan.contacts).toEqual([]);
    expect(plan.warnings.join()).toMatch(/静态占位体/);
  });

  it('uses a clear left/right opponent cue to resolve multiple combat targets', () => {
    const opponents: StageProp[] = [
      { id: 'opponent-left', kind: 'opponent', position: [-0.8, 0, 1.6], rotationY: Math.PI + 0.4, size: { width: 0.62, height: 1.72, length: 0.42 } },
      { id: 'opponent-right', kind: 'opponent', position: [0.8, 0, 1.6], rotationY: Math.PI - 0.4, size: { width: 0.62, height: 1.72, length: 0.42 } },
    ];
    const leftPrompt = '挥剑攻击左侧对手';
    const rightPrompt = '挥剑攻击右边的对手';

    expect(ambiguousSceneObjectWarnings(leftPrompt, opponents)).toEqual([]);
    expect(ambiguousSceneObjectWarnings(rightPrompt, opponents)).toEqual([]);
    expect(decomposeSceneAction(leftPrompt, 4, opponents)?.segments.at(-1)?.targetPropId).toBe('opponent-left');
    expect(decomposeSceneAction(rightPrompt, 4, opponents)?.segments.at(-1)?.targetPropId).toBe('opponent-right');
    expect(ambiguousScenePropIds(leftPrompt, opponents)).toEqual([]);

    const rotatedActor = { position: [0, 0, 0] as [number, number, number], forward: [1, 0] as [number, number] };
    const rotatedLeft = '挥剑攻击左侧对手';
    const rotatedOpponents = [
      { ...opponents[0], position: [0, 0, 1.6] as [number, number, number] },
      { ...opponents[1], position: [0, 0, -1.6] as [number, number, number] },
    ];
    expect(decomposeSceneAction(rotatedLeft, 4, rotatedOpponents, rotatedActor)?.segments.at(-1)?.targetPropId).toBe('opponent-left');

    const aligned = opponents.map((opponent) => ({ ...opponent, position: [0, 0, 1.6] as [number, number, number] }));
    expect(ambiguousSceneObjectWarnings(leftPrompt, aligned)).toHaveLength(1);
    expect(decomposeSceneAction(leftPrompt, 4, aligned)).toBeNull();
  });

  it('decomposes weapon handoffs between attacks into a target-bound timeline phase', () => {
    const sword: StageProp = { id: 'sword-handoff', kind: 'sword', position: [0, 1, 0], rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R' };
    const plan = decomposeSceneAction('挥剑后把剑换到左手再格挡', 6, [sword])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['orient', 'sword', 'handoff', 'block']);
    expect(plan.segments[2]).toMatchObject({ targetPropId: sword.id, clause: expect.stringMatching(/左手/) });
    expect(plan.contacts).toContainEqual(expect.objectContaining({ phase: 'handoff', bodyPart: 'hand', propId: sword.id }));
    expect(sampleWeaponAttachment(sword, plan.segments, 0)).toMatchObject({ from: 'hand.R', to: 'hand.R', blend: 0 });
    const transfer = plan.segments[2];
    expect(sampleWeaponAttachment(sword, plan.segments, (transfer.t0 + transfer.t1) / 2)).toMatchObject({ from: 'hand.R', to: 'hand.L' });
    expect(sampleWeaponAttachment(sword, plan.segments, (transfer.t0 + transfer.t1) / 2).blend).toBeCloseTo(0.5);
    expect(sampleWeaponAttachment(sword, plan.segments, 6)).toMatchObject({ from: 'hand.L', to: 'hand.L', blend: 0 });
    const unheld = { ...sword, attachTo: null };
    const unheldPlan = decomposeSceneAction('把剑换到左手', 3, [unheld])!;
    expect(unheldPlan.warnings.join()).toMatch(/武器当前未挂在手上/);
    expect(sampleWeaponAttachment(unheld, unheldPlan.segments, 1)).toMatchObject({ from: null, to: null, blend: 0 });
  });

  it('drives the next sword attack from the post-handoff hand', () => {
    const sword: StageProp = { id: 'sword-timeline', kind: 'sword', position: [0, 1, 0], rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R' };
    const plan = decomposeSceneAction('把剑换到左手后挥剑', 4, [sword])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['orient', 'handoff', 'sword']);

    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const frame = resolvePropInteractionFrame(sword, character, buildSkeletonTree(character))!;
    const generated = generatePlannedTracks({
      spine: 'Spine', 'upperArm.L': 'ArmL', 'forearm.L': 'ForeL', 'upperArm.R': 'ArmR', 'forearm.R': 'ForeR',
    }, plan.segments, 4, 0, {}, {}, null, { [sword.id]: frame });
    const attack = plan.segments[2];
    const pose = sampleAnimation({ id: 'handoff-attack', name: 'handoff-attack', duration: 4, fps: 30, tracks: generated.tracks }, (attack.t0 + attack.t1) / 2);
    const identityDistance = (bone: string) => {
      const q = pose.get(bone)!.quaternion!;
      return Math.hypot(q[0], q[1], q[2], q[3] - 1);
    };
    // 交接后的主手（左臂）必须主导挥击。
    //
    // 注意阈值：原先断言 `×2`，那编码的是「副手近乎不动」的单手剑假设 ——
    // 恰恰是「拿剑姿势不对」的成因。双手握剑时副手同样在柄上、必然参与动作，
    // 实测领先幅度约 1.19×。这里改为断言「主攻臂领先」且「双手都真的动了」。
    expect(identityDistance('ArmL')).toBeGreaterThan(identityDistance('ArmR'));
    // 副手不再是 ±12° 的装饰：两条前臂都要有明显运动量
    expect(identityDistance('ForeL')).toBeGreaterThan(0.1);
    expect(identityDistance('ForeR')).toBeGreaterThan(0.1);
  });

  it('does not invent a bed interaction when lying down is negated', () => {
    expect(decomposeWorldAction('不要躺下睡觉', 8, [bed])).toBeNull();
  });

  it('keeps a requested sleep action when only the later wake-up is negated', () => {
    const plan = decomposeWorldAction('躺下睡觉后不要起床', 8, [bed]);
    expect(plan?.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'lie', 'sleep']);
  });

  it('decomposes sitting into approach, orientation, and a chair support target', () => {
    const plan = decomposeSceneAction('走到椅子前坐下', 5, [chair])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit']);
    expect(plan.contacts).toContainEqual(expect.objectContaining({ bodyPart: 'pelvis', surface: 'seat' }));
  });

  it('moves onto the chair seat and preserves a requested stand-up phase', () => {
    const plan = decomposeSceneAction('走到椅子前坐下，再站起来', 6, [chair])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'stand']);
    expect(plan.contacts).toContainEqual(expect.objectContaining({ actionIndex: 2, bodyPart: 'pelvis', surface: 'seat' }));
    expect(validateScenePlan(createScenePlan({
      animationId: 'chair-rise', prompt: '走到椅子前坐下，再站起来', duration: 6, source: 'rules', props: [chair],
      actions: plan.segments, contacts: plan.contacts,
    })).filter((issue) => issue.level === 'error')).toEqual([]);
    expect(decomposeSceneAction('走到椅子前坐下，但不要站起来', 6, [chair])?.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit']);

    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const frame = resolvePropInteractionFrame(chair, character, buildSkeletonTree(character))!;
    expect(frame.sitPosition[1]).toBeLessThan(frame.approachPosition[1]);
    expect(frame.sitPosition[1]).toBeGreaterThan(chair.size.height * 0.65);
    const skeleton = buildSkeletonTree(character);
    const motion = generatePlannedTracks(buildBoneMap(skeleton), plan.segments, 6, 0, buildRestMap(skeleton), buildRestPositionMap(skeleton), null, { [chair.id]: frame });
    const hipsTrack = motion.tracks.find((track) => track.boneName === 'Hips')!;
    expect(hipsTrack.position.find((key) => Math.abs(key.time - plan.segments[2].t1) < 1e-4)?.value).toEqual(frame.sitPosition);
    expect(hipsTrack.position.at(-1)?.value).toEqual(frame.approachPosition);
  });
  it('breaks sleeping on a staged bed into approach, sit, supine, and rest phases', () => {
    const plan = decomposeWorldAction('躺下睡觉', 8, [bed])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'lie', 'sleep']);
    expect(plan.segments[0].t0).toBe(0);
    expect(plan.segments.at(-1)!.t1).toBe(8);
    expect(plan.contacts.map((contact) => contact.bodyPart)).toEqual(['pelvis', 'back', 'head', 'legs']);
    expect(plan.warnings.join()).toMatch(/尚未运行刚体碰撞/);
  });

  it('does not silently choose the first bed when the standalone planner receives an ambiguous scene', () => {
    const secondBed: StageProp = { ...bed, id: 'bed-guest', position: [4, 0, 0] };
    expect(decomposeWorldAction('躺下睡觉', 8, [bed, secondBed])).toBeNull();
    expect(decomposeWorldAction('躺下睡觉 bed-guest', 8, [bed, secondBed])?.targetPropId).toBe('bed-guest');
  });

  it('does not append a sleep phase when the request only says lie on the bed', () => {
    const plan = decomposeWorldAction('躺倒床上', 6, [bed])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'lie']);
    expect(plan.contacts.map((contact) => contact.bodyPart)).toEqual(['pelvis', 'back']);
  });

  it('preserves a wake-up transition after sleeping, with or without a staged bed', () => {
    const bedPlan = decomposeWorldAction('躺下睡觉，然后起床', 10, [bed])!;
    expect(bedPlan.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'lie', 'sleep', 'orient', 'sit', 'stand']);
    expect(bedPlan.contacts.some((contact) => contact.phase === 'sleep' && contact.relation === 'rest')).toBe(true);
    expect(bedPlan.segments.at(-1)?.clause).toMatch(/起身/);
    expect(bedPlan.segments[5].clause).toMatch(/侧身|翻身/);
    expect(bedPlan.segments[6].clause).toMatch(/床沿|双腿垂下/);
    expect(bedPlan.contacts).toContainEqual(expect.objectContaining({ phase: 'sit', actionIndex: 6, bodyPart: 'pelvis', relation: 'support' }));
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const frame = resolveBedInteractionFrame(bed, character, skeleton)!;
    const frames = resolveSequentialInteractionFrames(bedPlan.segments, character, skeleton, [bed]);
    const motion = generatePlannedTracks(buildBoneMap(skeleton), bedPlan.segments, 10, 0, buildRestMap(skeleton), buildRestPositionMap(skeleton), null, {}, frames);
    const hipsTrack = motion.tracks.find((track) => track.boneName === 'Hips')!;
    const sampledHips = (time: number) => sampleAnimation({ id: 'wake-track', name: 'wake-track', duration: 10, fps: 30, tracks: motion.tracks }, time).get('Hips')!.position!;
    const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(sampledHips((bedPlan.segments[5].t0 + bedPlan.segments[5].t1) / 2), frame.liePosition)).toBeLessThan(0.001);
    expect(dist(sampledHips(bedPlan.segments[6].t1), frame.sitPosition)).toBeLessThan(0.001);
    expect(hipsTrack.position.at(-1)?.value).toEqual(frame.approachPosition);
    expect(validateScenePlan(createScenePlan({
      animationId: 'wake-from-bed', prompt: '躺下睡觉，然后起床', duration: 10, source: 'rules', props: [bed],
      actions: bedPlan.segments, contacts: bedPlan.contacts,
    })).filter((issue) => issue.level === 'error')).toEqual([]);

    const floorPlan = decomposeWorldAction('躺下睡觉后站起来', 10, [])!;
    expect(floorPlan.segments.map((segment) => segment.template)).toEqual(['kneel', 'lie', 'sleep', 'orient', 'kneel', 'stand']);
    expect(floorPlan.segments[3].clause).toMatch(/侧身|翻身/);
    expect(floorPlan.segments[4].clause).toMatch(/撑地|跪起/);
    expect(floorPlan.contacts).toContainEqual(expect.objectContaining({ phase: 'orient', actionIndex: 3, bodyPart: 'hand', propId: 'ground', relation: 'support' }));
    expect(floorPlan.contacts).toContainEqual(expect.objectContaining({ phase: 'kneel', actionIndex: 4, bodyPart: 'legs', propId: 'ground', relation: 'support' }));
    expect(floorPlan.segments.at(-1)?.t1).toBe(10);
    expect(floorPlan.contacts.every((contact) => contact.actionIndex < floorPlan.segments.length - 1)).toBe(true);
    expect(validateScenePlan(createScenePlan({
      animationId: 'wake-from-floor', prompt: '躺下睡觉后站起来', duration: 10, source: 'rules', props: [],
      actions: floorPlan.segments, contacts: floorPlan.contacts,
    })).filter((issue) => issue.level === 'error')).toEqual([]);
    expect(decomposeWorldAction('躺下睡觉，但不要起床', 8, [bed])?.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sit', 'lie', 'sleep']);
  });

  it('uses a grounded supine fallback when the scene has no bed', () => {
    const plan = decomposeWorldAction('躺下睡觉', 8, [])!;
    expect(plan.segments.map((segment) => segment.template)).toEqual(['kneel', 'lie', 'sleep']);
    expect(plan.contacts).toEqual([
      { phase: 'kneel', actionIndex: 0, bodyPart: 'hand', propId: 'ground', surface: 'ground', relation: 'support' },
      { phase: 'lie', actionIndex: 1, bodyPart: 'pelvis', propId: 'ground', surface: 'ground', relation: 'support' },
      { phase: 'lie', actionIndex: 1, bodyPart: 'back', propId: 'ground', surface: 'ground', relation: 'support' },
      { phase: 'sleep', actionIndex: 2, bodyPart: 'head', propId: 'ground', surface: 'ground', relation: 'rest' },
      { phase: 'sleep', actionIndex: 2, bodyPart: 'legs', propId: 'ground', surface: 'ground', relation: 'rest' },
    ]);
    expect(plan.warnings.join()).toMatch(/没有床/);
    expect(plan.warnings.join()).toMatch(/没有刚体碰撞或地面接触模拟/);

    const scenePlan = createScenePlan({ animationId: 'ground-sleep', prompt: '躺下睡觉', duration: 8, source: 'rules', props: [], actions: plan.segments, contacts: plan.contacts });
    expect(validateScenePlan(scenePlan)).toEqual([]);

    const bones = {
      hips: 'Hips', spine: 'Spine', head: 'Head',
      'upperArm.L': 'ArmL', 'upperArm.R': 'ArmR', 'forearm.L': 'ForeL', 'forearm.R': 'ForeR',
      'thigh.L': 'ThighL', 'thigh.R': 'ThighR', 'shin.L': 'ShinL', 'shin.R': 'ShinR',
    } as never;
    const motion = generatePlannedTracks(bones, plan.segments, 8, 0, {}, { hips: [0, 1, 0] });
    expect(motion.templates).toEqual(['kneel', 'lie', 'sleep']);
    const animation = { id: 'ground-sleep', name: 'ground-sleep', duration: 8, fps: 30, tracks: motion.tracks };
    const lowered = sampleAnimation(animation, plan.segments[0].t1 - 0.1);
    expect(lowered.get('Hips')!.position![1]).toBeLessThan(0.7);
    expect(new THREE.Quaternion(...lowered.get('ForeL')!.quaternion!).angleTo(new THREE.Quaternion())).toBeGreaterThan(0.5);
    const supine = sampleAnimation(animation, 7.5);
    const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...supine.get('Hips')!.quaternion!));
    expect(faceNormal.y).toBeGreaterThan(0.9);

    const pelvisRig = new THREE.Group();
    const pelvis = new THREE.Bone(); pelvis.name = 'Hips'; pelvis.position.y = 1; pelvisRig.add(pelvis);
    pelvisRig.updateWorldMatrix(true, true);
    const pelvisSnapshot = buildSkeletonTree(pelvisRig);
    const pelvisMotion = generatePlannedTracks(buildBoneMap(pelvisSnapshot), plan.segments, 8, 0,
      buildRestMap(pelvisSnapshot), buildRestPositionMap(pelvisSnapshot));
    const supportWarnings = inspectGroundSupportWarnings(pelvisRig,
      { id: 'pelvis-grounding', name: 'grounded lie', duration: 8, fps: 30, tracks: pelvisMotion.tracks },
      plan.segments, plan.contacts);
    expect(supportWarnings).not.toContainEqual(expect.stringMatching(/声明pelvis支撑地面.*离地/));
    expect(supportWarnings).not.toContainEqual(expect.stringMatching(/声明pelvis支撑地面.*支撑可能不稳定/));

    for (const gender of ['male', 'female'] as const) {
      const demo = buildDemoCharacter(gender);
      try {
        const demoSnapshot = buildSkeletonTree(demo.scene);
        const demoOffset = estimateGroundHipLocalOffset(demo.scene, demoSnapshot, 0);
        const demoMotion = generatePlannedTracks(buildBoneMap(demoSnapshot), plan.segments, 8, 0,
          buildRestMap(demoSnapshot), buildRestPositionMap(demoSnapshot), null, {}, {}, 0, demoOffset);
        const demoAnimation = { id: `demo-ground-lie-${gender}`, name: `${gender} demo lie`, duration: 8, fps: 30,
          tracks: correctGroundedLegTracks(demo.scene, { id: `demo-ground-lie-${gender}`, name: `${gender} demo lie`, duration: 8, fps: 30, tracks: demoMotion.tracks },
            buildBoneMap(demoSnapshot), plan.segments, plan.contacts) };
        const demoSupport = inspectGroundSupportWarnings(demo.scene, demoAnimation, plan.segments, plan.contacts);
        const demoCollisions = inspectMotionCollisions(demo.scene, demoAnimation, [], plan.segments, plan.contacts, demoSnapshot);
        expect(demoSupport, `${gender} support`).toEqual([]);
        expect(demoCollisions.filter((finding) => finding.propId === '地面'), gender).toEqual([]);
      } finally {
        demo.dispose();
      }
    }

    const raisedFloorMotion = generatePlannedTracks(buildBoneMap(pelvisSnapshot), plan.segments, 8, 0,
      buildRestMap(pelvisSnapshot), buildRestPositionMap(pelvisSnapshot), null, {}, {}, 0.4);
    const raisedFloorHips = sampleAnimation({ id: 'raised-floor', name: 'raised floor lie', duration: 8, fps: 30, tracks: raisedFloorMotion.tracks }, 7.5);
    expect(raisedFloorHips.get('Hips')!.position![1]).toBeCloseTo(0.53);
    expect(inspectGroundSupportWarnings(pelvisRig,
      { id: 'raised-floor', name: 'raised floor lie', duration: 8, fps: 30, tracks: raisedFloorMotion.tracks },
      plan.segments, plan.contacts, 0.4)).not.toContainEqual(expect.stringMatching(/声明pelvis支撑地面.*(?:离地|支撑可能不稳定)/));
  });

  it('converts world floor height through a translated, scaled, and tilted character parent', () => {
    const character = new THREE.Group(); character.position.y = 0.5; character.scale.set(1, 2, 1);
    character.rotation.z = Math.PI / 4;
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1; character.add(hips);
    character.updateWorldMatrix(true, true);
    const snapshot = buildSkeletonTree(character);
    const localGroundHipOffset = estimateGroundHipLocalOffset(character, snapshot, 0.4);
    expect(localGroundHipOffset).toBeDefined();
    expect(localGroundHipOffset![0]).not.toBeCloseTo(0);
    const worldScale = hips.getWorldScale(new THREE.Vector3());
    const targetWorldPosition = hips.position.clone().add(new THREE.Vector3(...localGroundHipOffset!)).applyMatrix4(character.matrixWorld);
    expect(targetWorldPosition.y).toBeCloseTo(0.4 + 0.13 * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z)));

    const plan = decomposeWorldAction('躺下睡觉', 8, [])!;
    const motion = generatePlannedTracks(buildBoneMap(snapshot), plan.segments, 8, 0,
      buildRestMap(snapshot), buildRestPositionMap(snapshot), null, {}, {}, 0.4, localGroundHipOffset);
    const warnings = inspectGroundSupportWarnings(character,
      { id: 'scaled-ground-lie', name: 'scaled lie', duration: 8, fps: 30, tracks: motion.tracks }, plan.segments, plan.contacts, 0.4);
    expect(warnings).not.toContainEqual(expect.stringMatching(/声明pelvis支撑地面.*(?:离地|支撑可能不稳定)/));
  });

  it('respects an explicit floor target even when the scene contains a bed', () => {
    const plan = decomposeWorldAction('躺到地板上睡觉', 8, [bed])!;
    expect(plan.targetPropId).toBeUndefined();
    expect(plan.segments.map((segment) => segment.template)).toEqual(['kneel', 'lie', 'sleep']);
    expect(plan.contacts.every((contact) => contact.propId === 'ground' && contact.surface === 'ground')).toBe(true);
  });

  it('resolves bed targets into hips-parent coordinates', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    hips.position.set(0, 1, 0);
    character.add(hips);
    character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const frame = resolveBedInteractionFrame(bed, character, skeleton)!;
    expect(frame.approachPosition[0]).toBeCloseTo(0.38);
    expect(frame.sitPosition[1]).toBeCloseTo(0.82);
    expect(frame.liePosition[0]).toBeCloseTo(1.35);
    expect(frame.liePosition[1]).toBeCloseTo(0.7);
    expect(frame.yawRadians).toBeCloseTo(Math.PI / 2);
  });

  it('resolves an interaction point and distance for a table target', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const frame = resolvePropInteractionFrame(table, character, buildSkeletonTree(character))!;
    expect(frame.interactionPosition[2]).toBeGreaterThan(0.6);
    expect(frame.distanceMeters).toBeGreaterThan(0);
    expect(frame.yawRadians).toBeCloseTo(Math.PI, 5);
  });

  it('rejects interaction targets inside the minimum reach of a folded two-bone arm', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0);
    const upperArm = new THREE.Bone(); upperArm.name = 'UpperArm_R'; upperArm.position.set(0.2, 0.6, 0); hips.add(upperArm);
    const forearm = new THREE.Bone(); forearm.name = 'Forearm_R'; forearm.position.set(0.7, 0, 0); upperArm.add(forearm);
    const hand = new THREE.Bone(); hand.name = 'Hand_R'; hand.position.set(0.1, 0, 0); forearm.add(hand);
    character.add(hips); character.updateWorldMatrix(true, true);
    const closePhone: StageProp = { ...phone, position: [0.25, 1.59, 0] };

    const frame = resolvePropInteractionFrame(closePhone, character, buildSkeletonTree(character))!;

    expect(frame.armReach?.R?.distanceMeters).toBeLessThan(frame.armReach?.R?.minDistanceMeters ?? 0);
    expect(frame.armReach?.R?.reachable).toBe(false);
  });

  it('recognizes a phone on a rotated table using the table local footprint', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const rotatedTable: StageProp = { ...table, rotationY: Math.PI / 2, size: { ...table.size, length: 0.3 } };
    const phoneOnTable: StageProp = { ...phone, position: [1, 0.76, -0.48] };

    const frame = resolvePropInteractionFrame(phoneOnTable, character, buildSkeletonTree(character), [rotatedTable, phoneOnTable])!;

    expect(frame.interactionPosition[0]).toBeCloseTo(1.5, 5);
    expect(frame.interactionPosition[2]).toBeCloseTo(0, 5);
    expect(frame.handTargetPosition?.[1]).toBeCloseTo(0.769, 5);
  });

  it('does not treat a phone above the table as table-supported', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const raisedPhone: StageProp = { ...phone, position: [1, 1.2, 0] };
    const frame = resolvePropInteractionFrame(raisedPhone, character, buildSkeletonTree(character), [table, raisedPhone])!;

    expect(frame.interactionPosition[0]).toBeCloseTo(1, 5);
    expect(frame.interactionPosition[2]).toBeGreaterThan(0.4);
    expect(frame.interactionPosition[0]).not.toBeCloseTo(1.5, 5);
  });

  it('uses the visible chair seat as the hand-contact height while keeping the higher hip sit target', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const frame = resolvePropInteractionFrame(chair, character, buildSkeletonTree(character))!;

    // 手接触高度 = **真实可见椅面** 0.48h + 0.04 = 0.472（默认 h=0.9）。
    // 旧值用 0.52h = 0.468，误差 0.04(1-h)：椅高 0.2m 时差 3.2cm、3.0m 时差 8cm。
    expect(frame.handTargetPosition?.[1]).toBeCloseTo(0.472, 5);
    // 髋目标 = 椅面 + 骨盆代理半径 0.13 = 0.602。
    // 旧值 0.74h = 0.666 的关节抬升是 0.198m，而 bed(0.12)/sofa(0.126) 都 ~0.12~0.13，
    // 椅子是离群值，会让角色坐椅时骨盆网格悬空 8.1cm（可见）。
    expect(frame.sitPosition[1]).toBeCloseTo(0.602, 5);
  });

  it('detects a thin obstacle between approach samples', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const target: StageProp = { ...table, id: 'far-table', position: [6, 0, 0] };
    const blocker: StageProp = {
      ...table, id: 'thin-blocker', position: [2.25, 0, 0.2625],
      size: { width: 0.01, height: 1.2, length: 0.01 },
    };

    const frame = resolvePropInteractionFrame(target, character, buildSkeletonTree(character), [target, blocker])!;

    expect(frame.pathObstructed).toBe(true);
    expect(frame.approachPath).toBeDefined();
    expect(frame.approachPath!.length).toBeGreaterThan(2);

    const motion = generatePlannedTracks(
      { hips: 'Hips' },
      [{ t0: 0, t1: 6, template: 'march', clause: '绕过障碍走到桌前', targetPropId: target.id }],
      6, 0, {}, { hips: [0, 1, 0] }, null, { [target.id]: frame },
    );
    const hipsTrack = motion.tracks.find((track) => track.boneName === 'Hips')!;
    expect(hipsTrack.position.length).toBeGreaterThan(2);
    expect(hipsTrack.position.every((key) => {
      const localX = key.value[0] - blocker.position[0];
      const localZ = key.value[2] - blocker.position[2];
      return Math.abs(localX) > blocker.size.width / 2 + 0.3 - 1e-4
        || Math.abs(localZ) > blocker.size.length / 2 + 0.3 - 1e-4;
    })).toBe(true);
  });

  it('does not route around an obstacle that is fully above the character bounds', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const target: StageProp = { ...table, id: 'far-table', position: [6, 0, 0] };
    const overhead = {
      ...table, id: 'overhead-shelf', position: [2.25, 1.4, 0.2625],
      size: { width: 0.01, height: 0.3, length: 0.01 },
    };

    const frame = resolvePropInteractionFrame(target, character, buildSkeletonTree(character), [target, overhead])!;

    expect(frame.pathObstructed).toBe(false);
    expect(frame.approachPath).toHaveLength(2);
  });

  it('scales route clearance with the character world height', () => {
    const makeCharacter = (height: number) => {
      const character = new THREE.Group();
      const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, height, 0.4), new THREE.MeshBasicMaterial());
      body.position.y = height / 2;
      character.add(body);
      character.updateWorldMatrix(true, true);
      return character;
    };
    const target: StageProp = { ...table, id: 'height-target', position: [6, 0, 0] };
    const blocker: StageProp = {
      ...table, id: 'height-blocker', position: [2.25, 0, 0.709],
      size: { width: 0.01, height: 1.2, length: 0.01 },
    };
    const smallCharacter = makeCharacter(1.7);
    const smallActor = resolvePropInteractionFrame(target, smallCharacter, buildSkeletonTree(smallCharacter), [target, blocker])!;
    const largeCharacter = makeCharacter(3.4);
    const largeActor = resolvePropInteractionFrame(target, largeCharacter, buildSkeletonTree(largeCharacter), [target, blocker])!;

    expect(smallActor.approachPath).toHaveLength(2);
    expect(largeActor.approachPath!.length).toBeGreaterThan(2);
  });

  it('does not invent a detour through the wall when a room-sized obstacle blocks the route', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(-1, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const room: StageProp = { id: 'room-route', kind: 'room', position: [0, 0, 0], rotationY: 0, size: { width: 4, height: 2.5, length: 4 } };
    const target: StageProp = { ...table, id: 'route-target', position: [1, 0, 0] };
    const wall: StageProp = { ...table, id: 'full-room-blocker', position: [0, 0, 0], size: { width: 4, height: 2, length: 4 } };

    const frame = resolvePropInteractionFrame(target, character, buildSkeletonTree(character), [room, target, wall])!;

    expect(frame.pathObstructed).toBe(true);
    expect(frame.approachPath).toBeUndefined();
    const generated = generatePlannedTracks(
      { hips: 'Hips' },
      [{ t0: 0, t1: 2, template: 'march', clause: '走向目标', targetPropId: target.id }],
      2, 0, {}, { hips: [-1, 1, 0] }, null, { [target.id]: frame },
    );
    const hipsTrack = generated.tracks.find((track) => track.boneName === 'Hips')!;
    expect(hipsTrack.position.every((key) => key.value[0] === -1 && key.value[2] === 0)).toBe(true);
    expect(generated.warnings.join(' ')).toMatch(/没有可从当前起点使用的安全路线/);
  });

  it('plans each later approach from the previous targeted movement endpoint', () => {
    const character = new THREE.Group();
    character.position.x = -4;
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const first: StageProp = { ...table, id: 'first-table', position: [-3, 0, 0] };
    const second: StageProp = { ...table, id: 'second-table', position: [4, 0, 0] };
    const blocker: StageProp = { ...table, id: 'middle-blocker', position: [0.5, 0, 0.7], size: { width: 0.8, height: 1.2, length: 0.8 } };
    const segments = [
      { template: 'march', targetPropId: first.id },
      { template: 'reach', targetPropId: first.id },
      { template: 'march', targetPropId: second.id },
    ];

    const frames = resolveSequentialInteractionFrames(segments, character, buildSkeletonTree(character), [first, second, blocker]);
    const firstStop = frames[0].interactionPosition;
    const secondRoute = frames[2].approachPath!;

    expect(secondRoute.length).toBeGreaterThan(2);
    expect(secondRoute[0]).toEqual(firstStop);
    const generated = generatePlannedTracks(
      { hips: 'Hips' },
      [
        { t0: 0, t1: 1, template: 'march', clause: '走到第一个桌子', targetPropId: first.id },
        { t0: 1, t1: 2, template: 'reach', clause: '拿起物品', targetPropId: first.id },
        { t0: 2, t1: 5, template: 'march', clause: '绕过障碍走到第二个桌子', targetPropId: second.id },
      ],
      5, 0, {}, { hips: [0, 1, 0] }, null, {}, frames,
    );
    const secondMarchKeys = generated.tracks.find((track) => track.boneName === 'Hips')!.position.filter((key) => key.time >= 2);
    const blockerLocalX = blocker.position[0] - character.position.x;
    const blockerLocalZ = blocker.position[2] - character.position.z;
    expect(secondMarchKeys.some((key) => Math.abs(key.value[0] - blockerLocalX) < blocker.size.width / 2 + 0.18
      && Math.abs(key.value[2] - blockerLocalZ) < blocker.size.length / 2 + 0.18)).toBe(false);
  });

  it.each([
    ['hand.R', 'R', 'UpperArm_R', 'UpperArm_L'],
    ['hand.L', 'L', 'UpperArm_L', 'UpperArm_R'],
  ] as const)('drives the sword arm matching its %s attachment', (attachTo, hand, attackingArm, supportArm) => {
    const character = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips); character.updateWorldMatrix(true, true);
    const sword: StageProp = {
      id: 'sword-main', kind: 'sword', position: [0, 1, 0], rotationY: 0,
      size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo,
    };
    const frame = resolvePropInteractionFrame(sword, character, buildSkeletonTree(character))!;
    expect(frame.wieldingHand).toBe(hand);
    const result = generatePlannedTracks({
      spine: 'Spine', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'forearm.L': 'Forearm_L',
      'upperArm.R': 'UpperArm_R', 'forearm.R': 'Forearm_R',
    }, [{ t0: 0, t1: 1, template: 'sword', targetPropId: sword.id }], 1, 0, {}, {}, null, { [sword.id]: frame });
    const track = (boneName: string) => result.tracks.find((item) => item.boneName === boneName)!;
    const midpoint = (boneName: string) => track(boneName).rotation.reduce((a, b) => Math.abs(a.time - 0.5) <= Math.abs(b.time - 0.5) ? a : b).value;
    const isIdentity = (q: number[]) => Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) < 1e-6 && Math.abs(q[3] - 1) < 1e-6;
    expect(isIdentity(midpoint(attackingArm))).toBe(false);
    expect(isIdentity(midpoint(supportArm))).toBe(false);
    expect(isIdentity(midpoint(hand === 'L' ? 'Forearm_L' : 'Forearm_R'))).toBe(false);
  });

  it('animates the root through the scene targets and finishes on the mattress', () => {
    const plan = decomposeWorldAction('躺下睡觉', 8, [bed])!;
    const result = generatePlannedTracks({
      hips: 'Hips', spine: 'Spine', chest: 'Chest', head: 'Head',
      'upperArm.L': 'UpperArm_L', 'upperArm.R': 'UpperArm_R',
      'thigh.L': 'Thigh_L', 'thigh.R': 'Thigh_R', 'shin.L': 'Shin_L', 'shin.R': 'Shin_R',
    }, plan.segments, 8, 0, {}, { hips: [0, 1, 0] }, {
      approachPosition: [0.38, 1, 0], sitPosition: [0.86, 0.82, 0],
      liePosition: [1.35, 0.7, 0], yawRadians: Math.PI / 2,
    });
    const hips = result.tracks.find((track) => track.boneName === 'Hips')!;
    expect(hips.position.at(-1)!.value).toEqual([1.35, 0.7, 0]);
    expect(result.segments.map((segment) => segment.template)).toContain('sit');
  });
});
