import type { AnimationData } from '../../core/animation/types';

/** Map provider bone names (or shared semantic names) onto this request's rig names. */
export function mapMotionBones(
  animation: AnimationData,
  semanticToRig: Record<string, string>,
  rawMapping?: unknown,
): AnimationData {
  const explicit = new Map<string, string>();
  if (rawMapping !== undefined && rawMapping !== null) {
    if (typeof rawMapping !== 'object' || Array.isArray(rawMapping)) throw new Error('动作服务 bone_mapping 必须是对象');
    for (const [sourceName, destination] of Object.entries(rawMapping as Record<string, unknown>)) {
      if (typeof destination !== 'string' || !destination.trim()) throw new Error(`动作服务 bone_mapping.${sourceName} 必须是非空字符串`);
      const rigName = semanticToRig[destination] ?? destination;
      if (!Object.values(semanticToRig).includes(rigName)) {
        throw new Error(`动作服务 bone_mapping.${sourceName} 指向当前骨架不存在的骨骼/语义 ${destination}`);
      }
      explicit.set(sourceName, rigName);
    }
  }
  const semanticNames = new Map(Object.entries(semanticToRig));
  let changed = false;
  const tracks = animation.tracks.map((track) => {
    const boneName = explicit.get(track.boneName) ?? semanticNames.get(track.boneName) ?? track.boneName;
    if (boneName === track.boneName) return track;
    changed = true;
    return { ...track, boneName };
  });
  return changed ? { ...animation, tracks } : animation;
}
