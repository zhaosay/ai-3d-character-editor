#!/usr/bin/env node
/**
 * MCP stdio ↔ HTTP 转发 —— 给只支持 stdio 的客户端（Claude Desktop 等）。
 *
 * 为什么需要：mcp/server.mjs 是 HTTP 服务，适合 Claude Code / Codex 这类
 * 支持 remote MCP 的客户端；Claude Desktop 的配置格式只接受
 * `{"command": "...", "args": [...]}`，必须有一个 stdio 进程。
 *
 * 本进程只做逐行 JSON-RPC 的透明转发，不解释协议：
 *   stdin  ← 每行一个 JSON-RPC 消息 →  HTTP POST mcp/server.mjs
 *   stdout ← 响应逐行写回
 *
 * 用法（Claude Desktop 的 claude_desktop_config.json）：
 *   {
 *     "mcpServers": {
 *       "ai-3d-character-editor": {
 *         "command": "node",
 *         "args": ["/绝对路径/mcp/stdio-bridge.mjs"],
 *         "env": {
 *           "MCP_URL": "http://127.0.0.1:7331/mcp",
 *           "MCP_TOKEN": "<与 server.mjs 相同的 token>"
 *         }
 *       }
 *     }
 *   }
 *
 * 前置：先另起一个终端跑 `MCP_TOKEN=<token> node mcp/server.mjs`。
 */

import { createInterface } from 'node:readline';

const URL_ = process.env.MCP_URL ?? 'http://127.0.0.1:7331/mcp';
const TOKEN = process.env.MCP_TOKEN ?? '';

if (!TOKEN) {
  // 不静默降级为匿名：转发必然 401，早点失败并说清原因
  process.stderr.write('[stdio-bridge] 缺少 MCP_TOKEN，无法鉴权。请在客户端配置的 env 里设置。\n');
}

const headers = {
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

/** 串行发送：保持 JSON-RPC 顺序，避免并发请求打乱响应。 */
let chain = Promise.resolve();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  chain = chain.then(async () => {
    try {
      const res = await fetch(URL_, { method: 'POST', headers, body: text });
      const body = await res.text();
      if (!body.trim()) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: safeId(text),
            error: { code: res.status, message: `MCP 端点返回 ${res.status}（空响应体）` },
          }) + '\n',
        );
        return;
      }
      process.stdout.write(body.trim() + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: safeId(text),
          error: { code: -32000, message: `无法连接 MCP ${URL_}：${e?.message ?? e}` },
        }) + '\n',
      );
    }
  });
});

rl.on('close', () => { chain.then(() => process.exit(0)); });

/** 转发失败时也要回一条 id 匹配的响应，否则客户端会一直等。 */
function safeId(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.id ?? null;
  } catch {
    return null;
  }
}
