import type { Vec3Tuple } from '../../types/global';
import * as THREE from 'three';
import type { SkeletonSnapshot } from '../skeleton/types';

export interface StageProp {
  id: string;
  kind: 'room' | 'bed' | 'chair' | 'sofa' | 'table' | 'door' | 'phone' | 'sword' | 'opponent';
  position: Vec3Tuple;
  rotationY: number;
  size: { width: number; height: number; length: number };
  attachTo?: 'hand.R' | 'hand.L' | null;
  attachOffset?: Vec3Tuple;
}

/** Character frame used to interpret actor-relative spatial language. */
export interface SceneActorReference {
  position: Vec3Tuple;
  /** Horizontal world-space forward direction. */
  forward: [number, number];
}

export interface PropCollisionBox {
  /** Center relative to the prop group's origin, before yaw rotation. */
  center: Vec3Tuple;
  size: Vec3Tuple;
  /** Body region represented by an opponent proxy box. */
  contactZone?: 'head' | 'torso' | 'legs';
}

export interface StagePropRoomOverflow {
  propId: string;
  axis: 'width' | 'height' | 'length';
  overflowMeters: number;
}

/** Compound proxy volumes follow the visible furniture parts instead of filling empty space. */
export function getPropCollisionBoxes(prop: StageProp): PropCollisionBox[] {
  const { width, height, length } = prop.size;
  const box = (center: Vec3Tuple, size: Vec3Tuple, contactZone?: PropCollisionBox['contactZone']): PropCollisionBox => ({ center, size, ...(contactZone ? { contactZone } : {}) });
  if (prop.kind === 'room') return [];
  if (prop.kind === 'table') {
    const topThickness = 0.12;
    const legHeight = Math.max(0, height - topThickness);
    return [
      box([0, height - topThickness / 2, 0], [width, topThickness, length]),
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => box(
        [x * width * 0.42, legHeight / 2, z * length * 0.38], [0.07, legHeight, 0.07],
      ))),
    ];
  }
  if (prop.kind === 'chair') {
    return [
      box([0, height * 0.48, 0], [width, 0.08, length]),
      box([0, height * 0.76, -length * 0.42], [width, height * 0.5, 0.07]),
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => box(
        [x * width * 0.4, height * 0.23, z * length * 0.4], [0.055, height * 0.46, 0.055],
      ))),
    ];
  }
  if (prop.kind === 'sofa') {
    const seatHeight = height * 0.58;
    return [
      box([0, seatHeight * 0.68, length * 0.04], [width * 0.84, seatHeight * 0.64, length * 0.78]),
      box([0, height * 0.72, -length * 0.4], [width * 0.88, height * 0.52, length * 0.16]),
      ...[-1, 1].map((side) => box([side * width * 0.44, height * 0.48, 0], [width * 0.12, height * 0.5, length * 0.82])),
    ];
  }
  if (prop.kind === 'bed') {
    const frameHeight = Math.min(0.24, height * 0.42);
    const mattressHeight = height - frameHeight;
    const legHeight = Math.max(0.12, frameHeight - 0.02);
    return [
      box([0, frameHeight - legHeight / 2, 0], [width, legHeight, length]),
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => box(
        [x * (width / 2 - 0.05), legHeight / 2, z * (length / 2 - 0.05)], [0.1, legHeight, 0.1],
      ))),
      box([0, frameHeight + mattressHeight / 2, 0], [width - 0.06, mattressHeight, length - 0.06]),
      box([0, height + 0.1, -length / 2 + 0.14], [width, 0.2, 0.1]),
      box([0, height + 0.035, -length / 2 + 0.3], [width * 0.42, 0.09, 0.34]),
    ];
  }
  if (prop.kind === 'opponent') {
    const headRadius = Math.min(width * 0.15, length * 0.19, 0.13);
    const limbRadius = width * 0.075;
    return [
      box([0, height * 0.88, 0], [headRadius * 2, headRadius * 2, headRadius * 2], 'head'),
      box([0, height * 0.63, 0], [width * 0.46, height * 0.42, length * 0.36], 'torso'),
      box([0, height * 0.43, 0], [width * 0.4, height * 0.25, length * 0.34], 'torso'),
      ...[-1, 1].flatMap((side) => [
        box([side * width * 0.37, height * 0.61, 0], [limbRadius * 2, height * 0.48, limbRadius * 2], 'torso'),
        box([side * width * 0.16, height * 0.21, 0], [limbRadius * 2.4, height * 0.42, limbRadius * 2.4], 'legs'),
      ]),
    ];
  }
  if (prop.kind === 'sword') return [box([0, length / 2, 0], [width, length, height])];
  return [box([0, height / 2, 0], [width, height, length])];
}

/** Reports solid prop volumes that do not fit inside the room's inner bounds. */
export function findStagePropRoomOverflows(props: StageProp[], toleranceMeters = 0.015): StagePropRoomOverflow[] {
  const room = props.find((prop) => prop.kind === 'room');
  if (!room) return [];
  const overflows: StagePropRoomOverflow[] = [];
  const roomCos = Math.cos(room.rotationY);
  const roomSin = Math.sin(room.rotationY);
  const innerHalfWidth = Math.max(0, room.size.width / 2 - 0.04);
  const innerHalfLength = Math.max(0, room.size.length / 2 - 0.04);
  for (const prop of props) {
    if (prop.kind === 'room' || prop.kind === 'sword' && prop.attachTo) continue;
    const relativeRotation = prop.rotationY - room.rotationY;
    const cos = Math.abs(Math.cos(relativeRotation));
    const sin = Math.abs(Math.sin(relativeRotation));
    for (const box of getPropCollisionBoxes(prop)) {
      const worldCenterX = prop.position[0] + box.center[0] * Math.cos(prop.rotationY) + box.center[2] * Math.sin(prop.rotationY);
      const worldCenterZ = prop.position[2] - box.center[0] * Math.sin(prop.rotationY) + box.center[2] * Math.cos(prop.rotationY);
      const dx = worldCenterX - room.position[0];
      const dz = worldCenterZ - room.position[2];
      const centerX = dx * roomCos - dz * roomSin;
      const centerZ = dx * roomSin + dz * roomCos;
      const halfWidth = box.size[0] / 2 * cos + box.size[2] / 2 * sin;
      const halfLength = box.size[0] / 2 * sin + box.size[2] / 2 * cos;
      const checks: Array<[StagePropRoomOverflow['axis'], number]> = [
        ['width', Math.abs(centerX) + halfWidth - innerHalfWidth],
        ['length', Math.abs(centerZ) + halfLength - innerHalfLength],
        ['height', Math.max(
          room.position[1] - (prop.position[1] + box.center[1] - box.size[1] / 2),
          prop.position[1] + box.center[1] + box.size[1] / 2 - (room.position[1] + room.size.height),
        )],
      ];
      for (const [axis, overflowMeters] of checks) {
        if (overflowMeters > toleranceMeters && !overflows.some((item) => item.propId === prop.id && item.axis === axis)) {
          overflows.push({ propId: prop.id, axis, overflowMeters });
        }
      }
    }
  }
  return overflows;
}

/** Validate a user-authored prop edit before the store applies its size clamps. */
export function validateStagePropPlacement(props: StageProp[], candidate: StageProp): string | null {
  for (const dimension of ['width', 'height', 'length'] as const) {
    const [minimum, maximum] = STAGE_PROP_SIZE_LIMITS[candidate.kind][dimension];
    const value = candidate.size[dimension];
    if (value < minimum || value > maximum) return `${dimension} 需在 ${minimum}–${maximum} 米之间`;
  }
  const nextProps = props.map((prop) => prop.id === candidate.id ? candidate : prop);
  const overlap = findStagePropOverlaps(nextProps).find((item) => item.firstPropId === candidate.id || item.secondPropId === candidate.id);
  if (overlap) return `与 ${overlap.firstPropId === candidate.id ? overlap.secondPropId : overlap.firstPropId} 的实体占位相交约 ${(overlap.overlapMeters * 100).toFixed(0)} 厘米`;
  const overflow = findStagePropRoomOverflows(nextProps).find((item) => candidate.kind === 'room' || item.propId === candidate.id);
  if (overflow) return `道具 ${overflow.propId} 超出房间${overflow.axis === 'width' ? '宽度' : overflow.axis === 'length' ? '深度' : '净高'}约 ${(overflow.overflowMeters * 100).toFixed(0)} 厘米`;
  return null;
}

export const STAGE_PROP_SIZE_LIMITS: Record<StageProp['kind'], Record<'width' | 'height' | 'length', readonly [number, number]>> = {
  room: { width: [1, 100], height: [1, 20], length: [1, 100] },
  bed: { width: [0.3, 4], height: [0.2, 3], length: [0.3, 4] },
  chair: { width: [0.3, 4], height: [0.2, 3], length: [0.3, 4] },
  sofa: { width: [0.9, 4], height: [0.45, 1.6], length: [0.55, 2.2] },
  table: { width: [0.3, 4], height: [0.2, 3], length: [0.3, 4] },
  door: { width: [0.3, 4], height: [0.2, 3], length: [0.02, 0.3] },
  phone: { width: [0.04, 0.3], height: [0.005, 0.08], length: [0.08, 0.5] },
  sword: { width: [0.005, 0.25], height: [0.005, 0.25], length: [0.3, 2] },
  opponent: { width: [0.25, 1.5], height: [0.8, 2.5], length: [0.2, 1] },
};

/** Coordinated starter layout for the standard room assets, in world-space meters. */
export function defaultStagePropPosition(kind: StageProp['kind'], opponentIndex = 0): Vec3Tuple {
  if (kind === 'room' || kind === 'door') return [0, 0, 0];
  if (kind === 'bed') return [-1.25, 0, 0];
  if (kind === 'table') return [1.3, 0, -0.8];
  if (kind === 'chair') return [1.3, 0, -1.6];
  if (kind === 'sofa') return [0, 0, -1.95];
  if (kind === 'phone') return [1.3 + opponentIndex * 0.25, 0.75, -0.8];
  if (kind === 'opponent') return [opponentIndex * 0.8, 0, 1.6];
  return [0, 1, 0];
}

export interface StagePropOverlap {
  firstPropId: string;
  secondPropId: string;
  overlapMeters: number;
}

/** Find solid prop volume intersections using vertical intervals and yaw-oriented XZ rectangles. */
export function findStagePropOverlaps(props: StageProp[], toleranceMeters = 0.015): StagePropOverlap[] {
  const solids = props.filter((prop) => prop.kind !== 'room' && !(prop.kind === 'sword' && prop.attachTo));
  const overlaps: StagePropOverlap[] = [];
  for (let firstIndex = 0; firstIndex < solids.length; firstIndex++) {
    const first = solids[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < solids.length; secondIndex++) {
      const second = solids[secondIndex];
      let maximumOverlap = 0;
      const firstAxes = [new THREE.Vector2(Math.cos(first.rotationY), -Math.sin(first.rotationY)), new THREE.Vector2(Math.sin(first.rotationY), Math.cos(first.rotationY))];
      const secondAxes = [new THREE.Vector2(Math.cos(second.rotationY), -Math.sin(second.rotationY)), new THREE.Vector2(Math.sin(second.rotationY), Math.cos(second.rotationY))];
      for (const firstBox of getPropCollisionBoxes(first)) for (const secondBox of getPropCollisionBoxes(second)) {
        const verticalOverlap = Math.min(first.position[1] + firstBox.center[1] + firstBox.size[1] / 2, second.position[1] + secondBox.center[1] + secondBox.size[1] / 2)
          - Math.max(first.position[1] + firstBox.center[1] - firstBox.size[1] / 2, second.position[1] + secondBox.center[1] - secondBox.size[1] / 2);
        if (verticalOverlap <= toleranceMeters) continue;
        const centerDelta = new THREE.Vector2(
          second.position[0] + secondBox.center[0] * Math.cos(second.rotationY) + secondBox.center[2] * Math.sin(second.rotationY)
            - first.position[0] - firstBox.center[0] * Math.cos(first.rotationY) - firstBox.center[2] * Math.sin(first.rotationY),
          second.position[2] - secondBox.center[0] * Math.sin(second.rotationY) + secondBox.center[2] * Math.cos(second.rotationY)
            - first.position[2] + firstBox.center[0] * Math.sin(first.rotationY) - firstBox.center[2] * Math.cos(first.rotationY),
        );
        let minimumOverlap = Number.POSITIVE_INFINITY;
        let separated = false;
        for (const axis of [...firstAxes, ...secondAxes]) {
          const firstRadius = firstBox.size[0] / 2 * Math.abs(firstAxes[0].dot(axis)) + firstBox.size[2] / 2 * Math.abs(firstAxes[1].dot(axis));
          const secondRadius = secondBox.size[0] / 2 * Math.abs(secondAxes[0].dot(axis)) + secondBox.size[2] / 2 * Math.abs(secondAxes[1].dot(axis));
          const overlap = firstRadius + secondRadius - Math.abs(centerDelta.dot(axis));
          if (overlap <= toleranceMeters) { separated = true; break; }
          minimumOverlap = Math.min(minimumOverlap, overlap);
        }
        if (!separated) maximumOverlap = Math.max(maximumOverlap, Math.min(verticalOverlap, minimumOverlap));
      }
      if (maximumOverlap > 0) overlaps.push({ firstPropId: first.id, secondPropId: second.id, overlapMeters: maximumOverlap });
    }
  }
  return overlaps;
}

export interface ContactConstraint {
  phase: string;
  /** Stable action-stage reference; optional for compatibility with existing project files. */
  actionIndex?: number;
  bodyPart: 'pelvis' | 'back' | 'head' | 'legs' | 'hand';
  propId: string;
  surface: 'mattress' | 'seat' | 'handle' | 'interaction-point' | 'ground';
  relation: 'approach' | 'support' | 'rest';
}

export interface WorldActionPlan {
  segments: Array<{ t0: number; t1: number; template: string; clause: string; targetPropId?: string }>;
  contacts: ContactConstraint[];
  warnings: string[];
  targetPropId?: string;
}

export interface BedInteractionFrame {
  approachPosition: Vec3Tuple;
  sitPosition: Vec3Tuple;
  liePosition: Vec3Tuple;
  yawRadians: number;
}

export interface WorldInteractionFrame extends BedInteractionFrame {
  interactionPosition: Vec3Tuple;
  /** World target in the actor's hips-parent coordinates for a hand interaction. */
  handTargetPosition?: Vec3Tuple;
  armReach?: Partial<Record<'L' | 'R', { distanceMeters: number; minDistanceMeters?: number; maxDistanceMeters: number; reachable: boolean }>>;
  /** Actor-parent local route points from the current hips position to the interaction point. */
  approachPath?: Vec3Tuple[];
  /** Side holding a sword target; omitted for props without a hand attachment. */
  wieldingHand?: 'L' | 'R';
  distanceMeters?: number;
  distanceHeightRatio?: number;
  pathObstructed?: boolean;
}

/** Convert a world-space floor plane into a local hips translation, including tilted parents. */
export function estimateGroundHipLocalOffset(
  character: THREE.Object3D,
  skeleton: SkeletonSnapshot,
  groundY: number,
  capsuleRadius = 0.13,
): Vec3Tuple | undefined {
  const hipsNode = Object.values(skeleton.nodes).find((node) => node.semantic === 'hips');
  const hips = hipsNode ? character.getObjectByProperty('uuid', hipsNode.id) : null;
  if (!hips?.parent) return undefined;
  character.updateWorldMatrix(true, true);
  const parentMatrix = hips.parent.matrixWorld;
  const determinant = parentMatrix.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return undefined;
  const worldScale = hips.getWorldScale(new THREE.Vector3());
  const radius = capsuleRadius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z));
  const restPosition = new THREE.Vector3(...hipsNode!.restLocal.position);
  const targetWorld = restPosition.clone().applyMatrix4(parentMatrix);
  targetWorld.y = groundY + radius;
  const targetLocal = targetWorld.applyMatrix4(parentMatrix.clone().invert());
  const offset = targetLocal.sub(restPosition).toArray() as Vec3Tuple;
  return offset.every(Number.isFinite) ? offset : undefined;
}

const WALKING_BODY_CLEARANCE = 0.3;
const ROUTE_CORNER_MARGIN = 0.04;

function walkingBodyClearance(characterHeight: number): number {
  if (!(characterHeight > 0) || !Number.isFinite(characterHeight)) return WALKING_BODY_CLEARANCE;
  return THREE.MathUtils.clamp(WALKING_BODY_CLEARANCE * characterHeight / 1.7, 0.18, 0.65);
}

/** Default actor-to-prop clearance used by both initial plans and target edits. */
export function defaultInteractionDistance(prop: StageProp): number {
  if (prop.kind === 'bed') return 0.32;
  if (prop.kind === 'sword') return 0.18;
  return 0.35;
}

export interface WeaponAttachmentSample {
  from: 'hand.R' | 'hand.L' | null;
  to: 'hand.R' | 'hand.L' | null;
  blend: number;
}

/** Resolve timeline handoffs from the weapon's saved starting hand at any playback time. */
export function sampleWeaponAttachment(
  weapon: Pick<StageProp, 'id' | 'attachTo'>,
  actions: Array<Pick<WorldActionPlan['segments'][number], 't0' | 't1' | 'template' | 'clause' | 'targetPropId'>>,
  time: number,
): WeaponAttachmentSample {
  let attachedTo = weapon.attachTo ?? null;
  for (const action of actions) {
    if (action.template !== 'handoff' || action.targetPropId !== weapon.id) continue;
    if (!attachedTo) return { from: null, to: null, blend: 0 };
    const explicitHand = /左手|左边|交给左|换到左|接到左/.test(action.clause) ? 'hand.L'
      : /右手|右边|交给右|换到右|接到右/.test(action.clause) ? 'hand.R'
        : attachedTo === 'hand.L' ? 'hand.R' : 'hand.L';
    if (time < action.t0) break;
    if (time < action.t1) {
      return { from: attachedTo, to: explicitHand, blend: Math.min(Math.max((time - action.t0) / Math.max(action.t1 - action.t0, 1e-6), 0), 1) };
    }
    attachedTo = explicitHand;
  }
  return { from: attachedTo, to: attachedTo, blend: 0 };
}

export interface PortablePropTransferSample {
  /** 1 follows the hand, 0 rests at the placement point. */
  attachmentWeight: number;
  hand: 'hand.R' | 'hand.L';
  placementPosition?: Vec3Tuple;
}

/** Shared world-space contact point for preview rendering and hand IK targets. */
export function propInteractionWorldPoint(prop: StageProp): Vec3Tuple {
  if (prop.kind === 'door') return doorHandleWorldPosition(prop);
  const local = prop.kind === 'table'
    ? new THREE.Vector3(0, prop.size.height, prop.size.length / 2)
      : prop.kind === 'chair'
        ? new THREE.Vector3(0, prop.size.height * 0.52, prop.size.length * 0.32)
        : prop.kind === 'sofa'
          ? new THREE.Vector3(0, prop.size.height * 0.58, prop.size.length * 0.06)
        : prop.kind === 'bed'
        ? new THREE.Vector3(0, prop.size.height, 0)
        : prop.kind === 'phone'
            ? new THREE.Vector3(0, prop.size.height * 0.65, 0)
            : prop.kind === 'opponent'
              ? new THREE.Vector3(0, prop.size.height * 0.55, 0)
              : new THREE.Vector3(0, prop.size.height * 0.65, 0);
  local.applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(new THREE.Vector3(...prop.position));
  return [local.x, local.y, local.z];
}

/** Resolve a phone's pickup/carry/release interval from indexed hand contacts. */
export function samplePortablePropTransfer(
  prop: StageProp,
  props: StageProp[],
  actions: Array<Pick<WorldActionPlan['segments'][number], 't0' | 't1' | 'template' | 'clause' | 'targetPropId'>>,
  contacts: ContactConstraint[],
  time: number,
): PortablePropTransferSample | null {
  if (prop.kind !== 'phone') return null;
  const actionFor = (contact: ContactConstraint) => contact.actionIndex === undefined
    ? undefined
    : actions[contact.actionIndex];
  const pickup = contacts.find((contact) => {
    const action = actionFor(contact);
    return contact.propId === prop.id && contact.bodyPart === 'hand' && contact.surface === 'interaction-point'
      && contact.relation === 'support' && action?.template === 'reach' && action.targetPropId === prop.id
      && /拿起|拾起|捡起|抓起|取下/.test(action.clause);
  });
  const pickupAction = pickup && actionFor(pickup);
  if (!pickupAction || time < pickupAction.t0) return null;
  const hand = /左手|左臂/.test(pickupAction.clause) ? 'hand.L' : 'hand.R';
  const release = contacts.flatMap((contact) => {
    const action = actionFor(contact);
    if (contact.propId === prop.id || contact.bodyPart !== 'hand' || contact.surface !== 'interaction-point'
      || contact.relation !== 'support' || action?.template !== 'reach' || action.targetPropId !== contact.propId
      || !/放下|放回|放到|放在|摆/.test(action.clause)) return [];
    const destination = props.find((item) => item.id === contact.propId);
    return destination ? [{ action, destination }] : [];
  }).sort((a, b) => a.action.t0 - b.action.t0)[0];
  const placementPosition = release ? propInteractionWorldPoint(release.destination) : undefined;
  if (release && time >= release.action.t1) return { attachmentWeight: 0, hand, placementPosition };
  const smoothstep = (value: number) => {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };
  if (release && time >= Math.max(release.action.t0, release.action.t1 - 0.2)) {
    const releaseStart = Math.max(release.action.t0, release.action.t1 - 0.2);
    return {
      attachmentWeight: 1 - smoothstep((time - releaseStart) / Math.max(release.action.t1 - releaseStart, 1e-6)),
      hand,
      placementPosition,
    };
  }
  const pickupBlendEnd = Math.min(pickupAction.t1, pickupAction.t0 + 0.2);
  if (time < pickupBlendEnd) {
    return { attachmentWeight: smoothstep((time - pickupAction.t0) / Math.max(pickupBlendEnd - pickupAction.t0, 1e-6)), hand, ...(placementPosition ? { placementPosition } : {}) };
  }
  return { attachmentWeight: 1, hand, ...(placementPosition ? { placementPosition } : {}) };
}

/** Resolves mattress targets into the local coordinate frame used by the hips track. */
export function resolveBedInteractionFrame(
  bed: StageProp,
  character: THREE.Object3D,
  skeleton: SkeletonSnapshot,
  props: StageProp[] = [bed],
  desiredDistanceMeters?: number,
  startPositionParent?: Vec3Tuple,
): WorldInteractionFrame | null {
  const hipsNode = Object.values(skeleton.nodes).find((node) => node.semantic === 'hips');
  const hips = hipsNode ? character.getObjectByProperty('uuid', hipsNode.id) as THREE.Bone | undefined : undefined;
  if (!hips?.parent) return null;
  character.updateWorldMatrix(true, true);
  hips.parent.updateWorldMatrix(true, false);

  const bedPoint = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), bed.rotationY)
    .add(new THREE.Vector3(...bed.position));
  const toParent = (point: THREE.Vector3): Vec3Tuple => {
    const local = hips.parent!.worldToLocal(point);
    return [local.x, local.y, local.z];
  };
  const worldHip = hips.getWorldPosition(new THREE.Vector3());
  const routeStart = startPositionParent
    ? hips.parent!.localToWorld(new THREE.Vector3(...startPositionParent))
    : worldHip.clone();
  const top = bed.position[1] + bed.size.height;
  const clearance = desiredDistanceMeters === undefined ? defaultInteractionDistance(bed) : Math.max(0, desiredDistanceMeters);
  const approach = bedPoint(-bed.size.width / 2 - clearance, worldHip.y, 0);
  const sit = bedPoint(-bed.size.width / 2 + 0.16, top + 0.24, 0);
  const lie = bedPoint(0, top + 0.12, 0);
  const distanceMeters = new THREE.Vector2(worldHip.x - approach.x, worldHip.z - approach.z).length();
  const characterHeight = estimateCharacterHeight(character);
  const walkingClearance = walkingBodyClearance(characterHeight);
  const [actorMinY, actorMaxY] = characterVerticalBounds(character, routeStart.y);
  const route = routeAroundProps(routeStart, approach, bed, props, actorMinY, actorMaxY, walkingClearance);
  const handTargetPosition = toParent(bedPoint(0, top, 0));
  const armReach = estimateArmReach(handTargetPosition, skeleton, hips.parent!);
  const currentForward = new THREE.Vector3(0, 0, 1).applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion()));
  const bedFacing = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), bed.rotationY);
  const yawRadians = Math.atan2(
    currentForward.z * bedFacing.x - currentForward.x * bedFacing.z,
    currentForward.x * bedFacing.x + currentForward.z * bedFacing.z,
  );

  return {
    approachPosition: toParent(approach),
    sitPosition: toParent(sit),
    liePosition: toParent(lie),
    interactionPosition: toParent(approach),
    handTargetPosition,
    armReach,
    yawRadians,
    distanceMeters,
    distanceHeightRatio: characterHeight > 0 ? distanceMeters / characterHeight : undefined,
    pathObstructed: route === null || route.length > 2,
    ...(route ? { approachPath: route.map(toParent) } : {}),
  };
}

export function estimateCharacterHeight(character: THREE.Object3D): number {
  const bounds = new THREE.Box3().setFromObject(character);
  return Math.max(0, bounds.max.y - bounds.min.y);
}

function characterVerticalBounds(character: THREE.Object3D, fallbackY: number): [number, number] {
  const bounds = new THREE.Box3().setFromObject(character);
  return Number.isFinite(bounds.min.y) && Number.isFinite(bounds.max.y)
    ? [bounds.min.y, bounds.max.y]
    : [fallbackY, fallbackY];
}

/** Door knob center used by both the interaction target and the rendered handle. */
export function doorHandleLocalHeight(door: StageProp): number {
  return door.size.height * 0.48;
}

export const DOOR_HANDLE_RADIUS = 0.035;

/** Handle center in the closed door's root-local coordinates. */
export function doorHandleLocalPosition(door: StageProp): Vec3Tuple {
  return [door.size.width * 0.34, doorHandleLocalHeight(door), door.size.length / 2 + DOOR_HANDLE_RADIUS];
}

export function doorHandleWorldPosition(door: StageProp): Vec3Tuple {
  return doorHandleWorldPositionAt(door, 0);
}

/** Sample the moving handle around the rendered door hinge. */
export function doorHandleWorldPositionAt(door: StageProp, openAngle: number): Vec3Tuple {
  const hingeX = -door.size.width / 2;
  const local = new THREE.Vector3(...doorHandleLocalPosition(door))
    .sub(new THREE.Vector3(hingeX, 0, 0))
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), openAngle)
    .add(new THREE.Vector3(hingeX, 0, 0))
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), door.rotationY);
  local.add(new THREE.Vector3(...door.position));
  return [local.x, local.y, local.z];
}

const PROP_TERMS: Record<StageProp['kind'], RegExp> = {
  room: /房间|室内|房间里|room/i,
  bed: /床|bed/i,
  chair: /椅子|椅|凳子|chair/i,
  sofa: /沙发|sofa|couch/i,
  table: /桌子|桌|table/i,
  door: /门口|门|door/i,
  phone: /手机|电话|phone/i,
  sword: /剑|刀|武器|sword/i,
  opponent: /对手|敌人|陪练|假人|靶子|sparring partner|opponent/i,
};

function findPromptProp(prompt: string, kind: StageProp['kind'], props: StageProp[], actor?: SceneActorReference): StageProp | undefined {
  const byId = props.find((prop) => prop.kind === kind && prompt.includes(prop.id));
  if (byId) return byId;
  if (kind === 'opponent') {
    const matches = props.filter((prop) => prop.kind === kind);
    const bySide = opponentBySide(prompt, matches, actor);
    if (bySide) return bySide;
  }
  return props.find((prop) => prop.kind === kind && PROP_TERMS[kind].test(prompt));
}

/** Left/right is projected onto the actor's horizontal left/right axis. */
function opponentBySide(prompt: string, opponents: StageProp[], actor?: SceneActorReference): StageProp | undefined {
  if (opponents.length < 2) return undefined;
  const asksLeft = /最左(?:侧|边)|左侧(?:的)?对手|左边(?:的)?对手|左手边(?:的)?对手/.test(prompt);
  const asksRight = /最右(?:侧|边)|右侧(?:的)?对手|右边(?:的)?对手|右手边(?:的)?对手/.test(prompt);
  if (asksLeft === asksRight) return undefined;
  const forward = actor?.forward;
  const length = forward ? Math.hypot(forward[0], forward[1]) : 0;
  // The default stage view faces +Z; without a loaded actor retain that convention.
  const right = length > 1e-5 ? [forward![1] / length, -forward![0] / length] : [1, 0];
  const lateral = (prop: StageProp) => prop.position[0] * right[0] + prop.position[2] * right[1];
  const ordered = [...opponents].sort((a, b) => lateral(a) - lateral(b));
  if (Math.abs(lateral(ordered.at(-1)!) - lateral(ordered[0])) < 0.1) return undefined;
  return asksLeft ? ordered[0] : ordered.at(-1);
}

/** Warn instead of silently choosing the first of several same-kind scene props. */
function ambiguousScenePropGroups(prompt: string, props: StageProp[], actor?: SceneActorReference): Array<{ kind: StageProp['kind']; matches: StageProp[] }> {
  return (['bed', 'chair', 'sofa', 'table', 'door', 'phone', 'sword', 'opponent'] as const).flatMap((kind) => {
    const mentioned = PROP_TERMS[kind].test(prompt) || (kind === 'bed' && /躺|卧|睡|休息/.test(prompt));
    if (!mentioned) return [];
    const matches = props.filter((prop) => prop.kind === kind);
    const explicitlySelected = matches.some((prop) => prompt.includes(prop.id))
      || kind === 'opponent' && Boolean(opponentBySide(prompt, matches, actor));
    return matches.length > 1 && !explicitlySelected ? [{ kind, matches }] : [];
  });
}

/** IDs that must not be attached to AI-planned action stages before the user resolves ambiguity. */
export function ambiguousScenePropIds(prompt: string, props: StageProp[], actor?: SceneActorReference): string[] {
  return ambiguousScenePropGroups(prompt, props, actor).flatMap(({ matches }) => matches.map((prop) => prop.id));
}

/** Warn instead of silently choosing the first of several same-kind scene props. */
export function ambiguousSceneObjectWarnings(prompt: string, props: StageProp[], actor?: SceneActorReference): string[] {
  return ambiguousScenePropGroups(prompt, props, actor).map(({ kind, matches }) =>
    `场景中有多个${displayProp(kind)}（${matches.map((prop) => prop.id).join('、')}），无法仅凭描述确定目标`);
}

function targetedProp(prompt: string, props: StageProp[]): StageProp | undefined {
  const explicit = props.find((prop) => prop.kind !== 'room' && prompt.includes(prop.id));
  if (explicit) return explicit;
  if (/放下|放回|放在|放到|摆在|摆到|摆放/.test(prompt)) {
    const surface = props.find((prop) => ['table', 'bed', 'chair', 'sofa'].includes(prop.kind) && PROP_TERMS[prop.kind].test(prompt));
    if (surface) return surface;
  }
  if (/拿起|拾起|捡起|接过/.test(prompt) && /手机|电话|phone/i.test(prompt)) return props.find((prop) => prop.kind === 'phone');
  if (/开门|推门|拉门|关门|关闭门|关上门|合上门/.test(prompt)) return props.find((prop) => prop.kind === 'door');
  if (/坐下|坐到|坐在/.test(prompt)) return props.find((prop) => prop.kind === 'chair' || prop.kind === 'sofa');
  const named = props.find((prop) => prop.kind !== 'room' && PROP_TERMS[prop.kind].test(prompt));
  if (named) return named;
  if (/拿起|拿着|拾起|捡起|递给|接过|使用/.test(prompt)) return props.find((prop) => prop.kind === 'phone' || prop.kind === 'sword');
  if (/坐下|坐到|坐在/.test(prompt)) return props.find((prop) => prop.kind === 'chair' || prop.kind === 'sofa');
  return undefined;
}

interface PlannedPhase {
  template: string;
  clause: string;
  weight: number;
  targetPropId?: string;
}

function timedSegments(phases: PlannedPhase[], duration: number): WorldActionPlan['segments'] {
  const totalWeight = phases.reduce((sum, phase) => sum + phase.weight, 0);
  let time = 0;
  return phases.map((phase, index) => {
    const t0 = time;
    time = index === phases.length - 1 ? duration : Math.round((time + duration * phase.weight / totalWeight) * 1000) / 1000;
    return { t0, t1: time, template: phase.template, clause: phase.clause, ...(phase.targetPropId ? { targetPropId: phase.targetPropId } : {}) };
  });
}

function describeLookClause(prompt: string, prefix = ''): string {
  const match = /(?:回头|回眸)?\s*(?:看向|看着|看|望向|望着|望|注视)\s*([^，,。；;]+)/.exec(prompt);
  const target = match?.[1]?.split(/然后|接着|随后|之后|再|并且|并/)[0].trim();
  const turning = /回头|回眸/.test(match?.[0] ?? '');
  return `${prefix}${turning ? '回头' : ''}${target ? `看向${target}` : '看向描述中的目标'}`;
}

/** Sample a door leaf from its associated interaction phases; openings stay open until a close phase. */
export function sampleDoorOpenAngle(
  actions: Array<Pick<WorldActionPlan['segments'][number], 't0' | 't1' | 'template' | 'clause' | 'targetPropId'>>,
  propId: string,
  time: number,
): number {
  const openAngle = Math.PI / 2;
  let angle = 0;
  for (const action of actions) {
    if (action.targetPropId !== propId || action.template !== 'reach') continue;
    const opens = /开门|打开门|推开门|拉开门/.test(action.clause);
    const closes = /关门|关闭门|关上门|合上门|推回门|拉回门/.test(action.clause);
    if (!opens && !closes) continue;
    if (time < action.t0) break;
    const nextAngle = opens ? openAngle : 0;
    if (time < action.t1) {
      const rawProgress = Math.min(Math.max((time - action.t0) / Math.max(action.t1 - action.t0, 1e-6), 0), 1);
      const progress = Math.min(Math.max((rawProgress - 0.18) / 0.82, 0), 1);
      const smooth = progress * progress * (3 - 2 * progress);
      return angle + (nextAngle - angle) * smooth;
    }
    angle = nextAngle;
  }
  return angle;
}

function decomposeCombatAction(prompt: string, duration: number, props: StageProp[], actor?: SceneActorReference): WorldActionPlan | null {
  const isCombat = /武打|打斗|对战|交手|挥剑|挥刀|劈砍|刺剑|格挡|招架|防守|踢腿|踢击|出拳|换手|换到(?:左|右)手|(?:交给|递给)(?:左|右)手|(?:左|右)手接过/.test(prompt);
  if (!isCombat) return null;
  const weapon = findPromptProp(prompt, 'sword', props);
  const opponent = findPromptProp(prompt, 'opponent', props, actor);
  const swordMatch = /挥剑|挥刀|劈砍|刺剑/.exec(prompt);
  const handoffMatch = /换手|换到左手|换到右手|交给左手|交给右手|递给左手|递给右手|左手接过|右手接过/.exec(prompt);
  const broadRequest = /武打|打斗|对战|交手/.test(prompt);
  const actions: Array<{ at: number; phase: PlannedPhase }> = [];
  const countNames: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const verbs = /(挥剑|挥刀|劈砍|刺剑|踢腿|踢击|出拳|格挡|招架|防守)/g;
  for (const match of prompt.matchAll(verbs)) {
    const verb = match[0];
    const at = match.index ?? 0;
    const repetition = prompt.slice(at + verb.length).match(/^\s*([一二三四五六七八九两\d])次/);
    const count = repetition ? Math.min(9, Number(countNames[repetition[1]] ?? repetition[1])) : 1;
    const isSword = /挥剑|挥刀|劈砍|刺剑/.test(verb);
    const isKick = /踢腿|踢击/.test(verb);
    const isPunch = verb === '出拳';
    const template = isSword ? 'sword' : isKick ? 'kick' : isPunch ? 'punch' : 'block';
    const precedingClause = prompt.slice(0, at).split(/[，,。；;]|然后|接着|随后|之后|再|后/).at(-1) ?? '';
    const sideCue = isPunch
      ? (/左手/.test(precedingClause) ? '左手' : /右手/.test(precedingClause) ? '右手' : '')
      : isKick ? (/左(?:腿|脚)/.test(precedingClause) ? '左腿' : /右(?:腿|脚)/.test(precedingClause) ? '右腿' : '') : '';
    const weight = template === 'block' ? 0.38 : 0.42;
    for (let index = 0; index < count; index++) {
      const clause = count > 1
        ? `第${index + 1}次${sideCue}${verb}并回到防守姿势`
        : template === 'punch' && sideCue ? `${sideCue}${verb}并收回防守姿势`
        : template === 'kick' && sideCue ? `${sideCue}${verb}并收回支撑姿势`
        : template === 'sword' ? `执行${verb}并回到防守姿势`
          : template === 'kick' ? `完成${verb}并收回支撑姿势`
            : template === 'punch' ? '完成出拳并收回防守姿势' : '完成格挡并恢复防守架势';
      actions.push({ at: at + index * 0.001, phase: {
        template, clause, weight,
        ...(opponent ? { targetPropId: opponent.id } : isSword && weapon ? { targetPropId: weapon.id } : {}),
      } });
    }
  }
  if (handoffMatch) actions.push({ at: handoffMatch.index, phase: { template: 'handoff', clause: handoffMatch[0], weight: 0.3, ...(weapon ? { targetPropId: weapon.id } : {}) } });
  actions.sort((a, b) => a.at - b.at);

  const phases: PlannedPhase[] = opponent
    ? [
      { template: 'march', clause: `走近${displayProp(opponent.kind)}至安全对练距离`, weight: 0.32, targetPropId: opponent.id },
      { template: 'orient', clause: `面向${displayProp(opponent.kind)}进入对抗站姿`, weight: 0.16, targetPropId: opponent.id },
      ...actions.map(({ phase }) => phase),
    ]
    : broadRequest
      ? [{ template: 'orient', clause: '进入稳定的对抗站姿', weight: 0.18 }, ...actions.map(({ phase }) => phase)]
      : actions.length > 1
      ? [{ template: 'orient', clause: '进入稳定的对抗站姿', weight: 0.18 }, ...actions.map(({ phase }) => phase)]
      : actions.map(({ phase }) => phase);
  if (broadRequest && phases.length === 1) {
    phases.push(weapon
      ? { template: 'sword', clause: '以手中武器完成一次受控挥砍', weight: 0.42, targetPropId: opponent?.id ?? weapon.id }
      : { template: 'block', clause: '进入防守姿势；请补充具体攻击方式', weight: 0.4 });
  }
  if (phases.length === 0) phases.push({ template: 'block', clause: '进入防守姿势；请补充具体攻击方式', weight: 0.4 });

  const contacts: ContactConstraint[] = weapon ? phases.flatMap((phase, actionIndex) =>
    ['sword', 'handoff'].includes(phase.template)
      && phase.targetPropId === weapon.id
      ? [{ phase: phase.template, actionIndex, bodyPart: 'hand' as const, propId: weapon.id, surface: 'interaction-point' as const, relation: 'support' as const }]
      : []) : [];
  const warnings = [opponent
    ? `攻击目标绑定到对手 ${opponent.id}；当前对手是静态占位体，命中/格挡仍需碰撞诊断复核`
    : '当前仅按动作顺序生成模板预演；没有对手目标与碰撞判定，不能验证命中或格挡结果'];
  if (/(对手|敌人|陪练|假人|靶子)/.test(prompt) && !opponent) warnings.push('描述指定了对手，但场景中没有对手目标；攻击暂按空场模板预演，请先添加对手');
  if (swordMatch && !weapon) warnings.push('描述要求使用剑/刀，但场景中没有武器；挥砍仅为无道具动作模板');
  if (handoffMatch && !weapon) warnings.push('描述要求交接武器，但场景中没有剑；交接阶段仅为手部动作模板');
  if (handoffMatch && weapon && !weapon.attachTo) warnings.push('武器当前未挂在手上，无法执行手间交接；请先将剑设为左手或右手持握');
  if (broadRequest && actions.length === 0 && !weapon) warnings.push('武打描述缺少具体攻击方式与武器，暂用防守动作占位，请补充攻击类型');
  return {
    segments: timedSegments(phases, duration),
    contacts,
    targetPropId: opponent?.id ?? weapon?.id,
    warnings,
  };
}

function decomposePortableTransfer(prompt: string, duration: number, props: StageProp[]): WorldActionPlan | null {
  const portable = findPromptProp(prompt, 'phone', props) ?? findPromptProp(prompt, 'sword', props);
  const surface = props.find((prop) => ['table', 'bed', 'chair', 'sofa'].includes(prop.kind) && prompt.includes(prop.id))
    ?? props.find((prop) => ['table', 'bed', 'chair', 'sofa'].includes(prop.kind) && PROP_TERMS[prop.kind].test(prompt));
  const pickupMatch = /拿起|拾起|捡起|抓起|取下/.exec(prompt);
  const placeMatch = /放下|放回|放在|放到|摆在|摆到|摆放/.exec(prompt);
  if (!portable || !surface || !pickupMatch || !placeMatch) return null;
  const pickupHand = handCueForAction(prompt, pickupMatch.index);
  const placementHand = handCueForAction(prompt, placeMatch.index);
  const phases: PlannedPhase[] = [
    { template: 'march', clause: `走到${displayProp(portable.kind)}所在位置`, weight: 0.28, targetPropId: portable.id },
    { template: 'orient', clause: `转向${displayProp(portable.kind)}并调整到便于拿取的位置`, weight: 0.12, targetPropId: portable.id },
    { template: 'reach', clause: `${pickupHand ? `${pickupHand}` : ''}伸手拿起${displayProp(portable.kind)}`, weight: 0.2, targetPropId: portable.id },
    { template: 'march', clause: `拿着${displayProp(portable.kind)}走到${displayProp(surface.kind)}前`, weight: 0.32, targetPropId: surface.id },
    { template: 'orient', clause: `转向${displayProp(surface.kind)}并对齐放置位置`, weight: 0.12, targetPropId: surface.id },
    { template: 'reach', clause: `${placementHand ? `${placementHand}` : ''}将${displayProp(portable.kind)}放到${displayProp(surface.kind)}上`, weight: 0.2, targetPropId: surface.id },
  ];
  if (/回头|回眸|看向|望向/.test(prompt)) phases.push({ template: 'look', clause: describeLookClause(prompt, '完成放置后'), weight: 0.16 });
  return {
    segments: timedSegments(phases, duration),
    contacts: [
      { phase: 'reach', actionIndex: 2, bodyPart: 'hand', propId: portable.id, surface: 'interaction-point', relation: 'support' },
      { phase: 'reach', actionIndex: 5, bodyPart: 'hand', propId: surface.id, surface: 'interaction-point', relation: 'support' },
    ],
    targetPropId: surface.id,
    warnings: [`按顺序规划拿起${displayProp(portable.kind)}并放到${displayProp(surface.kind)}；抓握和释放仍是姿态近似`],
  };
}

function handCueForAction(prompt: string, actionIndex: number): '左手' | '右手' | undefined {
  const separators = /[，,。；;]|然后|接着|随后|之后|再/g;
  let start = 0;
  let end = prompt.length;
  for (const match of prompt.matchAll(separators)) {
    const boundary = match.index ?? 0;
    const next = boundary + match[0].length;
    if (next <= actionIndex) start = next;
    else if (boundary > actionIndex) {
      end = boundary;
      break;
    }
  }
  const clause = prompt.slice(start, end);
  const cues = [...clause.matchAll(/左手|右手/g)];
  const cue = cues.sort((a, b) => Math.abs((a.index ?? 0) - (actionIndex - start)) - Math.abs((b.index ?? 0) - (actionIndex - start)))[0]?.[0];
  return cue === '左手' || cue === '右手' ? cue : undefined;
}

const NEGATION_RE = /(?:不要|别|不需要|无需|不能|禁止|不想|不去)\s*.{0,12}(?:拿|取|抓|递|接|使用|触碰|开门|推门|拉门|起床|起身|站起|坐起来|坐|走|跑|躺|卧|睡|休息|挥|刺|格挡|踢|跳|转身|回头|看向)/;

/** Remove independently negated clauses before extracting scene targets or action phases. */
export function positiveIntent(prompt: string): string {
  return prompt.split(/[，,。；;\n]+|但是|而是|只不过|但|然后|接着|之后/)
    .flatMap((clause) => {
      const negation = NEGATION_RE.exec(clause);
      if (!negation) return [clause.trim()];
      const positivePrefix = clause.slice(0, negation.index)
        .replace(/(?:然后|接着|随后|之后|再|后|并且|并|和|[,，\s])+$/g, '')
        .replace(/^(?:也|还|并且|并|再|然后|接着)\s*/g, '')
        .trim();
      return positivePrefix ? [positivePrefix] : [];
    })
    .filter(Boolean)
    .join('，')
    .trim();
}

function requestsStandUp(intent: string): boolean {
  return /起床|起身|站起|坐起来|从(?:床上|椅子上|地上)起来|(?:^|[，,])(?:再)?起来/.test(intent);
}

/** Finds an editable prop target in a natural-language action and assigns a spatial approach/contact plan. */
export function decomposeSceneAction(prompt: string, duration: number, props: StageProp[], actor?: SceneActorReference): WorldActionPlan | null {
  const intent = positiveIntent(prompt);
  if (!intent) return null;
  if (ambiguousSceneObjectWarnings(intent, props, actor).length > 0) return null;
  const lyingPlan = decomposeWorldAction(intent, duration, props);
  if (lyingPlan) return lyingPlan;
  const combat = decomposeCombatAction(intent, duration, props, actor);
  if (combat) return combat;
  const transfer = decomposePortableTransfer(intent, duration, props);
  if (transfer) return transfer;
  const prop = findPromptProp(intent, 'opponent', props, actor) ?? targetedProp(intent, props);
  if (!prop || prop.kind === 'room' || !/(走|跑|靠近|来到|到|拿|取|抓|坐|开门|推门|拉门|关门|关闭|关上|合上|触碰|使用|放下|放回|放在|放到|摆)/.test(intent)) return null;

  let phases: PlannedPhase[];
  let contacts: ContactConstraint[] = [];
  if ((prop.kind === 'chair' || prop.kind === 'sofa' || prop.kind === 'bed') && /坐/.test(intent)) {
    phases = [
      { template: 'march', clause: `走到${displayProp(prop.kind)}前`, weight: 0.38, targetPropId: prop.id },
      { template: 'orient', clause: `转向${displayProp(prop.kind)}并对齐坐姿`, weight: 0.18, targetPropId: prop.id },
      { template: 'sit', clause: `坐到${prop.kind === 'bed' ? '床沿' : prop.kind === 'sofa' ? '沙发座面' : '椅面'}并保持支撑`, weight: 0.44, targetPropId: prop.id },
    ];
    contacts = [{ phase: 'sit', actionIndex: 2, bodyPart: 'pelvis', propId: prop.id, surface: prop.kind === 'bed' ? 'mattress' : 'seat', relation: 'support' }];
    if (requestsStandUp(intent)) {
      phases.push({ template: 'stand', clause: '从座面支撑起身，恢复站立', weight: 0.28, targetPropId: prop.id });
    }
  } else if (prop.kind === 'door' && /开门|推门|拉门|关门|关闭|关上|合上/.test(intent)) {
    phases = [
      { template: 'march', clause: '走到门前', weight: 0.45, targetPropId: prop.id },
      { template: 'orient', clause: '面向门并调整到把手一侧', weight: 0.18, targetPropId: prop.id },
    ];
    const doorActions = [...intent.matchAll(/推开门|拉开门|打开门|开门|推门|拉门|关闭门|关上门|合上门|关门|合上/g)]
      .map((match) => ({ at: match.index, closing: /关|合/.test(match[0]) }));
    let opened = false;
    let addedPassThrough = false;
    for (const doorAction of doorActions) {
      if (doorAction.closing && opened && !addedPassThrough && /走进去|穿过|进屋|走进/.test(intent)) {
        phases.push({ template: 'march', clause: '穿过已打开的门', weight: 0.3, targetPropId: prop.id });
        addedPassThrough = true;
      }
      const actionIndex = phases.length;
      const clause = doorAction.closing ? '握住门把手并将门扇拉回，再关上门' : '伸手触碰门把手并推开门扇';
      phases.push({ template: 'reach', clause, weight: 0.32, targetPropId: prop.id });
      contacts.push({ phase: 'reach', actionIndex, bodyPart: 'hand', propId: prop.id, surface: 'handle', relation: 'support' });
      if (!doorAction.closing) opened = true;
    }
  } else if (/(放下|放回|放在|放到|摆)/.test(intent)) {
    phases = [
      { template: 'march', clause: `走到${displayProp(prop.kind)}前`, weight: 0.58, targetPropId: prop.id },
      { template: 'orient', clause: `转向${displayProp(prop.kind)}并对齐放置位置`, weight: 0.16, targetPropId: prop.id },
      { template: 'reach', clause: `将手中物体放到${displayProp(prop.kind)}上`, weight: 0.26, targetPropId: prop.id },
    ];
    contacts = [{ phase: 'reach', actionIndex: 2, bodyPart: 'hand', propId: prop.id, surface: 'interaction-point', relation: 'support' }];
  } else if (/(拿|取|抓|递|接|使用|触碰|开门|推门|拉门)/.test(intent)) {
    phases = [
      { template: 'march', clause: `走到${displayProp(prop.kind)}前`, weight: 0.5, targetPropId: prop.id },
      { template: 'orient', clause: `转向${displayProp(prop.kind)}并对齐交互位置`, weight: 0.16, targetPropId: prop.id },
      { template: 'reach', clause: interactionClause(prop.kind), weight: 0.34, targetPropId: prop.id },
    ];
    contacts = [{ phase: 'reach', actionIndex: 2, bodyPart: 'hand', propId: prop.id, surface: prop.kind === 'door' ? 'handle' : 'interaction-point', relation: 'support' }];
  } else {
    phases = [{ template: 'march', clause: `走到${displayProp(prop.kind)}前`, weight: 1, targetPropId: prop.id }];
  }
  let finalTargetProp = prop;
  const firstInteraction = /拿|取|抓|递|接|使用|触碰|开门|推门|拉门|关门|坐/.exec(intent);
  if (firstInteraction) {
    const tail = intent.slice(firstInteraction.index + firstInteraction[0].length);
    const tailClauses = tail.split(/[，,。；;]|然后|接着|随后|之后|再/).map((clause) => clause.trim());
    for (const clause of tailClauses) {
      if (!/(走|跑|前往|来到|靠近)/.test(clause)) continue;
      const destination = props.find((item) => item.kind !== 'room' && clause.includes(item.id))
        ?? props.find((item) => item.kind !== 'room' && PROP_TERMS[item.kind].test(clause));
      if (!destination || destination.id === phases.at(-1)?.targetPropId && phases.at(-1)?.template === 'march') continue;
      phases.push({ template: 'march', clause: `走到${displayProp(destination.kind)}前`, weight: 0.42, targetPropId: destination.id });
      finalTargetProp = destination;
      if (destination.kind === 'door' && /开门|推门|拉门|关门|关闭|关上|合上/.test(clause)) {
        phases.push({ template: 'orient', clause: '面向门并调整到把手一侧', weight: 0.16, targetPropId: destination.id });
        const actionIndex = phases.length;
        phases.push({ template: 'reach', clause: /关|合/.test(clause) ? '握住门把手并关上门' : '伸手触碰门把手并推开门扇', weight: 0.3, targetPropId: destination.id });
        contacts.push({ phase: 'reach', actionIndex, bodyPart: 'hand', propId: destination.id, surface: 'handle', relation: 'support' });
      }
    }
  }
  if (/回头|回眸|看向|望向/.test(intent) && !phases.some((phase) => phase.template === 'look')) {
    phases.push({ template: 'look', clause: describeLookClause(intent), weight: 0.2 });
  }
  const handCue = /左手/.test(intent) ? '左手' : /右手/.test(intent) ? '右手' : undefined;
  if (handCue) phases = phases.map((phase) => phase.template === 'reach' && !/左手|右手/.test(phase.clause)
    ? { ...phase, clause: `${handCue}${phase.clause}` }
    : phase);
  const segments = timedSegments(phases, duration);
  return {
    segments, contacts, targetPropId: finalTargetProp.id,
    warnings: [`已将${displayProp(prop.kind)}识别为场景目标；距离按道具尺寸规划，手部接触仍是姿态近似`],
  };
}

function displayProp(kind: StageProp['kind']): string {
  return ({ room: '房间', bed: '床', chair: '椅子', sofa: '沙发', table: '桌子', door: '门', phone: '手机', sword: '武器', opponent: '对手' })[kind];
}

export function missingSceneObjectWarnings(prompt: string, props: StageProp[]): string[] {
  const intent = positiveIntent(prompt);
  const mentions: Array<[StageProp['kind'], RegExp]> = [
    ['bed', /床上|床边|床沿|床面|躺.*床/], ['table', /桌前|桌边|桌上|桌子/],
    ['chair', /椅子|凳子/], ['sofa', /沙发|sofa|couch/i], ['door', /门口|门把手|开门|推门|拉门/], ['phone', /手机|电话/], ['sword', /挥剑|拔剑|刺剑|刀|武器/],
    ['opponent', /对手|敌人|陪练|假人|靶子/],
  ];
  return mentions.filter(([kind, terms]) => terms.test(intent) && !props.some((prop) => prop.kind === kind))
    .map(([kind]) => `场景中没有${displayProp(kind)}，AI保留动作模板近似；添加该道具后可绑定距离与接触目标`);
}

function interactionClause(kind: StageProp['kind']): string {
  if (kind === 'door') return '伸手触碰门把手并完成开门动作';
  if (kind === 'phone') return '伸手拿起手机';
  if (kind === 'sword') return '伸手握住武器并进入动作准备';
  return `伸手触碰${displayProp(kind)}的交互点`;
}

/** Converts a prop's front approach point and facing direction into the hips parent frame. */
export function resolvePropInteractionFrame(
  prop: StageProp,
  character: THREE.Object3D,
  skeleton: SkeletonSnapshot,
  props: StageProp[] = [prop],
  desiredDistanceMeters?: number,
  startPositionParent?: Vec3Tuple,
): WorldInteractionFrame | null {
  const hipsNode = Object.values(skeleton.nodes).find((node) => node.semantic === 'hips');
  const hips = hipsNode ? character.getObjectByProperty('uuid', hipsNode.id) as THREE.Bone | undefined : undefined;
  if (!hips?.parent) return null;
  character.updateWorldMatrix(true, true);
  hips.parent.updateWorldMatrix(true, false);
  const parent = hips.parent;
  const propCenter = new THREE.Vector3(...prop.position);
  const support = prop.kind === 'phone' ? props.find((item) => item.kind === 'table'
    && isPointInsidePropFootprint(prop.position[0], prop.position[2], item)
    && Math.abs(prop.position[1] - (item.position[1] + item.size.height)) <= 0.08) : undefined;
  const surfaceProp = support ?? prop;
  const localFront = prop.kind === 'sword'
    ? new THREE.Vector3(0, 0, 0.18)
    : new THREE.Vector3(0, 0, surfaceProp.size.length / 2 + 0.35);
  if (desiredDistanceMeters !== undefined) {
    localFront.setLength(prop.kind === 'sword' ? Math.max(0, desiredDistanceMeters) : surfaceProp.size.length / 2 + Math.max(0, desiredDistanceMeters));
  }
  localFront.applyAxisAngle(new THREE.Vector3(0, 1, 0), surfaceProp.rotationY);
  const approach = new THREE.Vector3(...surfaceProp.position).add(localFront);
  const worldHip = hips.getWorldPosition(new THREE.Vector3());
  const routeStart = startPositionParent
    ? parent.localToWorld(new THREE.Vector3(...startPositionParent))
    : worldHip.clone();
  approach.y = routeStart.y;
  const toParent = (point: THREE.Vector3): Vec3Tuple => {
    const local = parent.worldToLocal(point.clone());
    return [local.x, local.y, local.z];
  };
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion()));
  const toward = propCenter.clone().sub(approach).setY(0).normalize();
  const yawRadians = Math.atan2(forward.z * toward.x - forward.x * toward.z, forward.x * toward.x + forward.z * toward.z);
  const interaction = toParent(approach);
  const seat = prop.kind === 'chair' || prop.kind === 'sofa'
    ? new THREE.Vector3(0, prop.kind === 'sofa' ? prop.size.height * 0.72 : prop.size.height * 0.74,
      prop.kind === 'sofa' ? prop.size.length * 0.06 : prop.size.length * 0.08)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY)
      .add(new THREE.Vector3(...prop.position))
    : approach;
  const distanceMeters = new THREE.Vector2(routeStart.x - approach.x, routeStart.z - approach.z).length();
  const characterHeight = estimateCharacterHeight(character);
  const walkingClearance = walkingBodyClearance(characterHeight);
  const [actorMinY, actorMaxY] = characterVerticalBounds(character, routeStart.y);
  const route = routeAroundProps(routeStart, approach, prop, props, actorMinY, actorMaxY, walkingClearance);
  const handTarget = prop.kind === 'door'
    ? new THREE.Vector3(...doorHandleWorldPosition(prop))
    : prop.kind === 'table'
      ? new THREE.Vector3(0, prop.size.height, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(propCenter)
      : prop.kind === 'chair'
        ? new THREE.Vector3(0, prop.size.height * 0.52, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(propCenter)
        : prop.kind === 'phone'
          ? new THREE.Vector3(0, prop.size.height / 2, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(propCenter)
          : prop.kind === 'sword'
            ? new THREE.Vector3(0, -0.04, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(propCenter)
            : prop.kind === 'opponent'
              ? new THREE.Vector3(0, prop.size.height * 0.55, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY).add(propCenter)
              : propCenter.clone().add(new THREE.Vector3(0, prop.size.height / 2, 0));
  const handTargetPosition = toParent(handTarget);
  const armReach = estimateArmReach(handTargetPosition, skeleton, parent);
  return {
    approachPosition: interaction,
    sitPosition: toParent(seat),
    liePosition: interaction,
    interactionPosition: interaction,
    handTargetPosition,
    armReach,
    yawRadians,
    ...(prop.kind === 'sword' && prop.attachTo ? { wieldingHand: prop.attachTo === 'hand.L' ? 'L' : 'R' } : {}),
    distanceMeters,
    distanceHeightRatio: characterHeight > 0 ? distanceMeters / characterHeight : undefined,
    pathObstructed: route === null || route.length > 2,
    ...(route ? { approachPath: route.map(toParent) } : {}),
  };
}

function estimateArmReach(
  targetParent: Vec3Tuple,
  skeleton: SkeletonSnapshot,
  parent: THREE.Object3D,
): WorldInteractionFrame['armReach'] {
  const targetWorld = parent.localToWorld(new THREE.Vector3(...targetParent));
  const nodes = Object.values(skeleton.nodes);
  const reach: NonNullable<WorldInteractionFrame['armReach']> = {};
  for (const side of ['L', 'R'] as const) {
    const shoulder = nodes.find((node) => node.semantic === `upperArm.${side}`);
    const elbow = nodes.find((node) => node.semantic === `forearm.${side}`);
    const hand = nodes.find((node) => node.semantic === `hand.${side}`);
    if (!shoulder || !elbow || !hand) continue;
    const shoulderWorld = new THREE.Vector3(...shoulder.world.position);
    const elbowWorld = new THREE.Vector3(...elbow.world.position);
    const handWorld = new THREE.Vector3(...hand.world.position);
    const upperLength = shoulderWorld.distanceTo(elbowWorld);
    const lowerLength = elbowWorld.distanceTo(handWorld);
    const maxDistanceMeters = upperLength + lowerLength;
    const minDistanceMeters = Math.abs(upperLength - lowerLength) + 0.015;
    const distanceMeters = shoulderWorld.distanceTo(targetWorld);
    reach[side] = {
      distanceMeters,
      minDistanceMeters,
      maxDistanceMeters,
      reachable: distanceMeters >= minDistanceMeters && distanceMeters <= maxDistanceMeters * 0.98,
    };
  }
  return reach;
}

/** Plans each targeted action from the prior movement stage's resulting hips position. */
export function resolveSequentialInteractionFrames(
  segments: Array<Pick<WorldActionPlan['segments'][number], 'template' | 'targetPropId' | 'clause'>>,
  character: THREE.Object3D,
  skeleton: SkeletonSnapshot,
  props: StageProp[],
  targetDistanceMeters?: Record<string, number | undefined>,
): Record<number, WorldInteractionFrame> {
  const hipsNode = Object.values(skeleton.nodes).find((node) => node.semantic === 'hips');
  const hips = hipsNode ? character.getObjectByProperty('uuid', hipsNode.id) as THREE.Bone | undefined : undefined;
  if (!hips?.parent) return {};
  character.updateWorldMatrix(true, true);
  hips.parent.updateWorldMatrix(true, false);
  let position: Vec3Tuple | undefined;
  const frames: Record<number, WorldInteractionFrame> = {};
  for (const [index, segment] of segments.entries()) {
    if (!segment.targetPropId) continue;
    const prop = props.find((item) => item.id === segment.targetPropId);
    if (!prop) continue;
    const distance = targetDistanceMeters?.[prop.id];
    const frame = prop.kind === 'bed'
      ? resolveBedInteractionFrame(prop, character, skeleton, props, distance, position)
      : resolvePropInteractionFrame(prop, character, skeleton, props, distance, position);
    if (!frame) continue;
    frames[index] = frame;
    if (segment.template === 'orient') {
      position = /翻身|侧卧|侧身/.test(segment.clause) ? [...frame.liePosition] : [...frame.interactionPosition];
    } else if (segment.template === 'march') position = [...frame.interactionPosition];
    else if (segment.template === 'sit') position = [...frame.sitPosition];
    else if (segment.template === 'lie' || segment.template === 'sleep') position = [...frame.liePosition];
    else if (segment.template === 'stand') position = [...frame.approachPosition];
  }
  return frames;
}

function isPointInsidePropFootprint(x: number, z: number, prop: StageProp): boolean {
  const dx = x - prop.position[0];
  const dz = z - prop.position[2];
  const cos = Math.cos(prop.rotationY);
  const sin = Math.sin(prop.rotationY);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return Math.abs(localX) <= prop.size.width / 2 && Math.abs(localZ) <= prop.size.length / 2;
}

function routeAroundProps(
  start: THREE.Vector3,
  end: THREE.Vector3,
  target: StageProp,
  props: StageProp[],
  actorMinY: number,
  actorMaxY: number,
  clearance: number,
): THREE.Vector3[] | null {
  const obstacles = props.filter((prop) => prop.id !== target.id && prop.kind !== 'sword' && prop.kind !== 'room'
    && prop.position[1] <= actorMaxY + clearance
    && prop.position[1] + prop.size.height >= actorMinY - clearance)
    .sort((a, b) => a.id.localeCompare(b.id));
  const room = props.find((prop) => prop.kind === 'room');
  const insideRoom = (point: THREE.Vector3) => {
    if (!room) return true;
    const local = point.clone().sub(new THREE.Vector3(...room.position))
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), -room.rotationY);
    return Math.abs(local.x) <= room.size.width / 2 - clearance
      && Math.abs(local.z) <= room.size.length / 2 - clearance;
  };
  if (!insideRoom(start) || !insideRoom(end)) return null;
  const blocked = (a: THREE.Vector3, b: THREE.Vector3) => !insideRoom(a) || !insideRoom(b)
    || obstacles.some((prop) => segmentIntersectsExpandedFootprint(a, b, prop, clearance));
  if (!blocked(start, end)) return [start.clone(), end.clone()];

  const nodes = [start.clone(), end.clone()];
  for (const prop of obstacles) {
    const halfWidth = prop.size.width / 2 + clearance + ROUTE_CORNER_MARGIN;
    const halfLength = prop.size.length / 2 + clearance + ROUTE_CORNER_MARGIN;
    for (const x of [-halfWidth, halfWidth]) for (const z of [-halfLength, halfLength]) {
      const corner = new THREE.Vector3(x, start.y, z)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotationY)
        .add(new THREE.Vector3(...prop.position));
      if (insideRoom(corner)) nodes.push(corner);
    }
  }

  // Search the visible rectangle corners for the shortest route that keeps clearance from props.
  const distances = nodes.map((_, index) => index === 0 ? 0 : Infinity);
  const previous = nodes.map(() => -1);
  const visited = nodes.map(() => false);
  for (let iteration = 0; iteration < nodes.length; iteration++) {
    let current = -1;
    for (let index = 0; index < nodes.length; index++) {
      if (!visited[index] && (current < 0 || distances[index] < distances[current])) current = index;
    }
    if (current < 0 || !Number.isFinite(distances[current])) break;
    if (current === 1) break;
    visited[current] = true;
    for (let next = 0; next < nodes.length; next++) {
      if (next === current || visited[next] || blocked(nodes[current], nodes[next])) continue;
      const candidate = distances[current] + Math.hypot(nodes[next].x - nodes[current].x, nodes[next].z - nodes[current].z);
      if (candidate < distances[next]) {
        distances[next] = candidate;
        previous[next] = current;
      }
    }
  }
  if (!Number.isFinite(distances[1])) return null;
  const route: THREE.Vector3[] = [];
  for (let index = 1; index >= 0; index = previous[index]) {
    route.push(nodes[index].clone());
    if (index === 0) break;
    if (previous[index] < 0) return null;
  }
  return route.reverse();
}

function segmentIntersectsExpandedFootprint(
  start: THREE.Vector3,
  end: THREE.Vector3,
  prop: StageProp,
  clearance: number,
): boolean {
  const origin = start.clone().sub(new THREE.Vector3(...prop.position)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -prop.rotationY);
  const finish = end.clone().sub(new THREE.Vector3(...prop.position)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -prop.rotationY);
  const directionX = finish.x - origin.x;
  const directionZ = finish.z - origin.z;
  let enter = 0;
  let exit = 1;
  for (const [coordinate, direction, halfExtent] of [
    [origin.x, directionX, prop.size.width / 2 + clearance],
    [origin.z, directionZ, prop.size.length / 2 + clearance],
  ]) {
    if (Math.abs(direction) < 1e-9) {
      if (Math.abs(coordinate) > halfExtent) return false;
      continue;
    }
    let near = (-halfExtent - coordinate) / direction;
    let far = (halfExtent - coordinate) / direction;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    exit = Math.min(exit, far);
    if (enter > exit) return false;
  }
  return exit >= 0 && enter <= 1;
}

const BED_PHASES = [
  { template: 'march', clause: '走到床边', weight: 0.2 },
  { template: 'orient', clause: '转向床并对齐床面', weight: 0.12 },
  { template: 'sit', clause: '坐到床沿', weight: 0.2 },
  { template: 'lie', clause: '支撑身体并向后躺到床面，转为仰卧', weight: 0.3 },
];

const FLOOR_PHASES = [
  { template: 'kneel', clause: '屈膝缓慢跪下，并伸手扶地降低重心', weight: 0.3 },
  { template: 'lie', clause: '以手臂支撑身体并转为仰卧，平稳落到地面', weight: 0.4 },
];

/** Decomposes bed/sleep intent into explicit phases and support-contact requirements. */
export function decomposeWorldAction(prompt: string, duration: number, props: StageProp[]): WorldActionPlan | null {
  const intent = positiveIntent(prompt);
  if (!/躺|卧|睡|休息/.test(intent)) return null;
  // 独立调用时也必须检查歧义，避免不经上层规划器就静默选中第一张床。
  if (ambiguousSceneObjectWarnings(intent, props).some((warning) => /多个床/.test(warning))) return null;
  const explicitGroundTarget = /地上|地面|地板|地毯|地砖|floor|ground/i.test(intent);
  const explicitlyRequestsBed = !explicitGroundTarget && /床上|床面|床沿|床边|躺.*床|卧.*床/.test(intent);
  const bed = explicitGroundTarget ? undefined : findPromptProp(intent, 'bed', props) ?? props.find((prop) => prop.kind === 'bed');
  if (explicitlyRequestsBed && !bed) {
    const phases = timedSegments([{
      template: 'sway', clause: '等待床面支撑：请先添加床，或明确改为地面躺卧', weight: 1,
    }], duration);
    return {
      segments: phases,
      contacts: [],
      warnings: ['场景中没有床；描述明确要求床面支撑，未改成地面躺卧，请添加床或明确改为地面'],
    };
  }
  const wantsSleep = /睡|休息/.test(intent);
  const wantsStand = requestsStandUp(intent);
  const phases = [...(bed ? BED_PHASES : FLOOR_PHASES), ...(wantsSleep ? [
    { template: 'sleep', clause: bed ? '调整到放松姿势并安静呼吸' : '仰卧放松并安静呼吸', weight: bed ? 0.18 : 0.35 },
  ] : []), ...(wantsStand && bed ? [
    { template: 'orient', clause: '睡眠结束后翻身侧卧，用手臂支撑床面', weight: 0.2 },
    { template: 'sit', clause: '撑起上身坐到床沿，双腿垂下', weight: 0.22 },
    { template: 'stand', clause: '从床沿移到地面并支撑起身，恢复站立', weight: 0.2 },
  ] : wantsStand ? [
    { template: 'orient', clause: '从仰卧翻身侧身，用手臂支撑地面', weight: 0.18 },
    { template: 'kneel', clause: '双手撑地并收腿跪起，稳定重心', weight: 0.22 },
    { template: 'stand', clause: '从跪撑姿势站起，恢复站立', weight: 0.2 },
  ] : [])];
  const segments = timedSegments(phases.map((phase) => ({ ...phase, ...(bed ? { targetPropId: bed.id } : {}) })), duration);
  const contacts: ContactConstraint[] = bed ? [
    { phase: 'sit', actionIndex: 2, bodyPart: 'pelvis', propId: bed.id, surface: 'mattress', relation: 'support' },
    { phase: 'lie', actionIndex: 3, bodyPart: 'back', propId: bed.id, surface: 'mattress', relation: 'support' },
    ...(wantsSleep ? [
      { phase: 'sleep', actionIndex: 4, bodyPart: 'head' as const, propId: bed.id, surface: 'mattress' as const, relation: 'rest' as const },
      { phase: 'sleep', actionIndex: 4, bodyPart: 'legs' as const, propId: bed.id, surface: 'mattress' as const, relation: 'rest' as const },
    ] : []),
    ...(wantsStand ? [
      { phase: 'orient', actionIndex: wantsSleep ? 5 : 4, bodyPart: 'hand' as const, propId: bed.id, surface: 'mattress' as const, relation: 'support' as const },
      { phase: 'sit', actionIndex: wantsSleep ? 6 : 5, bodyPart: 'pelvis' as const, propId: bed.id, surface: 'mattress' as const, relation: 'support' as const },
    ] : []),
  ] : [
    { phase: 'kneel', actionIndex: 0, bodyPart: 'hand', propId: 'ground', surface: 'ground', relation: 'support' },
    { phase: 'lie', actionIndex: 1, bodyPart: 'pelvis', propId: 'ground', surface: 'ground', relation: 'support' },
    { phase: 'lie', actionIndex: 1, bodyPart: 'back', propId: 'ground', surface: 'ground', relation: 'support' },
    ...(wantsSleep ? [
      { phase: 'sleep', actionIndex: 2, bodyPart: 'head' as const, propId: 'ground', surface: 'ground' as const, relation: 'rest' as const },
      { phase: 'sleep', actionIndex: 2, bodyPart: 'legs' as const, propId: 'ground', surface: 'ground' as const, relation: 'rest' as const },
    ] : []),
    ...(wantsStand ? [
      { phase: 'orient', actionIndex: wantsSleep ? 3 : 2, bodyPart: 'hand' as const, propId: 'ground', surface: 'ground' as const, relation: 'support' as const },
      { phase: 'kneel', actionIndex: wantsSleep ? 4 : 3, bodyPart: 'hand' as const, propId: 'ground', surface: 'ground' as const, relation: 'support' as const },
      { phase: 'kneel', actionIndex: wantsSleep ? 4 : 3, bodyPart: 'legs' as const, propId: 'ground', surface: 'ground' as const, relation: 'support' as const },
    ] : []),
  ];
  return {
    segments,
    contacts,
    targetPropId: bed?.id,
    warnings: bed
      ? ['阶段和床面支撑目标已规划；当前使用程序化姿态近似，尚未运行刚体碰撞/多点接触求解']
      : explicitGroundTarget
        ? [wantsStand
          ? '描述明确指定地面支撑；已规划侧身支撑、跪撑和站立过渡，但没有刚体碰撞或地面接触模拟'
          : '描述明确指定地面支撑；当前按地面仰卧规划，但没有刚体碰撞或地面接触模拟']
        : [wantsStand
          ? '场景没有床；已按地面侧身支撑、跪撑和站立过渡规划，但没有刚体碰撞或地面接触模拟'
          : '场景没有床；当前按地面仰卧规划并记录地面支撑意图，但没有刚体碰撞或地面接触模拟。添加床后可生成床沿、躺下和床面支撑阶段'],
  };
}
