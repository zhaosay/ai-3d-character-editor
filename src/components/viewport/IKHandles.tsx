import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Line, TransformControls } from '@react-three/drei';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { applyIKChain } from '../../core/ik/applyIK';
import { indexBonesByName } from '../../core/animation/applyPose';
import type { IKChainId } from '../../core/ik/types';
import type { Vec3Tuple } from '../../types/global';

const ORDER: IKChainId[] = ['arm.L', 'arm.R', 'leg.L', 'leg.R'];

/** 中央求解：暂停时对启用的链逐帧解算（播放时 FK 优先，IK 让路）。 */
export function IKSolver() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const bones = useMemo(() => (sceneObject ? indexBonesByName(sceneObject) : null), [sceneObject]);

  useFrame(() => {
    if (useAnimationStore.getState().playing) return;
    if (!sceneObject || !bones) return;
    const ik = useIKStore.getState();
    for (const id of ORDER) {
      const c = ik.chains[id];
      if (!c?.enabled) continue;
      try {
        const r = applyIKChain(bones, c.def, c.target, c.polePoint);
        if (r) ik.setLastSolve(id, { reached: r.reached, hingeDeg: r.hingeDeg, clamped: r.clamped });
      } catch (e) {
        console.error(`IK ${id}:`, e);
      }
    }
  });
  return null;
}

/** 末端目标 + 极向量手柄（播放时隐藏，避免与采样打架）。 */
export function IKHandles() {
  const playing = useAnimationStore((s) => s.playing);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const chains = useIKStore((s) => s.chains);
  if (playing || !sceneObject) return null;
  return (
    <group>
      {ORDER.map((id) => (chains[id]?.enabled ? <ChainHandles key={id} id={id} /> : null))}
    </group>
  );
}

function ChainHandles({ id }: { id: IKChainId }) {
  const targetRef = useRef<THREE.Mesh>(null);
  const poleRef = useRef<THREE.Mesh>(null);
  const lastRev = useRef(-1);
  const color = id.startsWith('arm') ? '#34d399' : '#60a5fa';

  useFrame(() => {
    const c = useIKStore.getState().chains[id];
    const t = targetRef.current;
    const p = poleRef.current;
    if (!c || !t || !p) return;
    if (c.rev !== lastRev.current) {
      // 外部写入（数字框/重置）：手柄跟随 store
      t.position.fromArray(c.target);
      p.position.fromArray(c.polePoint);
      lastRev.current = c.rev;
    } else {
      // 手柄拖动：store 跟随手柄（TransformControls 直接改 object）
      const tp: Vec3Tuple = [t.position.x, t.position.y, t.position.z];
      if (distSq(tp, c.target) > 1e-10) {
        useIKStore.getState().setTarget(id, tp);
        lastRev.current = useIKStore.getState().chains[id]?.rev ?? lastRev.current + 1;
      }
      const pp: Vec3Tuple = [p.position.x, p.position.y, p.position.z];
      if (distSq(pp, c.polePoint) > 1e-10) {
        useIKStore.getState().setPolePoint(id, pp);
        lastRev.current = useIKStore.getState().chains[id]?.rev ?? lastRev.current + 1;
      }
    }
  });

  const c = useIKStore((s) => s.chains[id]);
  if (!c) return null;
  const midPos = useMidWorldPos(c.def.midBone);

  return (
    <group>
      <mesh ref={targetRef} position={c.target}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
      </mesh>
      <TransformControls object={targetRef as unknown as RefObject<THREE.Object3D>} mode="translate" size={0.7} />
      <mesh ref={poleRef} position={c.polePoint}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshBasicMaterial color="#fbbf24" depthTest={false} transparent opacity={0.9} />
      </mesh>
      <TransformControls object={poleRef as unknown as RefObject<THREE.Object3D>} mode="translate" size={0.5} />
      {midPos && <Line points={[midPos, c.polePoint]} color="#fbbf24" lineWidth={1} transparent opacity={0.6} />}
    </group>
  );
}

function useMidWorldPos(boneName: string): Vec3Tuple | null {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  // 订阅 rev/time，保证拖动时极向量线跟随
  const revs = useIKStore((s) => ORDER.map((id) => s.chains[id]?.rev ?? -1).join(','));
  const currentTime = useAnimationStore((s) => s.currentTime);
  return useMemo(() => {
    void revs;
    void currentTime;
    if (!sceneObject) return null;
    const b = sceneObject.getObjectByProperty('name', boneName) as THREE.Bone | undefined;
    if (!b || !(b as THREE.Bone).isBone) return null;
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return [v.x, v.y, v.z] as Vec3Tuple;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneObject, boneName, revs, currentTime]);
}

function distSq(a: Vec3Tuple, b: Vec3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
