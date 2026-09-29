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
  /** Rebuild recipe for editor-generated sketch characters saved in project.json. */
  sketchSource?: {
    landmarks: Partial<Record<'head' | 'neck' | 'shoulder' | 'elbow' | 'wrist' | 'hips' | 'knee' | 'ankle', { x: number; y: number }>>;
    options: { headR: number; thickness: number };
  };
}
