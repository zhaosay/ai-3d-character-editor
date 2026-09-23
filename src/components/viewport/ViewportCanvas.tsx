import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useCharacterStore } from '../../stores/characterStore';
import { useViewportStore } from '../../stores/viewportStore';
import { FpsMeter, HighlightSync, SkeletonOverlay } from './SceneSync';
import { PlaybackEngine } from './PlaybackEngine';
import { IKHandles, IKSolver } from './IKHandles';

function CharacterPrimitive() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const [, force] = useState(0);
  useEffect(() => {
    force((x) => x + 1);
  }, [sceneObject]);
  if (!sceneObject) return null;
  return <primitive object={sceneObject} />;
}

export function ViewportCanvas() {
  const showGrid = useViewportStore((s) => s.showGrid);
  const shadows = useViewportStore((s) => s.shadows);
  const sceneObject = useCharacterStore((s) => s.sceneObject);

  return (
    <div className="relative h-full w-full bg-[#0b0d12]">
      <Canvas shadows={shadows} camera={{ position: [2.5, 1.8, 3.2], fov: 45 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b0d12']} />
        <hemisphereLight intensity={0.9} />
        <directionalLight
          position={[4, 6, 3]}
          intensity={1.6}
          castShadow={shadows}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        <Suspense fallback={null}>
          <CharacterPrimitive />
        </Suspense>
        {/* 地面 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[30, 30]} />
          <shadowMaterial opacity={0.35} />
        </mesh>
        {showGrid && (
          <Grid
            position={[0, 0.001, 0]}
            args={[30, 30]}
            cellColor="#2a2f3a"
            sectionColor="#3d4454"
            fadeDistance={25}
            infiniteGrid
          />
        )}
        <OrbitControls makeDefault target={[0, 1, 0]} />
        <FpsMeter />
        <PlaybackEngine />
        <IKSolver />
        <IKHandles />
        <HighlightSync sceneObject={sceneObject} />
        <SkeletonOverlay sceneObject={sceneObject} />
      </Canvas>
      {!sceneObject && <EmptyHint />}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="rounded bg-black/60 px-5 py-4 text-center text-sm text-zinc-300">
        <div className="text-base text-white">拖入 .glb 人物开始</div>
        <div className="mt-1 text-xs text-zinc-400">或点左侧「示例男/女角色」直接试玩</div>
        <div className="mt-1 text-xs text-zinc-400">支持 Orbit 旋转 / 右键平移 / 滚轮缩放</div>
      </div>
    </div>
  );
}

export function disposeHelper(h: THREE.SkeletonHelper | null, scene: THREE.Scene) {
  if (h) {
    scene.remove(h);
    (h.geometry as THREE.BufferGeometry)?.dispose();
  }
}
