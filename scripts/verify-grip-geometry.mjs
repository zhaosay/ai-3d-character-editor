/**
 * 双手握持在**真实运行的应用**里的几何验证。
 *
 * 动机：纯函数通过 ≠ 用户看得到效果。这里读运行时真实骨骼世界坐标，
 * 并对比开关两种状态，证明「开」确实驱动了 IK、「关」确实退回纯 FK。
 *
 * 用法：node scripts/verify-grip-geometry.mjs（需 vite dev，DEV 才有 __editor 钩子）
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const ok = (b) => (b ? '✓' : '✗');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

if (!(await page.evaluate(() => Boolean(window.__editor)))) {
  console.log('✗ 没有 __editor 钩子 —— 请对 vite dev(5173) 运行，本脚本不适用于 preview(4173)');
  await browser.close();
  process.exit(1);
}

// 加剑
await page.locator('.inspector-section > summary', { hasText: '场景与道具' }).click();
await page.waitForTimeout(300);
const add = page.getByRole('button', { name: '+ 剑' });
if (await add.count()) { await add.first().click(); await page.waitForTimeout(700); }

/** 读运行时几何：双手世界坐标 + 剑锚点世界坐标 */
const read = () => page.evaluate(() => {
  const E = window.__editor;
  const scene = E.character.getState().sceneObject;
  const sword = E.world.getState().props.find((p) => p.kind === 'sword');
  if (!scene || !sword) return null;
  const bones = E.skeleton.getState().snapshot;
  const byName = Object.values(bones?.nodes ?? {});
  const handOf = (sem) => {
    const n = byName.find((x) => x.semantic === sem);
    return n ? scene.getObjectByProperty('uuid', n.id) : null;
  };
  const handR = handOf('hand.R');
  const handL = handOf('hand.L');
  const hips = handOf('hips');
  if (!handR || !handL || !hips) return { error: '骨骼不全', found: byName.map((n) => n.semantic) };
  const wp = (o) => { o.updateWorldMatrix(true, false); const m = o.matrixWorld.elements; return [m[12], m[13], m[14]]; };
  const mainBone = sword.attachTo === 'hand.L' ? handL : handR;
  const anchors = E.swordAnchorsWorld(mainBone, sword);
  const v = (t) => [t.x, t.y, t.z];
  return {
    attachTo: sword.attachTo,
    Hand_R: wp(handR), Hand_L: wp(handL), Hips: wp(hips),
    grip: v(anchors.grip), pommel: v(anchors.pommel), tip: v(anchors.tip),
  };
});

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (v) => `[${v.map((n) => n.toFixed(3)).join(', ')}]`;

const snapshot = async (label, enabled) => {
  await page.evaluate((on) => window.__editor.grip.getState().setEnabled(on), enabled);
  await page.waitForTimeout(600); // 等若干帧 useFrame
  const d = await read();
  if (!d || d.error) { console.log(`  ${label}: 读不到 — ${d?.error ?? 'null'} ${JSON.stringify(d?.found ?? '')}`); return null; }
  const offHand = d.attachTo === 'hand.R' ? 'Hand_L' : 'Hand_R';
  return {
    label,
    d,
    handSpan: dist(d.Hand_R, d.Hand_L),
    offToPommel: dist(d[offHand], d.pommel),
    offToPommelAtGrip: dist(d[offHand], d.grip),
  };
};

console.log('\n=== 运行时真实几何（demo rig 臂长≈580mm，肩 x=±0.24）===');
const off = await snapshot('双手握持 IK = 关（纯 FK）', false);
const on = await snapshot('双手握持 IK = 开', true);

for (const s of [off, on].filter(Boolean)) {
  const o = s.d;
  console.log(`\n  ${s.label}`);
  console.log(`     Hand_R        ${fmt(o.Hand_R)}`);
  console.log(`     Hand_L        ${fmt(o.Hand_L)}`);
  console.log(`     剑 grip 点     ${fmt(o.grip)}`);
  console.log(`     剑 pommel 点   ${fmt(o.pommel)}`);
  console.log(`     双手间距       ${(s.handSpan * 1000).toFixed(0)} mm`);
  console.log(`     副手→柄尾      ${(s.offToPommel * 1000).toFixed(0)} mm`);
}

console.log('\n=== 判定 ===');
if (off && on) {
  const improved = on.offToPommel < off.offToPommel - 0.01;
  console.log(`  ${ok(improved)}  开启后副手更贴近柄尾：${(off.offToPommel * 1000).toFixed(0)}mm → ${(on.offToPommel * 1000).toFixed(0)}mm`);
  console.log(`  ${ok(on.offToPommel < 0.03)}  开启后副手到柄尾 < 30mm（${(on.offToPommel * 1000).toFixed(0)}mm）`);
  const spanOK = on.handSpan >= 0.05 && on.handSpan <= 0.20;
  console.log(`  ${ok(spanOK)}  开启后双手间距在真实握剑范围 50~200mm：${(on.handSpan * 1000).toFixed(0)}mm`);
  const mainHand = on.d.attachTo === 'hand.R' ? on.d.Hand_R : on.d.Hand_L;
  console.log(`  ${ok(mainHand[2] > 0.05)}  主手在身前 z=${mainHand[2].toFixed(3)}（护手位，非垂在体侧）`);
  const yGap = Math.abs(mainHand[1] - on.d.Hips[1]);
  console.log(`  ${ok(yGap < 0.6)}  主手与髋高度差 ${yGap.toFixed(3)}m（<0.6m）`);
} else {
  console.log('  ✗ 几何读取失败，验证不成立');
}

await browser.close();