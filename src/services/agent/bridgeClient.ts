import type { AgentAction, ToolName, ToolResult } from './toolTypes';
import { isToolName } from './toolTypes';
import { executeAction } from './toolRegistry';

/**
 * Agent 桥接客户端（浏览器侧）。
 *
 * MCP server（Node 进程）通过 FastAPI 中转把工具调用送来，而**场景状态在本页面里**，
 * 所以最终执行必须发生在这里。本模块：
 *   1. 与后端建立 WebSocket 表示「在线」
 *   2. 轮询 `/bridge/pending` claim 待执行请求
 *   3. 复用 Agent 的唯一执行入口（`executeAction`）执行，不新增旁路
 *   4. 把结果回传 `/bridge/result/{id}`
 *
 * 只在浏览器环境可用；Node 侧（MCP server）不 import 本模块。
 *
 * 令牌：后端所有会改状态的端点都要求 `BRIDGE_TOKEN`（见 backend/bridge.py），
 * 浏览器侧从 `VITE_BRIDGE_TOKEN` 读取并以 Bearer 头携带；WebSocket 握手不能自定义
 * header，故走 `?token=` 查询参数。
 *
 * ⚠️ 安全边界（不要高估）：本项目是**局域网单用户开发工具**，Vite 以 `--host` 暴露，
 * 因此注入前端的令牌对「能打开本编辑器页面的人」是可见的。它能挡住的是
 * **未授权的跨源盲调用**（局域网里任意网页随手 POST /bridge/execute），
 * 挡不住有意的本机/LAN 攻击者。不要把它当成多租户边界。
 */

const POLL_INTERVAL_MS = 400;
const MAX_BODY_BYTES = 512 * 1024;

export interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  idempotencyKey?: string | null;
}

/** 读取注入的桥接令牌；未配置时返回空串（此时不连接，后端也会 fail-closed）。 */
export function bridgeToken(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.['VITE_BRIDGE_TOKEN'] ?? '').trim();
}

/** 本标签页的稳定 client id —— 供后端把 claim 归属到具体页面。 */
function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** 解析并校验单个请求。非法输入直接拒绝，不猜测意图。 */
export function parseBridgeRequest(raw: string): BridgeRequest | { error: string } {
  if (raw.length > MAX_BODY_BYTES) return { error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）` };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: 'JSON 解析失败' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: '请求体必须是对象' };
  const b = body as Partial<BridgeRequest>;
  if (typeof b.id !== 'string' || !b.id) return { error: '缺少 id' };
  if (typeof b.tool !== 'string') return { error: '缺少 tool' };
  if (!isToolName(b.tool)) return { error: `未知工具：${b.tool}` };
  if (b.args !== undefined && (typeof b.args !== 'object' || b.args === null || Array.isArray(b.args))) {
    return { error: 'args 必须是对象' };
  }
  return { id: b.id, tool: b.tool, args: (b.args ?? {}) as Record<string, unknown>, idempotencyKey: b.idempotencyKey };
}

/** 执行一个已校验的请求。 */
export async function runBridgeRequest(req: BridgeRequest): Promise<ToolResult> {
  const action: AgentAction = {
    tool: req.tool as ToolName,
    args: req.args,
    idempotencyKey: req.idempotencyKey ?? `bridge-${req.tool}-${Date.now()}`,
  };
  return executeAction(action);
}

export interface BridgeClient {
  stop: () => void;
  /** 当前是否已完成鉴权握手（供 UI/测试观测）。 */
  readonly connected: boolean;
}

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * 启动桥接客户端。
 *
 * 先探 `/bridge/health`：后端未设置 BRIDGE_TOKEN 时 `enabled=false`，
 * 此时**完全不发起任何请求**（避免对着未鉴权的旧后端空转 400ms 一次）。
 * 未连接时静默重试，不打断编辑器使用。
 */
export function startBridgeClient(baseUrl = ''): BridgeClient {
  const httpBase = `${baseUrl}/bridge`;
  const token = bridgeToken();
  const clientId = newClientId();
  let stopped = false;
  let busy = false;
  let enabled = false;
  let socket: WebSocket | null = null;

  const authedFetch = (path: string, init?: RequestInit) =>
    fetch(`${httpBase}${path}`, { ...init, headers: authHeaders(token) });

  const connect = () => {
    if (stopped || !enabled) return;
    try {
      const wsUrl = httpBase.replace(/^http/, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`
        + (token ? `&token=${encodeURIComponent(token)}` : '');
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        // 后端要等首个消息拿 clientId；发一个 ping 兼作握手
        socket?.send(JSON.stringify({ type: 'ping', clientId }));
      };
      socket.onclose = () => {
        socket = null;
        if (!stopped) setTimeout(connect, 2000);
      };
      socket.onerror = () => { /* onclose 会接管重连 */ };
    } catch {
      if (!stopped) setTimeout(connect, 2000);
    }
  };

  const probe = async () => {
    if (stopped || enabled) return;
    try {
      const res = await fetch(`${httpBase}/health`);
      if (!res.ok) return;
      const data = await res.json() as { enabled?: boolean };
      // 后端未启用鉴权桥接 → 不连接（fail-closed）
      if (data.enabled !== true) return;
      enabled = true;
      connect();
    } catch {
      // 后端不可达：下一轮再试
    }
  };

  const report = async (id: string, body: unknown) => {
    try {
      await authedFetch(`/result/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch {
      // 回传失败：请求会由后端按超时处理
    }
  };

  const poll = async () => {
    if (busy || stopped || !enabled) return;
    busy = true;
    try {
      // claim 语义：后端取出即出队，别的标签页不会再拿到同一请求
      const res = await authedFetch(`/pending?clientId=${encodeURIComponent(clientId)}`);
      if (!res.ok) return;
      const data = await res.json() as { requests?: unknown[] };
      for (const raw of data.requests ?? []) {
        const id = (raw as { id?: string }).id ?? 'unknown';
        const parsed = parseBridgeRequest(JSON.stringify(raw));
        if ('error' in parsed) {
          await report(id, { ok: false, error: parsed.error });
          continue;
        }
        try {
          await report(parsed.id, await runBridgeRequest(parsed));
        } catch (e) {
          await report(parsed.id, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch {
      // 后端不可达：下一轮再试
    } finally {
      busy = false;
    }
  };

  void probe();
  const healthTimer = setInterval(() => { void probe(); }, 3000);
  const pollTimer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
  return {
    get connected() { return enabled; },
    stop: () => {
      stopped = true;
      clearInterval(healthTimer);
      clearInterval(pollTimer);
      socket?.close();
    },
  };
}
