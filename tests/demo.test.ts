import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter, GLTFLoader } from 'three-stdlib';
import { buildDemoCharacter, type DemoGender } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { createEmptyAnimation } from '../src/core/animation/types';
import { toThreeClip } from '../src/core/animation/toThreeClip';

const Q0: [number, number, number, number] = [0, 0, 0, 1];
const Q90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function exportBinary(scene: THREE.Group): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (r) => resolve(r as ArrayBuffer),
      (e) => reject(e instanceof Error ? e : new Error(String(e))),
      { binary: true },
    );
  });
}

function importGltf(buf: ArrayBuffer): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      buf,
      '',
      (gltf) => resolve(gltf.scene as THREE.Group),
      (e) => reject(e instanceof Error ? e : new Error(String(e))),
    );
  });
}

describe.each([['male'], ['female']] as Array<[DemoGender]>)('demo character (%s)', (gender) => {
  it('17 骨骼且语义全映射', () => {
    const { scene, meta } = buildDemoCharacter(gender);
    const snap = buildSkeletonTree(scene);
    expect(snap.boneCount).toBe(17);
    const unmapped = Object.values(snap.nodes).filter((n) => !n.semantic);
    expect(unmapped).toEqual([]);
    expect(meta.gltfInfo.hasSkin).toBe(true);
    expect(meta.fileName).toMatch(gender === 'female' ? /female/ : /male/);
  });

  it('站立地面：脚底 y≈0，身高约 1.74', () => {
    const { scene } = buildDemoCharacter(gender);
    const box = new THREE.Box3().setFromObject(scene);
    expect(box.min.y).toBeCloseTo(0, 2);
    expect(box.max.y - box.min.y).toBeCloseTo(1.74, 1);
  });

  it('IK 检测出 4 链', () => {
    const { scene } = buildDemoCharacter(gender);
    const ids = detectIKChains(buildSkeletonTree(scene)).map((c) => c.id).sort();
    expect(ids).toEqual(['arm.L', 'arm.R', 'leg.L', 'leg.R']);
  });
});

describe('demo 男女体型差异', () => {
  it('女肩窄臀宽，男肩宽臀窄（骨骼世界坐标）', () => {
    const male = buildSkeletonTree(buildDemoCharacter('male').scene);
    const female = buildSkeletonTree(buildDemoCharacter('female').scene);
    const wx = (snap: typeof male, name: string) => {
      const n = Object.values(snap.nodes).find((x) => x.name === name)!;
      return Math.abs(n.world.position[0]);
    };
    // 肩：男 0.26 > 女 0.21
    expect(wx(male, 'UpperArm_L')).toBeCloseTo(0.26, 3);
    expect(wx(female, 'UpperArm_L')).toBeCloseTo(0.21, 3);
  });

  it('女版网格更多（长发/发髻/胸型），男女文件名不同', () => {
    const m = buildDemoCharacter('male');
    const f = buildDemoCharacter('female');
    expect(f.meta.gltfInfo.meshes).toBeGreaterThan(m.meta.gltfInfo.meshes);
    expect(f.meta.fileName).not.toBe(m.meta.fileName);
    m.dispose();
    f.dispose();
  });
});

describe.each([['male'], ['female']] as Array<[DemoGender]>)('demo 蒙皮 (%s)', (gender) => {
  it('单 Skeleton 共享 + 权重归一化', () => {
    const { scene } = buildDemoCharacter(gender);
    const skins: THREE.SkinnedMesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skins.push(o as THREE.SkinnedMesh);
    });
    expect(skins.length).toBeGreaterThan(10);
    const skel = skins[0].skeleton;
    for (const m of skins) {
      expect(m.skeleton).toBe(skel);
      const w = m.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
      for (let i = 0; i < w.count; i++) {
        expect(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i)).toBeCloseTo(1, 5);
      }
    }
    expect(skel.bones.length).toBe(17);
  });
});

describe('demo GLB 往返', () => {

  it('GLB 往返：骨骼保留 + 动画可驱动', async () => {
    const demo = buildDemoCharacter('male');
    const buf = await exportBinary(demo.scene);
    expect(buf.byteLength).toBeGreaterThan(1000);
    const imported = await importGltf(buf);
    const snap = buildSkeletonTree(imported);
    expect(snap.boneCount).toBe(17);
    const names = Object.values(snap.nodes).map((n) => n.name);
    for (const n of ['Hips', 'UpperArm_L', 'Foot_R', 'Head']) {
      expect(names).toContain(n);
    }

    const anim = createEmptyAnimation('Wave', 30, 2);
    anim.tracks.push({
      boneName: 'UpperArm_L',
      position: [],
      rotation: [
        { time: 0, value: Q0, interp: 'linear' },
        { time: 2, value: Q90, interp: 'linear' },
      ],
      scale: [],
    });
    const { clip } = toThreeClip(anim);
    const mixer = new THREE.AnimationMixer(imported);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.update(1);
    const bone = imported.getObjectByProperty('name', 'UpperArm_L') as THREE.Bone;
    expect(bone.quaternion.w).toBeLessThan(0.99);
    action.stop();
    mixer.uncacheClip(clip);
    demo.dispose();
  }, 30000);
});
