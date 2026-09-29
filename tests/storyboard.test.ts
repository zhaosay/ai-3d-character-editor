import { describe, expect, it } from 'vitest';
import { buildComfyStoryboardRequest, buildStoryboard, buildVpipeStoryboardRequest, storyboardDurationSeconds, storyboardText } from '../src/core/previs/storyboard';
import type { PrevisEffectEvent } from '../src/core/previs/effects';

const animation = { id: 'a', name: 'AI:test', duration: 6, fps: 30, tracks: [] };

describe('storyboard', () => {
  it('合并动作段和相机关键帧，生成可用于两条生成链路的分镜', () => {
    const shots = buildStoryboard(animation, [
      { t0: 0, t1: 2, template: 'march', clause: '人物走到桌前' },
      { t0: 2, t1: 4, template: 'reach', clause: '拿起手机' },
      { t0: 4, t1: 6, template: 'look', clause: '回头看向门口' },
    ], [
      { time: 0, position: [3, 1.8, 4], target: [0, 1, 0], fov: 45 },
      { time: 3, position: [1.8, 1.5, 2.4], target: [0, 1, 0.3], fov: 50 },
      { time: 6, position: [1.8, 1.5, 2.4], target: [0, 1, 0.3], fov: 50 },
    ], [], [{ id: 'phone-main', kind: 'phone', position: [1, 0.75, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } }]);
    expect(shots).toHaveLength(4);
    expect(shots.map((shot) => [shot.t0, shot.t1])).toEqual([[0, 2], [2, 3], [3, 4], [4, 6]]);
    expect(shots[0].shot).toBe('中全景');
    expect(shots[1].shot).toBe('中全景');
    expect(shots[3].shot).toBe('近景');
    expect(shots[0].comfyPrompt).toMatch(/adult Chinese person/);
    expect(shots[1].comfyPrompt).toMatch(/Full person head to toe with margins/);
    expect(shots[1].comfyPrompt).toMatch(/pick up a single small smartphone from the desk/);
    expect(shots[1].comfyPrompt).toMatch(/one palm-sized black smartphone/);
    expect(shots[1].comfyPrompt.length).toBeLessThan(450);
    expect(shots[1].comfyNegativePrompt).toMatch(/cropped head.*tablet, laptop, printer/);
    expect(buildComfyStoryboardRequest(shots[1]).negative_prompt).toContain('duplicate phone');
    expect(buildComfyStoryboardRequest(shots[1], 'viewport-png-base64')).toMatchObject({ reference_image_base64: 'viewport-png-base64' });
    expect(shots[0].vpipePrompt).toMatch(/2.0秒/);
    expect(storyboardText(shots)).toMatch(/ComfyUI 首尾帧提示词/);
  });

  it('没有语义数据时仍输出完整动作段', () => {
    const shots = buildStoryboard(animation, [], []);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ t0: 0, t1: 6, shot: '中景' });
  });

  it('把武打特效事件写入对应分镜提示词', () => {
    const fx: PrevisEffectEvent[] = [
      { id: 'fx-impact', kind: 'impact', time: 1.4, duration: 0.2, position: [0, 1, 0], scale: 1, color: '#ffaa00' },
      { id: 'fx-spark', kind: 'spark', time: 1.5, duration: 0.2, position: [0, 1, 0], scale: 1, color: '#ffcc00' },
      { id: 'fx-smoke', kind: 'smoke', time: 1.6, duration: 0.4, position: [0, 1, 0], scale: 1, color: '#999999' },
      { id: 'fx-energy', kind: 'energy', time: 1.7, duration: 0.3, position: [0, 1, 0], scale: 1, color: '#44ddbb' },
    ];
    const shots = buildStoryboard(animation, [{ t0: 0, t1: 3, template: 'sword', clause: '挥剑攻击' }], [], fx);
    expect(shots[0].effects).toMatch(/冲击波/);
    expect(shots[0].effects).toMatch(/飞散火花/);
    expect(shots[0].effects).toMatch(/烟雾/);
    expect(shots[0].effects).toMatch(/能量环/);
    expect(shots[0].vpipePrompt).toMatch(/1.40秒/);
    expect(storyboardText(shots)).toMatch(/特效：/);
  });

  it('把原始故事设定和 AI 连续性建议带入 ComfyUI 与 V-Pipe 文案', () => {
    const shots = buildStoryboard(animation, [{ t0: 0, t1: 6, template: 'wave', clause: '人物挥手' }], [], [], [], {
      sourcePrompt: '短发女性穿红色外套，在夜晚的旧车站挥手',
      aiDetails: [{ index: 1, visualStyle: '冷色月光，胶片颗粒', continuity: '短发与红外套保持不变，车站灯光方向固定' }],
    });
    expect(shots[0].comfyPrompt).toMatch(/short-haired adult Chinese woman wearing a red coat/);
    expect(shots[0].comfyPrompt.length).toBeLessThanOrEqual(450);
    expect(shots[0].vpipePrompt).toMatch(/胶片颗粒/);
    expect(shots[0].vpipePrompt).toMatch(/车站灯光方向固定/);
  });

  it('把场景尺寸朝向、接触约束和镜头路径数值传给 V-Pipe', () => {
    const shots = buildStoryboard(animation, [{ t0: 0, t1: 2, template: 'lie', clause: '人物躺到床上' }], [
      { time: 0, position: [3, 2, 4], target: [0, 1, 0], fov: 45 },
      { time: 2, position: [2, 1.5, 2], target: [0.5, 0.8, 0], fov: 50 },
    ], [], [{
      id: 'bed-main', kind: 'bed', position: [1, 0, 0], rotationY: Math.PI / 2,
      size: { width: 1.4, height: 0.6, length: 2 },
    }], {
      contacts: [{ phase: 'lie', actionIndex: 0, bodyPart: 'back', propId: 'bed-main', surface: 'mattress', relation: 'support' }],
    });

    expect(shots[0].scene).toMatch(/底面中心坐标\(1\.00,0\.00,0\.00\)米，顶面高0\.60米，宽1\.40米、深2\.00米，绕Y轴90度/);
    expect(shots[0].vpipePrompt).toMatch(/背部支撑于bed-main的床垫上表面/);
    expect(shots[0].vpipePrompt).toMatch(/不得互相穿透/);
    expect(shots[0].vpipePrompt).toMatch(/相机路径从\(3\.00,2\.00,4\.00\)米/);
    expect(shots[0].vpipePrompt).toMatch(/2\.0秒/);
  });

  it('保留沙发作为场景物体传入图像与视频分镜，并描述座面支撑', () => {
    const shots = buildStoryboard(animation, [{ t0: 0, t1: 3, template: 'sit', clause: '人物坐到沙发上' }], [], [], [{
      id: 'sofa-main', kind: 'sofa', position: [0, 0, -1], rotationY: 0,
      size: { width: 2, height: 0.9, length: 0.9 },
    }], {
      contacts: [{ phase: 'sit', actionIndex: 0, bodyPart: 'pelvis', propId: 'sofa-main', surface: 'seat', relation: 'support' }],
    });
    expect(shots[0].comfyPrompt).toMatch(/ordinary fabric sofa/);
    expect(shots[0].scene).toMatch(/沙发sofa-main/);
    expect(shots[0].vpipePrompt).toMatch(/骨盆支撑于sofa-main的座面/);
  });

  it('limits V-Pipe clip length to the storyboard interval and splits actions above ten seconds', () => {
    expect(storyboardDurationSeconds({ t0: 1, t1: 3 })).toBe(2);
    expect(storyboardDurationSeconds({ t0: 0, t1: 0.5 })).toBe(1);
    expect(storyboardDurationSeconds({ t0: 0, t1: 14 })).toBe(10);
    expect(buildVpipeStoryboardRequest({ index: 2, t0: 1, t1: 3, vpipePrompt: '两秒走到桌边' })).toMatchObject({ duration_sec: 2, prompt: '两秒走到桌边', seed: 9162028 });
    expect(buildVpipeStoryboardRequest({ index: 2, t0: 1, t1: 3, vpipePrompt: '两秒走到桌边' }, 'image-data')).toMatchObject({ image_base64: 'image-data' });
    expect(buildComfyStoryboardRequest({ index: 2, comfyPrompt: '宽画幅镜头' })).toMatchObject({ width: 1024, height: 576, seed: 9162028 });
    const shots = buildStoryboard({ ...animation, duration: 12 }, [
      { t0: 0, t1: 12, template: 'march', clause: '人物持续走向床边' },
    ], []);
    expect(shots.map(({ t0, t1 }) => [t0, t1])).toEqual([[0, 10], [10, 12]]);
    expect(shots.map(({ vpipePrompt }) => vpipePrompt.match(/^([\d.]+)秒/)?.[1])).toEqual(['10.0', '2.0']);
  });
});
