import { useCharacterStore } from '../../stores/characterStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useIKStore } from '../../stores/ikStore';
import { useWorldStore } from '../../stores/worldStore';
import { useWeaponGripStore } from '../../stores/weaponGripStore';
import { useAnimationStore } from '../../stores/animationStore';
import { useMaterialStore } from '../../stores/materialStore';
import { solveHeldSwordGrip } from './applyHeldGrip';
import { swordAnchorsWorld } from './grip';

/**
 * 开发期调试钩子：把 store 与几个纯函数挂到 `window.__editor`。
 *
 * ## 为什么需要
 *
 * 布局与姿态的验证必须读**运行时真实状态**（骨骼世界坐标、剑的实际落点），
 * 否则只能验证纯函数 —— 而纯函数通过并不代表用户在浏览器里看得到效果。
 * 参照 avatar-stage 的 `?debug` 做法。
 *
 * ## 安全性
 *
 * 仅在 `import.meta.env.DEV` 下**动态 import**，因此不会进生产包，
 * 生产环境 `window.__editor` 恒为 undefined。
 */
export function installDebugHooks(): void {
  const w = window as unknown as Record<string, unknown>;
  w['__editor'] = {
    character: useCharacterStore,
    skeleton: useSkeletonStore,
    ik: useIKStore,
    world: useWorldStore,
    grip: useWeaponGripStore,
    animation: useAnimationStore,
    material: useMaterialStore,
    solveHeldSwordGrip,
    swordAnchorsWorld,
  };
}