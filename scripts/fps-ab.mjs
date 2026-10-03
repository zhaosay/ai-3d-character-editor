/**
 * 对照实验：在同一页面里开关 backdrop-filter，实测 FPS 差异。
 *
 * 动机：把 Inspector 从悬浮改为停靠时，截图里 FPS 从 17 变成 51。
 * 单次读数不足以断言「去掉 backdrop-blur 提速 N 倍」，
 * 所以在同一页面、同一角色、同一帧率下直接 A/B。
 *
 * 用法：node scripts/fps-ab.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';

const sampleFps = (page, ms = 3000) => page.evaluate((dur) => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    else resolve(Math.round((frames * 1000) / (performance.now() - t0)));
  };
  requestAnimationFrame(tick);
}), ms);

const shot = await chromium.launch();
const page = await shot.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const hudFps = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => /^FPS\s+\d+$/.test(d.textContent?.trim() ?? ''));
  return el ? el.textContent.trim() : null;
});

console.log('\n=== 载入示例角色（避开空场景的渲染负载差异）===');
const loadBtn = page.getByRole('button', { name: '男性 · 短发' });
if (await loadBtn.count()) { await loadBtn.first().click(); await page.waitForTimeout(3000); }

console.log('\n=== A/B：同一页面开关 backdrop-filter ===');
const runs = [];
for (const label of ['停靠（当前，无 backdrop-filter）', '悬浮 + backdrop-filter']) {
  await page.evaluate((blur) => {
    const el = document.querySelector('.editor-inspector');
    if (!el) return;
    el.style.backdropFilter = blur ? 'blur(24px)' : '';
    el.style.background = blur ? 'rgba(255,255,255,0.9)' : '';
    el.style.borderRadius = blur ? '16px' : '';
  }, label.includes('悬浮'));
  await page.waitForTimeout(1200);
  const fps = await sampleFps(page);
  runs.push({ label, fps });
  console.log(`  ${label.padEnd(30)} ${fps} FPS`);
}

console.log('\n=== 3D 视口自身（不含面板）的基准 ===');
await page.evaluate(() => {
  const el = document.querySelector('.editor-inspector');
  if (el) { el.style.backdropFilter = ''; el.style.background = ''; el.style.borderRadius = ''; }
});
await page.waitForTimeout(800);
console.log(`  视口独立渲染: ${await sampleFps(page)} FPS`);
console.log(`  HUD 读数: ${await hudFps()}`);

console.log(`\n=== 结论 ===`);
console.log(`  backdrop-filter 开: ${runs[1].fps} FPS / 关: ${runs[0].fps} FPS`);
console.log(`  差值: ${runs[1].fps - runs[0].fps > 0 ? '+' : ''}${runs[1].fps - runs[0].fps} FPS（${runs[0].fps ? Math.round((runs[1].fps / runs[0].fps) * 100) : '—'}%）`);

await shot.close();