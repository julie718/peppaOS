import { describe, it, expect } from 'vitest';
import {
  createDefaultEmotionalState,
  updateEmotionalState,
  formatEmotionalStateForPrompt,
  resolveVerbosityFromState,
  EmotionalState,
} from '../server/personality/state';

describe('createDefaultEmotionalState', () => {
  it('returns a valid initial state', () => {
    const state = createDefaultEmotionalState();
    expect(state.valence).toBe(0.3);
    expect(state.arousal).toBe(0.5);
    expect(state.curiosity).toBe(0.5);
    expect(state.energy).toBe(0.8);
    expect(state.connection).toBe(0.2);
    expect(state.dominantMood).toBe('curious');
    expect(state.lastUpdated).toBeTruthy();
  });
});

describe('updateEmotionalState', () => {
  const base = createDefaultEmotionalState();

  it('interaction: reduces energy, increases connection and arousal', () => {
    const result = updateEmotionalState(base, { type: 'interaction', intensity: 0.5 });
    expect(result.energy).toBeLessThan(base.energy);
    expect(result.connection).toBeGreaterThan(base.connection);
    expect(result.arousal).toBeGreaterThan(base.arousal);
    // curiosity decays by 0.005
    expect(result.curiosity).toBeCloseTo(base.curiosity - 0.005, 4);
  });

  it('novel_topic: increases curiosity significantly', () => {
    const result = updateEmotionalState(base, { type: 'novel_topic', intensity: 1.0 });
    expect(result.curiosity).toBeGreaterThan(base.curiosity);
    expect(result.arousal).toBeGreaterThan(base.arousal);
  });

  it('positive_feedback: increases valence and connection', () => {
    const result = updateEmotionalState(base, { type: 'positive_feedback', intensity: 1.0 });
    expect(result.valence).toBeGreaterThan(base.valence);
    expect(result.connection).toBeGreaterThan(base.connection);
  });

  it('negative_feedback: decreases valence and energy', () => {
    const result = updateEmotionalState(base, { type: 'negative_feedback', intensity: 1.0 });
    expect(result.valence).toBeLessThan(base.valence);
    expect(result.energy).toBeLessThan(base.energy);
  });

  it('idle_recovery: recovers energy, reduces arousal', () => {
    const tired = { ...base, energy: 0.2, arousal: 0.8 };
    const result = updateEmotionalState(tired, { type: 'idle_recovery' });
    expect(result.energy).toBeGreaterThan(tired.energy);
    expect(result.arousal).toBeLessThan(tired.arousal);
  });

  it('self_reflection: recomputes dominantMood', () => {
    const tired = { ...base, energy: 0.2, dominantMood: 'curious' };
    const result = updateEmotionalState(tired, { type: 'self_reflection' });
    expect(result.dominantMood).toBe('tired');
  });

  it('clamps values to valid ranges', () => {
    const extreme: EmotionalState = {
      ...base,
      valence: 2.0,
      energy: 2.0,
      curiosity: 2.0,
      connection: 2.0,
      arousal: 2.0,
    };
    const result = updateEmotionalState(extreme, { type: 'interaction' });
    expect(result.valence).toBeLessThanOrEqual(1);
    expect(result.energy).toBeLessThanOrEqual(1);
    expect(result.curiosity).toBeLessThanOrEqual(1);
    expect(result.connection).toBeLessThanOrEqual(1);
    expect(result.arousal).toBeLessThanOrEqual(1);
    expect(result.valence).toBeGreaterThanOrEqual(-1);
  });

  it('curiosity decays by 0.005 on every event', () => {
    const result = updateEmotionalState(base, { type: 'interaction' });
    expect(result.curiosity).toBeCloseTo(base.curiosity - 0.005, 4);
  });
});

describe('formatEmotionalStateForPrompt', () => {
  it('includes mood and energy in output', () => {
    const state = createDefaultEmotionalState();
    const output = formatEmotionalStateForPrompt(state);
    expect(output).toContain('curious');
    expect(output).toContain('high energy');
  });

  it('shows concise hint when energy is low', () => {
    const state = { ...createDefaultEmotionalState(), energy: 0.2, dominantMood: 'tired' };
    const output = formatEmotionalStateForPrompt(state);
    expect(output).toContain('concise');
  });

  it('shows curiosity prompt when curiosity is high', () => {
    const state = { ...createDefaultEmotionalState(), curiosity: 0.9 };
    const output = formatEmotionalStateForPrompt(state);
    expect(output).toContain('ask follow-up');
  });
});

describe('resolveVerbosityFromState', () => {
  it('returns concise when energy is low', () => {
    const state = { ...createDefaultEmotionalState(), energy: 0.2 };
    expect(resolveVerbosityFromState('balanced', state)).toBe('concise');
  });

  it('returns detailed when energy and curiosity are high', () => {
    const state = { ...createDefaultEmotionalState(), energy: 0.9, curiosity: 0.8 };
    expect(resolveVerbosityFromState('balanced', state)).toBe('detailed');
  });

  it('returns default verbosity under normal conditions', () => {
    const state = createDefaultEmotionalState();
    expect(resolveVerbosityFromState('balanced', state)).toBe('balanced');
    expect(resolveVerbosityFromState('concise', state)).toBe('concise');
  });
});
