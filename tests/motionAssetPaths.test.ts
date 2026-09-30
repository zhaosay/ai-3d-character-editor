import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 动作库资源路径回归测试。
 *
 * 曾经的 bug：路径写成相对 `motions/...`，在浏览器里解析成 `/motions/...`，
 * 该路径不存在 → dev server 走 SPA fallback 返回 **index.html（200 text/html）**
 * → 报 `Unexpected token '<'`（把 `<!doctype html>` 当 JSON 解析）。
 *
 * 这个测试锁住「代码里写的路径」与「public 下真实文件」一致。
 */
const ROOT = resolve(__dirname, '..');
const SOURCES = [
  'src/services/motion/motionRetarget.ts',
  'src/services/motion/motionLibrary.ts',
];

describe('动作库资源路径', () => {
  it('源码里不含会命中 SPA fallback 的裸相对路径', () => {
    for (const rel of SOURCES) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      // 形如 `'motions/...` 或 `${BASE}motions/...`（缺 samples/）都会 404→HTML。
      // 只看真正的 URL 字面量，避开注释里的散文字符串。
      const bare = /['"`](?:\$\{[^}]*\})?motions\//.exec(src);
      expect(bare, `${rel} 出现了会命中 SPA fallback 的裸路径 ${bare?.[0]}`).toBeNull();
      expect(src, `${rel} 应使用 samples/motions/`).toMatch(/samples\/motions\//);
    }
  });

  it('public 下确实存在被引用的文件', () => {
    for (const f of ['humanoid-v1.json', 'humanoid-v1-manifest.json']) {
      expect(existsSync(resolve(ROOT, 'public/samples/motions', f)), `缺少 ${f}`).toBe(true);
    }
  });

  it('manifest 是合法 JSON（不是被截断或包了 HTML）', () => {
    const text = readFileSync(resolve(ROOT, 'public/samples/motions/humanoid-v1-manifest.json'), 'utf8');
    expect(text.trimStart().startsWith('<')).toBe(false);
    const parsed = JSON.parse(text) as { presets?: unknown[] };
    expect(Array.isArray(parsed.presets)).toBe(true);
    expect((parsed.presets ?? []).length).toBeGreaterThan(0);
  });

  it('读取 JSON 时能识别 HTML 响应并给出可诊断错误', () => {
    const src = readFileSync(resolve(ROOT, 'src/services/motion/motionRetarget.ts'), 'utf8');
    expect(src).toContain('text/html');
    expect(src).toContain('不是合法 JSON');
  });
});
