import { HandLandmarker, FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';

let handLandmarker: HandLandmarker | null = null;
let faceDetector: FaceDetector | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initMediaPipe(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: FACE_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.6,
    });

    initialized = true;
  })();

  return initPromise;
}

export type HandResult = {
  handedness: 'Left' | 'Right';
  landmarks: Array<{ x: number; y: number; z: number }>;
};

export type FaceResult = {
  boundingBox: { x: number; y: number; width: number; height: number };
  score: number;
};

export function detectHands(video: HTMLVideoElement): HandResult[] {
  if (!handLandmarker) return [];
  const now = performance.now();
  const result = handLandmarker.detectForVideo(video, now);
  const hands: HandResult[] = [];
  for (let i = 0; i < result.handednesses.length; i++) {
    const h = result.handednesses[i];
    const lm = result.landmarks[i];
    if (!lm) continue;
    hands.push({
      handedness: h[0]?.categoryName as 'Left' | 'Right',
      landmarks: lm.map(l => ({ x: l.x, y: l.y, z: l.z })),
    });
  }
  return hands;
}

export function detectFaces(video: HTMLVideoElement): FaceResult[] {
  if (!faceDetector) return [];
  const now = performance.now();
  const result = faceDetector.detectForVideo(video, now);
  return result.detections.map(d => ({
    boundingBox: {
      x: d.boundingBox.originX,
      y: d.boundingBox.originY,
      width: d.boundingBox.width,
      height: d.boundingBox.height,
    },
    score: d.categories[0]?.score ?? 0,
  }));
}

export function isMediaPipeReady(): boolean {
  return initialized;
}
