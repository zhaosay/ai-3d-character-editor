import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { applyAIPreviewSuggestions } from '../src/services/motion/aiSuggestions';
import { useCameraStore } from '../src/stores/cameraStore';
import { useEffectsStore } from '../src/stores/effectsStore';
import type { StageProp } from '../src/core/previs/world';

const sword: StageProp = {
  id: 'sword-main', kind: 'sword', position: [0, 1, 0], rotationY: 0,
  size: { width: 0.045, height: 0.045, length: 0.9 }, attachTo: 'hand.R', attachOffset: [0, 0, 0],
};

afterEach(() => {
  useCameraStore.getState().clear();
  useEffectsStore.getState().clear();
});

describe('AI scene and shot suggestions', () => {
  it('creates editable camera keys and per-animation sword effect cues', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1;
    const hand = new THREE.Bone(); hand.name = 'Hand.R'; hand.position.set(0.4, 0.5, 0.2); hips.add(hand); character.add(hips);
    character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const notes = applyAIPreviewSuggestions({
      animationId: 'sword-take', duration: 3, prompt: '挥剑并命中', stageProps: [sword], character, skeleton,
      segments: [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑并命中', intensity: 1, speed: 1 }],
    });
    expect(useCameraStore.getState().enabled).toBe(true);
    expect(useCameraStore.getState().keyframes.map((key) => key.time)).toEqual([0, 3]);
    expect(useEffectsStore.getState().events.map((event) => event.kind)).toEqual(['slash']);
    expect(useEffectsStore.getState().events.every((event) => event.animationId === 'sword-take')).toBe(true);
    expect(useEffectsStore.getState().events[0].path).toBeUndefined();
    expect(notes.join()).toMatch(/建议镜头/);
  });

  it.each([
    ['hand.R', [0.4, 1.968, 0.2]],
    ['hand.L', [-0.4, 1.968, -0.2]],
  ] as const)('anchors sword effects to the attached %s', (attachTo, expectedPosition) => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1;
    const right = new THREE.Bone(); right.name = 'Hand.R'; right.position.set(0.4, 0.5, 0.2); hips.add(right);
    const left = new THREE.Bone(); left.name = 'Hand.L'; left.position.set(-0.4, 0.5, -0.2); hips.add(left);
    character.add(hips);
    character.updateWorldMatrix(true, true);
    const attachedSword = { ...sword, attachTo };

    applyAIPreviewSuggestions({
      animationId: `sword-${attachTo}`, duration: 3, prompt: '挥剑', stageProps: [attachedSword], character,
      skeleton: buildSkeletonTree(character),
      segments: [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑', intensity: 1, speed: 1 }],
    });

    expect(useEffectsStore.getState().events[0].position).toEqual(expectedPosition);
  });

  it('samples attack and impact positions at their event times and restores the live pose', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1;
    const hand = new THREE.Bone(); hand.name = 'Hand.R'; hand.position.set(0.4, 0.5, 0.2); hips.add(hand); character.add(hips);
    character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const opponent: StageProp = { id: 'opponent-main', kind: 'opponent', position: [0, 0, 1], rotationY: Math.PI, size: { width: 0.62, height: 1.72, length: 0.42 } };
    const animation = {
      id: 'sampled-sword', name: '挥剑', duration: 3, fps: 30, faceTracks: [],
      tracks: [{
        boneName: 'Hand.R',
        position: [
          { time: 0, value: [0.4, 0.5, 0.2] as [number, number, number], interp: 'linear' as const },
          { time: 3, value: [0.4, 1.5, 0.2] as [number, number, number], interp: 'linear' as const },
        ],
        rotation: [], scale: [],
      }],
    };

    applyAIPreviewSuggestions({
      animationId: 'sampled-sword', duration: 3, prompt: '挥剑并命中', stageProps: [sword, opponent], character, skeleton, animation,
      segments: [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑', intensity: 1, speed: 1, targetPropId: opponent.id }],
      collisionFindings: [{ propId: opponent.id, bodyPart: `剑身 ${sword.id}`, time: 1.7, estimatedOverlapMeters: 0.03, opponentContact: true, opponentZone: 'torso', contactPosition: [0.2, 1.1, 0.8] }],
    });

    const [slash, impact] = useEffectsStore.getState().events;
    expect(slash.path).toHaveLength(9);
    expect(slash.bladeSweep).toHaveLength(9);
    expect(slash.bladeSweep?.[0].base).not.toEqual(slash.bladeSweep?.[0].tip);
    expect(slash.path?.[0][1]).toBeLessThan(slash.path?.at(-1)?.[1] ?? 0);
    expect(slash.position[1]).toBeCloseTo(1 + 0.5 + 0.62 + 0.9 * 0.52);
    expect(impact.time).toBe(1.7);
    expect(impact.position).toEqual([0.2, 1.1, 0.8]);
    expect(hand.position.y).toBe(0.5);
  });

  it('does not claim a hit or add impact when a targeted sword attack misses the opponent proxy', () => {
    const character = new THREE.Group();
    const hand = new THREE.Bone(); hand.name = 'Hand.R'; character.add(hand);
    const opponent: StageProp = { id: 'opponent-main', kind: 'opponent', position: [0, 0, 2], rotationY: Math.PI, size: { width: 0.62, height: 1.72, length: 0.42 } };
    const notes = applyAIPreviewSuggestions({
      animationId: 'missed-hit', duration: 3, prompt: '挥剑命中对手', stageProps: [sword, opponent], character,
      skeleton: buildSkeletonTree(character),
      segments: [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑命中对手', intensity: 1, speed: 1, targetPropId: opponent.id }],
      collisionFindings: [],
    });
    expect(useEffectsStore.getState().events.map((event) => event.kind)).toEqual(['slash']);
    expect(notes.join()).toMatch(/采样未检测到.*接触；未生成冲击特效/);
  });

  it('explains when an unsupported animation track forces a static effect estimate', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1;
    const hand = new THREE.Bone(); hand.name = 'Hand.R'; hand.position.set(0.4, 0.5, 0.2); hips.add(hand); character.add(hips);
    character.updateWorldMatrix(true, true);
    const animation = {
      id: 'cubic-sword', name: '挥剑', duration: 3, fps: 30, faceTracks: [],
      tracks: [{
        boneName: 'Hand.R', position: [], scale: [],
        rotation: [
          { time: 0, value: [0, 0, 0, 1] as [number, number, number, number], interp: 'cubic' as const },
          { time: 3, value: [0, 0.7, 0, 0.7] as [number, number, number, number], interp: 'cubic' as const },
        ],
      }],
    };

    const notes = applyAIPreviewSuggestions({
      animationId: 'cubic-sword', duration: 3, prompt: '挥剑', stageProps: [sword], character,
      skeleton: buildSkeletonTree(character), animation,
      segments: [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑', intensity: 1, speed: 1 }],
    });

    expect(notes.join()).toMatch(/无法采样/);
    expect(hand.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('uses the sword named by each action and asks when multiple swords are ambiguous', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1;
    const right = new THREE.Bone(); right.name = 'Hand.R'; right.position.set(0.4, 0.5, 0.2); hips.add(right);
    const left = new THREE.Bone(); left.name = 'Hand.L'; left.position.set(-0.4, 0.5, -0.2); hips.add(left);
    character.add(hips);
    character.updateWorldMatrix(true, true);
    const swords = [sword, { ...sword, id: 'sword-offhand', attachTo: 'hand.L' as const }];
    const skeleton = buildSkeletonTree(character);
    const segment = (t0: number, t1: number, targetPropId?: string) => ({
      t0, t1, template: 'sword', clause: '挥剑', intensity: 1, speed: 1, ...(targetPropId ? { targetPropId } : {}),
    });

    const ambiguity = applyAIPreviewSuggestions({
      animationId: 'ambiguous-swords', duration: 3, prompt: '挥剑', stageProps: swords, character, skeleton,
      segments: [segment(0, 3)],
    });
    expect(useEffectsStore.getState().events).toHaveLength(0);
    expect(ambiguity.join()).toMatch(/多把剑/);

    const notes = applyAIPreviewSuggestions({
      animationId: 'specified-swords', duration: 3, prompt: '挥剑', stageProps: swords, character, skeleton,
      segments: [segment(0, 1, 'sword-main'), segment(1, 3, 'sword-offhand')],
    });
    const events = useEffectsStore.getState().events.filter((event) => event.animationId === 'specified-swords');
    expect(events.map((event) => event.position[0])).toEqual([0.4, -0.4]);
    expect(notes.join()).toMatch(/添加特效/);
  });

  it('refreshes its own previous camera suggestion but preserves hand-authored camera keys', () => {
    const segment = [{ t0: 0, t1: 3, template: 'march', clause: '走位' }];
    applyAIPreviewSuggestions({ animationId: 'take-a', duration: 3, segments: segment, prompt: '', stageProps: [], character: null, skeleton: null });
    applyAIPreviewSuggestions({ animationId: 'take-b', duration: 5, segments: [{ ...segment[0], t1: 5 }], prompt: '', stageProps: [], character: null, skeleton: null });
    expect(useCameraStore.getState().keyframes.at(-1)?.time).toBe(5);
    expect(useCameraStore.getState().autoGenerated).toBe(true);

    useCameraStore.getState().upsertKeyframe({ time: 1, position: [1, 2, 3], target: [0, 1, 0], fov: 45 }, 5);
    const manualKeys = useCameraStore.getState().keyframes;
    applyAIPreviewSuggestions({ animationId: 'take-c', duration: 4, segments: [{ ...segment[0], t1: 4 }], prompt: '', stageProps: [], character: null, skeleton: null });
    expect(useCameraStore.getState().keyframes).toEqual(manualKeys);
    expect(useCameraStore.getState().autoGenerated).toBe(false);
  });

  it('follows hips root motion with generated camera keys and restores the live pose', () => {
    const character = new THREE.Group();
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0); character.add(hips);
    character.updateWorldMatrix(true, true);
    const skeleton = buildSkeletonTree(character);
    const animation = {
      id: 'walk-across', name: '走到桌前', duration: 2, fps: 30, faceTracks: [],
      tracks: [{
        boneName: 'Hips',
        position: [
          { time: 0, value: [0, 1, 0] as [number, number, number], interp: 'linear' as const },
          { time: 2, value: [2, 3, 0] as [number, number, number], interp: 'linear' as const },
        ],
        rotation: [], scale: [],
      }],
    };

    applyAIPreviewSuggestions({
      animationId: 'walk-across', duration: 2, prompt: '走到桌前', stageProps: [], character, skeleton, animation,
      segments: [{ t0: 0, t1: 2, template: 'march', clause: '走到桌前', intensity: 1, speed: 1 }],
    });

    const [start, end] = useCameraStore.getState().keyframes;
    expect(end.target[0] - start.target[0]).toBeCloseTo(2);
    expect(end.target[1] - start.target[1]).toBeCloseTo(2);
    expect(end.position[1] - start.position[1]).toBeCloseTo(2);
    expect(hips.position.toArray()).toEqual([0, 1, 0]);
  });

  it('scales automatic camera distance and aim height to the visible character bounds', () => {
    const character = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.4), new THREE.MeshBasicMaterial());
    body.position.y = 0.85;
    character.add(body);
    character.updateWorldMatrix(true, true);
    const args = { animationId: 'camera-fit', duration: 2, segments: [{ t0: 0, t1: 2, template: 'march', clause: '走路' }], prompt: '', stageProps: [], character, skeleton: null };

    applyAIPreviewSuggestions(args);
    const normal = useCameraStore.getState().keyframes[0];
    useCameraStore.getState().clear();
    character.scale.setScalar(2);
    character.updateWorldMatrix(true, true);
    applyAIPreviewSuggestions(args);
    const large = useCameraStore.getState().keyframes[0];

    expect(large.position[0]).toBeCloseTo(normal.position[0] * 2);
    expect(large.position[1]).toBeCloseTo(normal.position[1] * 2);
    expect(large.target[1]).toBeCloseTo(normal.target[1] * 2);
  });
});
