import * as THREE from 'three';
import type { AnimationData } from '../animation/types';
import { DEFAULT_CAMERA_POSE, sampleCameraTrack, type CameraKeyframe } from '../camera/track';
import type { PrevisEffectEvent } from './effects';
import type { ContactConstraint, StageProp } from './world';

export interface StoryboardSegment {
  t0: number;
  t1: number;
  template: string;
  clause: string;
  intensity?: number;
  speed?: number;
}

export interface StoryboardShot {
  index: number;
  t0: number;
  t1: number;
  action: string;
  shot: string;
  camera: string;
  comfyPrompt: string;
  comfyNegativePrompt?: string;
  vpipePrompt: string;
  effects: string;
  scene: string;
}

export interface StoryboardPromptDetail { index: number; visualStyle: string; continuity: string }

export function storyboardDurationSeconds(shot: Pick<StoryboardShot, 't0' | 't1'>): number {
  return Math.max(1, Math.min(10, Math.round((shot.t1 - shot.t0) * 10) / 10));
}

export function buildComfyStoryboardRequest(shot: Pick<StoryboardShot, 'index' | 'comfyPrompt' | 'comfyNegativePrompt'>, referenceImageBase64?: string) {
  return {
    prompt: shot.comfyPrompt,
    negative_prompt: shot.comfyNegativePrompt ?? 'cropped person, cut off feet, extra people, unrelated props, clutter, text, watermark, blurry',
    width: 1024, height: 576, seed: 9162026 + shot.index,
    ...(referenceImageBase64 ? { reference_image_base64: referenceImageBase64 } : {}),
  };
}

export function buildVpipeStoryboardRequest(shot: Pick<StoryboardShot, 'index' | 't0' | 't1' | 'vpipePrompt'>, imageBase64?: string) {
  return {
    prompt: shot.vpipePrompt, style: 'real' as const, width: 960, height: 544,
    duration_sec: storyboardDurationSeconds(shot), seed: 9162026 + shot.index,
    ...(imageBase64 ? { image_base64: imageBase64 } : {}),
  };
}

const ACTION_LABEL: Record<string, string> = {
  march: '人物向前走位', reach: '人物伸手拿取物品', look: '人物回头看向目标', look_left: '人物头部向左转', look_right: '人物头部向右转', turn: '人物转身',
  lie: '人物躺倒并仰卧', sleep: '人物仰卧安静呼吸', stand: '人物起身站立',
  orient: '人物转向床面', sit: '人物坐到床沿', squat: '人物下蹲', raise_left: '人物抬起左手', raise_right: '人物抬起右手',
  wave: '人物挥手', bow: '人物鞠躬', sword: '人物挥剑', block: '人物格挡', kick: '人物踢腿', punch: '人物出拳', breath: '人物自然呼吸待机', sway: '人物站立准备',
};

function imageActionDescription(template: string, clause: string, hasPhone: boolean): string {
  if (template === 'reach') return hasPhone
    ? 'reaching down with one hand to pick up a single small smartphone from the desk'
    : 'reaching toward the clearly visible object';
  if (template === 'march') return /门|door/i.test(clause) ? 'walking toward the doorway' : /桌|table|desk/i.test(clause) ? 'walking toward the desk' : 'walking with a natural full-body stride';
  if (template === 'look') return /门|door/i.test(clause) ? 'turning back to look toward the doorway' : 'turning the head and shoulders to look toward the stated target';
  if (template === 'lie') return /床|bed/i.test(clause) ? 'carefully lying down on the bed' : 'carefully lowering to a supine position';
  if (template === 'sleep') return /床|bed/i.test(clause) ? 'resting supine on the bed' : 'resting supine on the floor';
  const labels: Record<string, string> = {
    stand: 'rising to stand', sit: /沙发|sofa|couch/i.test(clause) ? 'sitting down on the sofa with the pelvis supported by the seat' : 'sitting down on the chair', orient: 'turning to face the target',
    squat: 'squatting down', kneel: 'kneeling with support', turn: 'turning the body toward the target',
    raise_left: 'raising the left arm', raise_right: 'raising the right arm', wave: 'waving one hand',
    bow: 'bowing forward', sword: 'swinging the sword', block: 'holding a defensive block',
    kick: 'performing a controlled kick', punch: 'performing a controlled punch', breath: 'breathing calmly',
    sway: 'standing naturally', look_left: 'turning the head left', look_right: 'turning the head right',
  };
  return labels[template] ?? 'performing the described action';
}

function imageCharacterDescription(sourcePrompt: string): string {
  const gender = /女人|女性|女生|女主|女孩|female|woman/i.test(sourcePrompt) ? 'woman'
    : /男人|男性|男生|男主|男孩|male|man/i.test(sourcePrompt) ? 'man' : 'person';
  const garment = sourcePrompt.match(/(黑色|深色|白色|红色|蓝色|灰色|绿色)?(夹克|外套|衬衫|西装|制服|T恤|裙子|大衣)/);
  const color = garment?.[1] ? ({ 黑色: 'black', 深色: 'dark', 白色: 'white', 红色: 'red', 蓝色: 'blue', 灰色: 'gray', 绿色: 'green' } as Record<string, string>)[garment[1]] : '';
  const clothing = garment ? ` wearing a ${[color, ({ 夹克: 'jacket', 外套: 'coat', 衬衫: 'shirt', 西装: 'suit', 制服: 'uniform', T恤: 't-shirt', 裙子: 'skirt', 大衣: 'coat' } as Record<string, string>)[garment[2]]].filter(Boolean).join(' ')}` : '';
  const hair = /短发/.test(sourcePrompt) ? 'short-haired ' : /长发/.test(sourcePrompt) ? 'long-haired ' : '';
  return `${hair}adult Chinese ${gender}${clothing}, natural realistic skin`;
}

function imageSceneDescription(props: StageProp[]): string {
  const items = props.flatMap((prop) => {
    if (prop.kind === 'room') return ['simple apartment'];
    if (prop.kind === 'table') return ['wooden desk'];
    if (prop.kind === 'phone') return ['one palm-sized black smartphone'];
    if (prop.kind === 'door') return ['plain doorway'];
    if (prop.kind === 'bed') return ['ordinary bed'];
    if (prop.kind === 'chair') return ['ordinary chair'];
    if (prop.kind === 'sofa') return ['ordinary fabric sofa'];
    if (prop.kind === 'sword') return ['realistic sword'];
    return [];
  });
  return [...new Set(items)].join(', ') || 'a simple uncluttered neutral interior';
}

function imageCameraDescription(keys: CameraKeyframe[], t0: number, t1: number, template: string): string {
  const camera = sampleCameraTrack(keys, (t0 + t1) / 2);
  const frame = ['march', 'reach', 'lie', 'sleep', 'stand', 'sit', 'squat', 'kneel', 'sword', 'block', 'kick', 'punch'].includes(template)
    ? 'wide establishing view, full-length person with space around them'
    : 'medium cinematic view';
  if (!camera) return `${frame}, eye-level camera`;
  const vertical = camera.position[1] - camera.target[1];
  const angle = vertical > 0.7 ? 'slightly high camera angle' : vertical < -0.4 ? 'slightly low camera angle' : 'eye-level camera';
  const lens = camera.fov > 58 ? 'wide-angle lens' : camera.fov < 36 ? 'long lens' : '35mm lens';
  return `${frame}, horizontal 16:9, ${angle}, ${lens}`;
}

function cameraDistance(p: [number, number, number], t: [number, number, number]) {
  return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
}

function cameraDescription(keys: CameraKeyframe[], t0: number, t1: number): string {
  const a = sampleCameraTrack(keys, t0);
  const b = sampleCameraTrack(keys, t1);
  if (!a || !b) {
    const vector = (value: [number, number, number]) => `(${value.map((component) => component.toFixed(2)).join(',')})米`;
    return `固定中景，人物保持在画面中心；相机路径保持在${vector(DEFAULT_CAMERA_POSE.position)}注视${vector(DEFAULT_CAMERA_POSE.target)}、${DEFAULT_CAMERA_POSE.fov}度视角`;
  }
  const delta = cameraDistance(b.position, b.target) - cameraDistance(a.position, a.target);
  const moved = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]);
  const movement = delta < -0.12 ? '镜头缓慢推近，保持人物在画面中心'
    : delta > 0.12 ? '镜头缓慢拉远，保留环境关系'
      : moved > 0.12 ? '镜头平稳跟移，持续注视人物' : '固定机位，保持构图稳定';
  const vector = (value: [number, number, number]) => `(${value.map((component) => component.toFixed(2)).join(',')})米`;
  return `${movement}；相机路径从${vector(a.position)}注视${vector(a.target)}、${a.fov.toFixed(0)}度视角，移动到${vector(b.position)}注视${vector(b.target)}、${b.fov.toFixed(0)}度视角`;
}

function shotFor(template: string): string {
  if (template === 'march' || template === 'lie' || template === 'sleep' || template === 'stand' || template === 'sit') return '中全景';
  if (template === 'reach') return '中全景';
  if (template === 'look' || template === 'turn') return '近景';
  return '中景';
}

/** 将真实动作段和镜头关键帧合并为可编辑的生成视频分镜。 */
export function buildStoryboard(
  animation: AnimationData,
  segments: StoryboardSegment[],
  cameraKeys: CameraKeyframe[],
  effectEvents: PrevisEffectEvent[] = [],
  sceneProps: StageProp[] = [],
  promptContext: { sourcePrompt?: string; aiDetails?: StoryboardPromptDetail[]; contacts?: ContactConstraint[] } = {},
): StoryboardShot[] {
  const motion = segments.length > 0 ? segments : [{ t0: 0, t1: animation.duration, template: 'sway', clause: '人物完成当前预演动作' }];
  const boundaries = new Set([0, animation.duration]);
  for (const segment of motion) {
    boundaries.add(segment.t0); boundaries.add(segment.t1);
    for (let split = segment.t0 + 10; split < segment.t1 - 1e-4; split += 10) boundaries.add(split);
  }
  for (const key of cameraKeys) if (key.time > 0 && key.time < animation.duration) boundaries.add(key.time);
  const times = [...boundaries].sort((a, b) => a - b);
  return times.slice(0, -1).map((t0, i) => {
    const t1 = times[i + 1];
    const segment = motion.find((item) => item.t0 <= t0 + 1e-4 && item.t1 >= t1 - 1e-4) ?? motion.find((item) => item.t0 < t1 && item.t1 > t0) ?? motion[0];
    const actionBase = segment.clause || ACTION_LABEL[segment.template] || '人物自然表演';
    const motionDetail = [
      segment.intensity !== undefined ? `幅度${Math.round(segment.intensity * 100)}%` : '',
      segment.speed !== undefined ? `速度${Math.round(segment.speed * 100)}%` : '',
    ].filter(Boolean).join('，');
    const action = motionDetail ? `${actionBase}（${motionDetail}）` : actionBase;
    const shot = shotFor(segment.template);
    const camera = cameraDescription(cameraKeys, t0, t1);
    const duration = storyboardDurationSeconds({ t0, t1 });
    const effects = effectEvents
      .filter((event) => event.time >= t0 && (event.time < t1 || (i === times.length - 2 && event.time === t1)))
      .map((event) => `${({ slash: '挥砍拖尾', impact: '冲击波', dust: '落地尘土', spark: '飞散火花', smoke: '烟雾', energy: '能量环' })[event.kind]}（${event.time.toFixed(2)}秒，${event.color}）`)
      .join('、');
    const effectPrompt = effects ? `特效：${effects}。` : '';
    const coordinates = (position: readonly number[]) => `(${position.map((value) => value.toFixed(2)).join(',')})米`;
    const scene = sceneProps.map((prop) => prop.kind === 'room'
      ? `房间原点${coordinates(prop.position)}，宽${prop.size.width.toFixed(2)}米、高${prop.size.height.toFixed(2)}米、深${prop.size.length.toFixed(2)}米，绕Y轴${THREE.MathUtils.radToDeg(prop.rotationY).toFixed(0)}度`
      : prop.kind === 'sword'
        ? `剑${prop.id}：刃根坐标${coordinates(prop.position)}，刃长${prop.size.length.toFixed(2)}米、宽${prop.size.width.toFixed(2)}米、厚${prop.size.height.toFixed(2)}米，绕Y轴${THREE.MathUtils.radToDeg(prop.rotationY).toFixed(0)}度`
        : prop.kind === 'phone'
          ? `手机${prop.id}：一部掌心大小、外形明确为普通智能手机的单一小道具，底面中心坐标${coordinates(prop.position)}，宽${prop.size.width.toFixed(2)}米、厚${prop.size.height.toFixed(2)}米、长${prop.size.length.toFixed(2)}米，按场景位置放置，不得放大或替换成平板、笔记本或打印机`
        : `${({ bed: '床', chair: '椅子', sofa: '沙发', table: '桌子', door: '门', phone: '手机', sword: '剑', room: '房间', opponent: '对手占位体' })[prop.kind]}${prop.id}：底面中心坐标${coordinates(prop.position)}，顶面高${(prop.position[1] + prop.size.height).toFixed(2)}米，宽${prop.size.width.toFixed(2)}米、深${prop.size.length.toFixed(2)}米，绕Y轴${THREE.MathUtils.radToDeg(prop.rotationY).toFixed(0)}度`).join('；');
    const scenePrompt = scene ? `场景道具：${scene}。` : '';
    const segmentIndex = motion.indexOf(segment);
    const contacts = promptContext.contacts?.filter((contact) => contact.actionIndex === segmentIndex
      || contact.actionIndex === undefined && contact.phase === segment.template
        && motion.filter((candidate) => candidate.template === segment.template).length === 1) ?? [];
    const contactPrompt = contacts.map((contact) => {
      const part = ({ pelvis: '骨盆', back: '背部', head: '头部', legs: '腿部', hand: '手掌' })[contact.bodyPart];
      const surface = ({ mattress: '床垫上表面', seat: '座面', handle: '门把手', 'interaction-point': '物体交互点', ground: '地面' })[contact.surface];
      return `${part}${contact.relation === 'approach' ? '接近' : contact.relation === 'support' ? '支撑于' : '轻触并停留于'}${contact.propId}的${surface}`;
    }).join('；');
    const physicalPrompt = `严格遵守空间关系：人物和所有道具不得互相穿透；只在声明的身体部位发生接触。动作必须在${duration.toFixed(1)}秒内完成，结束时保持该阶段终姿。${contactPrompt ? `本阶段接触：${contactPrompt}。` : ''}`;
    const aiDetail = promptContext.aiDetails?.find((detail) => detail.index === i + 1);
    const sourcePrompt = promptContext.sourcePrompt?.trim() ?? '';
    const storyContext = sourcePrompt ? `故事与人物设定：${sourcePrompt}。` : '';
    const aiVisualStyle = aiDetail?.visualStyle?.slice(0, 80) ?? '';
    const visualStyle = aiVisualStyle ? `${aiVisualStyle}，` : '';
    const continuity = aiDetail?.continuity ? `连续性要求：${aiDetail.continuity}。` : '保持同一角色、服装、道具和光线连续。';
    const imageAction = imageActionDescription(segment.template, segment.clause, sceneProps.some((prop) => prop.kind === 'phone'));
    const imageScene = imageSceneDescription(sceneProps);
    const imageCamera = imageCameraDescription(cameraKeys, t0, t1, segment.template);
    const comfyPrompt = `Photorealistic 16:9 landscape storyboard. ${imageCamera}. ${imageCharacterDescription(sourcePrompt)}; ${imageAction}. Scene: ${imageScene}. Full person head to toe with margins; hand and object visible, natural scale, soft daylight.${aiVisualStyle ? ` Style: ${aiVisualStyle}.` : ''}`
      .slice(0, 450).trimEnd();
    const comfyNegativePrompt = [
      'close-up, portrait crop, cropped head, cropped feet, out of frame',
      ...(sceneProps.some((prop) => prop.kind === 'phone') ? ['second phone, duplicate phone, tablet, laptop, printer, fax machine, extra electronics'] : []),
      'papers, clutter, extra people, extra objects, malformed hands, text, watermark, blurry',
    ].join(', ');
    return {
      index: i + 1, t0, t1, action, shot, camera, effects, scene,
      comfyPrompt,
      comfyNegativePrompt,
      vpipePrompt: `${duration.toFixed(1)}秒，${storyContext}${visualStyle}${shot}。${scenePrompt}${action}。${physicalPrompt}${effectPrompt}${camera}。真实电影镜头，人物动作连续，${continuity}无字幕，无镜头闪切。`,
    };
  });
}

export function storyboardText(shots: StoryboardShot[]): string {
  return shots.map((shot) => [
    `镜头 ${shot.index} | ${shot.t0.toFixed(1)}-${shot.t1.toFixed(1)}s | ${shot.shot}`,
    `动作：${shot.action}`,
    `相机：${shot.camera}`,
    ...(shot.scene ? [`场景：${shot.scene}`] : []),
    ...(shot.effects ? [`特效：${shot.effects}`] : []),
    `ComfyUI 首尾帧提示词：${shot.comfyPrompt}`,
    `vpipe 视频提示词：${shot.vpipePrompt}`,
  ].join('\n')).join('\n\n');
}
