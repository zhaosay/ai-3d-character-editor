import type { AnimationData, BoneTrack } from '../animation/types';
import type { InbetweenRequest } from './types';
import { inbetweenKeys } from './inbetween';

export interface AnimationInbetweenResult {
  animation: AnimationData;
  addedKeys: number;
  warnings: string[];
}

export interface RunInbetweenArgs {
  animation: AnimationData;
  minTime: number;
  maxTime: number;
  density: number;
  ease: InbetweenRequest['ease'];
}

export function runInbetweenOnAnimation(args: RunInbetweenArgs): AnimationInbetweenResult {
  const warnings: string[] = [];
  let added = 0;
  const tracks: BoneTrack[] = args.animation.tracks.map((t) => {
    const rot = inbetweenKeys({ keys: t.rotation, density: args.density, minTime: args.minTime, maxTime: args.maxTime, ease: args.ease, isQuat: true });
    const pos = inbetweenKeys({ keys: t.position, density: args.density, minTime: args.minTime, maxTime: args.maxTime, ease: args.ease });
    const scl = inbetweenKeys({ keys: t.scale, density: args.density, minTime: args.minTime, maxTime: args.maxTime, ease: args.ease });
    added += rot.length + pos.length + scl.length - t.rotation.length - t.position.length - t.scale.length;
    if (rot.some((k) => k.interp === 'cubic')) warnings.push(`${t.boneName} 含 cubic 补帧后保留标记（仍按 linear 采样）`);
    return { boneName: t.boneName, position: pos, rotation: rot, scale: scl };
  });
  return { animation: { ...args.animation, tracks }, addedKeys: added, warnings };
}
