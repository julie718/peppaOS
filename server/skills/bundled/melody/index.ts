import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── Music theory engine ──────────────────────────────────────────────────────

type Note = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';

const CHROMATIC: Note[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const MAJOR_INTERVALS = [2, 2, 1, 2, 2, 2, 1];
const MINOR_INTERVALS = [2, 1, 2, 2, 1, 2, 2];

const SCALE_PATTERNS: Record<string, number[]> = {
  major: MAJOR_INTERVALS,
  minor: MINOR_INTERVALS,
  harmonic_minor: [2, 1, 2, 2, 1, 3, 1],
  melodic_minor: [2, 1, 2, 2, 2, 2, 1],
  pentatonic_major: [2, 2, 3, 2, 3],
  pentatonic_minor: [3, 2, 2, 3, 2],
  blues: [3, 2, 1, 1, 3, 2],
  dorian: [2, 1, 2, 2, 2, 1, 2],
  phrygian: [1, 2, 2, 2, 1, 2, 2],
  lydian: [2, 2, 2, 1, 2, 2, 1],
  mixolydian: [2, 2, 1, 2, 2, 1, 2],
  locrian: [1, 2, 2, 1, 2, 2, 2],
};

const SCALE_NAMES: Record<string, string> = {
  major: 'Major (Ionian)',
  minor: 'Natural Minor (Aeolian)',
  harmonic_minor: 'Harmonic Minor',
  melodic_minor: 'Melodic Minor',
  pentatonic_major: 'Major Pentatonic',
  pentatonic_minor: 'Minor Pentatonic',
  blues: 'Blues',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
};

const CHORD_TYPES: Record<string, number[]> = {
  '': [0, 4, 7],
  'm': [0, 3, 7],
  'dim': [0, 3, 6],
  'aug': [0, 4, 8],
  'sus2': [0, 2, 7],
  'sus4': [0, 5, 7],
  '7': [0, 4, 7, 10],
  'maj7': [0, 4, 7, 11],
  'm7': [0, 3, 7, 10],
  'm7b5': [0, 3, 6, 10],
  'dim7': [0, 3, 6, 9],
  '6': [0, 4, 7, 9],
  'm6': [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 14],
  'maj9': [0, 4, 7, 11, 14],
  'm9': [0, 3, 7, 10, 14],
  'add9': [0, 4, 7, 14],
};

const CHORD_NAMES: Record<string, string> = {
  '': 'Major', 'm': 'Minor', 'dim': 'Diminished', 'aug': 'Augmented',
  'sus2': 'Sus2', 'sus4': 'Sus4', '7': 'Dominant 7th', 'maj7': 'Major 7th',
  'm7': 'Minor 7th', 'm7b5': 'Half-dim 7th', 'dim7': 'Diminished 7th',
  '6': 'Major 6th', 'm6': 'Minor 6th', '9': 'Dominant 9th', 'maj9': 'Major 9th',
  'm9': 'Minor 9th', 'add9': 'Add9',
};

const PROGRESSIONS: Record<string, { chords: string[]; description: string }> = {
  'I-V-vi-IV': { chords: ['I', 'V', 'vi', 'IV'], description: 'Pop anthem progression — upbeat, hopeful, universally appealing' },
  'I-vi-IV-V': { chords: ['I', 'vi', 'IV', 'V'], description: '50s progression / doo-wop — nostalgic, romantic, sweet' },
  'vi-IV-I-V': { chords: ['vi', 'IV', 'I', 'V'], description: 'Emotional pop — passionate, anthemic, builds intensity' },
  'I-IV-V-I': { chords: ['I', 'IV', 'V', 'I'], description: 'Perfect cadence — classical, resolved, complete' },
  'ii-V-I': { chords: ['ii', 'V', 'I'], description: 'Jazz turnaround — sophisticated, resolves beautifully' },
  'I-V-vi-iii-IV-I-IV-V': { chords: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], description: 'Pachelbel Canon — timeless, elegant, flowing' },
  'vi-V-IV-III': { chords: ['vi', 'V', 'IV', 'III'], description: 'Andalusian cadence — dramatic, passionate, flamenco' },
  'I-vi-ii-V': { chords: ['I', 'vi', 'ii', 'V'], description: 'Jazz pop — smooth, late-night feel' },
  'i-VI-III-VII': { chords: ['i', 'VI', 'III', 'VII'], description: 'Minor epic — dark, cinematic, powerful' },
  'i-iv-V-i': { chords: ['i', 'iv', 'V', 'i'], description: 'Minor cadence — classical minor, dramatic resolution' },
};

const PENTATONIC_MOODS: Record<string, { scale: string; baseNote: string; description: string }> = {
  'warm': { scale: 'pentatonic_major', baseNote: 'C', description: 'C Major Pentatonic — warm, bright, like a sunrise' },
  'nostalgic': { scale: 'pentatonic_major', baseNote: 'G', description: 'G Major Pentatonic — gentle nostalgia, like old photographs' },
  'dreamy': { scale: 'pentatonic_major', baseNote: 'D', description: 'D Major Pentatonic — ethereal, floating, daydream-like' },
  'melancholic': { scale: 'pentatonic_minor', baseNote: 'A', description: 'A Minor Pentatonic — soft melancholy, rain-on-window feeling' },
  'heroic': { scale: 'pentatonic_major', baseNote: 'E', description: 'E Major Pentatonic — bold, expansive, cinematic' },
  'peaceful': { scale: 'pentatonic_major', baseNote: 'F', description: 'F Major Pentatonic — serene, grounded, nature-like' },
  'playful': { scale: 'pentatonic_major', baseNote: 'G', description: 'G Major Pentatonic — light, bouncy, childlike joy' },
  'mysterious': { scale: 'pentatonic_minor', baseNote: 'D', description: 'D Minor Pentatonic — mysterious, misty, introspective' },
};

function noteToMidi(note: string): number {
  const match = note.match(/^([A-G]#?)(\d)$/);
  if (!match) throw new Error(`Invalid note: ${note}`);
  const semitone = CHROMATIC.indexOf(match[1] as Note);
  const octave = parseInt(match[2]);
  return (octave + 1) * 12 + semitone;
}

function midiToNote(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = midi % 12;
  return `${CHROMATIC[semitone]}${octave}`;
}

function buildScale(root: Note, pattern: number[]): string[] {
  let idx = CHROMATIC.indexOf(root);
  const notes: string[] = [root];
  for (const interval of pattern.slice(0, -1)) {
    idx = (idx + interval) % 12;
    notes.push(CHROMATIC[idx]);
  }
  return notes;
}

function scaleNotesInOctaves(root: Note, pattern: number[], octaves: number = 3): string[] {
  const scaleNotes = buildScale(root, pattern);
  const result: string[] = [];
  for (let oct = 3; oct < 3 + octaves; oct++) {
    for (const note of scaleNotes) {
      result.push(`${note}${oct}`);
    }
  }
  return result;
}

function buildChord(root: string, type: string): { name: string; notes: string[]; midiNotes: number[] } {
  const intervals = CHORD_TYPES[type] || CHORD_TYPES[''];
  const rootMidi = noteToMidi(root);
  const midiNotes = intervals.map(i => rootMidi + i);
  const noteNames = midiNotes.map(midiToNote);
  const suffix = CHORD_NAMES[type] || type;
  return { name: `${midiToNote(rootMidi)} ${suffix}`, notes: noteNames, midiNotes };
}

function romanToScaleDegree(roman: string): number {
  const degreeMap: Record<string, number> = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 };
  const clean = roman.replace(/[^IV]/g, '');
  let degree = degreeMap[clean] ?? 0;
  if (roman.startsWith('b')) degree = (degree - 1 + 7) % 7;
  if (roman.startsWith('#')) degree = (degree + 1) % 7;
  return degree;
}

function chordQualityFromRoman(roman: string): string {
  if (roman.includes('dim') || roman.includes('°')) return 'dim';
  if (roman.includes('aug') || roman.includes('+')) return 'aug';
  if (/^[a-z]+$/.test(roman.replace(/[#b]/, ''))) return 'm';
  if (roman === roman.toLowerCase() && roman !== roman.toUpperCase()) return 'm';
  return '';
}

// ── Melody composition engine ────────────────────────────────────────────────

interface MelodyNote {
  note: string;
  midi: number;
  duration: number;
  velocity: number;
}

function composeMelody(
  scaleRoot: Note,
  scaleType: string,
  tempo: number,
  measures: number,
  style: 'flowing' | 'rhythmic' | 'gentle' | 'playful' | 'dramatic',
) {
  const pattern = SCALE_PATTERNS[scaleType] || MAJOR_INTERVALS;
  const pool = scaleNotesInOctaves(scaleRoot, pattern, 2);
  const midiPool = pool.map(noteToMidi);

  const notes: MelodyNote[] = [];
  const totalBeats = measures * 4;
  let beat = 0;

  let seed = scaleRoot.charCodeAt(0) * 7 + tempo % 97;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const styleProfiles: Record<string, { durations: number[]; weights: number[]; leapChance: number; restChance: number; velocityRange: [number, number] }> = {
    flowing: { durations: [0.25, 0.5, 1, 2], weights: [0.3, 0.35, 0.25, 0.1], leapChance: 0.3, restChance: 0.05, velocityRange: [70, 100] },
    rhythmic: { durations: [0.25, 0.5, 1, 1.5], weights: [0.4, 0.3, 0.2, 0.1], leapChance: 0.2, restChance: 0.1, velocityRange: [80, 110] },
    gentle: { durations: [0.5, 1, 2, 3], weights: [0.2, 0.4, 0.3, 0.1], leapChance: 0.1, restChance: 0.15, velocityRange: [50, 80] },
    playful: { durations: [0.25, 0.5, 1, 0.75], weights: [0.35, 0.3, 0.2, 0.15], leapChance: 0.4, restChance: 0.08, velocityRange: [75, 105] },
    dramatic: { durations: [0.5, 1, 2, 4], weights: [0.2, 0.35, 0.3, 0.15], leapChance: 0.45, restChance: 0.1, velocityRange: [85, 120] },
  };

  const profile = styleProfiles[style] || styleProfiles.flowing;
  const startChoices = [midiPool[0], midiPool[2], midiPool[4]];
  let currentMidi = startChoices[Math.floor(rand() * startChoices.length)];
  let currentIdx = midiPool.indexOf(currentMidi);
  if (currentIdx < 0) currentIdx = 0;

  while (beat < totalBeats) {
    const dIdx = weightedIndex(profile.weights, rand);
    let duration = profile.durations[dIdx];
    if (beat + duration > totalBeats) duration = totalBeats - beat;
    if (duration <= 0) break;

    if (rand() < profile.restChance && beat > 0) { beat += duration; continue; }

    const stepRange = rand() < profile.leapChance ? [-4, -3, 3, 4] : [-2, -1, 1, 2];
    const step = stepRange[Math.floor(rand() * stepRange.length)];
    currentIdx = Math.max(0, Math.min(midiPool.length - 1, currentIdx + step));
    currentMidi = midiPool[currentIdx];
    const velocity = Math.floor(profile.velocityRange[0] + rand() * (profile.velocityRange[1] - profile.velocityRange[0]));
    notes.push({ note: midiToNote(currentMidi), midi: currentMidi, duration, velocity });
    beat += duration;
  }

  return {
    key: `${scaleRoot} ${SCALE_NAMES[scaleType] || scaleType}`,
    scale: scaleType, tempo, timeSignature: [4, 4], notes, totalBeats,
  };
}

function weightedIndex(weights: number[], rand: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

// ── Output helpers ───────────────────────────────────────────────────────────

function text(data: any, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(isError ? { ok: false, error: data } : { ok: true, ...data }) }], ...(isError ? { isError: true } : {}) };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'peppa-melody',
  version: '1.0.1',
});

// ── Tool 1: music_theory ─────────────────────────────────────────────────────

server.registerTool('music_theory', {
  description: 'Music theory reference — scales, chords, progressions, transposition, and chord analysis.',
  inputSchema: {
    action: z.enum(['scale', 'chord', 'progression', 'chord_in_key', 'transpose', 'analyze']).describe('What to look up'),
    key: z.string().optional().describe('Key or root note, e.g. "C", "Am", "G#", "F"'),
    scale: z.string().optional().describe('Scale type: major, minor, pentatonic_major, pentatonic_minor, blues, dorian, etc.'),
    chord: z.string().optional().describe('Chord name, e.g. "C", "Am", "G7", "Dm7", "Fmaj7"'),
    progression: z.string().optional().describe('Progression name, e.g. "I-V-vi-IV"'),
    mood: z.string().optional().describe('Mood hint: warm, nostalgic, melancholic, epic, playful, romantic, dramatic, jazzy'),
    semitones: z.number().optional().describe('Semitones to transpose'),
    notes: z.string().optional().describe('Comma-separated notes, e.g. "C,E,G,B"'),
  },
}, async (args: any) => {
  try {
    const action = args.action || 'scale';
    switch (action) {
      case 'scale': {
        const key = args.key || 'C';
        const scaleType = args.scale || 'major';
        const root = key.replace(/m$/i, '').replace(/maj/i, '') as Note;
        const pattern = SCALE_PATTERNS[scaleType];
        if (!pattern) return text(`Unknown scale: ${scaleType}`, true);
        const notes = buildScale(root, pattern);
        const fullNotes = scaleNotesInOctaves(root, pattern, 2);
        return text({ scale: `${root} ${SCALE_NAMES[scaleType]}`, notes, fullNotes, pattern: pattern.join('-'),
          relativeMinor: scaleType === 'major' ? buildScale(CHROMATIC[(CHROMATIC.indexOf(root) + 9) % 12] as Note, MINOR_INTERVALS) : null });
      }
      case 'chord': {
        const chordName = args.chord || 'C';
        const match = chordName.match(/^([A-G]#?)(m7b5|maj7|maj9|dim7|sus[24]|add9|m[679]?|7|9|6|dim|aug)?$/);
        if (!match) return text(`Cannot parse chord: ${chordName}`, true);
        const root = `${match[1]}4`;
        const type = match[2] || '';
        const chord = buildChord(root, type);
        return text({ chord: chordName, fullName: chord.name.replace(/\d$/, ''), notes: chord.notes, midiNotes: chord.midiNotes,
          type: CHORD_NAMES[type] || type, intervals: CHORD_TYPES[type] || CHORD_TYPES[''] });
      }
      case 'progression': {
        if (args.progression && PROGRESSIONS[args.progression]) {
          const prog = PROGRESSIONS[args.progression];
          const key = args.key || 'C';
          const root = key.replace(/m$/i, '') as Note;
          const scaleNotes = buildScale(root, MAJOR_INTERVALS);
          const resolved = prog.chords.map(r => {
            const deg = romanToScaleDegree(r);
            return buildChord(`${scaleNotes[deg]}4`, chordQualityFromRoman(r));
          });
          return text({ progression: args.progression, key: `${root} Major`, description: prog.description,
            chords: resolved.map(c => ({ name: c.name.replace(/\d$/, ''), notes: c.notes, midiNotes: c.midiNotes })) });
        }
        const moodMap: Record<string, string[]> = {
          warm: ['I-V-vi-IV', 'I-IV-V-I'], nostalgic: ['I-vi-IV-V', 'I-V-vi-IV'],
          melancholic: ['vi-IV-I-V', 'i-VI-III-VII'], epic: ['vi-IV-I-V', 'i-VI-III-VII', 'vi-V-IV-III'],
          playful: ['I-V-vi-IV', 'I-vi-ii-V'], romantic: ['I-vi-IV-V', 'ii-V-I'],
          dramatic: ['vi-V-IV-III', 'i-iv-V-i'], jazzy: ['ii-V-I', 'I-vi-ii-V'],
        };
        const recs = (moodMap[args.mood || 'warm'] || ['I-V-vi-IV']).map(name => ({ name, description: PROGRESSIONS[name]?.description || '' }));
        return text({ mood: args.mood || 'warm', recommendations: recs });
      }
      case 'chord_in_key': {
        const key = args.key || 'C';
        const root = key.replace(/m$/i, '') as Note;
        const scaleNotes = buildScale(root, MAJOR_INTERVALS);
        const qualities = ['', 'm', 'm', '', '', 'm', 'dim'];
        const chords = scaleNotes.map((note, i) => {
          const chord = buildChord(`${note}4`, qualities[i]);
          return { degree: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'][i], name: chord.name.replace(/\d$/, ''), notes: chord.notes,
            function: i === 0 ? 'Tonic' : i === 3 || i === 4 ? 'Subdominant/Dominant' : i === 5 ? 'Relative minor' : 'Predominant' };
        });
        return text({ key: `${root} Major`, chords });
      }
      case 'transpose': {
        const noteStr = args.notes || 'C4,E4,G4';
        const semitones = args.semitones || 0;
        const notes = noteStr.split(',').map((n: string) => {
          const midi = noteToMidi(n.trim());
          return { original: n.trim(), midi, transposed: midiToNote(midi + semitones), transposedMidi: midi + semitones };
        });
        return text({ semitones, direction: semitones >= 0 ? 'up' : 'down', notes });
      }
      case 'analyze': {
        const noteStr = args.notes || 'C4,E4,G4';
        const notes = noteStr.split(',').map((n: string) => n.trim());
        const rootCandidates = notes.map(n => noteToMidi(n));
        const minMidi = Math.min(...rootCandidates);
        const relative = rootCandidates.map(m => m - minMidi);
        let identified = 'unknown';
        for (const [type, intervals] of Object.entries(CHORD_TYPES)) {
          if (intervals.length === relative.length && intervals.every((iv, i) => iv === relative[i])) {
            identified = `${notes[0].replace(/\d/, '')}${type}`; break;
          }
        }
        return text({ notes, identified, midiNotes: rootCandidates });
      }
      default:
        return text(`Unknown action: ${action}`, true);
    }
  } catch (e: any) {
    return text(e.message, true);
  }
});

// ── Tool 2: music_compose ────────────────────────────────────────────────────

server.registerTool('music_compose', {
  description: 'Compose a melody. Generates a structured sequence of MIDI notes with rhythm.',
  inputSchema: {
    key: z.string().optional().describe('Key, e.g. "C", "G", "Am"'),
    scale_type: z.string().optional().describe('Scale type. Default: pentatonic_major'),
    tempo: z.number().optional().describe('Tempo BPM. Default: 100'),
    measures: z.number().optional().describe('Number of measures. Default: 8'),
    style: z.enum(['flowing', 'rhythmic', 'gentle', 'playful', 'dramatic']).optional().describe('Melody style. Default: flowing'),
    mood: z.string().optional().describe('Mood preset: warm, nostalgic, dreamy, melancholic, heroic, peaceful, playful, mysterious'),
  },
}, async (args: any) => {
  try {
    let key = args.key || 'C';
    let scaleType = args.scale_type || 'pentatonic_major';
    const tempo = Math.max(40, Math.min(200, args.tempo || 100));
    const measures = Math.max(2, Math.min(32, args.measures || 8));

    if (args.mood && PENTATONIC_MOODS[args.mood]) {
      const preset = PENTATONIC_MOODS[args.mood];
      scaleType = preset.scale;
      if (!args.key) key = preset.baseNote;
    }

    const rootNote = key.replace(/m$/i, '').replace(/maj/i, '') as Note;
    if (/m$/i.test(key) && scaleType === 'pentatonic_major') scaleType = 'pentatonic_minor';
    if (!SCALE_PATTERNS[scaleType]) {
      return text(`Unknown scale: ${scaleType}`, true);
    }

    const melody = composeMelody(rootNote, scaleType, tempo, measures, args.style || 'flowing');
    const timeline = melody.notes.map(n => `${n.note}(${n.duration})`).join(' ');

    return text({
      key: melody.key, scale: melody.scale, tempo: melody.tempo, timeSignature: melody.timeSignature,
      measures, style: args.style || 'flowing', totalNotes: melody.notes.length, totalBeats: melody.totalBeats,
      timeline, notes: melody.notes,
      playHint: `Copy the "notes" array and use Tone.js or Web Audio API to sequence each note. Each note.midi is MIDI pitch, note.duration is beats.`,
    });
  } catch (e: any) {
    return text(e.message, true);
  }
});

// ── Tool 3: music_harmonize ──────────────────────────────────────────────────

server.registerTool('music_harmonize', {
  description: 'Add chord accompaniment to a melody or generate chord progressions matching a mood.',
  inputSchema: {
    key: z.string().optional().describe('Key, e.g. "C", "Am", "G"'),
    mood: z.string().optional().describe('Mood: warm, nostalgic, melancholic, epic, playful, romantic, dramatic, jazzy, peaceful'),
    progression: z.string().optional().describe('Roman numeral progression, e.g. "I-V-vi-IV"'),
    measures: z.number().optional().describe('Number of measures. Default: 8'),
    rhythm: z.enum(['whole', 'half', 'quarter', 'pattern']).optional().describe('Chord rhythm. Default: pattern'),
  },
}, async (args: any) => {
  try {
    const key = (args.key || 'C').replace(/m$/i, '');
    const root = key as Note;
    const scaleNotes = buildScale(root, MAJOR_INTERVALS);
    const minorScale = buildScale(CHROMATIC[(CHROMATIC.indexOf(root) + 9) % 12] as Note, MINOR_INTERVALS);
    const measures = Math.max(4, Math.min(32, args.measures || 8));

    let progression: string[]; let progName: string; let progDesc: string;
    if (args.progression && PROGRESSIONS[args.progression]) {
      const p = PROGRESSIONS[args.progression];
      progression = p.chords; progName = args.progression; progDesc = p.description;
    } else {
      const moodMap: Record<string, string[]> = {
        warm: ['I-V-vi-IV', 'I-IV-V-I'], nostalgic: ['I-vi-IV-V', 'I-V-vi-IV'],
        melancholic: ['vi-IV-I-V', 'i-VI-III-VII'], epic: ['vi-IV-I-V', 'i-VI-III-VII'],
        playful: ['I-V-vi-IV', 'I-vi-ii-V'], romantic: ['I-vi-IV-V', 'ii-V-I'],
        dramatic: ['vi-V-IV-III', 'i-iv-V-i'], jazzy: ['ii-V-I', 'I-vi-ii-V'],
        peaceful: ['I-IV-V-I', 'I-V-vi-IV'],
      };
      const candidates = moodMap[args.mood || 'warm'] || ['I-V-vi-IV'];
      progName = candidates[Math.floor(Math.random() * candidates.length)];
      progression = PROGRESSIONS[progName]?.chords || ['I', 'V', 'vi', 'IV'];
      progDesc = PROGRESSIONS[progName]?.description || '';
    }

    const resolvedChords = progression.map(roman => {
      const deg = romanToScaleDegree(roman);
      const note = scaleNotes[deg];
      const chord = buildChord(`${note}4`, chordQualityFromRoman(roman));
      return { name: chord.name.replace(/\d$/, ''), notes: chord.notes, midiNotes: chord.midiNotes, degree: roman };
    });

    const rhythmPat: Record<string, number[]> = { whole: [4], half: [2, 2], quarter: [1, 1, 1, 1], pattern: [1, 1, 2] };
    const rhythm = rhythmPat[args.rhythm || 'pattern'] || rhythmPat.pattern;

    const chordSequence: Array<{ chord: typeof resolvedChords[0]; beat: number }> = [];
    let beat = 0, chordIdx = 0;
    while (beat < measures * 4) {
      for (const dur of rhythm) {
        if (beat >= measures * 4) break;
        chordSequence.push({ chord: resolvedChords[chordIdx % resolvedChords.length], beat });
        beat += dur; chordIdx++;
      }
    }

    return text({
      key: `${root} Major`, progression: progName, progressionDescription: progDesc,
      measures, chords: resolvedChords, chordSequence, relativeMinor: `${minorScale[0]} Minor`,
      playHint: 'Use chordSequence for accompaniment. Each chord.midiNotes played simultaneously at each beat position.',
    });
  } catch (e: any) {
    return text(e.message, true);
  }
});

// ── Tool 4: music_lyrics ─────────────────────────────────────────────────────

server.registerTool('music_lyrics', {
  description: 'Write song lyrics framework for a theme/mood/structure. Returns templates, rhyme schemes, and example first lines.',
  inputSchema: {
    theme: z.string().describe('Theme, e.g. "summer rain", "lost love", "new beginnings"'),
    mood: z.enum(['warm', 'melancholic', 'joyful', 'romantic', 'hopeful', 'playful', 'dramatic', 'peaceful']).optional().describe('Emotional tone'),
    language: z.enum(['zh', 'en', 'ja']).optional().describe('Lyrics language. Default: zh'),
    structure: z.enum(['verse_chorus', 'AABA', 'through_composed', 'simple']).optional().describe('Song structure. Default: verse_chorus'),
    syllables_per_line: z.number().optional().describe('Syllables/characters per line. Default: 8'),
    lines_per_section: z.number().optional().describe('Lines per verse/chorus. Default: 4'),
  },
}, async (args: any) => {
  try {
    const theme = String(args.theme || '');
    const mood = args.mood || 'warm';
    const lang = args.language || 'zh';
    const structure = args.structure || 'verse_chorus';
    const linesPer = args.lines_per_section || 4;

    const moodPrompts: Record<string, string> = {
      warm: lang === 'zh' ? '温暖、柔和、如阳光般' : lang === 'ja' ? '温かく、柔らかな' : 'warm, gentle, like sunlight',
      melancholic: lang === 'zh' ? '忧伤、怀念、如秋叶飘落' : lang === 'ja' ? '物悲しく、懐かしい' : 'sad, nostalgic, like autumn leaves',
      joyful: lang === 'zh' ? '欢快、明亮、如春风拂面' : lang === 'ja' ? '嬉しく、明るい' : 'happy, bright, like spring breeze',
      romantic: lang === 'zh' ? '浪漫、深情、如月光洒落' : lang === 'ja' ? 'ロマンチックで深い愛情' : 'romantic, deep, like moonlight',
      hopeful: lang === 'zh' ? '充满希望、积极向上、如晨曦微光' : lang === 'ja' ? '希望に満ちて' : 'hopeful, uplifting, like dawn light',
      playful: lang === 'zh' ? '俏皮、灵动、如小鸟跳跃' : lang === 'ja' ? '遊び心があって軽快' : 'playful, light, like a dancing bird',
      dramatic: lang === 'zh' ? '戏剧化、强烈、如雷鸣电闪' : lang === 'ja' ? '劇的で力強い' : 'dramatic, intense, like thunder',
      peaceful: lang === 'zh' ? '宁静、安详、如湖水静谧' : lang === 'ja' ? '静かで平和な' : 'peaceful, serene, like a still lake',
    };

    const rhymeSchemes: Record<string, string> = {
      verse_chorus: lang === 'zh' ? '主歌AABB或ABAB押韵，副歌每行结尾押同一韵' : lang === 'ja' ? 'Aメロ・Bメロ・サビの構成' : 'Verse: AABB or ABAB rhyme. Chorus: end-rhyme on even lines.',
      AABA: lang === 'zh' ? 'A段重复两次，B段转折，A段回归' : lang === 'ja' ? 'Aメロを2回繰り返し、Bメロで展開、再びAメロ' : 'Two A sections, contrasting B, return to A.',
      through_composed: lang === 'zh' ? '自由结构，随情感流动而变化' : lang === 'ja' ? '自由な構成で感情の流れに任せる' : 'Free structure, follow the emotional arc.',
      simple: lang === 'zh' ? '简单重复结构，主歌+副歌交替' : lang === 'ja' ? 'シンプルな繰り返し構成' : 'Simple verse/chorus repeating pattern.',
    };

    const songStructureGuide = structure === 'verse_chorus'
      ? (lang === 'zh' ? '【主歌1】→【副歌】→【主歌2】→【副歌】→【桥段】→【副歌】→【尾奏】'
        : lang === 'ja' ? '【Aメロ】→【サビ】→【Aメロ2】→【サビ】→【Cメロ】→【サビ】→【アウトロ】'
        : '[Verse 1] → [Chorus] → [Verse 2] → [Chorus] → [Bridge] → [Chorus] → [Outro]')
      : structure === 'AABA' ? '[A] → [A] → [B] → [A]'
      : structure === 'simple' ? '[Verse] → [Chorus] → [Verse] → [Chorus]'
      : (lang === 'zh' ? '自由流动结构' : lang === 'ja' ? '自由な流れ' : 'Free-flowing structure');

    const exampleFirstLines: Record<string, Record<string, string>> = {
      zh: { warm: '阳光穿过树叶的缝隙', melancholic: '窗外的雨还在下个不停', joyful: '今天的风都是甜的', romantic: '月光洒在你的侧脸上', hopeful: '天边出现第一道光', playful: '你像一只猫跳进我心里', dramatic: '闪电划破了夜的寂静', peaceful: '湖面倒映着满天星光' },
      ja: { warm: '木漏れ日が揺れる午後', melancholic: '雨音だけが響く部屋', joyful: '風が背中を押すように', romantic: '月明かりに照らされた横顔', hopeful: '夜明け前の藍色の空', playful: '猫じゃらし揺れる小道', dramatic: '雷鳴が静寂を破る', peaceful: '湖面に映る満天の星' },
      en: { warm: 'Sunlight slips through the window pane', melancholic: 'Rain keeps falling on this empty street', joyful: 'Today the air tastes sweet and new', romantic: 'Moonlight traces your silhouette', hopeful: "There's a light at the edge of the sky", playful: 'You bounced in like a melody', dramatic: 'Thunder splits the silent night', peaceful: 'Still water holds the evening star' },
    };

    const writingHints = lang === 'zh'
      ? ['先确定核心情感意象（选择一个具体的画面）', '主歌讲故事/场景，副歌表达情感/主题', '每句结尾的字尽量押韵', '用具体的意象代替抽象的形容词', '副歌的第一句要抓耳，让人记住']
      : lang === 'ja'
      ? ['核となる感情や情景を具体的にイメージする', 'Aメロで情景描写、サビで感情を爆発させる', '日本語の五七五のリズムを意識する', '擬音語・擬態語を効果的に使う']
      : ['Start with a concrete image or moment', 'Verses tell the story, chorus delivers the emotion', 'Use specific sensory details over abstract feelings', 'The hook should be the most memorable line', 'Read aloud to check rhythm and flow'];

    return text({
      theme, mood, language: lang, structure, moodFeeling: moodPrompts[mood],
      rhymeScheme: rhymeSchemes[structure], songStructure: songStructureGuide,
      sections: {
        verse: { lines: linesPer, suggestedSyllables: args.syllables_per_line || 8 },
        chorus: { lines: linesPer, suggestedSyllables: args.syllables_per_line || 8 },
        bridge: structure !== 'simple' ? { lines: Math.max(2, linesPer - 2), suggestedSyllables: args.syllables_per_line || 8 } : null,
      },
      writingHints,
      exampleFirstLine: (exampleFirstLines[lang] || exampleFirstLines.en)[mood] || (lang === 'zh' ? '写下第一行...' : 'Write your first line...'),
    });
  } catch (e: any) {
    return text(e.message, true);
  }
});

// ── Tool 5: music_perform ────────────────────────────────────────────────────

server.registerTool('music_perform', {
  description: 'Bundle melody + chords + lyrics into a complete performance-ready song score for audio synthesis or MIDI export.',
  inputSchema: {
    theme: z.string().describe('Song theme, e.g. "morning light", "farewell", "cherry blossoms"'),
    mood: z.string().optional().describe('Mood: warm, nostalgic, dreamy, melancholic, heroic, peaceful, playful, mysterious'),
    key: z.string().optional().describe('Musical key. Default: auto from mood'),
    tempo: z.number().optional().describe('Tempo BPM. Default: 90'),
    language: z.enum(['zh', 'en', 'ja']).optional().describe('Lyrics language. Default: zh'),
    measures: z.number().optional().describe('Total measures. Default: 16'),
  },
}, async (args: any) => {
  try {
    const theme = String(args.theme || '');
    const mood = args.mood || 'warm';

    let key = args.key || 'C';
    let scaleType = 'pentatonic_major';
    if (PENTATONIC_MOODS[mood]) {
      const preset = PENTATONIC_MOODS[mood];
      scaleType = preset.scale;
      if (!args.key) key = preset.baseNote;
    }
    const root = key.replace(/m$/i, '').replace(/maj/i, '') as Note;
    if (/m$/i.test(key)) scaleType = scaleType === 'pentatonic_major' ? 'pentatonic_minor' : scaleType;

    const tempo = Math.max(50, Math.min(160, args.tempo || 90));
    const measures = Math.max(4, Math.min(32, args.measures || 16));

    const melody = composeMelody(root, scaleType, tempo, measures, 'flowing');

    const moodProgMap: Record<string, string> = {
      warm: 'I-V-vi-IV', nostalgic: 'I-vi-IV-V', melancholic: 'vi-IV-I-V',
      epic: 'vi-IV-I-V', playful: 'I-V-vi-IV', romantic: 'I-vi-IV-V',
      dramatic: 'vi-V-IV-III', peaceful: 'I-IV-V-I',
    };
    const progName = moodProgMap[mood] || 'I-V-vi-IV';
    const scaleNotes = buildScale(root, MAJOR_INTERVALS);
    const progression = PROGRESSIONS[progName]?.chords || ['I', 'V', 'vi', 'IV'];

    const chordSeq: Array<{ name: string; midiNotes: number[]; beat: number }> = [];
    for (let m = 0; m < measures; m++) {
      const roman = progression[m % progression.length];
      const deg = romanToScaleDegree(roman);
      const chord = buildChord(`${scaleNotes[deg]}3`, chordQualityFromRoman(roman));
      chordSeq.push({ name: chord.name.replace(/\d$/, ''), midiNotes: chord.midiNotes, beat: m * 4 });
    }

    const vocalScore = melody.notes.map((n, i) => ({
      note: n.note, midi: n.midi, duration: n.duration, velocity: n.velocity,
      beat: melody.notes.slice(0, i).reduce((sum, prev) => sum + prev.duration, 0),
    }));

    const lang = args.language || 'zh';
    return text({
      title: theme, mood, key: melody.key, scale: melody.scale, tempo, timeSignature: [4, 4], measures, totalBeats: melody.totalBeats,
      melody: { notes: melody.notes, vocalScore },
      chords: chordSeq, progression: progName,
      lyrics: {
        language: lang,
        placeholderVerses: { verse: lang === 'zh' ? '写下你的故事...' : lang === 'ja' ? '物語を綴って...' : 'Tell your story...',
          chorus: lang === 'zh' ? '唱出你的心声...' : lang === 'ja' ? '心の声を歌って...' : 'Sing your heart out...' },
        syllableHint: melody.notes.length,
        structure: 'verse → chorus → verse → chorus → bridge → chorus',
      },
      performance: {
        intro: 'Play chords alone for 2 measures before vocals enter',
        singingTip: 'Match each lyric syllable to one melody note.',
        outro: 'Hold final chord for 2 measures, fade out',
      },
      playHint: `Use chordSeq for accompaniment. Use melody.vocalScore for the singing line. Total duration: ${Math.round(melody.totalBeats / tempo * 60)}s at ${tempo} BPM.`,
    });
  } catch (e: any) {
    return text(e.message, true);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Peppa Melody] Ready — 5 music tools loaded');
}
main().catch(console.error);
