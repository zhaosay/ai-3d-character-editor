import { describe, expect, it, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three-stdlib';
import { isLoadableUrl, loadGltfUrl } from '../src/services/loader/loadGltf';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { guessSemantic } from '../src/core/skeleton/humanoidMap';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function demoGlbBytes(): Promise<ArrayBuffer> {
  const demo = buildDemoCharacter('male');
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    new GLTFExporter().parse(
      demo.scene,
      (r) => resolve(r as ArrayBuffer),
      (e) => reject(e instanceof Error ? e : new Error(String(e))),
      { binary: true },
    );
  });
  demo.dispose();
  return buf;
}

describe('isLoadableUrl', () => {
  it('仅接受 http(s) + .glb 路径（含查询参数）', () => {
    expect(isLoadableUrl('https://models.readyplayer.me/abc.glb')).toBe(true);
    expect(isLoadableUrl('https://models.readyplayer.me/abc.glb?pose=T')).toBe(true);
    expect(isLoadableUrl('http://localhost:8123/x.glb')).toBe(true);
    expect(isLoadableUrl('https://example.com/x.gltf')).toBe(false);
    expect(isLoadableUrl('https://example.com/x.glb.zip')).toBe(false);
    expect(isLoadableUrl('ftp://example.com/x.glb')).toBe(false);
    expect(isLoadableUrl('not a url')).toBe(false);
    expect(isLoadableUrl('')).toBe(false);
  });
});

describe('loadGltfUrl', () => {
  it('非法地址直接拒绝（不发请求）', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(loadGltfUrl('https://example.com/x.gltf')).rejects.toThrow(/\.glb/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('断网/404 给出可操作错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(loadGltfUrl('https://example.com/x.glb')).rejects.toThrow(/跨域/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    await expect(loadGltfUrl('https://example.com/x.glb')).rejects.toThrow(/404/);
  });

  it('下载字节走同一管线（定标+骨骼统计）', async () => {
    const buf = await demoGlbBytes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(buf, { status: 200 })));
    const loaded = await loadGltfUrl('https://example.com/demo.glb');
    expect(loaded.meta.fileName).toBe('demo.glb');
    expect(loaded.meta.gltfInfo.bones).toBe(17);
    loaded.dispose();
  });
});

describe('Soldier 在线预设（真人男，Mixamo 骨架）', () => {
  it(
    'CDN 可达且关节语义覆盖四肢', async () => {
      const res = await fetch('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r186/examples/models/gltf/Soldier.glb');
      expect(res.ok, `Soldier 预设地址失效: ${res.status}`).toBe(true);
      const buf = await res.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(1024 * 1024);
      const view = new DataView(buf);
      const clen = view.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, clen))) as Record<string, unknown>;
      const skins = json['skins'] as Array<{ joints: number[] }>;
      const nodes = json['nodes'] as Array<{ name?: string }>;
      const sems = new Set<string>();
      for (const idx of new Set<number>(skins.flatMap((s) => s.joints))) {
        const sem = guessSemantic(nodes[idx]?.name ?? '');
        if (sem) sems.add(sem);
      }
      for (const need of ['hips', 'spine', 'head', 'upperArm.L', 'upperArm.R', 'hand.L', 'hand.R', 'thigh.L', 'thigh.R', 'foot.L', 'foot.R']) {
        expect(sems.has(need), `Soldier 缺少语义 ${need}`).toBe(true);
      }
    },
    90000,
  );
});
