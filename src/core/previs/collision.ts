import * as THREE from 'three';
import type { AnimationData } from '../animation/types';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { sampleAnimation } from '../animation/sampler';
import { getPropCollisionBoxes, sampleDoorOpenAngle, samplePortablePropTransfer, sampleWeaponAttachment, type ContactConstraint, type PropCollisionBox, type StageProp } from './world';
import type { SkeletonSnapshot } from '../skeleton/types';

export type OpponentContactZone = 'head' | 'torso' | 'legs';
export interface MotionCollision {
  propId: string;
  bodyPart: string;
  time: number;
  estimatedOverlapMeters: number;
  opponentContact?: boolean;
  opponentZone?: OpponentContactZone;
  requestedOpponentZone?: OpponentContactZone;
  contactPosition?: [number, number, number];
  sweepSamplingLimited?: boolean;
}

/** Identifies diagnostics that must be replaced after motion or scene changes. */
export function isMotionCollisionWarning(warning: string): boolean {
  return /动作约 .*?(?:可能与道具 .*?相交|代理估算穿入地面|代理估算超出房间边界|代理与对手 .*?发生估算接触|扫掠碰撞检查达到采样上限)|人物-道具碰撞检查/.test(warning);
}

const BODY_PARTS: Array<{ pattern: RegExp; label: string; radius: number }> = [
  { pattern: /hips|pelvis|spine|chest|torso/i, label: 'torso', radius: 0.13 },
  { pattern: /head|neck/i, label: 'head', radius: 0.11 },
  { pattern: /hand|wrist/i, label: 'hand', radius: 0.04 },
  { pattern: /upper.?arm|forearm|shoulder|arm/i, label: 'arm', radius: 0.055 },
  { pattern: /thigh|shin|calf|foot|leg/i, label: 'leg', radius: 0.075 },
];

export function motionCollisionCoverageWarning(character: THREE.Object3D): string | null {
  const covered = new Set<string>();
  character.traverse((object) => {
    if (!(object as THREE.Bone).isBone) return;
    const body = BODY_PARTS.find((part) => part.pattern.test(object.name));
    if (body) covered.add(body.label);
  });
  if (covered.size === 0) return '人物-道具碰撞检查未生效：当前骨架未识别到人体语义骨骼，请先映射骨骼后再判断穿模';
  const missing = BODY_PARTS.map((part) => part.label).filter((part) => !covered.has(part));
  if (missing.length > 0) return `人物-道具碰撞检查覆盖不完整：未识别到${missing.join('、')}骨骼，相关身体部位无法判定穿模`;
  return null;
}

export function formatMotionCollisionWarnings(findings: MotionCollision[], character?: THREE.Object3D): string[] {
  return [
    ...(character ? [motionCollisionCoverageWarning(character)].filter((warning): warning is string => warning !== null) : []),
    ...findings.map((finding) => finding.sweepSamplingLimited
      ? `动作约 ${finding.time.toFixed(1)} 秒：${finding.bodyPart}扫掠碰撞检查达到采样上限，相邻代理位移约 ${(finding.estimatedOverlapMeters * 100).toFixed(0)} 厘米；无法排除穿过薄物体，请降低该段速度或人工复核`
      : finding.propId === '地面'
      ? `动作约 ${finding.time.toFixed(1)} 秒：${finding.bodyPart}代理估算穿入地面 ${(finding.estimatedOverlapMeters * 100).toFixed(0)} 厘米；请调整动作高度或姿势后复查`
      : finding.propId === '房间边界'
        ? `动作约 ${finding.time.toFixed(1)} 秒：${finding.bodyPart}代理估算超出房间边界 ${(finding.estimatedOverlapMeters * 100).toFixed(0)} 厘米；请调整房间尺寸、人物位置或动作幅度后复查`
      : finding.opponentContact
        ? `动作约 ${finding.time.toFixed(1)} 秒：${finding.bodyPart}代理与对手 ${finding.propId}${finding.opponentZone ? `的${({ head: '头部', torso: '躯干', legs: '腿部' })[finding.opponentZone]}` : ''}发生估算接触（交叠约 ${(finding.estimatedOverlapMeters * 100).toFixed(0)} 厘米）${finding.requestedOpponentZone && finding.opponentZone !== finding.requestedOpponentZone ? `；描述目标为${({ head: '头部', torso: '躯干', legs: '腿部' })[finding.requestedOpponentZone]}，采样接触位置估算为${({ head: '头部', torso: '躯干', legs: '腿部' })[finding.opponentZone!]}` : ''}；区域按占位体估算，不代表真实命中或格挡已验证`
      : `动作约 ${finding.time.toFixed(1)} 秒：${finding.bodyPart}可能与道具 ${finding.propId} 相交（胶囊/包围盒估算交叠 ${(finding.estimatedOverlapMeters * 100).toFixed(0)} 厘米）；请检查道具距离、高度、尺寸或动作后复查`),
  ];
}

function opponentContactDetails(
  a: THREE.Vector3,
  b: THREE.Vector3,
  opponent: StageProp,
  radius: number,
): { zone: OpponentContactZone; contactPosition: [number, number, number] } {
  const contactingBoxes = getPropCollisionBoxes(opponent).flatMap((box) => box.contactZone && segmentBoxDistance(a, b, opponent, box) <= radius
    ? [{ box, zone: box.contactZone, distance: segmentBoxDistance(a, b, opponent, box) }]
    : []).sort((left, right) => left.distance - right.distance);
  const hit = contactingBoxes[0];
  const zone = hit?.zone ?? 'torso';
  const localCenter = new THREE.Vector3(...(hit?.box.center ?? [0, opponent.size.height * 0.58, 0]));
  const worldCenter = localCenter.applyAxisAngle(new THREE.Vector3(0, 1, 0), opponent.rotationY).add(new THREE.Vector3(...opponent.position));
  const direction = b.clone().sub(a);
  const amount = direction.lengthSq() > 1e-10 ? THREE.MathUtils.clamp(worldCenter.clone().sub(a).dot(direction) / direction.lengthSq(), 0, 1) : 0.5;
  const contact = a.clone().addScaledVector(direction, amount);
  return { zone, contactPosition: [contact.x, contact.y, contact.z] };
}

function requestedOpponentContactZone(clause: string): OpponentContactZone | undefined {
  if (/头部|头|脸/.test(clause)) return 'head';
  if (/腿部|腿|下盘/.test(clause)) return 'legs';
  if (/躯干|胸|腹|上身/.test(clause)) return 'torso';
  return undefined;
}

function estimateRoomBoundaryOverflow(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  room: StageProp,
): number {
  const cosine = Math.cos(room.rotationY);
  const sine = Math.sin(room.rotationY);
  const toRoomLocal = (point: THREE.Vector3) => {
    const dx = point.x - room.position[0];
    const dz = point.z - room.position[2];
    return {
      x: dx * cosine + dz * sine,
      y: point.y - room.position[1],
      z: -dx * sine + dz * cosine,
    };
  };
  const start = toRoomLocal(a);
  const end = toRoomLocal(b);
  const horizontalX = Math.max(Math.abs(start.x), Math.abs(end.x)) + radius - room.size.width / 2;
  const horizontalZ = Math.max(Math.abs(start.z), Math.abs(end.z)) + radius - room.size.length / 2;
  const ceiling = Math.max(start.y, end.y) + radius - room.size.height;
  return Math.max(0, horizontalX, horizontalZ, ceiling);
}

function collectMotionSampleTimes(
  animation: AnimationData,
  actions: Array<{ t0: number; t1: number; template?: string; clause?: string; targetPropId?: string }>,
  props: StageProp[],
): number[] {
  const count = Math.min(301, Math.max(2, Math.ceil(animation.duration * 10) + 1));
  const times = new Set<number>(Array.from({ length: count }, (_, index) => animation.duration * index / (count - 1)));
  const timedActions = actions.map((action) => ({ ...action, template: action.template ?? '', clause: action.clause ?? '' }));
  for (const track of animation.tracks) {
    for (const key of [...track.position, ...track.rotation, ...track.scale]) {
      if (Number.isFinite(key.time) && key.time >= 0 && key.time <= animation.duration) times.add(key.time);
    }
    const rotations = [...track.rotation].sort((a, b) => a.time - b.time);
    for (let index = 1; index < rotations.length; index++) {
      const from = rotations[index - 1];
      const to = rotations[index];
      if (from.interp === 'step' || to.interp === 'step' || from.interp === 'cubic'
        || to.interp === 'cubic' || to.time <= from.time
        || from.value.some((value) => !Number.isFinite(value))
        || to.value.some((value) => !Number.isFinite(value))) continue;
      const start = new THREE.Quaternion(...from.value).normalize();
      const end = new THREE.Quaternion(...to.value).normalize();
      const angle = start.angleTo(end);
      const subdivisions = Math.min(64, Math.ceil(angle / THREE.MathUtils.degToRad(5)));
      for (let step = 1; step < subdivisions; step++) {
        times.add(THREE.MathUtils.lerp(from.time, to.time, step / subdivisions));
      }
    }
  }
  for (const action of actions) {
    if (Number.isFinite(action.t0) && action.t0 >= 0 && action.t0 <= animation.duration) times.add(action.t0);
    if (Number.isFinite(action.t1) && action.t1 >= 0 && action.t1 <= animation.duration) times.add(action.t1);
  }
  for (const door of props.filter((prop) => prop.kind === 'door')) {
    for (const action of actions) {
      if (action.targetPropId !== door.id || action.template !== 'reach') continue;
      const startAngle = sampleDoorOpenAngle(timedActions, door.id, action.t0);
      const endAngle = sampleDoorOpenAngle(timedActions, door.id, action.t1);
      const delta = endAngle - startAngle;
      const subdivisions = Math.min(64, Math.ceil(Math.abs(delta) / THREE.MathUtils.degToRad(5)));
      for (let step = 1; step < subdivisions; step++) {
        const targetAngle = startAngle + delta * step / subdivisions;
        let low = action.t0;
        let high = action.t1;
        for (let iteration = 0; iteration < 24; iteration++) {
          const mid = (low + high) / 2;
          const angle = sampleDoorOpenAngle(timedActions, door.id, mid);
          if ((delta > 0 && angle < targetAngle) || (delta < 0 && angle > targetAngle)) low = mid;
          else high = mid;
        }
        times.add((low + high) / 2);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Verify that explicitly declared ground support reaches the floor in the sampled pose. */
export function inspectGroundSupportWarnings(
  character: THREE.Object3D,
  animation: AnimationData,
  actions: Array<{ t0: number; t1: number; template: string; clause?: string }>,
  contacts: ContactConstraint[],
  groundY = 0,
): string[] {
  if (!Number.isFinite(animation.duration) || animation.duration <= 0) return [];
  const bones = indexBonesByName(character);
  const saved = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  bones.forEach((bone, name) => saved.set(name, { p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
  const warnings: string[] = [];
  const checked = new Set<string>();
  const contactSpecs: Record<ContactConstraint['bodyPart'], { pattern: RegExp; radius: number }> = {
    pelvis: { pattern: /hips|pelvis/i, radius: 0.13 },
    back: { pattern: /spine|chest|back|torso/i, radius: 0.13 },
    head: { pattern: /head|neck/i, radius: 0.11 },
    legs: { pattern: /thigh|shin|calf|foot|leg|knee/i, radius: 0.075 },
    hand: { pattern: /hand|wrist/i, radius: 0.04 },
  };
  try {
    for (const contact of contacts) {
      if (contact.propId !== 'ground' || contact.surface !== 'ground' || contact.relation === 'approach') continue;
      let actionIndex = contact.actionIndex;
      if (actionIndex === undefined) {
        const matches = actions.flatMap((action, index) => action.template === contact.phase || action.clause?.includes(contact.phase) ? [index] : []);
        if (matches.length !== 1) continue;
        actionIndex = matches[0];
      }
      const action = actions[actionIndex];
      if (!action || !Number.isFinite(action.t0) || !Number.isFinite(action.t1) || action.t1 <= action.t0) continue;
      const key = `${actionIndex}:${contact.bodyPart}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const spec = contactSpecs[contact.bodyPart];
      const matchingBones = [...bones.values()].filter((bone) => spec.pattern.test(bone.name));
      if (matchingBones.length === 0) {
        warnings.push(`动作段 ${actionIndex + 1} 声明${contact.bodyPart}支撑地面，但骨架没有映射对应骨骼，无法核实支撑`);
        continue;
      }
      const start = action.t0 + (action.t1 - action.t0) * 0.65;
      const sampleCount = Math.min(16, Math.max(2, Math.ceil((action.t1 - start) * 10) + 1));
      let closestBottom = Infinity;
      let closestTime = start;
      let nearFloorSamples = 0;
      let penetratingSamples = 0;
      let deepestBottom = Infinity;
      for (let i = 0; i < sampleCount; i++) {
        const time = start + (action.t1 - start) * i / (sampleCount - 1);
        applySampledPose(character, sampleAnimation(animation, time));
        character.updateWorldMatrix(true, true);
        const lowestBottom = matchingBones.reduce((lowest, bone) => {
          const worldPosition = bone.getWorldPosition(new THREE.Vector3());
          const scale = bone.getWorldScale(new THREE.Vector3());
          const radius = spec.radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
          return Math.min(lowest, worldPosition.y - radius);
        }, Infinity);
        if (lowestBottom >= groundY - 0.08 && lowestBottom <= groundY + 0.12) nearFloorSamples++;
        if (lowestBottom < groundY - 0.08) penetratingSamples++;
        deepestBottom = Math.min(deepestBottom, lowestBottom);
        if (Math.abs(lowestBottom - groundY) < Math.abs(closestBottom - groundY)) {
          closestBottom = lowestBottom;
          closestTime = time;
        }
      }
      const gap = closestBottom - groundY;
      if (penetratingSamples >= Math.max(2, Math.ceil(sampleCount * 0.2))) {
        warnings.push(`动作约 ${closestTime.toFixed(1)} 秒：声明${contact.bodyPart}支撑地面，但骨骼胶囊估算持续穿入地面 ${((groundY - deepestBottom) * 100).toFixed(0)} 厘米；请检查动作高度和姿态`);
      } else if (nearFloorSamples < sampleCount * 0.6 && gap > 0.18) {
        warnings.push(`动作约 ${closestTime.toFixed(1)} 秒：声明${contact.bodyPart}支撑地面，但骨骼胶囊估算仍离地 ${(gap * 100).toFixed(0)} 厘米；请检查动作高度和姿态`);
      } else if (nearFloorSamples < sampleCount * 0.6) {
        warnings.push(`动作段 ${actionIndex + 1} 声明${contact.bodyPart}持续支撑地面，但末段仅 ${nearFloorSamples}/${sampleCount} 个骨骼采样处于接触范围，支撑可能不稳定`);
      }
    }
  } finally {
    const live = indexBonesByName(character);
    saved.forEach((pose, name) => {
      const bone = live.get(name); if (!bone) return;
      bone.position.copy(pose.p); bone.quaternion.copy(pose.q); bone.scale.copy(pose.s);
    });
    character.updateWorldMatrix(true, true);
  }
  return warnings;
}

/** Checks declared bed/chair/sofa support against its rotated top-surface footprint. */
export function inspectPropSupportWarnings(
  character: THREE.Object3D,
  animation: AnimationData,
  actions: Array<{ t0: number; t1: number; template: string; clause?: string }>,
  contacts: ContactConstraint[],
  props: StageProp[],
): string[] {
  if (!Number.isFinite(animation.duration) || animation.duration <= 0) return [];
  const bones = indexBonesByName(character);
  const specs: Record<ContactConstraint['bodyPart'], { pattern: RegExp; radius: number }> = {
    pelvis: { pattern: /hips|pelvis/i, radius: 0.13 },
    back: { pattern: /spine|chest|back|torso/i, radius: 0.13 },
    head: { pattern: /head|neck/i, radius: 0.11 },
    legs: { pattern: /thigh|shin|calf|foot|leg|knee/i, radius: 0.075 },
    hand: { pattern: /hand|wrist/i, radius: 0.04 },
  };
  const saved = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  bones.forEach((bone, name) => saved.set(name, { p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
  const warnings: string[] = [];
  const checked = new Set<string>();
  try {
    for (const contact of contacts) {
      if ((contact.surface !== 'mattress' && contact.surface !== 'seat') || contact.relation === 'approach') continue;
      const prop = props.find((item) => item.id === contact.propId);
      if (!prop || (contact.surface === 'mattress' && prop.kind !== 'bed')
        || (contact.surface === 'seat' && prop.kind !== 'chair' && prop.kind !== 'sofa' && prop.kind !== 'bed')) continue;
      let actionIndex = contact.actionIndex;
      if (actionIndex === undefined) {
        const matches = actions.flatMap((action, index) => action.template === contact.phase || action.clause?.includes(contact.phase) ? [index] : []);
        if (matches.length !== 1) continue;
        actionIndex = matches[0];
      }
      const action = actions[actionIndex];
      if (!action || !Number.isFinite(action.t0) || !Number.isFinite(action.t1) || action.t1 <= action.t0) continue;
      const key = `${actionIndex}:${contact.bodyPart}:${prop.id}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const spec = specs[contact.bodyPart];
      const matching = [...bones.values()].filter((bone) => spec.pattern.test(bone.name));
      if (!matching.length) {
        warnings.push(`动作段 ${actionIndex + 1} 声明${contact.bodyPart}支撑 ${prop.id}，但骨架没有映射对应骨骼，无法核实支撑面`);
        continue;
      }
      const start = action.t0 + (action.t1 - action.t0) * 0.65;
      const count = Math.min(16, Math.max(2, Math.ceil((action.t1 - start) * 10) + 1));
      const surfaceY = contact.surface === 'seat' && prop.kind === 'chair'
        ? prop.position[1] + prop.size.height * 0.52
        : contact.surface === 'seat' && prop.kind === 'sofa'
          ? prop.position[1] + prop.size.height * 0.58
          : prop.position[1] + prop.size.height;
      const seatOffset = contact.surface === 'seat' && prop.kind === 'sofa'
        ? new THREE.Vector3(0, 0, prop.size.length * 0.06).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY)
        : new THREE.Vector3();
      const center = new THREE.Vector3(prop.position[0], surfaceY, prop.position[2]).add(seatOffset);
      const inverseRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -prop.rotationY);
      const halfW = prop.size.width * (prop.kind === 'sofa' ? 0.42 : 0.5);
      const halfL = prop.size.length * (prop.kind === 'sofa' ? 0.39 : 0.5);
      let supported = 0; let outside = 0; let highestGap = -Infinity; let lowestGap = Infinity;
      for (let i = 0; i < count; i++) {
        const time = start + (action.t1 - start) * i / (count - 1);
        applySampledPose(character, sampleAnimation(animation, time));
        character.updateWorldMatrix(true, true);
        const points = matching.map((bone) => {
          const position = bone.getWorldPosition(new THREE.Vector3());
          const scale = bone.getWorldScale(new THREE.Vector3());
          const radius = spec.radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
          const local = position.clone().sub(center).applyQuaternion(inverseRotation);
          return { local, radius };
        });
        const inFootprint = points.some(({ local, radius }) => Math.abs(local.x) <= halfW + radius && Math.abs(local.z) <= halfL + radius);
        const gap = Math.min(...points.map(({ local, radius }) => local.y - radius));
        highestGap = Math.max(highestGap, gap); lowestGap = Math.min(lowestGap, gap);
        if (!inFootprint) outside++;
        if (inFootprint && gap >= -0.08 && gap <= 0.16) supported++;
      }
      if (supported < count * 0.6) {
        if (outside >= count * 0.4) warnings.push(`动作约 ${start.toFixed(1)} 秒：声明${contact.bodyPart}支撑 ${prop.id} 的${contact.surface === 'mattress' ? '床面' : '座面'}，但骨架代理多次落在支撑面边界外；请调整位置、朝向或动作目标`);
        else if (highestGap < -0.08) warnings.push(`动作约 ${start.toFixed(1)} 秒：声明${contact.bodyPart}支撑 ${prop.id}，但骨架代理估算持续穿入${contact.surface === 'mattress' ? '床面' : '座面'} ${(-lowestGap * 100).toFixed(0)} 厘米；请检查高度和姿态`);
        else warnings.push(`动作约 ${start.toFixed(1)} 秒：声明${contact.bodyPart}支撑 ${prop.id}，但骨架代理与支撑面估算间隙约 ${(Math.max(0, highestGap) * 100).toFixed(0)} 厘米；请检查动作高度`);
      }
    }
  } finally {
    const live = indexBonesByName(character);
    saved.forEach((pose, name) => {
      const bone = live.get(name); if (!bone) return;
      bone.position.copy(pose.p); bone.quaternion.copy(pose.q); bone.scale.copy(pose.s);
    });
    character.updateWorldMatrix(true, true);
  }
  return warnings;
}

function segmentInPropSpace(a: THREE.Vector3, b: THREE.Vector3, prop: StageProp) {
  const center = new THREE.Vector3(prop.position[0], prop.position[1] + prop.size.height / 2, prop.position[2]);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).invert();
  const toLocal = (point: THREE.Vector3) => point.clone().sub(center).applyQuaternion(rotation);
  return { start: toLocal(a), end: toLocal(b) };
}

type HandSemantic = 'hand.R' | 'hand.L';
type HandWorldPositions = Partial<Record<HandSemantic, THREE.Vector3>>;

function getHandWorldPositions(character: THREE.Object3D, skeleton?: SkeletonSnapshot): HandWorldPositions {
  const positions: HandWorldPositions = {};
  for (const semantic of ['hand.R', 'hand.L'] as const) {
    const node = Object.values(skeleton?.nodes ?? {}).find((candidate) => candidate.semantic === semantic);
    const hand = node ? character.getObjectByProperty('uuid', node.id) : null;
    if (hand) positions[semantic] = hand.getWorldPosition(new THREE.Vector3());
  }
  return positions;
}

function interpolateHandWorldPositions(
  previous: HandWorldPositions | undefined,
  current: HandWorldPositions,
  previousTime: number | undefined,
  currentTime: number,
  time: number,
): HandWorldPositions {
  if (!previous || previousTime === undefined || currentTime <= previousTime) return current;
  const amount = THREE.MathUtils.clamp((time - previousTime) / (currentTime - previousTime), 0, 1);
  const positions: HandWorldPositions = {};
  for (const semantic of ['hand.R', 'hand.L'] as const) {
    const from = previous[semantic]; const to = current[semantic];
    if (from && to) positions[semantic] = from.clone().lerp(to, amount);
    else if (to) positions[semantic] = to;
  }
  return positions;
}

function segmentInPropGroupSpace(a: THREE.Vector3, b: THREE.Vector3, prop: StageProp) {
  const origin = new THREE.Vector3(...prop.position);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -prop.rotationY);
  return { start: a.clone().sub(origin).applyQuaternion(rotation), end: b.clone().sub(origin).applyQuaternion(rotation) };
}

type TimedAction = { t0: number; t1: number; template: string; clause: string; targetPropId?: string };

function propAtTime(
  prop: StageProp,
  actions: TimedAction[],
  time: number,
  character?: THREE.Object3D,
  skeleton?: SkeletonSnapshot,
  props: StageProp[] = [prop],
  contacts: ContactConstraint[] = [],
  handPositions?: HandWorldPositions,
): StageProp {
  if (prop.kind === 'door') {
    const angle = sampleDoorOpenAngle(actions, prop.id, time);
    if (Math.abs(angle) > 1e-7) {
      const hinge = new THREE.Vector3(-prop.size.width / 2, 0, 0)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY)
        .add(new THREE.Vector3(...prop.position));
      const leafCenter = new THREE.Vector3(prop.size.width / 2, 0, 0)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY + angle)
        .add(hinge);
      return { ...prop, position: [leafCenter.x, prop.position[1], leafCenter.z], rotationY: prop.rotationY + angle };
    }
  }
  const transfer = samplePortablePropTransfer(prop, props, actions, contacts, time);
  if (!transfer) return prop;
  if (transfer.attachmentWeight <= 1e-5 && transfer.placementPosition) return { ...prop, position: transfer.placementPosition };
  const handNode = Object.values(skeleton?.nodes ?? {}).find((node) => node.semantic === transfer.hand);
  const hand = handNode && character ? character.getObjectByProperty('uuid', handNode.id) : null;
  if (!hand) return prop;
  hand.updateWorldMatrix(true, false);
  const attached = handPositions?.[transfer.hand]?.clone() ?? hand.getWorldPosition(new THREE.Vector3());
  attached.y -= prop.size.height * 0.65;
  let position = new THREE.Vector3(...prop.position).lerp(attached, transfer.attachmentWeight);
  if (transfer.placementPosition) position = position.lerp(new THREE.Vector3(...transfer.placementPosition), 1 - transfer.attachmentWeight);
  return { ...prop, position: [position.x, position.y, position.z] };
}

function segmentBoxDistanceLocal(start: THREE.Vector3, end: THREE.Vector3, box: PropCollisionBox): number {
  const origin = [start.x - box.center[0], start.y - box.center[1], start.z - box.center[2]];
  const delta = [end.x - start.x, end.y - start.y, end.z - start.z];
  const half = box.size.map((size) => size / 2);
  const breaks = [0, 1];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(delta[axis]) < 1e-10) continue;
    for (const boundary of [-half[axis], half[axis]]) {
      const time = (boundary - origin[axis]) / delta[axis];
      if (time > 0 && time < 1) breaks.push(time);
    }
  }
  breaks.sort((a, b) => a - b);
  const distanceSquaredAt = (time: number) => {
    let sum = 0;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = origin[axis] + delta[axis] * time;
      const outside = Math.max(0, Math.abs(coordinate) - half[axis]);
      sum += outside * outside;
    }
    return sum;
  };
  let minimum = Math.min(distanceSquaredAt(0), distanceSquaredAt(1));
  for (let interval = 1; interval < breaks.length; interval++) {
    const low = breaks[interval - 1];
    const high = breaks[interval];
    const middle = (low + high) / 2;
    let slopeDotIntercept = 0;
    let slopeSquared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = origin[axis] + delta[axis] * middle;
      const boundary = coordinate < -half[axis] ? -half[axis] : coordinate > half[axis] ? half[axis] : undefined;
      if (boundary === undefined) continue;
      const intercept = origin[axis] - boundary;
      slopeDotIntercept += delta[axis] * intercept;
      slopeSquared += delta[axis] * delta[axis];
    }
    if (slopeSquared > 1e-12) {
      const closest = THREE.MathUtils.clamp(-slopeDotIntercept / slopeSquared, low, high);
      minimum = Math.min(minimum, distanceSquaredAt(closest));
    }
  }
  return Math.sqrt(minimum);
}

function segmentBoxDistance(a: THREE.Vector3, b: THREE.Vector3, prop: StageProp, box: PropCollisionBox): number {
  const { start, end } = segmentInPropGroupSpace(a, b, prop);
  return segmentBoxDistanceLocal(start, end, box);
}

function segmentHitsBox(
  a: THREE.Vector3,
  b: THREE.Vector3,
  prop: StageProp,
  radius: number,
  boxes = getPropCollisionBoxes(prop),
): boolean {
  const { start, end } = segmentInPropGroupSpace(a, b, prop);
  return boxes.some((box) => segmentBoxDistanceLocal(start, end, box) <= radius);
}

function segmentBoxMaximumInsideDepth(start: THREE.Vector3, end: THREE.Vector3, half: number[]): number | null {
  const origin = [start.x, start.y, start.z];
  const delta = [end.x - start.x, end.y - start.y, end.z - start.z];
  let enter = 0; let leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(delta[axis]) < 1e-10) {
      if (Math.abs(origin[axis]) > half[axis]) return null;
      continue;
    }
    let near = (-half[axis] - origin[axis]) / delta[axis];
    let far = (half[axis] - origin[axis]) / delta[axis];
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near); leave = Math.min(leave, far);
    if (enter > leave) return null;
  }

  const lines: Array<{ intercept: number; slope: number }> = [];
  for (let axis = 0; axis < 3; axis++) {
    lines.push(
      { intercept: half[axis] - origin[axis], slope: -delta[axis] },
      { intercept: half[axis] + origin[axis], slope: delta[axis] },
    );
  }
  const candidates = [enter, leave];
  for (let left = 0; left < lines.length; left++) {
    for (let right = left + 1; right < lines.length; right++) {
      const denominator = lines[left].slope - lines[right].slope;
      if (Math.abs(denominator) < 1e-10) continue;
      const time = (lines[right].intercept - lines[left].intercept) / denominator;
      if (time > enter && time < leave) candidates.push(time);
    }
  }
  return Math.max(...candidates.map((time) => Math.min(...lines.map((line) => line.intercept + line.slope * time))));
}

function estimateSegmentBoxOverlap(
  a: THREE.Vector3,
  b: THREE.Vector3,
  prop: StageProp,
  radius: number,
  boxes = getPropCollisionBoxes(prop),
): number {
  const { start, end } = segmentInPropGroupSpace(a, b, prop);
  return Math.max(0, ...boxes.map((box) => {
    const half = box.size.map((size) => size / 2);
    const localStart = start.clone().sub(new THREE.Vector3(...box.center));
    const localEnd = end.clone().sub(new THREE.Vector3(...box.center));
    const maximumInsideDepth = segmentBoxMaximumInsideDepth(localStart, localEnd, half);
    const signedDepth = maximumInsideDepth ?? -segmentBoxDistanceLocal(start, end, box);
    return radius + signedDepth;
  }));
}

function permitsExpectedContact(
  contact: ContactConstraint,
  label: string,
  a: THREE.Vector3,
  b: THREE.Vector3,
  prop: StageProp,
  radius: number,
  boxes = getPropCollisionBoxes(prop),
): boolean {
  if (contact.relation === 'approach') return false;
  const bodyMatches = (contact.bodyPart === 'hand' && label === 'hand')
    || (['pelvis', 'back'].includes(contact.bodyPart) && label === 'torso')
    || (contact.bodyPart === 'head' && label === 'head')
    || (contact.bodyPart === 'legs' && label === 'leg');
  if (!bodyMatches) return false;
  if (contact.surface === 'mattress' || contact.surface === 'seat') {
    const { start, end } = segmentInPropSpace(a, b, prop);
    const surfaceLocalY = contact.surface === 'seat' && prop.kind === 'chair'
      ? prop.size.height * 0.02
      : contact.surface === 'seat' && prop.kind === 'sofa'
        ? prop.size.height * 0.08
        : prop.size.height / 2;
    const lowestY = Math.min(start.y, end.y);
    const withinTopContactBand = lowestY >= surfaceLocalY - radius && lowestY <= surfaceLocalY + radius;
    const halfWidth = prop.size.width * (prop.kind === 'sofa' ? 0.42 : 0.5);
    const halfLength = prop.size.length * (prop.kind === 'sofa' ? 0.39 : 0.5);
    const zOffset = prop.kind === 'sofa' ? prop.size.length * 0.06 : 0;
    const withinTopFootprint = [start, end].every((point) => Math.abs(point.x) <= halfWidth + radius
      && Math.abs(point.z - zOffset) <= halfLength + radius);
    return withinTopContactBand && withinTopFootprint;
  }
  return contact.surface === 'handle' || contact.surface === 'interaction-point'
    // A declared touch may overlap the prop by the body's proxy radius, but
    // must not hide the hand/arm being placed well inside the prop volume.
    ? estimateSegmentBoxOverlap(a, b, prop, radius, boxes) <= radius + 0.035
    : false;
}

/** Swept bone-capsule proxy check; an approximation, not continuous rigid-body collision proof. */
export function inspectMotionCollisions(
  character: THREE.Object3D,
  animation: AnimationData,
  props: StageProp[],
  actions: Array<{ t0: number; t1: number; template: string; clause?: string; targetPropId?: string }> = [],
  contacts: ContactConstraint[] = [],
  skeleton?: SkeletonSnapshot,
): MotionCollision[] {
  if (!Number.isFinite(animation.duration) || animation.duration <= 0) return [];
  const bones = indexBonesByName(character);
  const segments: Array<{ a: THREE.Bone; b: THREE.Bone; label: string; radius: number }> = [];
  bones.forEach((bone) => {
    const body = BODY_PARTS.find((part) => part.pattern.test(bone.name));
    if (!body) return;
    const boneChildren = bone.children.filter((child) => (child as THREE.Bone).isBone) as THREE.Bone[];
    if (boneChildren.length === 0) segments.push({ a: bone, b: bone, label: body.label, radius: body.radius });
    else boneChildren.forEach((child) => segments.push({ a: bone, b: child, label: body.label, radius: body.radius }));
  });
  if (segments.length === 0) return [];
  const saved = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  bones.forEach((bone, name) => saved.set(name, { p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
  const findings = new Map<string, MotionCollision>();
  const candidates = props.filter((prop) => prop.kind !== 'room' && !(prop.kind === 'sword' && prop.attachTo));
  const collisionBoxesByProp = new Map(candidates.map((prop) => [prop.id, getPropCollisionBoxes(prop)]));
  const room = props.find((prop) => prop.kind === 'room');
  const timedActions = actions.map((action) => ({ ...action, clause: action.clause ?? '' }));
  const groundY = room?.position[1] ?? 0;
  const orderedTimes = collectMotionSampleTimes(animation, actions, props);
  const previous = new Map<string, { start: THREE.Vector3; end: THREE.Vector3; time: number }>();
  let previousHandPositions: HandWorldPositions | undefined;
  let previousHandTime: number | undefined;
  try {
    for (const time of orderedTimes) {
      applySampledPose(character, sampleAnimation(animation, time));
      character.updateWorldMatrix(true, true);
      const currentHandPositions = getHandWorldPositions(character, skeleton);
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const { a, b, label, radius } = segments[segmentIndex];
        const start = a.getWorldPosition(new THREE.Vector3()); const end = b.getWorldPosition(new THREE.Vector3());
        const worldScale = a.getWorldScale(new THREE.Vector3());
        const scaledRadius = radius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z));
        const segmentKey = `${segmentIndex}`;
        const prior = previous.get(segmentKey);
        const travel = prior ? Math.max(prior.start.distanceTo(start), prior.end.distanceTo(end)) : 0;
        const requiredSubdivisions = prior ? Math.max(1, Math.ceil(travel / Math.max(scaledRadius * 0.5, 0.015))) : 1;
        const subdivisions = Math.min(32, requiredSubdivisions);
        const unsampledStep = travel / subdivisions;
        if (prior && (candidates.length > 0 || room) && requiredSubdivisions > 32 && unsampledStep > scaledRadius * 2) {
          const key = `sampling:${label}`;
          const previousFinding = findings.get(key);
          if (!previousFinding || unsampledStep > previousFinding.estimatedOverlapMeters) {
            findings.set(key, {
              propId: '采样分辨率', bodyPart: label, time: (prior.time + time) / 2,
              estimatedOverlapMeters: unsampledStep, sweepSamplingLimited: true,
            });
          }
        }
        for (let step = 0; step <= subdivisions; step++) {
          if (prior && step === 0) continue;
          const amount = step / subdivisions;
          const sampleStart = prior ? prior.start.clone().lerp(start, amount) : start;
          const sampleEnd = prior ? prior.end.clone().lerp(end, amount) : end;
          const sampleTime = prior ? prior.time + (time - prior.time) * amount : time;
          const handPositions = interpolateHandWorldPositions(previousHandPositions, currentHandPositions, previousHandTime, time, sampleTime);
          const groundPenetration = groundY - (Math.min(sampleStart.y, sampleEnd.y) - scaledRadius);
          if (groundPenetration > 0.08) {
            const key = `ground:${label}`;
            const previousFinding = findings.get(key);
            if (!previousFinding || groundPenetration > previousFinding.estimatedOverlapMeters) {
              findings.set(key, { propId: '地面', bodyPart: label, time: sampleTime, estimatedOverlapMeters: groundPenetration });
            }
          }
          if (room) {
            const roomOverflow = estimateRoomBoundaryOverflow(sampleStart, sampleEnd, scaledRadius, room);
            if (roomOverflow > 0.03) {
              const key = `room:${label}`;
              const previousFinding = findings.get(key);
              if (!previousFinding || roomOverflow > previousFinding.estimatedOverlapMeters) {
                findings.set(key, { propId: '房间边界', bodyPart: label, time: sampleTime, estimatedOverlapMeters: roomOverflow });
              }
            }
          }
          const actionIndex = actions.findIndex((action, index) => sampleTime >= action.t0 - 1e-6
            && (sampleTime < action.t1 - 1e-6 || index === actions.length - 1 && sampleTime <= action.t1 + 1e-6));
          const action = actions[actionIndex];
          const uniqueLegacyPhase = action ? actions.filter((candidate) => candidate.template === action.template).length === 1 : false;
          const expectedContacts = action ? contacts.filter((contact) => contact.propId !== 'ground'
            && (contact.actionIndex === actionIndex
              || contact.actionIndex === undefined && uniqueLegacyPhase && contact.phase === action.template)) : [];
          for (const staticProp of candidates) {
            const prop = propAtTime(staticProp, timedActions, sampleTime, character, skeleton, props, contacts, handPositions);
            const collisionBoxes = collisionBoxesByProp.get(prop.id) ?? [];
            const key = `${prop.id}:${label}`;
            const portableTransfer = staticProp.kind === 'phone'
              ? samplePortablePropTransfer(staticProp, props, timedActions, contacts, sampleTime)
              : null;
            const carriedHand = portableTransfer && Object.values(skeleton?.nodes ?? {}).find((node) => node.semantic === portableTransfer.hand);
            const carriedByThisHand = staticProp.kind === 'phone' && label === 'hand' && Boolean(carriedHand && a.name === carriedHand.name)
              && (portableTransfer?.attachmentWeight ?? 0) > 0.02;
            const expectedPart = carriedByThisHand || expectedContacts.some((contact) => contact.propId === prop.id
              && permitsExpectedContact(contact, label, sampleStart, sampleEnd, prop, scaledRadius, collisionBoxes));
            if (!expectedPart && segmentHitsBox(sampleStart, sampleEnd, prop, scaledRadius, collisionBoxes)) {
              const finding: MotionCollision = {
                propId: prop.id, bodyPart: label, time: sampleTime,
                estimatedOverlapMeters: estimateSegmentBoxOverlap(sampleStart, sampleEnd, prop, scaledRadius, collisionBoxes),
                ...(prop.kind === 'opponent' && action?.targetPropId === prop.id && ['sword', 'punch', 'kick', 'block'].includes(action.template)
                  ? (() => {
                    const contact = opponentContactDetails(sampleStart, sampleEnd, prop, scaledRadius);
                    const requestedOpponentZone = requestedOpponentContactZone(action.clause ?? '');
                    return { opponentContact: true, opponentZone: contact.zone, contactPosition: contact.contactPosition,
                      ...(requestedOpponentZone ? { requestedOpponentZone } : {}) };
                  })() : {}),
              };
              const previousFinding = findings.get(key);
              if (!previousFinding || finding.estimatedOverlapMeters > previousFinding.estimatedOverlapMeters) {
                findings.set(key, finding);
              }
            }
          }
        }
        previous.set(segmentKey, { start, end, time });
      }
      previousHandPositions = currentHandPositions;
      previousHandTime = time;
    }
  } finally {
    const live = indexBonesByName(character);
    saved.forEach((pose, name) => {
      const bone = live.get(name); if (!bone) return;
      bone.position.copy(pose.p); bone.quaternion.copy(pose.q); bone.scale.copy(pose.s);
    });
    character.updateWorldMatrix(true, true);
  }
  return [...findings.values(), ...(skeleton ? inspectAttachedWeaponCollisions(character, animation, props, actions, contacts, skeleton, orderedTimes) : [])];
}

function inspectAttachedWeaponCollisions(
  character: THREE.Object3D,
  animation: AnimationData,
  props: StageProp[],
  actions: Array<{ t0: number; t1: number; template: string; clause?: string; targetPropId?: string }>,
  contacts: ContactConstraint[],
  skeleton: SkeletonSnapshot,
  times: number[],
): MotionCollision[] {
  const hands = new Map(['hand.R', 'hand.L'].flatMap((semantic) => {
    const node = Object.values(skeleton.nodes).find((candidate) => candidate.semantic === semantic);
    const hand = node ? character.getObjectByProperty('uuid', node.id) : null;
    return hand ? [[semantic, hand] as const] : [];
  }));
  const weapons = props.filter((prop) => prop.kind === 'sword' && prop.attachTo);
  if (hands.size === 0 || weapons.length === 0) return [];
  const timedActions: TimedAction[] = actions.map((action) => ({ ...action, clause: action.clause ?? '' }));
  const room = props.find((prop) => prop.kind === 'room');

  const bonePose = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  indexBonesByName(character).forEach((bone, name) => bonePose.set(name, {
    p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone(),
  }));
  const findings = new Map<string, MotionCollision>();
  const previous = new Map<string, { base: THREE.Vector3; tip: THREE.Vector3; time: number }>();
  const collisionBoxesByProp = new Map(props
    .filter((prop) => prop.kind !== 'room' && !(prop.kind === 'sword' && prop.attachTo))
    .map((prop) => [prop.id, getPropCollisionBoxes(prop)]));
  let previousHandPositions: HandWorldPositions | undefined;
  let previousHandTime: number | undefined;
  try {
    for (const time of times) {
      applySampledPose(character, sampleAnimation(animation, time));
      character.updateWorldMatrix(true, true);
      const currentHandPositions = getHandWorldPositions(character, skeleton);
      for (const weapon of weapons) {
        const attachment = sampleWeaponAttachment(weapon, timedActions, time);
        if (!attachment.from || !attachment.to) continue;
        const fromHand = hands.get(attachment.from);
        const toHand = hands.get(attachment.to);
        if (!fromHand || !toHand) continue;
        fromHand.updateWorldMatrix(true, false);
        toHand.updateWorldMatrix(true, false);
        const fromPosition = new THREE.Vector3(...(weapon.attachOffset ?? [0, 0, 0]));
        const toPosition = new THREE.Vector3(...(weapon.attachOffset ?? [0, 0, 0]));
        fromHand.localToWorld(fromPosition);
        toHand.localToWorld(toPosition);
        const position = fromPosition.lerp(toPosition, attachment.blend);
        const orientation = fromHand.getWorldQuaternion(new THREE.Quaternion())
          .slerp(toHand.getWorldQuaternion(new THREE.Quaternion()), attachment.blend)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), weapon.rotationY));
        const base = new THREE.Vector3(0, 0.12, 0).applyQuaternion(orientation).add(position);
        const tip = new THREE.Vector3(0, weapon.size.length + 0.12, 0).applyQuaternion(orientation).add(position);
        const radius = Math.max(0.015, Math.hypot(weapon.size.width, weapon.size.height) / 2);
        const prior = previous.get(weapon.id);
        const travel = prior ? Math.max(prior.base.distanceTo(base), prior.tip.distanceTo(tip)) : 0;
        const requiredSubdivisions = prior ? Math.max(1, Math.ceil(travel / Math.max(radius * 0.5, 0.01))) : 1;
        const subdivisions = Math.min(64, requiredSubdivisions);
        const unsampledStep = travel / subdivisions;
        if (prior && requiredSubdivisions > 64 && unsampledStep > radius * 2) {
          const key = `sampling:weapon:${weapon.id}`;
          const previousFinding = findings.get(key);
          if (!previousFinding || unsampledStep > previousFinding.estimatedOverlapMeters) {
            findings.set(key, {
              propId: '采样分辨率', bodyPart: `剑身 ${weapon.id}`, time: (prior.time + time) / 2,
              estimatedOverlapMeters: unsampledStep, sweepSamplingLimited: true,
            });
          }
        }
        for (let step = prior ? 1 : 0; step <= subdivisions; step++) {
          const amount = step / subdivisions;
          const sampleBase = prior ? prior.base.clone().lerp(base, amount) : base;
          const sampleTip = prior ? prior.tip.clone().lerp(tip, amount) : tip;
          const sampleTime = prior ? prior.time + (time - prior.time) * amount : time;
          const handPositions = interpolateHandWorldPositions(previousHandPositions, currentHandPositions, previousHandTime, time, sampleTime);
          if (room) {
            const roomOverflow = estimateRoomBoundaryOverflow(sampleBase, sampleTip, radius, room);
            const key = `room:weapon:${weapon.id}`;
            const previousFinding = findings.get(key);
            if (roomOverflow > 0.03 && (!previousFinding || roomOverflow > previousFinding.estimatedOverlapMeters)) {
              findings.set(key, { propId: '房间边界', bodyPart: `剑身 ${weapon.id}`, time: sampleTime, estimatedOverlapMeters: roomOverflow });
            }
          }
          for (const staticProp of props) {
            if (staticProp.id === weapon.id || staticProp.kind === 'room' || staticProp.kind === 'sword' && staticProp.attachTo) continue;
            const prop = propAtTime(staticProp, timedActions, sampleTime, character, skeleton, props, contacts, handPositions);
            const collisionBoxes = collisionBoxesByProp.get(prop.id) ?? [];
            const actionIndex = actions.findIndex((action, index) => sampleTime >= action.t0 - 1e-6
              && (sampleTime < action.t1 - 1e-6 || index === actions.length - 1 && sampleTime <= action.t1 + 1e-6));
            const action = actions[actionIndex];
            const expectedHit = prop.kind === 'opponent' && action?.targetPropId === prop.id && action.template === 'sword';
            const key = `${prop.id}:weapon:${weapon.id}${expectedHit ? `:action:${actionIndex}` : ''}`;
            if (!findings.has(key) && segmentHitsBox(sampleBase, sampleTip, prop, radius, collisionBoxes)) {
              findings.set(key, {
                propId: prop.id, bodyPart: `剑身 ${weapon.id}`, time: sampleTime,
                estimatedOverlapMeters: estimateSegmentBoxOverlap(sampleBase, sampleTip, prop, radius, collisionBoxes),
                ...(prop.kind === 'opponent' && action?.targetPropId === prop.id && action.template === 'sword'
                  ? (() => {
                    const contact = opponentContactDetails(sampleBase, sampleTip, prop, radius);
                    const requestedOpponentZone = requestedOpponentContactZone(action.clause ?? '');
                    return { opponentContact: true, opponentZone: contact.zone, contactPosition: contact.contactPosition,
                      ...(requestedOpponentZone ? { requestedOpponentZone } : {}) };
                  })() : {}),
              });
            }
          }
        }
        previous.set(weapon.id, { base, tip, time });
      }
      previousHandPositions = currentHandPositions;
      previousHandTime = time;
    }
  } finally {
    const live = indexBonesByName(character);
    bonePose.forEach((pose, name) => {
      const bone = live.get(name);
      if (!bone) return;
      bone.position.copy(pose.p); bone.quaternion.copy(pose.q); bone.scale.copy(pose.s);
    });
    character.updateWorldMatrix(true, true);
  }
  return [...findings.values()];
}
