import { STTResult } from '../types';
import { getKey } from '../../config/keys';
import path from 'path';

function getApiKey(): string {
  return process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY') || '';
}

interface AudioFileOptions {
  fileName?: string;
  mimeType?: string;
}

function safeFileName(fileName?: string): string {
  const safe = path.basename(String(fileName || '').trim());
  return safe || 'audio.webm';
}

export async function transcribe(
  audioBuffer: Buffer,
  language: string = 'zh',
  options: AudioFileOptions = {},
): Promise<STTResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const fileName = safeFileName(options.fileName);
  const mimeType = options.mimeType || 'audio/webm';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer as any], { type: mimeType }), fileName);
  form.append('model', 'whisper-1');
  form.append('language', language);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper error (${res.status}): ${err}`);
  }

  const data = await res.json() as any;
  return { text: data.text || '', isFinal: true };
}
