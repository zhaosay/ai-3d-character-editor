import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guessSemantic } from '../src/core/skeleton/humanoidMap';

function readGlbJson(file: string): { json: Record<string, unknown>; byteLength: number } {
  const buf = fs.readFileSync(path.resolve(process.cwd(), 'public/samples', file));
  const magic = buf.subarray(0, 4).toString('ascii');
  expect(magic).toBe('glTF');
  const clen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + clen).toString('utf-8')) as Record<string, unknown>;
  return { json, byteLength: buf.length };
}

const REQUIRED = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R',
  'upperArm.L', 'upperArm.R', 'forearm.L', 'forearm.R', 'hand.L', 'hand.R',
];

describe('bundled samples（离线 GLB JSON 解析，不解码贴图）', () => {
  it('CesiumMan：蒙皮+动画+关节语义全覆盖', () => {
    const { json, byteLength } = readGlbJson('CesiumMan.glb');
    expect(byteLength).toBeGreaterThan(100 * 1024);
    const skins = json['skins'] as Array<{ joints: number[] }>;
    expect(skins.length).toBeGreaterThanOrEqual(1);
    expect((json['animations'] as unknown[]).length).toBeGreaterThanOrEqual(1);
    const nodes = json['nodes'] as Array<{ name?: string }>;
    const jointNames = new Set<number>(skins.flatMap((s) => s.joints)).size;
    expect(jointNames).toBeGreaterThanOrEqual(15);
    const sems = new Map<string, string>();
    for (const idx of new Set<number>(skins.flatMap((s) => s.joints))) {
      const name = nodes[idx]?.name ?? '';
      const sem = guessSemantic(name);
      if (sem) sems.set(sem, name);
    }
    for (const need of REQUIRED) {
      expect(sems.has(need), `缺少语义 ${need}`).toBe(true);
    }
  });
});
