#!/usr/bin/env node
/**
 * MCP server — 让外部 Agent（Codex / Claude Code 等）操作本编辑器。
 *
 * 架构：MCP（Node）→ HTTP → 编辑器内置桥接（浏览器内执行）
 *   工具执行必须发生在**持有场景状态的浏览器**里，所以本进程只做协议转换：
 *     MCP tools/call → POST /bridge/execute → 前端执行 → 结果回传
 *   沿用 DirectorDesk 的三重防护：Host 头校验（防 DNS rebinding）、
 *     Origin 白名单、Bearer token 常量时间比较。
 *
 * 用法：
 *   MCP_TOKEN=<64位hex> EDITOR_BRIDGE=http://127.0.0.1:5173 node mcp/server.mjs
 *   node mcp/stdio-bridge.mjs       # 给 Claude Desktop 的 stdio 转发
 *
 * 前端桥接开启方式见 README「Agent 桥接 / MCP」。
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

const PORT = Number(process.env.MCP_PORT ?? 7331);
const BRIDGE = process.env.EDITOR_BRIDGE ?? 'http://127.0.0.1:5173';
const TOKEN = process.env.MCP_TOKEN ?? randomBytes(32).toString('hex');
/**
 * 转发给后端 FastAPI 桥接的令牌。必须与后端的 BRIDGE_TOKEN、后端看到的
 * 前端 VITE_BRIDGE_TOKEN 三者一致，否则 /bridge/* 会 401/503。
 */
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? '';

/**
 * 工具契约来自 mcp/tools.schema.json（由 scripts/genToolSchemas.mjs 从
 * src/services/agent/toolCatalog.ts 生成）。MCP 进程是纯 Node、无法 import
 * 本项目 TS 模块，故在构建期把目录导出为 JSON —— 与 handler 共用同一真相源。
 */
function loadSchemas() {
  const url = new URL('./tools.schema.json', import.meta.url);
  const data = JSON.parse(readFileSync(url, 'utf8'));
  if (!Array.isArray(data.tools) || data.tools.length === 0) {
    throw new Error('mcp/tools.schema.json 为空，请先运行 node scripts/genToolSchemas.mjs');
  }
  return data;
}

const SCHEMAS = loadSchemas();
const TOOL_NAMES = SCHEMAS.tools.map((t) => t.name);

/** 全文帮助：editor_help 无参时返回全集，带 tool 参数时只返回该工具。 */
const FULL_HELP = SCHEMAS.helpText;
const DOC_BY_NAME = new Map(SCHEMAS.docs.map((d) => [d.name, d]));

const TOOLS = [
  // 首发层：精简 schema —— 一行描述 + 必填参数名。
  // 全量 inputSchema 会占大量 context，模型需要细节时用 editor_help 按需拉取。
  ...SCHEMAS.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        t.requiredArgs.map((a) => [a, { type: 'string', description: '必填，详见 editor_help' }]),
      ),
      required: t.requiredArgs,
      additionalProperties: true,
    },
  })),
  {
    name: 'editor_help',
    description: '获取工具完整契约（类型/取值/示例/错误码）。不传 tool 返回全集；传 tool 只返回该工具。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: '只查这一个工具的完整文档；省略则返回全部',
          enum: TOOL_NAMES,
        },
      },
      additionalProperties: false,
    },
  },
];

async function callBridge(tool, args, idempotencyKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    if (!BRIDGE_TOKEN) {
      return { ok: false, error: '未设置 BRIDGE_TOKEN：本进程无法通过后端桥接鉴权。请与后端/前端使用同一个 BRIDGE_TOKEN 后重启。' };
    }
    const res = await fetch(`${BRIDGE}/bridge/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({ tool, args, idempotencyKey }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `编辑器桥接返回 ${res.status}: ${text.slice(0, 400)}` };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `桥接响应不是合法 JSON：${text.slice(0, 200)}` };
    }
  } catch (e) {
    return {
      ok: false,
      error: e?.name === 'AbortError'
        ? '编辑器桥接超时（30s）。请确认编辑器页面已打开且桥接已开启，然后重试本工具，不要重复写入。'
        : `无法连接编辑器桥接 ${BRIDGE}：${e?.message ?? e}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleRpc(body) {
  const { id, method, params } = body ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-3d-character-editor', version: '0.1.0' },
      });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      if (params?.name === 'editor_help') {
        const want = params?.arguments?.tool;
        if (typeof want === 'string' && want.length > 0) {
          const doc = DOC_BY_NAME.get(want);
          if (!doc) {
            return reply({
              content: [{ type: 'text', text: `未知工具 ${want}。可用：${TOOL_NAMES.join(', ')}` }],
              isError: true,
            });
          }
          return reply({ content: [{ type: 'text', text: formatDoc(doc) }] });
        }
        return reply({ content: [{ type: 'text', text: FULL_HELP }] });
      }
      if (!TOOL_NAMES.includes(params?.name)) {
        return reply({ content: [{ type: 'text', text: `未知工具 ${params?.name}` }], isError: true });
      }
      {
        const key = typeof params?.arguments?.idempotencyKey === 'string'
          ? params.arguments.idempotencyKey
          : `${params.name}-${Date.now()}`;
        const result = await callBridge(params.name, params?.arguments ?? {}, key);
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: result?.ok === false,
        });
      }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    default:
      return fail(-32601, `方法未实现：${method}`);
  }
}

function authorized(auth) {
  const expected = `Bearer ${TOKEN}`;
  if (auth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

/** 单个工具的全文文档（editor_help tool=<name>）。 */
function formatDoc(d) {
  const lines = [`### \`${d.name}\` — ${d.summary}${d.mutates ? '' : '（只读）'}`];
  if (d.detail) lines.push('', d.detail);
  if (d.params.length > 0) {
    lines.push('', '参数：');
    for (const p of d.params) {
      lines.push(`- \`${p.name}\`: ${p.type}${p.required ? '（必填）' : ''} — ${p.desc}`);
      if (p.values) lines.push(`  取值：${p.values.join(' / ')}`);
      if (p.example !== undefined) lines.push(`  例：${JSON.stringify(p.example)}`);
    }
  } else {
    lines.push('', '无参数。');
  }
  if (d.errors?.length) lines.push('', `错误码：${d.errors.join(' / ')}`);
  return lines.join('\n');
}

const server = createServer((req, res) => {
  // Host 校验：只接受回环地址，防 DNS rebinding
  const host = req.headers.host ?? '';
  if (!/^127\.0\.0\.1:\d+$/.test(host)) {
    res.writeHead(403).end('仅允许 127.0.0.1');
    return;
  }
  if (!authorized(req.headers.authorization ?? '')) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ error: 'unauthorized', hint: '需要 Authorization: Bearer <MCP_TOKEN>' }),
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, tools: TOOL_NAMES.length, bridge: BRIDGE }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end('仅支持 POST');
    return;
  }

  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'JSON 解析失败' }));
      return;
    }
    try {
      const out = await handleRpc(body);
      if (out === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({
        jsonrpc: '2.0', id: body?.id ?? null,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `MCP server 已启动 http://127.0.0.1:${PORT}\n`
    + `  桥接目标(编辑器): ${BRIDGE}/bridge/execute\n`
    + `  工具数: ${TOOL_NAMES.length} + editor_help\n`
    + `  Token: ${TOKEN}\n\n`
    + '客户端配置（Claude Code / Codex 等）:\n'
    + JSON.stringify({
      mcpServers: {
        'ai-3d-character-editor': {
          type: 'http',
          url: `http://127.0.0.1:${PORT}/mcp`,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    }, null, 2) + '\n',
  );
});

export { TOOL_NAMES, handleRpc, authorized };
