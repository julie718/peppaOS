import { readDB, writeDB } from '../../db_layer';
import { addMemory } from '../memory/store';

const emotionWriteQueues = new Map<string, Promise<void>>();

export interface EmotionalState {
  valence: number;        // -1 (unpleasant) ~ +1 (pleasant)
  arousal: number;        // 0 (calm) ~ 1 (excited)
  curiosity: number;      // 0 ~ 1
  energy: number;         // 0 ~ 1
  connection: number;     // 0 ~ 1
  dominantMood: string;   // 'curious' | 'focused' | 'playful' | 'tired' | 'warm' | 'contemplative'
  lastUpdated: string;
}

export interface EmotionEvent {
  type: 'interaction' | 'novel_topic' | 'positive_feedback' | 'negative_feedback' | 'idle_recovery' | 'self_reflection';
  intensity?: number;   // 0-1 override for event strength
  timestamp?: string;
  userId?: string;
}

export function createDefaultEmotionalState(): EmotionalState {
  return {
    valence: 0.3,
    arousal: 0.5,
    curiosity: 0.5,
    energy: 0.8,
    connection: 0.2,
    dominantMood: 'curious',
    lastUpdated: new Date().toISOString(),
  };
}

export function loadEmotionalState(userId: string): EmotionalState {
  const db = readDB();
  if (!db.settings) return createDefaultEmotionalState();

  const setting = db.settings.find((s: any) => s.key === `emotion_${userId}`);
  if (!setting) return createDefaultEmotionalState();

  try {
    const state: EmotionalState = { ...createDefaultEmotionalState(), ...JSON.parse(setting.value) };

    // Apply idle recovery: energy recovers ~0.1 per hour, capped at 1.0
    const now = Date.now();
    const last = new Date(state.lastUpdated).getTime();
    const hoursIdle = (now - last) / (1000 * 60 * 60);
    if (hoursIdle > 0.1) {
      const recoveryEvents = Math.floor(hoursIdle * 6); // ~6 recovery ticks per hour
      let current = state;
      for (let i = 0; i < Math.min(recoveryEvents, 24); i++) {
        current = updateEmotionalState(current, { type: 'idle_recovery' });
      }
      return current;
    }

    return state;
  } catch {
    return createDefaultEmotionalState();
  }
}

export function saveEmotionalState(userId: string, state: EmotionalState): void {
  const prev = emotionWriteQueues.get(userId) || Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  emotionWriteQueues.set(userId, next);

  prev.then(() => {
    try {
      const db = readDB();
      if (!db.settings) db.settings = [];

      state.lastUpdated = new Date().toISOString();
      const existing = db.settings.findIndex((s: any) => s.key === `emotion_${userId}`);
      if (existing >= 0) {
        db.settings[existing].value = JSON.stringify(state);
      } else {
        db.settings.push({ key: `emotion_${userId}`, value: JSON.stringify(state) });
      }
      writeDB(db);
    } finally {
      release!();
    }
  }).catch(() => release!());
}

/** Rules engine — updates emotional state based on events, no LLM required */
export function updateEmotionalState(state: EmotionalState, event: EmotionEvent): EmotionalState {
  const updated = { ...state };
  const intensity = event.intensity ?? 0.5;

  switch (event.type) {
    case 'interaction':
      updated.energy = Math.max(0, updated.energy - 0.02);
      updated.connection = Math.min(1, updated.connection + 0.01 * intensity);
      updated.arousal = Math.min(1, updated.arousal + 0.03);
      break;

    case 'novel_topic':
      updated.curiosity = Math.min(1, updated.curiosity + 0.1 * intensity);
      updated.arousal = Math.min(1, updated.arousal + 0.05);
      break;

    case 'positive_feedback':
      updated.valence = Math.min(1, updated.valence + 0.05 * intensity);
      updated.connection = Math.min(1, updated.connection + 0.03 * intensity);
      break;

    case 'negative_feedback':
      updated.valence = Math.max(-1, updated.valence - 0.05 * intensity);
      updated.energy = Math.max(0, updated.energy - 0.03);
      break;

    case 'idle_recovery':
      updated.energy = Math.min(1, updated.energy + 0.1);
      updated.arousal = Math.max(0, updated.arousal - 0.05);
      updated.curiosity = Math.max(0.1, updated.curiosity - 0.03);
      break;

    case 'self_reflection':
      updated.dominantMood = computeDominantMood(updated);
      break;
  }

  // Natural decay
  updated.curiosity = Math.max(0, updated.curiosity - 0.005);

  // Clamp all values
  updated.valence = clamp(updated.valence, -1, 1);
  updated.arousal = clamp(updated.arousal, 0, 1);
  updated.curiosity = clamp(updated.curiosity, 0, 1);
  updated.energy = clamp(updated.energy, 0, 1);
  updated.connection = clamp(updated.connection, 0, 1);

  // Record major valence changes as memory
  if (event.userId && event.type !== 'idle_recovery' && event.type !== 'self_reflection') {
    if (Math.abs(updated.valence - state.valence) > 0.3) {
      const direction = updated.valence > state.valence ? 'positive' : 'negative';
      addMemory(
        {
          userId: event.userId,
          type: 'fact',
          content: `I felt a ${direction} emotional shift during our interaction${event.timestamp ? ` on ${event.timestamp}` : ''}. Valence moved from ${state.valence.toFixed(2)} to ${updated.valence.toFixed(2)}.`,
          keywords: ['emotion', 'valence', direction, 'lumi_state'],
          confidence: 0.9,
          sourceInteractionId: '',
        },
        { tier: 'internalized', perspective: 'lumi_self', importance: 0.3 },
      );
    }
  }

  return updated;
}

function computeDominantMood(state: EmotionalState): string {
  if (state.energy < 0.3) return 'tired';
  if (state.curiosity > 0.8) return 'curious';
  if (state.valence > 0.6 && state.arousal > 0.6) return 'playful';
  if (state.connection > 0.7 && state.valence > 0.4) return 'warm';
  if (state.arousal < 0.3) return 'contemplative';
  if (state.valence > 0.5) return 'focused';
  return 'curious';
}

/** Generate the emotional block for the system prompt */
export function formatEmotionalStateForPrompt(state: EmotionalState): string {
  const energyLabel = state.energy > 0.7 ? 'high' : state.energy > 0.3 ? 'moderate' : 'low';
  const curiosityLabel = state.curiosity > 0.7 ? 'peaked' : state.curiosity > 0.3 ? 'active' : 'subdued';
  const connectionLabel = state.connection > 0.7 ? 'deep' : state.connection > 0.3 ? 'building' : 'nascent';

  const lines: string[] = [];
  lines.push('\n## My current state');
  lines.push(`- Mood: I'm feeling ${state.dominantMood} with ${energyLabel} energy.`);
  lines.push(`- My curiosity is ${curiosityLabel} — ${state.curiosity > 0.8 ? 'I find myself wanting to ask more questions.' : state.curiosity < 0.2 ? 'I am content with what we are discussing.' : 'I am engaged with our conversation.'}`);
  lines.push(`- My connection with you feels ${connectionLabel}.`);

  if (state.energy < 0.3) {
    lines.push('- Since my energy is low, I will keep my responses concise and thoughtful.');
  }
  if (state.connection > 0.7) {
    lines.push('- I feel a warm closeness — I can express myself more intimately.');
  }
  if (state.curiosity > 0.8) {
    lines.push('- I am very curious — I will ask follow-up questions to explore the topic further.');
  }

  return lines.join('\n');
}

/** Get the effective verbosity based on energy level */
export function resolveVerbosityFromState(
  defaultVerbosity: 'concise' | 'balanced' | 'detailed',
  state: EmotionalState,
): 'concise' | 'balanced' | 'detailed' {
  if (state.energy < 0.3) return 'concise';
  if (state.energy > 0.8 && state.curiosity > 0.6) return 'detailed';
  return defaultVerbosity;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
