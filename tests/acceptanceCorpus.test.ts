import { describe, expect, it } from 'vitest';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { createScenePlan, validateScenePlan } from '../src/core/previs/scenePlan';
import { ambiguousSceneObjectWarnings, decomposeSceneAction, resolveSequentialInteractionFrames, type StageProp } from '../src/core/previs/world';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks, planClauses } from '../src/services/motion/procedural';

const table: StageProp = { id: 'table-main', kind: 'table', position: [1, 0, 0], rotationY: 0, size: { width: 1.1, height: 0.75, length: 0.7 } };
const phone: StageProp = { id: 'phone-main', kind: 'phone', position: [1, 0.76, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
const bed: StageProp = { id: 'bed-main', kind: 'bed', position: [1, 0, 0], rotationY: 0, size: { width: 1.3, height: 0.58, length: 2.1 } };
const sword: StageProp = { id: 'sword-main', kind: 'sword', position: [0, 1, 0], rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R' };
const door: StageProp = { id: 'door-main', kind: 'door', position: [-4, 0, 0], rotationY: 0, size: { width: 0.9, height: 2.05, length: 0.08 } };

describe('中文预演验收语料：解析、ScenePlan 与可播放轨道', () => {
  const cases = [
    { prompt: '右手抬高，然后头向左转', duration: 4, templates: ['raise_right', 'look_left'], props: [] },
    { prompt: '左手挥手，然后头向右转', duration: 4, templates: ['wave', 'look_right'], props: [] },
    { prompt: '头向右转', duration: 3, templates: ['look_right'], props: [] },
    { prompt: '不要拿手机，只回头看门口', duration: 4, templates: ['look'], props: [] },
    { prompt: '慢慢下蹲，再站起来', duration: 4, templates: ['squat', 'stand'], props: [] },
    { prompt: '躺下睡觉', duration: 8, templates: ['kneel', 'lie', 'sleep'], props: [] },
    { prompt: '躺倒床上', duration: 6, templates: ['march', 'orient', 'sit', 'lie'], props: [bed] },
    { prompt: '躺倒床上', duration: 6, templates: ['sway'], props: [] },
    { prompt: '躺到地板上睡觉', duration: 8, templates: ['kneel', 'lie', 'sleep'], props: [bed] },
    { prompt: '躺下睡觉，然后起床', duration: 10, templates: ['march', 'orient', 'sit', 'lie', 'sleep', 'orient', 'sit', 'stand'], props: [bed] },
    { prompt: '躺下睡觉后不要起床', duration: 8, templates: ['march', 'orient', 'sit', 'lie', 'sleep'], props: [bed] },
    { prompt: '躺下睡觉后站起来', duration: 10, templates: ['kneel', 'lie', 'sleep', 'orient', 'kneel', 'stand'], props: [] },
    { prompt: '走到桌前，拿起手机，再回头看门口', duration: 8, templates: ['march', 'orient', 'reach', 'look'], props: [table, phone] },
    { prompt: '人物走到桌前，拿起手机，然后走到门口', duration: 8, templates: ['march', 'orient', 'reach', 'march'], props: [table, phone, door] },
    { prompt: '挥剑后格挡', duration: 4, templates: ['orient', 'sword', 'block'], props: [sword] },
  ];

  it.each(cases)('为“$prompt”生成结构有效且可采样的动作预演', ({ prompt, duration, templates, props }) => {
    const actor = buildDemoCharacter();
    try {
      const skeleton = buildSkeletonTree(actor.scene);
      const worldPlan = decomposeSceneAction(prompt, duration, props);
      const segments = worldPlan?.segments ?? planClauses(prompt, duration);
      const segmentInteractions = resolveSequentialInteractionFrames(segments, actor.scene, skeleton, props);
      const generated = generatePlannedTracks(
        buildBoneMap(skeleton), segments, duration, 0, buildRestMap(skeleton), buildRestPositionMap(skeleton), null, {}, segmentInteractions,
      );
      const plan = createScenePlan({
        animationId: `acceptance-${prompt}`, prompt, duration, source: 'rules', props,
        actions: generated.segments, contacts: worldPlan?.contacts,
        target: worldPlan?.targetPropId ? { propId: worldPlan.targetPropId } : undefined,
        warnings: worldPlan?.warnings,
      });

      expect(generated.templates).toEqual(templates);
      expect(generated.tracks.length).toBeGreaterThan(0);
      expect(generated.tracks.every((track) => [...track.rotation, ...track.position, ...track.scale].every((key) =>
        Number.isFinite(key.time) && key.value.every(Number.isFinite)))).toBe(true);
      expect(validateScenePlan(plan).filter((issue) => issue.level === 'error')).toEqual([]);
      expect(generated.segments[0].t0).toBe(0);
      expect(generated.segments.at(-1)?.t1).toBe(duration);
      if (prompt === '人物走到桌前，拿起手机，然后走到门口') {
        expect(segments.at(-1)?.targetPropId).toBe(door.id);
        expect(segmentInteractions[2]?.approachPath?.[0]).toEqual(segmentInteractions[0]?.interactionPosition);
        expect(segmentInteractions[2]?.handTargetPosition).toBeDefined();
        expect(segmentInteractions[2]?.armReach?.R?.maxDistanceMeters).toBeGreaterThan(0);
        expect(worldPlan?.contacts[0]).toMatchObject({ actionIndex: 2, propId: phone.id });
      }
      if (prompt === '躺到地板上睡觉') {
        expect(worldPlan?.targetPropId).toBeUndefined();
        expect(worldPlan?.contacts.every((contact) => contact.propId === 'ground' && contact.surface === 'ground')).toBe(true);
      }
      if (prompt === '躺倒床上' && props.length === 0) {
        expect(worldPlan?.contacts).toEqual([]);
        expect(worldPlan?.targetPropId).toBeUndefined();
        expect(worldPlan?.warnings.join()).toMatch(/未改成地面躺卧/);
        expect(generated.segments[0].clause).toMatch(/等待床面支撑/);
      }
      if (prompt === '躺倒床上' && props.length > 0) {
        expect(worldPlan?.targetPropId).toBe(bed.id);
        expect(worldPlan?.contacts).toContainEqual(expect.objectContaining({ phase: 'lie', propId: bed.id, surface: 'mattress' }));
      }
      if (prompt === '躺下睡觉，然后起床') {
        const sideTurn = generated.segments[5];
        expect(sideTurn.clause).toMatch(/翻身侧卧/);
        for (const semantic of ['upperArm.L', 'forearm.L'] as const) {
          const track = generated.tracks.find((item) => item.boneName === buildBoneMap(skeleton)[semantic]);
          const rest = buildRestMap(skeleton)[semantic]!;
          expect(track?.rotation.some((key) => key.time > sideTurn.t0 && key.time < sideTurn.t1
            && Math.hypot(key.value[0] - rest[0], key.value[1] - rest[1], key.value[2] - rest[2], key.value[3] - rest[3]) > 0.05)).toBe(true);
        }
        expect(worldPlan?.contacts).toContainEqual(expect.objectContaining({ phase: 'sit', actionIndex: 6, bodyPart: 'pelvis', surface: 'mattress' }));
      }
      if (prompt === '躺下睡觉后不要起床') {
        expect(worldPlan?.segments.some((segment) => segment.template === 'stand')).toBe(false);
        expect(worldPlan?.contacts.some((contact) => contact.phase === 'sleep' && contact.relation === 'rest')).toBe(true);
      }
      if (prompt === '躺下睡觉后站起来') {
        expect(worldPlan?.contacts).toContainEqual(expect.objectContaining({ phase: 'orient', actionIndex: 3, bodyPart: 'hand', propId: 'ground' }));
        expect(worldPlan?.contacts).toContainEqual(expect.objectContaining({ phase: 'kneel', actionIndex: 4, bodyPart: 'legs', propId: 'ground' }));
        expect(worldPlan?.warnings.join()).toMatch(/没有刚体碰撞或地面接触模拟/);
      }
    } finally {
      actor.dispose();
    }
  });

  it('refuses ambiguous same-kind targets instead of making a silently wrong playable plan', () => {
    const secondPhone = { ...phone, id: 'phone-side', position: [2, 0.76, 0] as [number, number, number] };
    expect(ambiguousSceneObjectWarnings('拿起手机', [phone, secondPhone])).toHaveLength(1);
    expect(decomposeSceneAction('拿起手机', 4, [phone, secondPhone])).toBeNull();
    expect(decomposeSceneAction('拿起手机 phone-side', 4, [phone, secondPhone])?.targetPropId).toBe('phone-side');
  });
});
