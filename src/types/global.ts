export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface GltfInfo {
  meshes: number;
  materials: number;
  bones: number;
  hasSkin: boolean;
  hasAnimations: number;
}

export interface CharacterMeta {
  id: string;
  fileName: string;
  fileSize: number;
  gltfInfo: GltfInfo;
}
