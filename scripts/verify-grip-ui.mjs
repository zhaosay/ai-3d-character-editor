/**
 * 双手握持开关的端到端验证。
 *
 * 目的：证明这个功能**真的能被用户用到**，而不只是单测里存在。
 * 之前实测发现两个缺口：无 UI 入口、无持久化，且默认场景没有剑所以永不触发。
 *
 * 校验链：加剑 → 展开「场景与道具」→ 看到开关 → 切换 → 存盘 → 读回。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const OUT = '/tmp/grip-proof.png';
const DL = '/tmp/grip-download';

const ok = (b) => (b ? '✓ 通过' : '✗ 失败');
const shot = await chromium.launch({ downloadsPath: DL });
const ctx = await shot.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

const checks = [];

// 1) 首屏已自动载入角色（第 2 步）
const bones = await page.evaluate(() => document.body.innerText.match(/(\d+) bones/)?.[1] ?? null);
checks.push(['首屏自动载入角色', Boolean(bones) && Number(bones) > 0, bones ? `${bones} 根骨骼` : '未载入']);

// 2) 手绘捏人默认收起（第 3 步）
const sketchCollapsed = await page.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('手绘捏人'));
  return el ? el.textContent.includes('▸') : null;
});
checks.push(['手绘捏人默认收起', sketchCollapsed === true, `▸=${sketchCollapsed}`]);

// 3) Inspector 折叠分组取代标签页（第 1 步）
const groups = await page.evaluate(() =>
  [...document.querySelectorAll('.inspector-section > summary')].map((s) => s.textContent?.trim().replace(/[›▾]/g, '').trim()));
checks.push(['Inspector 用折叠分组', groups.length >= 8, `${groups.length} 组：${groups.join(' / ')}`]);
const noTabs = await page.evaluate(() => document.querySelectorAll('.editor-inspector-tabs').length === 0);
checks.push(['标签页已移除', noTabs, noTabs ? '0 个 tablist' : '仍有标签页']);

// 4) 展开「场景与道具」并加剑
const sceneSummary = page.locator('.inspector-section > summary', { hasText: '场景与道具' });
await sceneSummary.click();
await page.waitForTimeout(300);
const addBtn = page.getByRole('button', { name: '+ 剑' });
if (await addBtn.count()) { await addBtn.first().click(); await page.waitForTimeout(600); }
const swordVisible = await page.evaluate(() => document.body.innerText.includes('训练剑'));
checks.push(['可添加训练剑', swordVisible, swordVisible ? '已添加' : '未找到 + 剑 按钮']);

// 5) 双手握持开关存在且默认开
const cb = page.locator('input[type=checkbox]').first();
const exists = await cb.count();
const defaultOn = exists ? await cb.isChecked() : false;
checks.push(['双手握持开关存在', exists > 0, exists ? '找到 checkbox' : '缺失']);
checks.push(['默认开启', defaultOn, `checked=${defaultOn}`]);

// 6) 切到关闭，状态真的变了
if (exists) {
  await cb.setChecked(false);
  await page.waitForTimeout(300);
  const nowChecked = await cb.isChecked();
  const hint = await page.evaluate(() => document.body.innerText.includes('退回纯关键帧驱动'));
  checks.push(['可切换为关闭', nowChecked === false, `切换后 checked=${nowChecked}`]);
  checks.push(['关闭时说明文案同步', hint, hint ? '已提示退回纯关键帧' : '文案未变']);
  await page.screenshot({ path: OUT });

  // 7) 存盘 → 读回
  await cb.setChecked(true);
  await page.waitForTimeout(200);
  const dl = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = await dl[0].path();
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const saved = json?.settings?.twoHandGrip;
  checks.push(['存盘写入 twoHandGrip', saved === true, `project.json settings.twoHandGrip=${saved}`]);
} else {
  await page.screenshot({ path: OUT });
}

console.log('\n=== 双手握持 UI 端到端验证 ===');
for (const [name, pass, detail] of checks) console.log(`  ${ok(pass)}  ${name.padEnd(22)} ${detail}`);
console.log(`\n  未捕获异常: ${errs.length === 0 ? '✓ 无' : `✗ ${errs.length}`}`);
errs.slice(0, 3).forEach((e) => console.log(`    · ${e.slice(0, 140)}`));
console.log(`  截图: ${OUT}`);

await shot.close();
process.exit(checks.every(([, p]) => p) ? 0 : 1);