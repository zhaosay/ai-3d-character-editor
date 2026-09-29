import { describe, expect, it } from 'vitest';
import { applyScenePlanPatch, createScenePlan, validateScenePlan } from '../src/core/previs/scenePlan';
import { findStagePropOverlaps, validateStagePropPlacement, type StageProp } from '../src/core/previs/world';

const table: StageProp = {
  id: 'table-1', kind: 'table', position: [1, 0, 0], rotationY: 0,
  size: { width: 1.1, height: 0.75, length: 0.7 },
};

describe('ScenePlan', () => {
  it('unifies action, scene, contact, weapon/effect/camera and interpretable uncertainty', () => {
    const plan = createScenePlan({
      animationId: 'anim-1', prompt: '走到桌前拿起手机', duration: 4,
      source: 'rules', props: [table], actions: [{ t0: 0, t1: 4, template: 'reach', clause: '拿起手机' }],
      warnings: ['场景中没有手机'], target: { propId: 'table-1', distanceMeters: 1.4 },
    });
    expect(plan.version).toBe(1);
    expect(plan.environment.props).toEqual([table]);
    expect(plan.interpretation.certainty).toBe('low');
    expect(plan.target.distanceMeters).toBe(1.4);
    expect(validateScenePlan(plan)).toEqual([]);
  });

  it('detects stale targets and invalid time ranges', () => {
    const plan = createScenePlan({
      animationId: 'anim-1', prompt: '起身', duration: 4, source: 'rules', props: [],
      actions: [{ t0: 3, t1: 5, template: 'stand', clause: '起身' }], target: { propId: 'removed' },
    });
    const issues = validateScenePlan(plan);
    expect(issues.filter((issue) => issue.level === 'error').map((issue) => issue.path)).toEqual(['actions.0.time', 'target.propId']);
  });

  it('rejects action templates the preview renderer cannot execute', () => {
    const plan = createScenePlan({
      animationId: 'unknown-template', prompt: '翻滚', duration: 4, source: 'model', props: [],
      actions: [{ t0: 0, t1: 4, template: 'somersault', clause: '向前翻滚' }],
    });
    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'error', path: 'actions.0.template', message: expect.stringMatching(/未知动作模板 somersault/),
    }));
  });

  it('rejects prop dimensions that conflict with the declared object kind', () => {
    const phone: StageProp = {
      id: 'oversized-phone', kind: 'phone', position: [0, 0.75, 0], rotationY: 0,
      size: { width: 0.5, height: 0.02, length: 0.15 },
    };
    const plan = createScenePlan({
      animationId: 'invalid-prop-scale', prompt: '拿起手机', duration: 2, source: 'rules', props: [phone],
      actions: [{ t0: 0, t1: 2, template: 'reach', clause: '拿起手机' }],
    });

    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'error', path: 'environment.props.0', message: expect.stringMatching(/道具 oversized-phone.*尺寸无效/),
    }));
  });

  it('warns when furniture and room clearances are implausible for the character scale', () => {
    const room: StageProp = { id: 'tight-room', kind: 'room', position: [0, 0, 0], rotationY: 0,
      size: { width: 2, height: 1.6, length: 2 } };
    const chair: StageProp = { id: 'tiny-chair', kind: 'chair', position: [0.7, 0, 0], rotationY: 0,
      size: { width: 0.5, height: 0.2, length: 0.5 } };
    const plan = createScenePlan({
      animationId: 'scale-warning', prompt: '人物坐到椅子上', duration: 2, source: 'rules', props: [room, chair],
      actions: [{ t0: 0, t1: 2, template: 'sit', clause: '坐到椅子上', targetPropId: chair.id }],
    });
    plan.character.heightMeters = 1.7;

    const warnings = validateScenePlan(plan).filter((issue) => issue.level === 'warning');
    expect(warnings).toContainEqual(expect.objectContaining({
      path: 'environment.props.tight-room.size.height', message: expect.stringMatching(/房间净高 1.60 米.*站立或抬手动作/),
    }));
    expect(warnings).toContainEqual(expect.objectContaining({
      path: 'environment.props.tiny-chair.size.height', message: expect.stringMatching(/椅面约 0.10 米.*占人物身高 6%/),
    }));
  });

  it('does not add scale warnings to the standard starter furniture layout', () => {
    const room: StageProp = { id: 'room', kind: 'room', position: [0, 0, 0], rotationY: 0,
      size: { width: 5, height: 3, length: 5 } };
    const chair: StageProp = { id: 'chair', kind: 'chair', position: [1.3, 0, -1.6], rotationY: 0,
      size: { width: 0.52, height: 0.9, length: 0.52 } };
    const plan = createScenePlan({ animationId: 'normal-scales', prompt: '人物走进房间', duration: 2,
      source: 'rules', props: [room, table, chair], actions: [{ t0: 0, t1: 2, template: 'march', clause: '走进房间' }] });
    plan.character.heightMeters = 1.7;

    expect(validateScenePlan(plan).filter((issue) => /净高|人物身高|常见比例/.test(issue.message))).toEqual([]);
  });

  it('warns when two solid scene props occupy the same physical volume', () => {
    const chair: StageProp = {
      id: 'chair-1', kind: 'chair', position: [1, 0, 0], rotationY: Math.PI / 4,
      size: { width: 0.52, height: 0.9, length: 0.52 },
    };
    const plan = createScenePlan({
      animationId: 'overlapping-props', prompt: '人物走到桌边', duration: 3, source: 'rules', props: [table, chair],
      actions: [{ t0: 0, t1: 3, template: 'march', clause: '走到桌边' }],
    });

    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'warning', message: expect.stringMatching(/场景道具 table-1 与 chair-1 的实体占位相交/),
    }));
  });

  it('warns when a sampled slash trail intersects a rotated scene prop footprint', () => {
    const rotatedTable = { ...table, rotationY: Math.PI / 2 };
    const plan = createScenePlan({
      animationId: 'slash-prop-collision', prompt: '挥剑', duration: 2, source: 'rules', props: [rotatedTable],
      actions: [{ t0: 0, t1: 2, template: 'sword', clause: '挥剑' }],
      effects: [{ id: 'slash-collision', kind: 'slash', time: 1, duration: 0.3, position: [1, 0.6, 0],
        path: [[1, 0.6, -2], [1, 0.6, 2]], scale: 1, color: '#ffffff' }],
    });
    const issue = validateScenePlan(plan).find((item) => item.path === 'effects.0.path');
    expect(issue?.level).toBe('warning');
    expect(issue?.message).toMatch(/剑尖采样路径.*道具/);
    plan.effects[0].path = [[3, 0.6, -2], [3, 0.6, 2]];
    expect(validateScenePlan(plan).some((item) => item.path === 'effects.0.path')).toBe(false);
  });

  it('warns when the sampled blade surface hits a prop even when the tip trail misses it', () => {
    const sword: StageProp = {
      id: 'sword-main', kind: 'sword', position: [0, 0, 0], rotationY: 0,
      size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R',
    };
    const plan = createScenePlan({
      animationId: 'blade-sweep-collision', prompt: '挥剑', duration: 2, source: 'rules', props: [table, sword],
      actions: [{ t0: 0, t1: 2, template: 'sword', clause: '挥剑', targetPropId: sword.id }],
      effects: [{
        id: 'blade-sweep', kind: 'slash', time: 1, duration: 0.3, position: [0, 1, 0],
        path: [[-3, 1, -3], [-2, 1, -3]],
        bladeSweep: [
          { base: [0.4, 0.72, 0], tip: [1.5, 0.72, 0] },
          { base: [0.4, 0.74, 0], tip: [1.5, 0.74, 0] },
        ],
        scale: 1, color: '#ffffff',
      }],
    });
    const issue = validateScenePlan(plan).find((item) => item.path === 'effects.0.bladeSweep');
    expect(issue?.level).toBe('warning');
    expect(issue?.message).toMatch(/剑身扫掠采样网格.*table-1/);
    expect(issue?.message).toMatch(/不代表连续碰撞/);
  });

  it('treats an unheld sword as a static obstacle but excludes the weapon being swung', () => {
    const activeSword: StageProp = {
      id: 'sword-held', kind: 'sword', position: [0, 0, 0], rotationY: 0,
      size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: 'hand.R',
    };
    const staticSword: StageProp = {
      id: 'sword-rack', kind: 'sword', position: [1, 0, 0], rotationY: 0,
      size: { width: 0.05, height: 0.05, length: 0.9 }, attachTo: null,
    };
    const plan = createScenePlan({
      animationId: 'blade-vs-racked-sword', prompt: '挥剑 sword-held', duration: 2, source: 'rules', props: [activeSword, staticSword],
      actions: [{ t0: 0, t1: 2, template: 'sword', clause: '挥剑', targetPropId: activeSword.id }],
      effects: [{
        id: 'sword-clash-path', kind: 'slash', time: 1, duration: 0.3, position: [0, 0, 0],
        path: [[-3, 1, -3], [-2, 1, -3]],
        bladeSweep: [
          { base: [0.4, 0.5, 0], tip: [1.5, 0.5, 0] },
          { base: [0.4, 0.55, 0], tip: [1.5, 0.55, 0] },
        ],
        scale: 1, color: '#ffffff',
      }],
    });

    const issue = validateScenePlan(plan).find((item) => item.path === 'effects.0.bladeSweep');
    expect(issue?.message).toMatch(/sword-rack/);
    expect(issue?.message).not.toMatch(/sword-held/);
  });

  it('AI patch cannot overwrite manually locked fields or plan identity', () => {
    const plan = createScenePlan({ animationId: 'anim-1', prompt: '挥手', duration: 4, source: 'rules', props: [table], actions: [], lockedFields: ['environment'] });
    const next = applyScenePlanPatch(plan, { animationId: 'other', environment: { props: [] }, prompt: '鞠躬' });
    expect(next.animationId).toBe('anim-1');
    expect(next.environment.props).toEqual([table]);
    expect(next.prompt).toBe('鞠躬');
  });

  it('creates clarification questions and reports object bounds/support mismatches', () => {
    const room: StageProp = { id: 'room', kind: 'room', position: [0, 0, 0], rotationY: 0, size: { width: 3, height: 2.4, length: 3 } };
    const plan = createScenePlan({
      animationId: 'anim-2', prompt: '躺下睡觉，手机响了', duration: 4, source: 'rules',
      props: [room, { ...table, position: [2, 0, 0] }],
      actions: [{ t0: 0, t1: 4, template: 'sway', clause: '动作未识别' }],
      warnings: ['场景中没有床', '场景中没有手机'],
      contacts: [{ phase: 'lie', bodyPart: 'back', propId: table.id, surface: 'mattress', relation: 'support' }],
    });
    expect(plan.interpretation.certainty).toBe('low');
    expect(plan.interpretation.questions.join()).toMatch(/是否添加手机/);
    expect(plan.interpretation.questions.join()).toMatch(/添加床/);
    expect(validateScenePlan(plan).map((issue) => issue.message).join()).toMatch(/不匹配|超出房间/);
  });

  it('checks room bounds in the rotated room coordinate frame', () => {
    const room: StageProp = { id: 'rotated-room', kind: 'room', position: [0, 0, 0], rotationY: Math.PI / 2, size: { width: 2, height: 2.5, length: 6 } };
    const inside: StageProp = { id: 'inside-room', kind: 'table', position: [2, 0, 0], rotationY: 0, size: { width: 0.6, height: 0.75, length: 0.6 } };
    const plan = createScenePlan({
      animationId: 'rotated-room-plan', prompt: '走到桌前', duration: 4, source: 'rules', props: [room, inside],
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }],
    });

    expect(validateScenePlan(plan).some((issue) => issue.path === 'environment.props.inside-room')).toBe(false);
  });

  it('checks each visible furniture volume against room width, depth and floor/ceiling', () => {
    const room: StageProp = { id: 'room-physical', kind: 'room', position: [0, 0, 0], rotationY: 0, size: { width: 3, height: 2.4, length: 3 } };
    const desk: StageProp = { ...table, id: 'desk-outside', position: [2, 0, 0] };
    const plan = createScenePlan({
      animationId: 'room-volume-bounds', prompt: '走到桌前', duration: 2, source: 'rules', props: [room, desk],
      actions: [{ t0: 0, t1: 2, template: 'march', clause: '走到桌前', targetPropId: desk.id }],
    });

    expect(validateScenePlan(plan).find((issue) => issue.path === `environment.props.${desk.id}`)?.message)
      .toMatch(/实体代理超出房间宽度约 109 厘米/);
  });

  it('records field provenance and never lets model confidence hide locally detected uncertainty', () => {
    const plan = createScenePlan({
      animationId: 'anim-3', prompt: '躺下睡觉', duration: 8, source: 'model', props: [],
      actions: [{ t0: 0, t1: 8, template: 'lie', clause: '躺下睡觉' }],
      warnings: ['场景中没有床体碰撞与接触模拟'],
      interpretation: { certainty: 'high', missingInfo: ['床的位置'], questions: ['要添加床吗？'] },
    });
    expect(plan.interpretation.certainty).toBe('low');
    expect(plan.interpretation.missingInfo).toEqual(['床的位置']);
    expect(plan.interpretation.questions).toContain('要添加床吗？');
    expect(plan.interpretation.fieldEvidence?.prompt).toMatchObject({ source: 'user', certainty: 'high' });
    expect(plan.interpretation.fieldEvidence?.actions).toMatchObject({ source: 'model', certainty: 'low' });
    expect(plan.interpretation.fieldEvidence?.contacts.reason).toMatch(/未建立/);
  });

  it('finds duplicated props, invalid dimensions, duplicate camera times and broken events', () => {
    const plan = createScenePlan({
      animationId: 'anim-4', prompt: '走到桌前', duration: 4, source: 'rules', props: [table, table],
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }],
      cameraKeyframes: [
        { time: 2, position: [0, 1, 3], target: [0, 1, 0], fov: 45 },
        { time: 2, position: [0, 1, 3], target: [0, 1, 0], fov: 45 },
      ],
    });
    plan.environment.props[0].size.width = 0;
    plan.events[0].actionIndex = 9;
    const messages = validateScenePlan(plan).map((issue) => issue.message).join('；');
    expect(messages).toMatch(/重复的道具 ID/);
    expect(messages).toMatch(/道具.*尺寸无效/);
    expect(messages).toMatch(/重复关键帧/);
    expect(messages).toMatch(/不存在的动作段/);
  });

  it('warns when an enabled camera path has no keys or leaves part of the take on a held endpoint', () => {
    const empty = createScenePlan({
      animationId: 'empty-camera', prompt: '走到桌前', duration: 4, source: 'rules', props: [table],
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }], cameraEnabled: true,
    });
    expect(validateScenePlan(empty)).toContainEqual(expect.objectContaining({
      level: 'warning', path: 'camera.keyframes', message: expect.stringMatching(/没有.*关键帧/),
    }));

    const partial = createScenePlan({
      animationId: 'partial-camera', prompt: '走到桌前', duration: 4, source: 'rules', props: [table], cameraEnabled: true,
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }],
      cameraKeyframes: [{ time: 1, position: [0, 1, 3], target: [0, 1, 0], fov: 45 }],
    });
    expect(validateScenePlan(partial)).toContainEqual(expect.objectContaining({
      level: 'warning', path: 'camera.coverage', message: expect.stringMatching(/片头.*片尾/),
    }));
  });

  it('rejects a perspective camera keyframe whose position equals its look target', () => {
    const plan = createScenePlan({
      animationId: 'degenerate-camera', prompt: '走到桌前', duration: 4, source: 'rules', props: [table],
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }], cameraEnabled: true,
      cameraKeyframes: [{ time: 0, position: [0, 1, 0], target: [0, 1, 0], fov: 45 }],
    });
    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'error', path: 'camera.keyframes.0.direction', message: expect.stringMatching(/位置和注视点不能重合/),
    }));
  });

  it('rejects camera keyframes whose times are closer than the editor replacement tolerance', () => {
    const plan = createScenePlan({
      animationId: 'near-duplicate-camera', prompt: '走到桌前', duration: 4, source: 'rules', props: [table],
      actions: [{ t0: 0, t1: 4, template: 'march', clause: '走到桌前' }], cameraEnabled: true,
      cameraKeyframes: [
        { time: 1, position: [0, 1, 3], target: [0, 1, 0], fov: 45 },
        { time: 1.00005, position: [0, 1, 3], target: [0, 1, 0], fov: 45 },
      ],
    });
    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'error', path: 'camera.keyframes.1.time', message: expect.stringMatching(/重复关键帧/),
    }));
  });

  it('warns when an effect will be cut off at the end of the take', () => {
    const plan = createScenePlan({
      animationId: 'anim-5', prompt: '挥剑', duration: 4, source: 'rules', props: [],
      actions: [{ t0: 0, t1: 4, template: 'sword', clause: '挥剑' }],
      effects: [{ id: 'fx', kind: 'slash', time: 3.8, duration: 0.5, position: [0, 1, 0], scale: 1, color: '#ffffff' }],
    });
    expect(validateScenePlan(plan).map((issue) => issue.message).join()).toMatch(/被截断/);
  });

  it('rejects malformed effect IDs, coordinates, paths, scale and color without crashing', () => {
    const plan = createScenePlan({
      animationId: 'invalid-effect-fields', prompt: '挥剑', duration: 4, source: 'rules', props: [],
      actions: [{ t0: 0, t1: 4, template: 'sword', clause: '挥剑' }],
      effects: [
        { id: '', kind: 'slash', time: 1, duration: 0.3, position: [0, 1, 0], path: [[0, 1, 0], [1, 1, 0]], scale: 1, color: '#ffffff' },
        { id: '', kind: 'impact', time: 2, duration: 0.3, position: [101, 1, 0], path: [[0, 1, 0]] as never, scale: 6, color: 'blue' },
      ],
    });
    const issues = validateScenePlan(plan);
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'effects.0.id', 'effects.1.id', 'effects.1.position', 'effects.1.path', 'effects.1.scale', 'effects.1.color',
    ]));
  });

  it('rejects duplicate effect IDs and non-finite camera keyframe times', () => {
    const plan = createScenePlan({
      animationId: 'duplicate-effect-id', prompt: '挥剑', duration: 4, source: 'rules', props: [],
      actions: [{ t0: 0, t1: 4, template: 'sword', clause: '挥剑' }],
      effects: [
        { id: 'same-fx', kind: 'slash', time: 1, duration: 0.3, position: [0, 1, 0], scale: 1, color: '#ffffff' },
        { id: 'same-fx', kind: 'impact', time: 2, duration: 0.3, position: [0, 1, 0], scale: 1, color: '#ffffff' },
      ],
      cameraKeyframes: [{ time: Number.NaN, position: [0, 1, 3], target: [0, 1, 0], fov: 45 }],
    });
    expect(validateScenePlan(plan).map((issue) => issue.path)).toContain('effects.1.id');
    expect(validateScenePlan(plan).map((issue) => issue.path)).toContain('camera.keyframes.0.time');
  });

  it('links an effect to the action at its trigger time and rejects a mismatched explicit link', () => {
    const input = {
      animationId: 'anim-fx-link', prompt: '先挥剑再格挡', duration: 4, source: 'rules' as const, props: [],
      actions: [
        { t0: 0, t1: 2, template: 'sword', clause: '挥剑' },
        { t0: 2, t1: 4, template: 'block', clause: '格挡' },
      ],
      effects: [{ id: 'fx-linked', kind: 'slash' as const, time: 2.5, duration: 0.2, position: [0, 1, 0] as [number, number, number], scale: 1, color: '#ffffff' }],
    };
    expect(createScenePlan(input).effects[0].actionIndex).toBe(1);
    const plan = createScenePlan({ ...input, effects: [{ ...input.effects[0], actionIndex: 0 }] });
    expect(validateScenePlan(plan).some((issue) => issue.path === 'effects.0.actionIndex' && issue.level === 'error')).toBe(true);
  });

  it('rejects an action phase targeting a prop absent from the scene', () => {
    const plan = createScenePlan({
      animationId: 'anim-6', prompt: '拿起手机', duration: 4, source: 'rules', props: [],
      actions: [{ t0: 0, t1: 4, template: 'reach', clause: '拿起手机', targetPropId: 'missing-phone' }],
    });
    expect(validateScenePlan(plan).map((issue) => issue.message).join()).toMatch(/动作 1 引用了场景中不存在的道具/);
  });

  it('catches out-of-range motion controls and contact targets that disagree with the action phase', () => {
    const bed: StageProp = { id: 'bed-1', kind: 'bed', position: [0, 0, 0], rotationY: 0, size: { width: 1.4, height: 0.6, length: 2 } };
    const plan = createScenePlan({
      animationId: 'anim-7', prompt: '躺到床上', duration: 4, source: 'rules', props: [bed, table],
      actions: [{ t0: 0, t1: 4, template: 'lie', clause: '躺到床上', targetPropId: table.id, intensity: 2, speed: 0.2 }],
      contacts: [{ phase: 'lie', bodyPart: 'back', propId: bed.id, surface: 'mattress', relation: 'support' }],
      target: { distanceMeters: Number.NaN },
    });
    const issues = validateScenePlan(plan);
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'actions.0.intensity', 'actions.0.speed', 'contacts.0.propId', 'target.distanceMeters',
    ]));
  });

  it('accepts explicit ground support contacts only on the virtual ground target', () => {
    const plan = createScenePlan({
      animationId: 'ground-support', prompt: '躺下睡觉', duration: 4, source: 'rules', props: [],
      actions: [
        { t0: 0, t1: 2, template: 'lie', clause: '缓慢躺下并仰卧' },
        { t0: 2, t1: 4, template: 'sleep', clause: '仰卧放松并安静呼吸' },
      ],
      contacts: [
        { phase: 'lie', actionIndex: 0, bodyPart: 'back', propId: 'ground', surface: 'ground', relation: 'support' },
        { phase: 'sleep', actionIndex: 1, bodyPart: 'head', propId: 'ground', surface: 'ground', relation: 'rest' },
      ],
    });
    expect(validateScenePlan(plan).filter((issue) => issue.level === 'error')).toEqual([]);
    plan.contacts[0].propId = 'missing-ground';
    expect(validateScenePlan(plan).some((issue) => issue.path === 'contacts.0.propId')).toBe(true);

    const invalid = createScenePlan({
      animationId: 'bad-ground-support', prompt: '睡觉', duration: 2, source: 'rules', props: [],
      actions: [{ t0: 0, t1: 2, template: 'wave', clause: '睡觉' }],
      contacts: [{ phase: 'wave', actionIndex: 0, bodyPart: 'back', propId: 'ground', surface: 'ground', relation: 'approach' }],
    });
    expect(validateScenePlan(invalid).map((issue) => issue.message).join()).toMatch(/只能绑定跪地、躺卧或睡眠阶段/);
    expect(validateScenePlan(invalid).map((issue) => issue.message).join()).toMatch(/地面接触应为 support/);
  });

  it('rejects physically incompatible body-part and support-surface contacts', () => {
    const door: StageProp = { id: 'door-1', kind: 'door', position: [0, 0, 0], rotationY: 0, size: { width: 0.9, height: 2, length: 0.08 } };
    const plan = createScenePlan({
      animationId: 'anim-contact', prompt: '开门', duration: 4, source: 'rules', props: [door],
      actions: [{ t0: 0, t1: 4, template: 'reach', clause: '伸手开门', targetPropId: door.id }],
      contacts: [{ phase: 'reach', bodyPart: 'legs', propId: door.id, surface: 'handle', relation: 'support' }],
    });
    expect(validateScenePlan(plan).map((issue) => issue.message).join()).toMatch(/腿.*把手/);
  });

  it('warns when a declared seat or mattress is far outside human-scale support height', () => {
    const highChair: StageProp = { id: 'high-seat', kind: 'chair', position: [0, 0, 0], rotationY: 0, size: { width: 0.6, height: 2.4, length: 0.6 } };
    const lowBed: StageProp = { id: 'low-bed', kind: 'bed', position: [1, 0, 0], rotationY: 0, size: { width: 1.2, height: 0.12, length: 2 } };
    const plan = createScenePlan({
      animationId: 'support-height', prompt: '坐下再躺到床上', duration: 4, source: 'rules', character: { label: '主角', heightMeters: 1.7 },
      props: [highChair, lowBed],
      actions: [
        { t0: 0, t1: 2, template: 'sit', clause: '坐到椅面', targetPropId: highChair.id },
        { t0: 2, t1: 4, template: 'lie', clause: '躺到床面', targetPropId: lowBed.id },
      ],
      contacts: [
        { phase: 'sit', actionIndex: 0, bodyPart: 'pelvis', propId: highChair.id, surface: 'seat', relation: 'support' },
        { phase: 'lie', actionIndex: 1, bodyPart: 'back', propId: lowBed.id, surface: 'mattress', relation: 'support' },
      ],
    });

    expect(validateScenePlan(plan).filter((issue) => issue.path.startsWith('environment.props.')).map((issue) => issue.message).join())
      .toMatch(/座面高度.*超出常见可达\/坐卧范围.*床面高度/);
  });

  it('allows a small object in usable space between table legs but rejects overlap with the tabletop', () => {
    const table: StageProp = { id: 'desk', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 0.8, height: 0.75, length: 0.8 } };
    const phone: StageProp = { id: 'phone-under', kind: 'phone', position: [0, 0.25, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    expect(findStagePropOverlaps([table, phone])).toEqual([]);

    const phoneOnTable: StageProp = { ...phone, id: 'phone-on', position: [0, 0.7, 0] };
    expect(findStagePropOverlaps([table, phoneOnTable])).toEqual([
      expect.objectContaining({ firstPropId: 'desk', secondPropId: 'phone-on' }),
    ]);
  });

  it('validates manual prop edits before store clamping or scene mutation', () => {
    const room: StageProp = { id: 'room-edit', kind: 'room', position: [0, 0, 0], rotationY: 0, size: { width: 5, height: 3, length: 5 } };
    const desk: StageProp = { ...table, id: 'table-edit', position: [1.8, 0, 0] };
    const oversized = { ...desk, size: { ...desk.size, width: 4.5 } };
    expect(validateStagePropPlacement([room, table], oversized)).toMatch(/width 需在 0.3–4 米之间/);

    const smallerRoom = { ...room, size: { ...room.size, width: 3 } };
    expect(validateStagePropPlacement([room, desk], smallerRoom)).toMatch(/超出房间宽度/);
    const overlappingChair: StageProp = { id: 'chair-edit', kind: 'chair', position: [1.8, 0, 0], rotationY: 0, size: { width: 0.52, height: 0.9, length: 0.52 } };
    expect(validateStagePropPlacement([room, desk, overlappingChair], desk)).toMatch(/实体占位相交/);
  });

  it('accepts normal chair, bed and door-handle heights for the measured character', () => {
    const normalChair: StageProp = { id: 'chair-normal', kind: 'chair', position: [0, 0, 0], rotationY: 0, size: { width: 0.52, height: 0.9, length: 0.52 } };
    const normalBed: StageProp = { id: 'bed-normal', kind: 'bed', position: [1, 0, 0], rotationY: 0, size: { width: 1.3, height: 0.58, length: 2 } };
    const normalDoor: StageProp = { id: 'door-normal', kind: 'door', position: [2, 0, 0], rotationY: 0, size: { width: 0.9, height: 2.05, length: 0.08 } };
    const plan = createScenePlan({
      animationId: 'normal-support-height', prompt: '坐椅子，躺床上，开门', duration: 4, source: 'rules', character: { label: '主角', heightMeters: 1.7 },
      props: [normalChair, normalBed, normalDoor],
      actions: [
        { t0: 0, t1: 1.3, template: 'sit', clause: '坐到椅面', targetPropId: normalChair.id },
        { t0: 1.3, t1: 2.6, template: 'lie', clause: '躺到床面', targetPropId: normalBed.id },
        { t0: 2.6, t1: 4, template: 'reach', clause: '拉动门把手', targetPropId: normalDoor.id },
      ],
      contacts: [
        { phase: 'sit', actionIndex: 0, bodyPart: 'pelvis', propId: normalChair.id, surface: 'seat', relation: 'support' },
        { phase: 'lie', actionIndex: 1, bodyPart: 'back', propId: normalBed.id, surface: 'mattress', relation: 'support' },
        { phase: 'reach', actionIndex: 2, bodyPart: 'hand', propId: normalDoor.id, surface: 'handle', relation: 'support' },
      ],
    });

    expect(validateScenePlan(plan).filter((issue) => issue.message.includes('超出常见可达/坐卧范围'))).toEqual([]);
  });

  it('warns when an action stage omits the contact or support needed to complete it', () => {
    const bed: StageProp = { id: 'bed-contact', kind: 'bed', position: [0, 0, 0], rotationY: 0, size: { width: 1.4, height: 0.6, length: 2 } };
    const phone: StageProp = { id: 'phone-contact', kind: 'phone', position: [0, 0.8, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    const plan = createScenePlan({
      animationId: 'missing-contact', prompt: '坐到床上，拿起手机后躺下', duration: 8, source: 'rules', props: [bed, phone],
      actions: [
        { t0: 0, t1: 2, template: 'sit', clause: '坐到床上', targetPropId: bed.id },
        { t0: 2, t1: 4, template: 'reach', clause: '拿起手机', targetPropId: phone.id },
        { t0: 4, t1: 6, template: 'lie', clause: '躺到床上', targetPropId: bed.id },
        { t0: 6, t1: 8, template: 'sleep', clause: '安静睡觉', targetPropId: bed.id },
      ],
    });
    const missing = validateScenePlan(plan).filter((issue) => issue.path.endsWith('.contacts'));
    expect(missing.map((issue) => issue.path)).toEqual([
      'actions.0.contacts', 'actions.1.contacts', 'actions.2.contacts', 'actions.3.contacts',
    ]);
    expect(missing.every((issue) => issue.level === 'warning')).toBe(true);
  });

  it('rejects contacts whose body part or relation cannot satisfy the action stage', () => {
    const bed: StageProp = { id: 'bed-semantics', kind: 'bed', position: [0, 0, 0], rotationY: 0, size: { width: 1.4, height: 0.6, length: 2 } };
    const plan = createScenePlan({
      animationId: 'bad-contact-semantics', prompt: '坐到床上然后睡觉', duration: 4, source: 'rules', props: [bed],
      actions: [
        { t0: 0, t1: 2, template: 'sit', clause: '坐到床沿', targetPropId: bed.id },
        { t0: 2, t1: 4, template: 'sleep', clause: '安静睡觉', targetPropId: bed.id },
      ],
      contacts: [
        { phase: 'sit', actionIndex: 0, bodyPart: 'hand', propId: bed.id, surface: 'mattress', relation: 'approach' },
        { phase: 'sleep', actionIndex: 1, bodyPart: 'back', propId: bed.id, surface: 'mattress', relation: 'support' },
      ],
    });
    const issues = validateScenePlan(plan);
    expect(issues.find((issue) => issue.path === 'contacts.0.relation')?.message).toMatch(/坐下阶段.*support/);
    expect(issues.find((issue) => issue.path === 'contacts.1.relation')?.message).toMatch(/睡眠阶段.*rest/);
  });

  it('binds repeated contact templates to their exact action stage', () => {
    const phone: StageProp = { id: 'phone-1', kind: 'phone', position: [0, 0.8, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    const plan = createScenePlan({
      animationId: 'anim-repeated-contact', prompt: '拿起手机再放到桌上', duration: 4, source: 'rules', props: [phone, table],
      actions: [
        { t0: 0, t1: 1, template: 'march', clause: '走到手机前', targetPropId: phone.id },
        { t0: 1, t1: 2, template: 'reach', clause: '拿起手机', targetPropId: phone.id },
        { t0: 2, t1: 3, template: 'march', clause: '走到桌前', targetPropId: table.id },
        { t0: 3, t1: 4, template: 'reach', clause: '放到桌上', targetPropId: table.id },
      ],
      contacts: [{ phase: 'reach', actionIndex: 3, bodyPart: 'hand', propId: table.id, surface: 'interaction-point', relation: 'support' }],
    });
    const initialIssues = validateScenePlan(plan);
    expect(initialIssues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(initialIssues.find((issue) => issue.path === 'actions.1.contacts')?.message).toMatch(/缺少.*接触\/支撑关系/);

    plan.contacts[0].actionIndex = 1;
    expect(validateScenePlan(plan).find((issue) => issue.path === 'contacts.0.propId')?.message).toMatch(/动作阶段目标 phone-1/);
    plan.contacts[0].actionIndex = 2;
    expect(validateScenePlan(plan).find((issue) => issue.path === 'contacts.0.actionIndex')?.message).toMatch(/绑定的是 march 阶段/);
  });

  it('rejects a contact target that contradicts an explicitly indexed action target', () => {
    const phone: StageProp = { id: 'phone-contact', kind: 'phone', position: [0, 0.8, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    const plan = createScenePlan({
      animationId: 'contradictory-contact-target', prompt: '走到桌前拿起手机', duration: 4, source: 'model', props: [phone, table],
      actions: [{ t0: 0, t1: 4, template: 'reach', clause: '拿起手机', targetPropId: phone.id }],
      contacts: [{ phase: 'reach', actionIndex: 0, bodyPart: 'hand', propId: table.id, surface: 'interaction-point', relation: 'approach' }],
    });
    expect(validateScenePlan(plan)).toContainEqual(expect.objectContaining({
      level: 'error', path: 'contacts.0.propId', message: expect.stringMatching(/接触目标 table-1.*动作阶段目标 phone-contact.*修正/),
    }));
    const legacy = createScenePlan({
      animationId: 'legacy-contact-target', prompt: '拿起手机', duration: 4, source: 'rules', props: [phone, table],
      actions: [{ t0: 0, t1: 4, template: 'reach', clause: '拿起手机', targetPropId: phone.id }],
      contacts: [{ phase: 'reach', bodyPart: 'hand', propId: table.id, surface: 'interaction-point', relation: 'approach' }],
    });
    expect(validateScenePlan(legacy).find((issue) => issue.path === 'contacts.0.propId')?.level).toBe('warning');
  });

  it('turns a same-kind object ambiguity warning into a concrete clarification question', () => {
    const phoneA: StageProp = { id: 'phone-a', kind: 'phone', position: [0, 1, 0], rotationY: 0, size: { width: 0.08, height: 0.02, length: 0.15 } };
    const phoneB = { ...phoneA, id: 'phone-b', position: [1, 1, 0] as [number, number, number] };
    const plan = createScenePlan({
      animationId: 'ambiguous-target', prompt: '拿起手机', duration: 4, source: 'rules', props: [phoneA, phoneB],
      actions: [{ t0: 0, t1: 4, template: 'reach', clause: '伸手拿起手机' }],
      warnings: ['场景中有多个手机（phone-a、phone-b），无法仅凭描述确定目标'],
    });
    expect(plan.interpretation.questions).toContain('手机目标不明确，请选择具体道具：phone-a、phone-b');
  });

  it('allows timed events inside their action phase and warns when they fall outside it', () => {
    const plan = createScenePlan({
      animationId: 'anim-8', prompt: '挥手后鞠躬', duration: 4, source: 'rules', props: [],
      actions: [
        { t0: 0, t1: 2, template: 'wave', clause: '挥手' },
        { t0: 2, t1: 4, template: 'bow', clause: '鞠躬' },
      ],
    });
    plan.events.push({ time: 1.5, actionIndex: 0, label: '挥手到达最高点' });
    expect(validateScenePlan(plan).some((issue) => issue.path === 'events.2.time')).toBe(false);
    plan.events[2].time = 2.5;
    expect(validateScenePlan(plan).find((issue) => issue.path === 'events.2.time')?.message).toMatch(/不在所关联动作阶段内/);
  });
});
