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

  it('MCP server 的解析规则与测试一致（ToolName 联合体内的字面量）', () => {
    const server = readFileSync(resolve(ROOT, 'mcp/server.mjs'), 'utf8');
    expect(server).toContain("src.indexOf('export type ToolName =')");
    // 不能用「整文件所有引号」，那会把 READONLY_TOOLS 也算进来
    expect(server).not.toMatch(/src\.matchAll\(\/\^\\s\*\\\|/);
  });
});
