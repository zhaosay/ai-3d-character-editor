import type { AgentAction, ToolName, ToolResult } from './toolTypes';
import { isToolName } from './toolTypes';
import { executeAction } from './toolRegistry';

/**
 * Agent 桥接客户端（浏览器侧）。
 *
 * MCP server（Node 进程）通过 FastAPI 中转把工具调用送来，而**场景状态在本页面里**，
 * 所以最终执行必须发生在这里。本模块：
 *   1. 与后端建立 WebSocket 表示「在线」
 *   2. 轮询 `/bridge/pending` 取回待执行请求
 *   3. 复用 Agent 的唯一执行入口（`executeAction`）执行，不新增旁路
 *   4. 把结果回传 `/bridge/result/{id}`
 *
 * 只在浏览器环境可用；Node 侧（MCP server）不 import 本模块。
 */

const POLL_INTERVAL_MS = 400;
const MAX_BODY_BYTES = 512 * 1024;

export interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  idempotencyKey?: string | null;
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
}

/**
 * 启动桥接客户端。未连接时静默重试，不打断编辑器使用。
 * 后端不可达时返回的 client 依然可用（只会持续重连）。
 */
export function startBridgeClient(baseUrl = ''): BridgeClient {
  const httpBase = `${baseUrl}/bridge`;
  let stopped = false;
  let busy = false;
  let socket: WebSocket | null = null;

  const connect = () => {
    if (stopped) return;
    try {
      const wsUrl = httpBase.replace(/^http/, 'ws') + '/ws';
      socket = new WebSocket(wsUrl);
      socket.onclose = () => {
        socket = null;
        if (!stopped) setTimeout(connect, 2000);
      };
      socket.onerror = () => { /* onclose 会接管重连 */ };
    } catch {
      if (!stopped) setTimeout(connect, 2000);
    }
  };

  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const res = await fetch(`${httpBase}/pending`);
      if (!res.ok) return;
      const data = await res.json() as { requests?: unknown[] };
      for (const raw of data.requests ?? []) {
        const parsed = parseBridgeRequest(JSON.stringify(raw));
        if ('error' in parsed) {
          await fetch(`${httpBase}/result/${(raw as { id?: string }).id ?? 'unknown'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: parsed.error }),
          });
          continue;
        }
        try {
          const result = await runBridgeRequest(parsed);
          await fetch(`${httpBase}/result/${parsed.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
          });
        } catch (e) {
          await fetch(`${httpBase}/result/${parsed.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          });
        }
      }
    } catch {
      // 后端不可达：下一轮再试
    } finally {
      busy = false;
    }
  };

  connect();
  const timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      socket?.close();
    },
  };
}
