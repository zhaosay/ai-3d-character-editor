import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useCharacterStore } from '../../stores/characterStore';
import { useViewportStore } from '../../stores/viewportStore';
import { FpsMeter, HighlightSync, SkeletonOverlay, EnvAndTone } from './SceneSync';
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
  const gridSize = useViewportStore((s) => s.gridSize);
  const gridCell = useViewportStore((s) => s.gridCell);
  const gridSection = useViewportStore((s) => s.gridSection);
  const shadowOpacity = useViewportStore((s) => s.shadowOpacity);
  const keyIntensity = useViewportStore((s) => s.keyIntensity);
  const fillIntensity = useViewportStore((s) => s.fillIntensity);
  const rimIntensity = useViewportStore((s) => s.rimIntensity);
  const hemiIntensity = useViewportStore((s) => s.hemiIntensity);
  const sceneObject = useCharacterStore((s) => s.sceneObject);

  return (
    <div className="relative h-full w-full bg-white">
      <Canvas shadows={shadows} camera={{ position: [2.5, 1.8, 3.2], fov: 45 }} dpr={[1, 2]}>
        <color attach="background" args={['#ffffff']} />
        <hemisphereLight intensity={hemiIntensity} />
        {/* 主光（投影） */}
        <directionalLight
          position={[3.5, 5, 2.5]}
          intensity={keyIntensity}
          castShadow={shadows}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        {/* 补光（左侧弱） */}
        <directionalLight position={[-4, 2, 1.5]} intensity={fillIntensity} />
        {/* 轮廓光（脑后） */}
        <directionalLight position={[-1.5, 3.5, -4]} intensity={rimIntensity} />
        <EnvAndTone />
        <Suspense fallback={null}>
          <CharacterPrimitive />
        </Suspense>
        {/* 地面 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[30, 30]} />
          <shadowMaterial opacity={shadowOpacity} />
        </mesh>
        {showGrid && (
          <Grid
            position={[0, 0.001, 0]}
            args={[gridSize, gridSize]}
            cellColor={gridCell}
            sectionColor={gridSection}
            fadeDistance={gridSize * 0.8}
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
      <div className="rounded bg-white/90 px-5 py-4 text-center text-sm text-zinc-600 ring-1 ring-zinc-200">
        <div className="text-base text-zinc-900">拖入 .glb 人物开始</div>
        <div className="mt-1 text-xs text-zinc-600">或点左侧「示例男/女角色」直接试玩</div>
        <div className="mt-1 text-xs text-zinc-600">支持 Orbit 旋转 / 右键平移 / 滚轮缩放</div>
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
