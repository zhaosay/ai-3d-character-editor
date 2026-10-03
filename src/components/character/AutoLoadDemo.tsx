import { useEffect } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { activateCharacter } from './activateCharacter';
import { buildDemoCharacter } from '../../services/demo/buildDemoCharacter';

/** 延后多久再决定是否自动装载。给「打开项目」留出抢跑窗口。 */
const DEFER_MS = 350;

/**
 * 首屏自动装载示例角色。
 *
 * ## 为什么
 *
 * 实测首屏（1440×900）：视口 893×685 全是空的，只有一句「拖入 .glb 人物开始」，
 * 左栏还有个空的「手绘捏人 0/8 关节」——**约 60% 屏幕没有任何可看的东西**，
 * 用户必须先知道「要点左栏某个蓝绿色按钮」才能开始。
 *
 * 示例角色由 `buildDemoCharacter()` **纯程序化生成**（不下载任何资源），
 * 所以首屏装载没有网络依赖，也不会闪 loading。
 *
 * ## 为什么要延后并二次检查
 *
 * 「Open」项目 / 拖入 .glb 都可能在挂载后立刻发生。若不检查就装载，
 * 会出现「示例角色闪一下又被项目角色顶掉」。因此：
 *   1. 延后 DEFER_MS，避开挂载瞬间的用户操作
 *   2. 真正装载前再查一次 `characterStore.meta` —— 已有角色则放弃
 *   3. 组件卸载时取消定时器
 */
export function AutoLoadDemo() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // 二次检查：可能已经被「打开项目」或拖入文件填上了
      if (useCharacterStore.getState().meta) return;
      const demo = buildDemoCharacter('male');
      activateCharacter(demo.meta, demo.scene, demo.dispose);
    }, DEFER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}