import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import type { CharacterMeta } from '../../types/global';

export interface LoadedCharacter {
  scene: THREE.Group;
  meta: CharacterMeta;
  dispose: () => void;
}

const loader = new GLTFLoader();

/** 加载本地 GLB/GLTF 文件（ObjectURL），自动定标到 ~1.7m 并居中到原点。 */
export async function loadGltfFile(file: File): Promise<LoadedCharacter> {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    throw new Error(`不支持的文件类型: ${file.name}（仅支持 .glb / .gltf）`);
  }
  if (file.size > 200 * 1024 * 1024) {
    throw new Error('文件超过 200MB 上限');
  }
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const scene = (gltf.scene ?? new THREE.Group()) as THREE.Group;

    // 定标 + 居中
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const height = Math.max(size.y, 0.0001);
    const scale = 1.7 / height;
    scene.scale.setScalar(scale);
    scene.position.sub(center.clone().multiplyScalar(scale));
    // 让脚底 y=0：重新算包围盒后抬升
    scene.updateWorldMatrix(true, true);
    const box2 = new THREE.Box3().setFromObject(scene);
    scene.position.y -= box2.min.y;

    let meshes = 0;
    let materials = 0;
    let bones = 0;
    const matSet = new Set<string>();
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        const m = (o as THREE.Mesh).material;
        const arr = Array.isArray(m) ? m : m ? [m] : [];
        arr.forEach((mm) => {
          if (!matSet.has(mm.uuid)) {
            matSet.add(mm.uuid);
            materials++;
          }
        });
        (o as THREE.Mesh).castShadow = true;
        (o as THREE.Mesh).receiveShadow = true;
      }
      if ((o as THREE.Bone).isBone) bones++;
    });

    const meta: CharacterMeta = {
      id: `char_${Date.now()}`,
      fileName: file.name,
      fileSize: file.size,
      gltfInfo: {
        meshes,
        materials,
        bones,
        hasSkin: bones > 0,
        hasAnimations: (gltf.animations?.length ?? 0),
      },
    };

    const dispose = () => {
      URL.revokeObjectURL(url);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
        }
      });
    };

    return { scene, meta, dispose };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e instanceof Error ? e : new Error('GLB 解析失败');
  }
}
