#!/usr/bin/env node
/**
 * 从 toolCatalog.ts 生成 mcp/tools.schema.json（MCP server 与 editor_help 的数据源）。
 *
 * 为什么单独生成：MCP server 是纯 Node 进程，无法 import 本项目的 TS 模块
 * （内部为 bundler 风格导入）。构建期把目录「编译」成 JSON，两侧共用一份真相源，
 * 避免参数说明与 handler 漂移。
 *
 * 运行：node scripts/genToolSchemas.mjs   （prebuild 自动执行）
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'mcp');
const OUT = join(OUT_DIR, 'tools.schema.json');

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import(join(ROOT, 'src/services/agent/toolCatalog.ts'));

const payload = {
  // 供 humans / editor 直接阅读的纯文本（editor_help 返回它）
  helpText: buildHelpText(mod.TOOL_DOCS, mod.TOOL_DOC_NAMES),
  // 供 MCP tools/list 下发的精简 schema
  tools: mod.briefSchemas(),
  // 全文文档（按需拉取单个工具）
  docs: mod.TOOL_DOC_NAMES.map((n) => mod.TOOL_DOCS[n]),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`genToolSchemas: ${payload.tools.length} 工具 → mcp/tools.schema.json`);

function buildHelpText(docs, names) {
  const lines = [
    '# 编辑器工具全集（全文契约）',
    '',
    '所有工具都支持 `idempotencyKey`（相同 key 重复调用只生效一次）。写操作进历史栈，可撤销。',
    '',
    '## 工具',
  ];
  for (const n of names) {
    const d = docs[n];
    lines.push(`### \`${d.name}\` — ${d.summary}${d.mutates ? '' : '（只读）'}`);
    if (d.detail) lines.push('', d.detail);
    if (d.params.length > 0) {
      lines.push('', '参数：');
      for (const p of d.params) {
        const bits = [`- \`${p.name}\`: ${p.type}${p.required ? '（必填）' : ''} — ${p.desc}`];
        if (p.values) bits.push(`  取值：${p.values.join(' / ')}`);
        if (p.example !== undefined) bits.push(`  例：${JSON.stringify(p.example)}`);
        lines.push(bits.join('\n'));
      }
    } else {
      lines.push('', '无参数。');
    }
    if (d.errors?.length) lines.push('', `错误码：${d.errors.join(' / ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
