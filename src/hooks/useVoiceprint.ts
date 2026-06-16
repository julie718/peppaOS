import { useEffect, useRef, useState, useCallback } from 'react';

// ── MFCC extraction (pure JS, 16kHz mono PCM) ──

function hammingWindow(n: number, N: number): number {
  return 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
}

// Iterative radix-2 FFT, in-place
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const reL = re[i + j], imL = im[i + j];
        const reR = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const imR = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = reL + reR;
        im[i + j] = imL + imR;
        re[i + j + half] = reL - reR;
        im[i + j + half] = imL - imR;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// Mel scale conversion
function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

// Pre-compute Mel filter bank (26 triangular filters for 0–8kHz)
const FFT_SIZE = 256;
const NUM_FILTERS = 26;
const SAMPLE_RATE = 16000;

let melFilterBank: Float64Array[] | null = null;
function getMelFilterBank(): Float64Array[] {
  if (melFilterBank) return melFilterBank;

  const lowMel = hzToMel(0);
  const highMel = hzToMel(SAMPLE_RATE / 2);
  const melPoints = new Float64Array(NUM_FILTERS + 2);
  for (let i = 0; i < NUM_FILTERS + 2; i++) {
    melPoints[i] = melToHz(lowMel + ((highMel - lowMel) * i) / (NUM_FILTERS + 1));
  }

  const binFreqs = new Float64Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    binFreqs[i] = (i * SAMPLE_RATE) / FFT_SIZE;
  }

  melFilterBank = [];
  for (let m = 0; m < NUM_FILTERS; m++) {
    const filter = new Float64Array(FFT_SIZE / 2);
    const fLow = melPoints[m];
    const fCenter = melPoints[m + 1];
    const fHigh = melPoints[m + 2];
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      const f = binFreqs[k];
      if (f > fLow && f < fCenter) filter[k] = (f - fLow) / (fCenter - fLow);
      else if (f >= fCenter && f < fHigh) filter[k] = (fHigh - f) / (fHigh - fCenter);
    }
    melFilterBank.push(filter);
  }
  return melFilterBank;
}

// DCT Type-II, returns first `numCoeffs` coefficients
function dct(input: Float64Array, numCoeffs: number): Float64Array {
  const out = new Float64Array(numCoeffs);
  const N = input.length;
  for (let k = 0; k < numCoeffs; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    out[k] = sum * Math.sqrt(2 / N);
  }
  return out;
}

function extractMFCC(samples: Float32Array): number[] {
  const N = FFT_SIZE;
  if (samples.length < N) {
    // Zero-pad to FFT_SIZE
    const padded = new Float32Array(N);
    padded.set(samples);
    samples = padded;
  }

  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // Pre-emphasis + Hamming window
  for (let i = 0; i < N; i++) {
    let s = i < samples.length ? samples[i] : 0;
    if (i > 0) s = s - 0.97 * samples[Math.min(i - 1, samples.length - 1)];
    re[i] = s * hammingWindow(i, N);
    im[i] = 0;
  }

  fft(re, im);

  // Power spectrum
  const power = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    power[i] = (re[i] * re[i] + im[i] * im[i]) / N;
  }

  // Mel filter bank energy
  const filters = getMelFilterBank();
  const melEnergy = new Float64Array(NUM_FILTERS);
  for (let m = 0; m < NUM_FILTERS; m++) {
    let energy = 0;
    for (let k = 0; k < N / 2; k++) {
      energy += power[k] * filters[m][k];
    }
    melEnergy[m] = Math.max(energy, 1e-10);
  }

  // Log energy
  for (let i = 0; i < NUM_FILTERS; i++) {
    melEnergy[i] = Math.log(melEnergy[i]);
  }

  // DCT → 13 MFCC coefficients
  const mfcc = dct(melEnergy, 13);
  return Array.from(mfcc);
}

// ── Cosine similarity ──

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA < 1e-10 || normB < 1e-10) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── RMS ──

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ── Types ──

export interface VoiceprintResult {
  isOwnerSpeaking: boolean;
  confidence: number;
  speakerLabel: string | null;
  threshold: 'high' | 'medium' | 'low' | 'reject';
  rms: number;
}

// ── Hook ──

interface VoiceprintTemplate {
  uid: string;
  label: string;
  mfccFrames: number[][];   // accumulated MFCC vectors from enrollment
  voiceprintId: string;
}

interface UseVoiceprintOptions {
  socket?: any;            // Socket.IO socket for server-side gating
}

export function useVoiceprint(options?: UseVoiceprintOptions) {
  const socketRef = useRef(options?.socket);
  socketRef.current = options?.socket;

  const [result, setResult] = useState<VoiceprintResult>({
    isOwnerSpeaking: false,
    confidence: 0,
    speakerLabel: null,
    threshold: 'reject',
    rms: 0,
  });
  const [enrolledCount, setEnrolledCount] = useState(0);
  const [templateFrameCount, setTemplateFrameCount] = useState(0);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  const templatesRef = useRef<VoiceprintTemplate[]>([]);
  const frameBufferRef = useRef<Float32Array[]>([]);
  const lastCheckTimeRef = useRef(0);
  const isEnrollingRef = useRef(false);
  const enrollmentFramesRef = useRef<number[][]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onVoiceprintResultRef = useRef<((r: VoiceprintResult) => void) | null>(null);

  // ── Load enrolled templates from server ──
  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/biometric/list', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const templates = (data.voiceprints || []).map((vp: any) => ({
          uid: 'owner',
          label: vp.label,
          voiceprintId: vp.id,
          mfccFrames: Array.isArray(vp.mfccFeatures) ? vp.mfccFeatures : [],
        }));
        templatesRef.current = templates;
        setEnrolledCount(templates.length);
        setTemplateFrameCount(templates.reduce((sum: number, tpl: VoiceprintTemplate) => sum + tpl.mfccFrames.length, 0));
      }
    } catch {
      templatesRef.current = [];
      setEnrolledCount(0);
      setTemplateFrameCount(0);
    } finally {
      setTemplatesLoaded(true);
    }
  }, []);

  // ── Start microphone capture independently for voiceprint ──
  const startListening = useCallback(async () => {
    if (audioContextRef.current) return; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = FFT_SIZE * 2;
      source.connect(analyserRef.current);

      // Process audio every ~256ms (matches 4096 samples @ 16kHz)
      const processInterval = () => {
        if (!analyserRef.current) return;
        const buffer = new Float32Array(FFT_SIZE);
        analyserRef.current.getFloatTimeDomainData(buffer);
        const rms = computeRMS(buffer);
        if (rms > 0.01) {
          frameBufferRef.current.push(new Float32Array(buffer));
          // Keep only last 10 frames (~2.5s of speech)
          if (frameBufferRef.current.length > 10) frameBufferRef.current.shift();

          // Check every ~500ms (every other frame)
          const now = Date.now();
          if (now - lastCheckTimeRef.current > 500 && frameBufferRef.current.length >= 3) {
            lastCheckTimeRef.current = now;
            const averagedMFCC = getAveragedMFCC();
            if (averagedMFCC) {
              const matchResult = compareWithTemplates(averagedMFCC);
              setResult(matchResult);
              onVoiceprintResultRef.current?.(matchResult);
              // Forward to server for voice gating
              socketRef.current?.emit('voiceprint:result', {
                isOwnerSpeaking: matchResult.isOwnerSpeaking,
                confidence: matchResult.confidence,
              });
            }
          }
        }
      };

      intervalRef.current = setInterval(processInterval, 256);
    } catch {
      // Mic not available — voiceprint won't work, but doesn't break the app
    }
  }, []);

  const stopListening = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    analyserRef.current = null;
    frameBufferRef.current = [];
  }, []);

  // ── Average MFCC over recent frames ──
  function getAveragedMFCC(): number[] | null {
    const frames = frameBufferRef.current;
    if (frames.length < 3) return null;
    const mfccFrames = frames.map(f => extractMFCC(f));
    const avg = new Array(13).fill(0);
    for (const mfcc of mfccFrames) {
      for (let i = 0; i < 13; i++) avg[i] += mfcc[i];
    }
    for (let i = 0; i < 13; i++) avg[i] /= mfccFrames.length;
    return avg;
  }

  // ── Compare against stored templates ──
  function compareWithTemplates(mfcc: number[]): VoiceprintResult {
    let bestConfidence = 0;
    let bestLabel: string | null = null;

    for (const tpl of templatesRef.current) {
      if (tpl.mfccFrames.length === 0) continue;
      for (const frame of tpl.mfccFrames) {
        const sim = cosineSimilarity(mfcc, frame);
        if (sim > bestConfidence) { bestConfidence = sim; bestLabel = tpl.label; }
      }
    }

    let threshold: VoiceprintResult['threshold'] = 'reject';
    if (bestConfidence >= 0.75) threshold = 'high';
    else if (bestConfidence >= 0.55) threshold = 'medium';
    else if (bestConfidence >= 0.40) threshold = 'low';

    return {
      isOwnerSpeaking: bestConfidence >= 0.55,
      confidence: Math.round(bestConfidence * 100) / 100,
      speakerLabel: bestLabel,
      threshold,
      rms: 0,
    };
  }

  // ── Enrollment ──
  const startEnrollment = useCallback(async (label: string) => {
    isEnrollingRef.current = true;
    enrollmentFramesRef.current = [];
    await startListening();
    // Collect frames for ~3 seconds
    return new Promise<{ success: boolean; voiceprintId?: string }>((resolve) => {
      const collectInterval = setInterval(() => {
        if (!isEnrollingRef.current) {
          clearInterval(collectInterval);
          resolve({ success: false });
          return;
        }
        const frames = frameBufferRef.current;
        if (frames.length > 0) {
          const mfcc = extractMFCC(frames[frames.length - 1]);
          enrollmentFramesRef.current.push(mfcc);
        }
        if (enrollmentFramesRef.current.length >= 12) {
          // ~3 seconds of voice collected
          isEnrollingRef.current = false;
          clearInterval(collectInterval);
          submitEnrollment(label).then(resolve);
        }
      }, 256);
      // Timeout after 10s
      setTimeout(() => {
        isEnrollingRef.current = false;
        clearInterval(collectInterval);
        submitEnrollment(label).then(resolve);
      }, 10000);
    });
  }, [startListening]);

  const cancelEnrollment = useCallback(() => {
    isEnrollingRef.current = false;
  }, []);

  async function submitEnrollment(label: string): Promise<{ success: boolean; voiceprintId?: string }> {
    const frames = enrollmentFramesRef.current;
    if (frames.length < 4) return { success: false };
    try {
      const res = await fetch('/api/auth/biometric/voiceprint/enroll', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ label, mfccFeatures: frames, sampleCount: frames.length }),
      });
      if (res.ok) {
        const data = await res.json();
        // Add to local templates
        templatesRef.current.push({
          uid: 'owner',
          label,
          voiceprintId: data.voiceprint.id,
          mfccFrames: frames,
        });
        setEnrolledCount(templatesRef.current.length);
        setTemplateFrameCount(prev => prev + frames.length);
        return { success: true, voiceprintId: data.voiceprint.id };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }

  // ── Callback registration ──
  const onResult = useCallback((cb: (r: VoiceprintResult) => void) => {
    onVoiceprintResultRef.current = cb;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    result,
    loadTemplates,
    startListening,
    stopListening,
    startEnrollment,
    cancelEnrollment,
    onResult,
    enrolledCount,
    hasUsableTemplates: templateFrameCount > 0,
    templatesLoaded,
    isListening: !!audioContextRef.current,
    isEnrolling: isEnrollingRef.current,
  };
}
