import * as THREE from 'three';

/**
 * 内置微型摄影棚环境（免外部 HDR 文件）：顶柔光 + 暖/冷侧条，
 * 供 PMREM 生成 scene.environment。纯场景构造，无需 renderer，可单测。
 */
export function buildPreviewEnv(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);

  const panel = (
    w: number,
    h: number,
    color: [number, number, number],
    pos: [number, number, number],
    lookAtOrigin = true,
  ) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(...color), side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    if (lookAtOrigin) m.lookAt(0, 1, 0);
    scene.add(m);
  };

  panel(9, 9, [5.0, 5.0, 5.0], [0, 5.5, 0]); // 顶柔光
  panel(2.5, 7, [3.0, 1.8, 1.2], [-4.5, 2, 0.5]); // 左暖
  panel(2.5, 7, [1.2, 1.8, 3.0], [4.5, 2, 0.5]); // 右冷
  panel(6, 2, [0.5, 0.5, 0.55], [0, 1.2, 5]); // 正面微补
  return scene;
}
