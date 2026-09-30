import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBridgeRequest, type BridgeRequest } from '../src/services/agent/bridgeClient';

const ROOT = resolve(__dirname, '..');

describe('桥接请求校验（浏览器侧）', () => {
  const valid = { id: 'req-1', tool: 'inspect_skeleton', args: {} };

  it('接受合法请求', () => {
    const r = parseBridgeRequest(JSON.stringify(valid));
    expect('error' in r).toBe(false);
    expect((r as BridgeRequest).id).toBe('req-1');
  });

  it('缺 id / 缺 tool 被拒', () => {
    expect(parseBridgeRequest(JSON.stringify({ tool: 'inspect_skeleton' }))).toHaveProperty('error');
    expect(parseBridgeRequest(JSON.stringify({ id: 'x' }))).toHaveProperty('error');
  });

  it('未知工具被拒（白名单）', () => {
    const r = parseBridgeRequest(JSON.stringify({ id: 'x', tool: 'rm_rf' }));
    expect(r).toHaveProperty('error');
    if ('error' in r) expect(r.error).toContain('未知工具');
  });

  it('args 非对象被拒', () => {
    expect(parseBridgeRequest(JSON.stringify({ id: 'x', tool: 'inspect_skeleton', args: [1, 2] })))
      .toHaveProperty('error');
  });

  it('body 非 JSON / 非对象被拒', () => {
    expect(parseBridgeRequest('not json')).toHaveProperty('error');
    expect(parseBridgeRequest('[1,2]')).toHaveProperty('error');
  });

  it('超大 body 被拒', () => {
    const huge = JSON.stringify({ id: 'x', tool: 'inspect_skeleton', args: { blob: 'a'.repeat(600_000) } });
    expect(parseBridgeRequest(huge)).toHaveProperty('error');
  });

  it('缺失 args 时补空对象', () => {
    const r = parseBridgeRequest(JSON.stringify({ id: 'x', tool: 'inspect_skeleton' })) as BridgeRequest;
    expect(r.args).toEqual({});
  });
});

describe('桥接鉴权与去重（防止未授权驱动 + 多标签页重复执行）', () => {
  const bridgePy = readFileSync(resolve(ROOT, 'backend/bridge.py'), 'utf8');
  const clientTs = readFileSync(resolve(ROOT, 'src/services/agent/bridgeClient.ts'), 'utf8');
  const serverJs = readFileSync(resolve(ROOT, 'mcp/server.mjs'), 'utf8');

  it('后端所有改状态端点都要求鉴权', () => {
    for (const fn of ['execute', 'take_pending', 'post_result']) {
      expect(bridgePy, `${fn} 必须调用 _require_auth`).toMatch(
        new RegExp(`async def ${fn}\\([\\s\\S]*?_require_auth\\(authorization\\)`),
      );
    }
  });

  it('后端 fail-closed：未配置 BRIDGE_TOKEN 时一律拒绝（503），不默认放行', () => {
    expect(bridgePy).toContain('fail-closed');
    expect(bridgePy).toContain('status_code=503');
    // 只有 health 公开可读，且它只报告 enabled，不泄露任何秘密
    expect(bridgePy).toMatch(/@router\.get\("\/health"\)[\s\S]*?def health[\s\S]*?enabled/);
  });

  it('令牌比较用常量时间，防时序侧信道', () => {
    expect(bridgePy).toContain('hmac.compare_digest');
    expect(bridgePy).not.toMatch(/token\s*==\s*expected/);
  });

  it('pending 采用 claim 语义：取出即出队，第二个标签页拿不到', () => {
    expect(bridgePy).toMatch(/for rid in list\(_pending\.keys\(\)\):[\s\S]*?_pending\.pop\(rid\)/);
    // claim 后转入 _claimed，post_result 才不会 404
    expect(bridgePy).toContain('_claimed');
  });

  it('浏览器端携带令牌与 clientId', () => {
    expect(clientTs).toContain('VITE_BRIDGE_TOKEN');
    expect(clientTs).toContain('Authorization');
    expect(clientTs).toContain('clientId=');
  });

  it('浏览器先探 health 的 enabled，未启用则完全不连接', () => {
    expect(clientTs).toContain('/health');
    expect(clientTs).toMatch(/data\.enabled !== true/);
  });

  it('MCP server 把 BRIDGE_TOKEN 转发给后端；未配置时给出明确指引', () => {
    expect(serverJs).toContain('BRIDGE_TOKEN');
    expect(serverJs).toMatch(/Authorization.*Bearer.*BRIDGE_TOKEN/s);
    expect(serverJs).toContain('未设置 BRIDGE_TOKEN');
  });
});

describe('Node 与 Python 工具列表一致', () => {
  const toolTypes = readFileSync(resolve(ROOT, 'src/services/agent/toolTypes.ts'), 'utf8');
  const py = readFileSync(resolve(ROOT, 'backend/bridge.py'), 'utf8');

  const extract = () => {
    const start = toolTypes.indexOf('export type ToolName =');
    const body = toolTypes.slice(start, toolTypes.indexOf(';', start));
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };

  it('前端 ToolName 与后端白名单完全一致（防止协议漂移）', () => {
    const frontend = extract();
    const backend = new Set(
      [...py.slice(py.indexOf('TOOL_NAMES: set[str] = {'), py.indexOf('}', py.indexOf('TOOL_NAMES: set[str] = {')))
        .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(frontend.length).toBeGreaterThan(20);
    expect(frontend.filter((n) => !backend.has(n))).toEqual([]);
  });

  it('MCP server 从生成的 schema JSON 读取工具契约', () => {
    const server = readFileSync(resolve(ROOT, 'mcp/server.mjs'), 'utf8');
    expect(server).toContain("new URL('./tools.schema.json', import.meta.url)");
    // 不再从 toolTypes.ts 现场正则解析（易与 isToolName 漂移），改为构建期生成
    expect(server).not.toContain('export type ToolName =');
  });

  it('生成的 tools.schema.json 与 toolCatalog 同步', async () => {
    const { TOOL_DOCS, TOOL_DOC_NAMES, briefSchemas } = await import('../src/services/agent/toolCatalog');
    const gen = JSON.parse(readFileSync(resolve(ROOT, 'mcp/tools.schema.json'), 'utf8')) as {
      tools: Array<{ name: string; description: string; requiredArgs: string[] }>;
    };
    expect(gen.tools.map((t) => t.name)).toEqual(TOOL_DOC_NAMES);
    expect(gen.tools).toEqual(briefSchemas());
    for (const t of gen.tools) {
      expect(t.description.length, `${t.name} 缺描述`).toBeGreaterThan(0);
      expect(Array.isArray(t.requiredArgs)).toBe(true);
      expect(TOOL_DOCS[t.name as keyof typeof TOOL_DOCS], `${t.name} 不在目录中`).toBeTruthy();
    }
  });

  it('editor_help 支持按工具名取全文', () => {
    const server = readFileSync(resolve(ROOT, 'mcp/server.mjs'), 'utf8');
    expect(server).toContain('DOC_BY_NAME');
    expect(server).toContain('formatDoc');
  });
});
