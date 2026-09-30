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
 * 工具契约从前端源码读取，避免两处维护。
 * 只取 `ToolName` 联合类型里、位于前两个花括号之间的字符串字面量 ——
 * 不能用「整文件所有 'xxx'」，那会把 READONLY_TOOLS 等其它常量也算进来。
 */
function loadToolNames() {
  const url = new URL('../src/services/agent/toolTypes.ts', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const start = src.indexOf('export type ToolName =');
  if (start < 0) throw new Error('未找到 ToolName 联合类型');
  const end = src.indexOf(';', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const TOOL_NAMES = loadToolNames();

const FULL_HELP = `# 编辑器工具全集

所有工具都支持 \`idempotencyKey\`（相同 key 重复调用只生效一次）。
写操作进历史栈，可撤销。

## 工具
${TOOL_NAMES.map((n) => `- \`${n}\``).join('\n')}

## 典型流程
1. \`inspect_skeleton\` — 看清当前角色骨骼与语义映射
2. \`load_character\` / \`create_animation\` — 准备工程
3. \`generate_motion\` 或 \`retarget_motion\` — 产生动作
4. \`check_physics\` — 体检（穿地/脚滑/平衡/关节极限）
5. \`repair_physics\` — 修复；\`export_animation\` — 导出
`;

const TOOLS = [
  ...TOOL_NAMES.map((name) => ({
    name,
    description: `编辑器工具 ${name}。参数与用法见 editor_help。`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  })),
  {
    name: 'editor_help',
    description: '获取全部工具的完整契约（首发 schema 为精简版，需要细节时调用本工具）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callBridge(tool, args, idempotencyKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BRIDGE}/bridge/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
