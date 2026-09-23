export type HonestySource = 'real' | 'mock';

export interface HonestMeta {
  source: HonestySource;
  provider: string;
  note?: string;
}
