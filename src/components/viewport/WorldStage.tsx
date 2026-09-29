import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { DOOR_HANDLE_RADIUS, doorHandleLocalPosition, sampleDoorOpenAngle, samplePortablePropTransfer, sampleWeaponAttachment, type ContactConstraint, type StageProp, type WorldActionPlan } from '../../core/previs/world';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useWorldStore } from '../../stores/worldStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { usePrevisStore } from '../../stores/previsStore';
import { isEffectVisible } from '../../core/previs/effects';

function Bed({ bed }: { bed: StageProp }) {
  const { width, height, length } = bed.size;
  const frameHeight = Math.min(0.24, height * 0.42);
  const mattressHeight = height - frameHeight;
  const leg = 0.1;
  const legHeight = Math.max(0.12, frameHeight - 0.02);

  return (
    <group position={bed.position} rotation={[0, bed.rotationY, 0]}>
      <mesh position={[0, frameHeight - legHeight / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, legHeight, length]} />
        <meshStandardMaterial color="#76583f" roughness={0.72} />
      </mesh>
      {[-1, 1].flatMap((x) => [-1, 1].map((z) => (
        <mesh key={`${x}-${z}`} position={[x * (width / 2 - leg / 2), legHeight / 2, z * (length / 2 - leg / 2)]} castShadow receiveShadow>
          <boxGeometry args={[leg, legHeight, leg]} />
          <meshStandardMaterial color="#684b35" roughness={0.78} />
        </mesh>
      )))}
      <mesh position={[0, frameHeight + mattressHeight / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width - 0.06, mattressHeight, length - 0.06]} />
        <meshStandardMaterial color="#c8bba7" roughness={0.9} />
      </mesh>
      <mesh position={[0, height + 0.1, -length / 2 + 0.14]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.2, 0.1]} />
        <meshStandardMaterial color="#76583f" roughness={0.75} />
      </mesh>
      <mesh position={[0, height + 0.035, -length / 2 + 0.3]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.42, 0.09, 0.34]} />
        <meshStandardMaterial color="#e9e4dc" roughness={0.95} />
      </mesh>
    </group>
  );
}

function Sofa({ sofa }: { sofa: StageProp }) {
  const { width, height, length } = sofa.size;
  const seatTop = height * 0.58;
  const cushionHeight = height * 0.18;
  const cushionWidth = width * 0.255;
  const seatZ = length * 0.06;
  return <group>
    <mesh position={[0, height * 0.29, seatZ]} castShadow receiveShadow>
      <boxGeometry args={[width * 0.82, height * 0.18, length * 0.72]} />
      <meshStandardMaterial color="#526f68" roughness={0.9} />
    </mesh>
    {[-1, 0, 1].map((index) => <mesh key={`seat-${index}`} position={[index * width * 0.27, seatTop - cushionHeight / 2, seatZ]} castShadow receiveShadow>
      <boxGeometry args={[cushionWidth, cushionHeight, length * 0.68]} />
      <meshStandardMaterial color={index === 0 ? '#789187' : '#6d877d'} roughness={0.96} />
    </mesh>)}
    <mesh position={[0, height * 0.72, -length * 0.4]} castShadow receiveShadow>
      <boxGeometry args={[width * 0.86, height * 0.46, length * 0.15]} />
      <meshStandardMaterial color="#526f68" roughness={0.92} />
    </mesh>
    {[-1, 1].map((side) => <mesh key={`arm-${side}`} position={[side * width * 0.44, height * 0.48, 0]} castShadow receiveShadow>
      <boxGeometry args={[width * 0.12, height * 0.5, length * 0.82]} />
      <meshStandardMaterial color="#425c56" roughness={0.9} />
    </mesh>)}
  </group>;
}

function Sword({ sword }: { sword: StageProp }) {
  const sceneObject = useCharacterStore((state) => state.sceneObject);
  const snapshot = useSkeletonStore((state) => state.snapshot);
  const animationId = useAnimationStore((state) => state.activeId);
  const plan = usePrevisStore((state) => animationId ? state.byAnimationId[animationId]?.scenePlan : undefined);
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const attachment = sampleWeaponAttachment(sword, plan?.actions ?? [], useAnimationStore.getState().currentTime);
    if (!attachment.from || !attachment.to || !sceneObject || !snapshot) {
      ref.current.position.fromArray(sword.position);
      ref.current.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sword.rotationY);
      return;
    }
    sceneObject.updateWorldMatrix(true, true);
    const transformAtHand = (semantic: 'hand.R' | 'hand.L') => {
      const handNode = Object.values(snapshot.nodes).find((node) => node.semantic === semantic);
      const hand = handNode ? sceneObject.getObjectByProperty('uuid', handNode.id) : null;
      if (!hand) return null;
      hand.updateWorldMatrix(true, false);
      const position = new THREE.Vector3(...(sword.attachOffset ?? [0, 0, 0]));
      hand.localToWorld(position);
      return { position, quaternion: hand.getWorldQuaternion(new THREE.Quaternion()) };
    };
    const from = transformAtHand(attachment.from);
    const to = transformAtHand(attachment.to);
    if (!from || !to) return;
    ref.current.position.copy(from.position).lerp(to.position, attachment.blend);
    ref.current.quaternion.copy(from.quaternion).slerp(to.quaternion, attachment.blend);
    ref.current.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sword.rotationY));
  });
  return (
    <group ref={ref} position={sword.position}>
      <mesh position={[0, -0.04, 0]} castShadow>
        <cylinderGeometry args={[0.018, 0.022, 0.18, 8]} />
        <meshStandardMaterial color="#76513a" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.065, 0]} castShadow>
        <boxGeometry args={[0.12, 0.025, 0.035]} />
        <meshStandardMaterial color="#c49b52" metalness={0.65} roughness={0.35} />
      </mesh>
      <mesh position={[0, sword.size.length * 0.52, 0]} castShadow>
        <boxGeometry args={[sword.size.width, sword.size.length, sword.size.height]} />
        <meshStandardMaterial color="#cbd5df" metalness={0.82} roughness={0.22} />
      </mesh>
    </group>
  );
}

function Door({ door, actions }: { door: StageProp; actions: WorldActionPlan['segments'] }) {
  const hinge = useRef<THREE.Group>(null);
  const { width, height, length } = door.size;
  const handle = doorHandleLocalPosition(door);
  useFrame(() => {
    if (!hinge.current) return;
    hinge.current.rotation.y = sampleDoorOpenAngle(actions, door.id, useAnimationStore.getState().currentTime);
  });
  return <group position={door.position} rotation={[0, door.rotationY, 0]}>
    <group ref={hinge} position={[-width / 2, 0, 0]}>
      <mesh position={[width / 2, height / 2, 0]} castShadow>
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial color="#94704d" roughness={0.65} />
      </mesh>
      <mesh position={[handle[0] + width / 2, handle[1], handle[2]]}>
        <sphereGeometry args={[DOOR_HANDLE_RADIUS, 10, 8]} />
        <meshStandardMaterial color="#c7a355" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  </group>;
}

function Opponent({ opponent }: { opponent: StageProp }) {
  const { width, height, length } = opponent.size;
  const headRadius = Math.min(width * 0.15, length * 0.19, 0.13);
  const limbRadius = width * 0.075;
  return <group position={opponent.position} rotation={[0, opponent.rotationY, 0]}>
    <mesh position={[0, height * 0.63, 0]} castShadow receiveShadow>
      <capsuleGeometry args={[width * 0.23, height * 0.27, 5, 8]} />
      <meshStandardMaterial color="#557b73" roughness={0.85} />
    </mesh>
    <mesh position={[0, height * 0.43, 0]} castShadow receiveShadow>
      <capsuleGeometry args={[width * 0.2, height * 0.12, 4, 8]} />
      <meshStandardMaterial color="#42565a" roughness={0.92} />
    </mesh>
    {([-1, 1] as const).map((side) => <group key={side}>
      <mesh position={[side * width * 0.16, height * 0.21, 0]} castShadow receiveShadow>
        <capsuleGeometry args={[limbRadius, height * 0.3, 4, 7]} />
        <meshStandardMaterial color="#343d45" roughness={0.9} />
      </mesh>
      <mesh position={[side * width * 0.37, height * 0.61, 0]} rotation={[0, 0, side * -0.24]} castShadow receiveShadow>
        <capsuleGeometry args={[limbRadius, height * 0.34, 4, 7]} />
        <meshStandardMaterial color="#557b73" roughness={0.85} />
      </mesh>
      <mesh position={[side * width * 0.43, height * 0.4, 0]} castShadow receiveShadow>
        <sphereGeometry args={[limbRadius * 1.12, 10, 8]} />
        <meshStandardMaterial color="#bf8d72" roughness={0.8} />
      </mesh>
    </group>)}
    <mesh position={[0, height * 0.88, 0]} castShadow receiveShadow>
      <sphereGeometry args={[headRadius, 14, 10]} />
      <meshStandardMaterial color="#bf8d72" roughness={0.8} />
    </mesh>
    <mesh position={[0, height * 0.81, length * 0.13]} castShadow>
      <boxGeometry args={[headRadius * 0.76, headRadius * 0.2, headRadius * 0.24]} />
      <meshStandardMaterial color="#27343a" roughness={0.8} />
    </mesh>
  </group>;
}

function SimpleProp({ prop, props, actions, contacts }: { prop: StageProp; props: StageProp[]; actions: WorldActionPlan['segments']; contacts: ContactConstraint[] }) {
  const { width, height, length } = prop.size;
  const ref = useRef<THREE.Group>(null);
  const sceneObject = useCharacterStore((state) => state.sceneObject);
  const snapshot = useSkeletonStore((state) => state.snapshot);
  useFrame(() => {
    if (!ref.current || prop.kind !== 'phone') return;
    const time = useAnimationStore.getState().currentTime;
    const transfer = samplePortablePropTransfer(prop, props, actions, contacts, time);
    if (!transfer) {
      ref.current.position.fromArray(prop.position);
      return;
    }
    if (transfer.attachmentWeight <= 1e-5 && transfer.placementPosition) {
      ref.current.position.fromArray(transfer.placementPosition);
      return;
    }
    const handNode = Object.values(snapshot?.nodes ?? {}).find((node) => node.semantic === transfer.hand);
    const hand = handNode && sceneObject ? sceneObject.getObjectByProperty('uuid', handNode.id) : null;
    if (!hand) {
      ref.current.position.fromArray(prop.position);
      return;
    }
    sceneObject!.updateWorldMatrix(true, true);
    hand.updateWorldMatrix(true, false);
    const attached = hand.getWorldPosition(new THREE.Vector3());
    attached.y -= height * 0.65;
    const base = new THREE.Vector3(...prop.position);
    let position = base.lerp(attached, transfer.attachmentWeight);
    if (transfer.placementPosition) position = position.lerp(new THREE.Vector3(...transfer.placementPosition), 1 - transfer.attachmentWeight);
    ref.current.position.copy(position);
  });
  return <group ref={ref} position={prop.position} rotation={[0, prop.rotationY, 0]}>
    {prop.kind === 'room' && <>
      <mesh position={[0, height / 2, -length / 2]} receiveShadow><boxGeometry args={[width, height, 0.08]} /><meshStandardMaterial color="#d6d8da" roughness={0.9} transparent opacity={0.16} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      <mesh position={[-width / 2, height / 2, 0]} receiveShadow><boxGeometry args={[0.08, height, length]} /><meshStandardMaterial color="#c9d4dc" roughness={0.9} transparent opacity={0.1} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      <mesh position={[width / 2, height / 2, 0]} receiveShadow><boxGeometry args={[0.08, height, length]} /><meshStandardMaterial color="#c9d4dc" roughness={0.9} transparent opacity={0.1} depthWrite={false} side={THREE.DoubleSide} /></mesh>
    </>}
    {prop.kind === 'table' && <>
      <mesh position={[0, height - 0.06, 0]} castShadow receiveShadow><boxGeometry args={[width, 0.12, length]} /><meshStandardMaterial color="#9a6a43" roughness={0.72} /></mesh>
      {[-1, 1].flatMap((x) => [-1, 1].map((z) => <mesh key={`${x}-${z}`} position={[x * width * 0.42, (height - 0.12) / 2, z * length * 0.38]} castShadow><boxGeometry args={[0.07, height - 0.12, 0.07]} /><meshStandardMaterial color="#76513a" roughness={0.75} /></mesh>))}
    </>}
    {prop.kind === 'chair' && <>
      <mesh position={[0, height * 0.48, 0]} castShadow><boxGeometry args={[width, 0.08, length]} /><meshStandardMaterial color="#537566" roughness={0.75} /></mesh>
      <mesh position={[0, height * 0.76, -length * 0.42]} castShadow><boxGeometry args={[width, height * 0.5, 0.07]} /><meshStandardMaterial color="#537566" roughness={0.75} /></mesh>
      {[-1, 1].flatMap((x) => [-1, 1].map((z) => <mesh key={`${x}-${z}`} position={[x * width * 0.4, height * 0.23, z * length * 0.4]} castShadow><boxGeometry args={[0.055, height * 0.46, 0.055]} /><meshStandardMaterial color="#76513a" roughness={0.75} /></mesh>))}
    </>}
    {prop.kind === 'sofa' && <Sofa sofa={prop} />}
    {prop.kind === 'phone' && <>
      <mesh position={[0, height / 2, 0]} rotation={[-0.08, 0, 0]} castShadow><boxGeometry args={[width, height, length]} /><meshStandardMaterial color="#282d34" metalness={0.45} roughness={0.32} /></mesh>
      <mesh position={[0, height + 0.002, 0]}><boxGeometry args={[width * 0.88, 0.003, length * 0.9]} /><meshBasicMaterial color="#79b8d1" /></mesh>
    </>}
  </group>;
}

function EffectPreview() {
  const animationId = useAnimationStore((state) => state.activeId);
  const allEvents = useEffectsStore((state) => state.events);
  const events = useMemo(() => allEvents.filter((event) => !event.animationId || event.animationId === animationId), [allEvents, animationId]);
  return <>{events.map((event) => <EffectEvent key={event.id} event={event} />)}</>;
}

function EffectEvent({ event }: { event: ReturnType<typeof useEffectsStore.getState>['events'][number] }) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const sweepMesh = useRef<THREE.Mesh>(null);
  const bladeMesh = useRef<THREE.Mesh>(null);
  const particles = useRef<THREE.InstancedMesh>(null);
  const particleTransform = useMemo(() => new THREE.Object3D(), []);
  const particleDirection = useMemo(() => new THREE.Vector3(), []);
  const sweepGeometry = useMemo(() => {
    if (event.kind !== 'slash' || !event.path || event.path.length < 2) return null;
    const origin = new THREE.Vector3(...event.position);
    const points = event.path.map((point) => new THREE.Vector3(...point).sub(origin))
      .filter((point, index, all) => index === 0 || point.distanceToSquared(all[index - 1]) > 1e-8);
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points);
    return new THREE.TubeGeometry(curve, Math.max(12, (points.length - 1) * 6), 0.012, 6, false);
  }, [event.kind, event.path, event.position]);
  const bladeGeometry = useMemo(() => {
    if (event.kind !== 'slash' || !event.bladeSweep || event.bladeSweep.length < 2) return null;
    const origin = new THREE.Vector3(...event.position);
    const positions = new Float32Array(event.bladeSweep.length * 2 * 3);
    const indices: number[] = [];
    event.bladeSweep.forEach((sample, index) => {
      const base = new THREE.Vector3(...sample.base).sub(origin);
      const tip = new THREE.Vector3(...sample.tip).sub(origin);
      positions.set(base.toArray(), index * 6);
      positions.set(tip.toArray(), index * 6 + 3);
      if (index > 0) {
        const previousBase = (index - 1) * 2;
        const currentBase = index * 2;
        indices.push(previousBase, currentBase, previousBase + 1, previousBase + 1, currentBase, currentBase + 1);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }, [event.kind, event.bladeSweep, event.position]);
  const particleGeometry = useMemo(() => ['spark', 'dust', 'smoke'].includes(event.kind)
    ? event.kind === 'spark'
      ? new THREE.CapsuleGeometry(0.012, 0.09, 2, 5)
      : new THREE.SphereGeometry(0.16, 9, 7)
    : null, [event.kind]);
  const particleMaterial = useMemo(() => ['spark', 'dust', 'smoke'].includes(event.kind)
    ? new THREE.MeshBasicMaterial({
      color: event.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: event.kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    : null, [event.kind, event.color]);
  const particleCount = event.kind === 'spark' ? 10 : event.kind === 'dust' ? 12 : event.kind === 'smoke' ? 8 : 0;
  useEffect(() => () => {
    sweepGeometry?.dispose();
    bladeGeometry?.dispose();
    particleGeometry?.dispose();
    particleMaterial?.dispose();
  }, [sweepGeometry, bladeGeometry, particleGeometry, particleMaterial]);
  useFrame(() => {
    const time = useAnimationStore.getState().currentTime;
    const visible = isEffectVisible(event, time);
    if (!group.current) return;
    group.current.visible = visible;
    if (!visible) return;
    const progress = Math.min(Math.max((time - event.time) / event.duration, 0), 1);
    const envelope = Math.sin(Math.PI * progress);
    group.current.scale.setScalar(event.scale * (0.7 + progress * 0.6));
    const material = mesh.current?.material as THREE.MeshBasicMaterial | undefined;
    if (material) material.opacity = envelope;
    const sweepMaterial = sweepMesh.current?.material as THREE.MeshBasicMaterial | undefined;
    if (sweepMaterial) sweepMaterial.opacity = envelope * 0.88;
    const bladeMaterial = bladeMesh.current?.material as THREE.MeshBasicMaterial | undefined;
    if (bladeMaterial) bladeMaterial.opacity = envelope * 0.22;
    if (particles.current && particleMaterial) {
      const burst = event.kind === 'spark' || event.kind === 'dust';
      particleMaterial.opacity = envelope * (event.kind === 'spark' ? 0.9 : event.kind === 'dust' ? 0.38 : 0.28);
      for (let index = 0; index < particleCount; index++) {
        const angle = index * 2.399963229728653;
        const vertical = event.kind === 'smoke' ? 0.35 + (index % 3) * 0.12 : Math.sin(angle * 1.7) * (burst ? 0.35 : 0.08);
        const direction = particleDirection.set(Math.cos(angle), vertical, Math.sin(angle)).normalize();
        const travel = progress * (event.kind === 'spark' ? 0.5 + (index % 4) * 0.07 : event.kind === 'dust' ? 0.36 : 0.22);
        particleTransform.position.copy(direction).multiplyScalar(travel);
        if (event.kind === 'smoke') particleTransform.position.y += progress * 0.2;
        particleTransform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        const size = event.kind === 'spark'
          ? 0.55 + (index % 3) * 0.18
          : (event.kind === 'smoke' ? 0.55 + progress * 1.5 : 0.45 + progress * 0.5) * (0.72 + (index % 4) * 0.12);
        particleTransform.scale.set(size, event.kind === 'spark' ? size : size * (event.kind === 'smoke' ? 1.5 : 0.85), size);
        particleTransform.updateMatrix();
        particles.current.setMatrixAt(index, particleTransform.matrix);
      }
      particles.current.count = particleCount;
      particles.current.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group ref={group} position={event.position}>
      {event.kind === 'slash' ? (
        <>
          {bladeGeometry && <mesh ref={bladeMesh} geometry={bladeGeometry}>
            <meshBasicMaterial color={event.color} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
          </mesh>}
          {sweepGeometry && <mesh ref={sweepMesh} geometry={sweepGeometry}>
            <meshBasicMaterial color={event.color} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>}
          <mesh ref={mesh} rotation={[0, 0, -0.6]}>
            <torusGeometry args={[0.55, 0.025, 6, 28, Math.PI * 1.25]} />
            <meshBasicMaterial color={event.color} transparent opacity={0.85} depthWrite={false} />
          </mesh>
        </>
      ) : event.kind === 'impact' ? (
        <group>
          <mesh ref={mesh}>
            <sphereGeometry args={[0.18, 10, 8]} />
            <meshBasicMaterial color={event.color} transparent opacity={0.85} depthWrite={false} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.3, 0.018, 5, 20]} />
            <meshBasicMaterial color={event.color} transparent opacity={0.65} depthWrite={false} />
          </mesh>
        </group>
      ) : event.kind === 'energy' ? (
        <mesh ref={mesh} rotation={[0.8, 0.2, -0.45]}>
          <torusGeometry args={[0.48, 0.026, 6, 32, Math.PI * 1.7]} />
          <meshBasicMaterial color={event.color} transparent opacity={0.85} depthWrite={false} />
        </mesh>
      ) : event.kind === 'spark' || event.kind === 'dust' || event.kind === 'smoke' ? (
        particleGeometry && particleMaterial && <instancedMesh ref={particles} args={[particleGeometry, particleMaterial, particleCount]} frustumCulled={false} />
      ) : (
        <mesh ref={mesh} position={[0, 0.18, 0]}>
          <sphereGeometry args={[0.28, 10, 7]} />
          <meshBasicMaterial color={event.color} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

export function WorldStage() {
  const props = useWorldStore((state) => state.props);
  const animationId = useAnimationStore((state) => state.activeId);
  const plan = usePrevisStore((state) => animationId ? state.byAnimationId[animationId]?.scenePlan : undefined);
  const contacts = plan?.contacts ?? [];
  return <>
    {props.map((prop) => prop.kind === 'bed' ? <Bed key={prop.id} bed={prop} /> : prop.kind === 'sword' ? <Sword key={prop.id} sword={prop} /> : prop.kind === 'door' ? <Door key={prop.id} door={prop} actions={plan?.actions ?? []} /> : prop.kind === 'opponent' ? <Opponent key={prop.id} opponent={prop} /> : <SimpleProp key={prop.id} prop={prop} props={props} actions={plan?.actions ?? []} contacts={contacts} />)}
    <EffectPreview />
  </>;
}
