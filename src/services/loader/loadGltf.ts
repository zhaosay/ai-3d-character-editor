import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import type { CharacterMeta } from '../../types/global';

export interface LoadedCharacter {
  scene: THREE.Group;
  meta: CharacterMeta;
  dispose: () => void;
}

const loader = new GLTFLoader();

/** 可加载的远程地址：http(s) 且路径以 .glb 结尾（允许 ?pose=T 等查询参数）。 */
export function isLoadableUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return /\.glb$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * 从 URL 下载 GLB 后走同一加载管线（定标/居中/统计）。
 * 远端示例：Ready Player Me 自建真人（demo.readyplayer.me 免费创建后粘贴链接）。
 */
export async function loadGltfUrl(rawUrl: string): Promise<LoadedCharacter> {
  const url = rawUrl.trim();
  if (!isLoadableUrl(url)) {
    throw new Error('请输入以 .glb 结尾的 http(s) 链接（RPM 链接形如 https://models.readyplayer.me/xxx.glb）');
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('下载失败：网络不通或对方服务器拒绝跨域（可下载后拖入加载）');
  }
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}（链接失效、无权限或需登录）`);
  }
  const blob = await res.blob();
  if (blob.size < 1024) throw new Error('下载内容过小，可能不是有效 GLB');
  if (blob.size > 200 * 1024 * 1024) throw new Error('文件超过 200MB 上限');
  const base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'remote.glb');
  const name = /\.glb$/i.test(base) ? base : `${base}.glb`;
  return loadGltfFile(new File([blob], name, { type: 'model/gltf-binary' }));
}

/** 加载本地 GLB/GLTF 文件，自动定标到 ~1.7m 并居中到原点。 */
export async function loadGltfFile(file: File): Promise<LoadedCharacter> {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    throw new Error(`不支持的文件类型: ${file.name}（仅支持 .glb / .gltf）`);
  }
  if (file.size > 200 * 1024 * 1024) {
    throw new Error('文件超过 200MB 上限');
  }
  return loadGltfBytes(await file.arrayBuffer(), file.name, file.size);
}

/** 从内存字节解析（URL 下载与文件共用同一管线；单文件 .gltf 需内嵌缓冲）。 */
export function loadGltfBytes(data: ArrayBuffer, name: string, size: number): Promise<LoadedCharacter> {
  return new Promise<LoadedCharacter>((resolve, reject) => {
    loader.parse(
      data,
      '',
      (gltf) => {
        try {
          resolve(finishLoaded(gltf.scene ?? null, gltf.animations?.length ?? 0, name, size));
        } catch (e) {
          reject(e instanceof Error ? e : new Error('GLB 解析失败'));
        }
      },
      (e) => reject(e instanceof Error ? e : new Error('GLB 解析失败')),
    );
  });
}

function finishLoaded(
  input: THREE.Object3D | null,
  animCount: number,
  name: string,
  size: number,
): LoadedCharacter {
  const scene = (input ?? new THREE.Group()) as THREE.Group;

    // 定标 + 居中
    const box = new THREE.Box3().setFromObject(scene);
    const dims = new THREE.Vector3();
    box.getSize(dims);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const height = Math.max(dims.y, 0.0001);
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
      fileName: name,
      fileSize: size,
      gltfInfo: {
        meshes,
        materials,
        bones,
        hasSkin: bones > 0,
        hasAnimations: animCount,
      },
    };

    const dispose = () => {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
        }
      });
    };

    return { scene, meta, dispose };
  }
