import * as THREE from 'three';
import type { PlanSegment } from './procedural';
import type { StageProp } from '../../core/previs/world';
import { sampleWeaponAttachment } from '../../core/previs/world';
import { applySampledPose, indexBonesByName } from '../../core/animation/applyPose';
import { sampleAnimation } from '../../core/animation/sampler';
import type { AnimationData } from '../../core/animation/types';
import type { MotionCollision } from '../../core/previs/collision';
import type { SkeletonSnapshot } from '../../core/skeleton/types';
import { DEFAULT_CAMERA_POSE, type CameraKeyframe, type CameraPose } from '../../core/camera/track';
import { useCameraStore } from '../../stores/cameraStore';
import { useEffectsStore } from '../../stores/effectsStore';

function cameraFor(template: string, center: THREE.Vector3, actorScale: number): CameraPose {
  const full = ['march', 'lie', 'sleep', 'stand', 'sit'].includes(template);
  const close = ['look', 'reach', 'turn'].includes(template);
  const position = full ? [3.5, 2.0, 4.5] : close ? [2.25, 1.55, 2.9] : [3.0, 1.75, 3.8];
  const target = center.clone().add(new THREE.Vector3(0, (close ? 1.2 : 1.0) * actorScale, 0));
  return {
    position: [center.x + position[0] * actorScale, center.y + position[1] * actorScale, center.z + position[2] * actorScale],
    target: [target.x, target.y, target.z],
    fov: full ? 48 : close ? 42 : 46,
  };
}

function cameraPlan(segments: PlanSegment[], duration: number, centerAt: (time: number) => THREE.Vector3, actorScale: number): CameraKeyframe[] {
  const ordered = segments.length ? segments : [{ t0: 0, t1: duration, template: 'sway', clause: '' }];
  const keys = new Map<number, CameraKeyframe>();
  for (const segment of ordered) keys.set(segment.t0, { time: segment.t0, ...cameraFor(segment.template, centerAt(segment.t0), actorScale) });
  const last = ordered.at(-1)!;
  keys.set(duration, { time: duration, ...cameraFor(last.template, centerAt(duration), actorScale) });
  if (keys.size === 1) keys.set(duration, { time: duration, ...DEFAULT_CAMERA_POSE });
  return [...keys.values()].sort((a, b) => a.time - b.time);
}

function cameraActorFraming(character: THREE.Object3D | null): { center: THREE.Vector3; scale: number } {
  if (!character) return { center: new THREE.Vector3(), scale: 1 };
  const bounds = new THREE.Box3().setFromObject(character);
  if (bounds.isEmpty()) return { center: character.getWorldPosition(new THREE.Vector3()), scale: 1 };
  const size = bounds.getSize(new THREE.Vector3());
  const center = new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2);
  const height = Number.isFinite(size.y) && size.y > 0.25 ? size.y : 1.7;
  return { center, scale: height / 1.7 };
}

function cameraActorCenters(
  character: THREE.Object3D | null,
  skeleton: SkeletonSnapshot | null,
  animation: AnimationData | undefined,
  times: number[],
): Map<number, THREE.Vector3> {
  const fallback = cameraActorFraming(character).center;
  const centers = new Map(times.map((time) => [time, fallback.clone()]));
  const hipsNode = Object.values(skeleton?.nodes ?? {}).find((node) => node.semantic === 'hips');
  const hips = hipsNode && character ? character.getObjectByProperty('uuid', hipsNode.id) : null;
  if (!character || !hips || !animation || animation.tracks.length === 0) return centers;
  const bones = indexBonesByName(character);
  const saved = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  for (const track of animation.tracks) {
    const bone = bones.get(track.boneName);
    if (bone && !saved.has(track.boneName)) saved.set(track.boneName, {
      position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
    });
  }
  try {
    character.updateWorldMatrix(true, true);
    const rootPosition = fallback.clone();
    applySampledPose(character, sampleAnimation(animation, 0));
    character.updateWorldMatrix(true, true);
    const baselineHips = hips.getWorldPosition(new THREE.Vector3());
    for (const time of times) {
      applySampledPose(character, sampleAnimation(animation, time));
      character.updateWorldMatrix(true, true);
      centers.set(time, rootPosition.clone().add(hips.getWorldPosition(new THREE.Vector3()).sub(baselineHips)));
    }
  } catch {
    return centers;
  } finally {
    for (const [name, transform] of saved) {
      const bone = bones.get(name);
      if (!bone) continue;
      bone.position.copy(transform.position);
      bone.quaternion.copy(transform.quaternion);
      bone.scale.copy(transform.scale);
    }
    character.updateWorldMatrix(true, true);
  }
  return centers;
}

function swordEffectPosition(args: {
  sword: StageProp;
  time: number;
  segments: PlanSegment[];
  character: THREE.Object3D | null;
  skeleton: SkeletonSnapshot | null;
  animation?: AnimationData;
}): { position: THREE.Vector3; basePosition: THREE.Vector3; sampled: boolean } {
  const { sword, time, segments, character, skeleton, animation } = args;
  const attachment = sampleWeaponAttachment(sword, segments, time);
  const fallbackHand = attachment.from ?? sword.attachTo ?? 'hand.R';
  if (!character || !skeleton) {
    const basePosition = new THREE.Vector3(...sword.position);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sword.rotationY);
    const tipOffset = new THREE.Vector3(0, sword.size.length * 0.52, 0).applyQuaternion(rotation);
    return { basePosition, position: basePosition.clone().add(tipOffset), sampled: false };
  }

  const bones = indexBonesByName(character);
  const saved = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  let sampled = false;
  try {
    if (animation) {
      for (const track of animation.tracks) {
        const bone = bones.get(track.boneName);
        if (bone && !saved.has(track.boneName)) saved.set(track.boneName, {
          position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
        });
      }
      applySampledPose(character, sampleAnimation(animation, time));
      sampled = true;
    }

    const transformAtHand = (semantic: 'hand.R' | 'hand.L') => {
      const node = Object.values(skeleton.nodes).find((item) => item.semantic === semantic);
      const hand = node ? character.getObjectByProperty('uuid', node.id) : null;
      if (!hand) return null;
      const basePosition = new THREE.Vector3(...(sword.attachOffset ?? [0, 0, 0]));
      hand.localToWorld(basePosition);
      const rotation = hand.getWorldQuaternion(new THREE.Quaternion())
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sword.rotationY));
      const position = basePosition.clone().add(new THREE.Vector3(0, sword.size.length * 0.52, 0).applyQuaternion(rotation));
      return { basePosition, position, rotation };
    };
    character.updateWorldMatrix(true, true);
    const from = transformAtHand(attachment.from ?? fallbackHand);
    const to = transformAtHand(attachment.to ?? fallbackHand);
    if (!from || !to) return { position: new THREE.Vector3(...sword.position), basePosition: new THREE.Vector3(...sword.position), sampled: false };
    return {
      position: from.position.clone().lerp(to.position, attachment.blend),
      basePosition: from.basePosition.clone().lerp(to.basePosition, attachment.blend),
      sampled,
    };
  } catch {
    // Unsupported tracks should not prevent a usable, explicitly approximate effect cue.
    const node = Object.values(skeleton.nodes).find((item) => item.semantic === fallbackHand);
    const hand = node ? character.getObjectByProperty('uuid', node.id) : null;
    return {
      position: hand
        ? hand.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.12, 0))
        : new THREE.Vector3(...sword.position),
      basePosition: hand ? hand.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(...sword.position),
      sampled: false,
    };
  } finally {
    if (sampled) {
      for (const [name, transform] of saved) {
        const bone = bones.get(name);
        if (!bone) continue;
        bone.position.copy(transform.position);
        bone.quaternion.copy(transform.quaternion);
        bone.scale.copy(transform.scale);
      }
      character.updateWorldMatrix(true, true);
    }
  }
}

/** Adds editable camera and effect cues only when the user has not authored a camera path. */
export function applyAIPreviewSuggestions(args: {
  animationId: string;
  duration: number;
  segments: PlanSegment[];
  prompt: string;
  stageProps: StageProp[];
  character: THREE.Object3D | null;
  skeleton: SkeletonSnapshot | null;
  animation?: AnimationData;
  collisionFindings?: MotionCollision[];
}): string[] {
  const notes: string[] = [];
  const camera = useCameraStore.getState();
  if (camera.keyframes.length === 0 || camera.autoGenerated) {
    const sampleTimes = [...new Set([args.duration, ...args.segments.map((segment) => segment.t0)])];
    const framing = cameraActorFraming(args.character);
    const actorCenters = cameraActorCenters(args.character, args.skeleton, args.animation, sampleTimes);
    const fallback = args.character?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
    camera.setKeyframes(cameraPlan(args.segments, args.duration, (time) => actorCenters.get(time) ?? fallback, framing.scale), args.duration, true);
    camera.setEnabled(true);
    notes.push('已按动作段生成建议镜头，可在镜头面板逐帧微调');
  }

  const swords = args.stageProps.filter((prop) => prop.kind === 'sword');
  const attacks = args.segments.flatMap((segment, actionIndex) => segment.template === 'sword' ? [{ segment, actionIndex }] : []);
  if (attacks.length > 0) {
    const existing = useEffectsStore.getState().events.filter((event) => event.animationId === args.animationId);
    let allSampled = Boolean(args.animation);
    let added = 0;
    const warnings: string[] = [];
    for (const { segment, actionIndex } of attacks) {
      const sword = swords.find((prop) => prop.id === segment.targetPropId)
        ?? swords.find((prop) => args.prompt.includes(prop.id))
        ?? (swords.length === 1 ? swords[0] : undefined);
      if (!sword) {
        warnings.push(swords.length > 1
          ? `第 ${actionIndex + 1} 段挥剑没有指定武器；场景中有多把剑，未自动添加特效`
          : `第 ${actionIndex + 1} 段挥剑没有可用的场景剑，未自动添加特效`);
        continue;
      }
      if (!sword.attachTo) {
        warnings.push(`武器 ${sword.id} 未挂接左右手，未自动添加挥剑特效`);
        continue;
      }
      const slashTime = segment.t0 + (segment.t1 - segment.t0) * 0.62;
      const slash = swordEffectPosition({ ...args, sword, time: slashTime });
      allSampled &&= slash.sampled;
      const pathStart = segment.t0 + (segment.t1 - segment.t0) * 0.42;
      const pathEnd = segment.t0 + (segment.t1 - segment.t0) * 0.78;
      let pathSampled = true;
      const samples = Array.from({ length: 9 }, (_, index) => {
        const time = pathStart + (pathEnd - pathStart) * index / 8;
        const sample = swordEffectPosition({ ...args, sword, time });
        allSampled &&= sample.sampled;
        pathSampled &&= sample.sampled;
        return {
          base: sample.basePosition.toArray() as [number, number, number],
          tip: sample.position.toArray() as [number, number, number],
        };
      });
      const path = samples.map((sample) => sample.tip);
      const pathLength = path.slice(1).reduce((length, point, index) => length + new THREE.Vector3(...point).distanceTo(new THREE.Vector3(...path[index])), 0);
      useEffectsStore.getState().add('slash', slashTime, args.animationId, slash.position.toArray(), actionIndex,
        pathSampled && pathLength > 0.03 ? path : undefined,
        pathSampled ? samples : undefined);
      added += 1;
      const opponentId = segment.targetPropId;
      const impact = args.collisionFindings?.filter((finding) => finding.opponentContact
        && finding.propId === opponentId && finding.bodyPart === `剑身 ${sword.id}`
        && finding.time >= segment.t0 - 1e-4 && finding.time <= segment.t1 + 1e-4)
        .sort((left, right) => left.time - right.time)[0];
      if (impact?.contactPosition) {
        useEffectsStore.getState().add('impact', impact.time, args.animationId, impact.contactPosition, actionIndex);
        added += 1;
      } else if (/命中|击中|砍中|刺中/.test(args.prompt) && opponentId) {
        warnings.push(`第 ${actionIndex + 1} 段描述要求命中对手，但剑身采样未检测到与目标占位体接触；未生成冲击特效`);
      }
    }
    if (existing.length === 0 && added > 0) notes.push(allSampled
      ? '已采样挥剑时段的剑尖轨迹并添加可编辑拖尾/命中特效；轨迹是姿势估算，不代表碰撞判定'
      : '已为挥剑段添加特效；动画轨道无法采样，位置按当前骨架姿势估值，可继续编辑');
    notes.push(...new Set(warnings));
  }
  return notes;
}
