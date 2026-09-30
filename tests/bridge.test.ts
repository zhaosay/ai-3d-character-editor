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
