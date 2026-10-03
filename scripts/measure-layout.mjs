/**
 * 布局实测脚本（不是目测，是读浏览器里元素的几何盒）。
 *
 * 用法：node scripts/measure-layout.mjs
 * 需要先 `npm run dev`（脚本自己会拉起到 4173）。
 *
 * 目的是把「视口被遮挡多少」「左右栏是否等宽」这类断言变成可复现的数字，
 * 避免以后改样式时靠肉眼判断。
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const OUT = process.env.OUT ?? '/tmp/layout-proof.png';

const shot = await chromium.launch();
const page = await shot.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const box = async (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

// 3D 视口的 canvas 在 main > div 里；左栏 SketchRig 也有 canvas，
// 必须按结构定位，否则会量到 2D 骨架草图（实测 257×334 就是它）。
const canvas = await page.evaluate(() => {
  const main = document.querySelector('.editor-main-layout > main');
  const el = main && main.querySelector('canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
const inspector = await box('.editor-inspector');
const sidebar = await box('.editor-sidebar');
const shell = await box('.editor-shell');

// 悬浮面板的判定特征：position 不是 static/relative（即脱离文档流压在画面上）
const floating = await page.evaluate(() => {
  const el = document.querySelector('.editor-inspector');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { position: cs.position, backdropFilter: cs.backdropFilter, borderRadius: cs.borderRadius };
});

await page.screenshot({ path: OUT });

const rows = [
  ['视口 canvas', canvas],
  ['左侧栏 .editor-sidebar', sidebar],
  ['右侧栏 .editor-inspector', inspector],
];
console.log('\n=== 1440×900 实测几何 ===');
for (const [k, v] of rows) console.log(`  ${k.padEnd(28)} ${v ? `x=${v.x} w=${v.w} h=${v.h}` : '（未找到）'}`);

const overlap = (() => {
  if (!canvas || !inspector) return null;
  // 水平重叠量 = 两矩形在 x 上的交集
  const lo = Math.max(canvas.x, inspector.x);
  const hi = Math.min(canvas.x + canvas.w, inspector.x + inspector.w);
  return Math.max(0, hi - lo);
})();

console.log('\n=== 判定 ===');
console.log(`  左右栏等宽: ${sidebar && inspector ? (Math.abs(sidebar.w - inspector.w) === 0 ? '✓ 通过' : `✗ 差 ${Math.abs(sidebar.w - inspector.w)}px`) : '—'}`);
console.log(`  Inspector position: ${floating?.position} ${floating?.position === 'absolute' ? '✗ 悬浮遮挡画面' : floating?.position === 'static' ? '✓ 停靠，不遮挡' : ''}`);
console.log(`  backdrop-filter: ${floating?.backdropFilter} ${floating?.backdropFilter && floating.backdropFilter !== 'none' ? '✗ 3D 画面上做模糊（性能+噪点）' : '✓ 无'}`);
console.log(`  画布水平重叠: ${overlap === null ? '—' : overlap === 0 ? `✓ 0px（零遮挡）` : `✗ ${overlap}px 被盖住（占画布 ${(overlap / canvas.w * 100).toFixed(0)}%）`}`);

if (shell && canvas) {
  const cx = canvas.x + canvas.w / 2;
  console.log(`  画布中心 x=${Math.round(cx)} / 屏幕中心 x=${Math.round(shell.w / 2)} → 偏移 ${Math.round(cx - shell.w / 2)}px`);
}
console.log(`\n  控制台错误: ${errors.length === 0 ? '✓ 无' : `✗ ${errors.length} 条`}`);
errors.slice(0, 5).forEach((e) => console.log(`    · ${e.slice(0, 160)}`));
console.log(`\n  截图: ${OUT}`);

await shot.close();