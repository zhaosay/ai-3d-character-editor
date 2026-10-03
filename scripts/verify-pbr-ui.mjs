/**
 * PBR 面板端到端验证。
 *
 * 背景：守卫曾只比较 scene.uuid，导致首次施加之后所有滑块改动被吞掉
 * —— 面板动了、画面不动。纯 store 单测也曾全绿。
 * 这里在真实页面里改 override，然后直接读 three 材质对象的 metalness。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const ok = (b) => (b ? '✓ 通过' : '✗ 失败');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const checks = [];
const hasHook = await page.evaluate(() => Boolean(window.__editor));
checks.push(['DEV 调试钩子可用', hasHook, hasHook ? 'window.__editor 存在' : '缺失（需 vite dev）']);
if (!hasHook) { console.log(checks.map(([n,p,d])=>`  ${ok(p)}  ${n}  ${d}`).join('\n')); await browser.close(); process.exit(1); }

// 打开「材质与外观」分组
await page.locator('.inspector-section > summary', { hasText: '材质与外观' }).click();
await page.waitForTimeout(500);

// 直接改一个材质的 metalness，等一帧，再从 three 对象读回
const result = await page.evaluate(async () => {
  const E = window.__editor;
  const scene = E.character.getState().sceneObject;
  const st = () => E.material.getState();
  // 找一个真实材质路径
  const mods = await import('/src/core/material/pbr.ts');
  const list = mods.listMaterials(scene);
  if (!list.length) return { error: '场景里没有材质' };
  const path = list[0].path;
  const before = mods.findMaterialByPath(scene, path).metalness;
  st().setOverride(path, { metalness: 0.87 });
  // 模拟 MaterialPanel 的 effect：overrides 变化后重新 applyTo
  const applied = st().applyTo(scene);
  const after = mods.findMaterialByPath(scene, path).metalness;
  return { path, before, after, applied };
});

if (result.error) {
  checks.push(['PBR 滑块生效', false, result.error]);
} else {
  checks.push(['PBR 滑块真的改到材质', Math.abs(result.after - 0.87) < 1e-6, `${result.path}: metalness ${result.before} → ${result.after}（applyTo 返回 ${result.applied}）`]);
  checks.push(['改动后 applyTo 不早退', result.applied === 1, `返回 ${result.applied}（修前为 0）`]);
}

console.log('\n=== PBR 面板端到端验证 ===');
for (const [n,p,d] of checks) console.log(`  ${ok(p)}  ${n.padEnd(24)} ${d}`);
await browser.close();
process.exit(checks.every(([,p])=>p) ? 0 : 1);
