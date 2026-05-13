export interface AtlasDefinition {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  animations: Record<string, AnimationRow>;
}

export interface AnimationRow {
  row: number;
  frameCount: number;
  frameDuration: number; // ms per frame
  loop?: boolean;
}

export interface PetConfig {
  id: string;
  name: string;
  author: string;
  spritesheet: string; // base64 data URL or URL path
  atlas: AtlasDefinition;
  thumbnail?: string; // preview image (first idle frame)
}

export type AnimationName = 'idle' | 'run' | 'wave' | 'jump' | 'failed' | 'waiting' | 'review' | 'sleep';

export const DEFAULT_ATLAS: AtlasDefinition = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  animations: {
    idle:      { row: 0, frameCount: 6, frameDuration: 180, loop: true },
    run:       { row: 1, frameCount: 8, frameDuration: 100, loop: true },
    runLeft:   { row: 2, frameCount: 8, frameDuration: 100, loop: true },
    wave:      { row: 3, frameCount: 4, frameDuration: 150, loop: false },
    jump:      { row: 4, frameCount: 6, frameDuration: 80, loop: false },
    failed:    { row: 5, frameCount: 4, frameDuration: 200, loop: false },
    waiting:   { row: 6, frameCount: 4, frameDuration: 250, loop: true },
    runFast:   { row: 7, frameCount: 8, frameDuration: 60, loop: true },
    review:    { row: 8, frameCount: 4, frameDuration: 300, loop: true },
  },
};
