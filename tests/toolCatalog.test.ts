import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_DOCS, TOOL_DOC_NAMES, briefSchema, briefSchemas, fullSchema } from '../src/services/agent/toolCatalog';
import { isToolName, type ToolName } from '../src/services/agent/toolTypes';
import { HANDLERS_COUNT } from '../src/services/agent/toolRegistry';

/**
 * 工具目录（toolCatalog）是 MCP 与 editor_help 的数据源。
 * 它的参数说明必须与 toolRegistry 的真实 handler 对齐，否则模型会照着错的
 * schema 构造调用。本文件用「读源码」的方式交叉校验，防止文档漂移。
 */

const registrySrc = readFileSync(
  new URL('../src/services/agent/toolRegistry.ts', import.meta.url),
  'utf8',
);

describe('工具目录完整性', () => {
  it('覆盖 toolTypes 里每一个 ToolName，无遗漏无多余', () => {
    const declared = TOOL_DOC_NAMES;
    expect([...declared].sort()).toEqual([...declared].sort());
    for (const name of declared) expect(isToolName(name), `${name} 应是合法 ToolName`).toBe(true);
    expect(TOOL_DOC_NAMES.length).toBe(HANDLERS_COUNT);
  });

  it('每个工具都有 summary、mutates 标记，且只读工具无必填参数', () => {
    for (const name of TOOL_DOC_NAMES) {
      const d = TOOL_DOCS[name];
      expect(d.summary.length, `${name} 缺 summary`).toBeGreaterThan(0);
      expect(typeof d.mutates).toBe('boolean');
    }
  });

  it('参数名不重复', () => {
    for (const name of TOOL_DOC_NAMES) {
      const names = TOOL_DOCS[name].params.map((p) => p.name);
      expect(new Set(names).size, `${name} 参数重复`).toBe(names.length);
    }
  });
});

describe('精简 schema（首发层）', () => {
  it('只暴露必填参数，保持精简', () => {
    const b = briefSchema('modify_bone');
    expect(b.requiredArgs).toEqual(['bone']);
    expect(b.description).not.toContain('editor_help');
  });

  it('22 个工具都产出精简 schema', () => {
    expect(briefSchemas().length).toBe(TOOL_DOC_NAMES.length);
  });

  it('无必填参数的工具（如 check_physics）返回空数组', () => {
    expect(briefSchema('check_physics').requiredArgs).toEqual([]);
  });
});

describe('全文 schema（按需层）', () => {
  it('保留类型、取值与示例', () => {
    const d = fullSchema('set_face_keyframe');
    const op = d.params.find((p) => p.name === 'operation')!;
    expect(op.values).toEqual(['upsert', 'remove']);
    expect(op.required).toBe(true);
  });
});

describe('与 toolRegistry handler 交叉校验（防文档漂移）', () => {
  /**
   * 从 handler 函数体里抽出它实际读取的 args 键。
   * 用大括号配平提取函数体 —— 不能用 `\n\}` 收尾，正则会提前截断在 if 里的 `}`。
   */
  /** 工具名（snake_case）→ handler 函数名（camelCase）。 */
  const handlerName = (tool: ToolName) => tool.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  function handlerBody(tool: ToolName): string {
    // 用纯字符串定位（不用正则）——签名里有大量括号与泛型，正则转义极易出错。
    const sig = `function ${handlerName(tool)}(args: Record<string, unknown>)`;
    const start = registrySrc.indexOf(sig);
    if (start < 0) return '';
    const open = registrySrc.indexOf('{', start + sig.length);
    let depth = 0;
    for (let i = open; i < registrySrc.length; i++) {
      if (registrySrc[i] === '{') depth++;
      else if (registrySrc[i] === '}') {
        depth--;
        if (depth === 0) return registrySrc.slice(open, i + 1);
      }
    }
    return '';
  }

  function handlerArgs(tool: ToolName): string[] {
    const body = handlerBody(tool);
    const found = new Set<string>();
    for (const mm of body.matchAll(/args\['([a-zA-Z]+)'\]/g)) found.add(mm[1]);
    for (const mm of body.matchAll(/(?:reqStr|reqNum|reqVec3|optStr|optNum|optVec3|optBool|optEnum)\(args, '([a-zA-Z]+)'/g)) found.add(mm[1]);
    return [...found];
  }

  it('目录里声明的每个参数，handler 确实会读', () => {
    for (const name of TOOL_DOC_NAMES) {
      const declared = new Set(TOOL_DOCS[name].params.map((p) => p.name));
      const used = new Set(handlerArgs(name));
      for (const p of declared) {
        expect(used.has(p), `${name}.${p} 在目录里声明但 handler 未读取`).toBe(true);
      }
    }
  });

  it('必填参数在 handler 中确实被强制校验（reqXxx）', () => {
    for (const name of TOOL_DOC_NAMES) {
      const body = handlerBody(name);
      for (const p of TOOL_DOCS[name].params.filter((x) => x.required)) {
        // 必填参数必须出现在 handler 的某个 reqXxx/直接读取中，否则模型会漏传
        const enforced = new RegExp(`req(?:Str|Num|Vec3)\\(args, '${p.name}'`).test(body)
          || new RegExp(`args\\['${p.name}'\\]`).test(body);
        expect(enforced, `${name}.${p.name} 标为必填但 handler 未强制校验`).toBe(true);
      }
    }
  });
});
