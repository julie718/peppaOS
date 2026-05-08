import { STTConfig, STTResult, STTProvider } from './types';
import * as deepgram from './providers/deepgram';
import * as whisper from './providers/whisper';
import * as qwen from './providers/qwen';
import { getKey } from '../config/keys';

export async function transcribe(audioBuffer: Buffer, config: STTConfig): Promise<STTResult> {
  switch (config.provider) {
    case 'whisper':
      return whisper.transcribe(audioBuffer, config.language);
    case 'deepgram':
      return new Promise((resolve, reject) => {
        const session = deepgram.createStream(config.language, false);
        let finalResult: STTResult = { text: '', isFinal: false };
        session.onResult((result) => {
          if (result.isFinal) finalResult = result;
        });
        session.onError(reject);
        session.sendAudio(audioBuffer);
        session.end();
        setTimeout(() => resolve(finalResult), 3000);
      });
    case 'qwen':
      return new Promise((resolve, reject) => {
        const session = qwen.createStream(config.language || 'zh', false);
        let finalResult: STTResult = { text: '', isFinal: false };
        session.onResult((result) => {
          if (result.isFinal) finalResult = result;
        });
        session.onError(reject);
        session.sendAudio(audioBuffer);
        session.end();
        setTimeout(() => resolve(finalResult), 3000);
      });
    default:
      throw new Error(`Unknown STT provider: ${config.provider}`);
  }
}

export function createStreamingSession(
  config: STTConfig,
): deepgram.DeepgramStreamSession | qwen.QwenStreamSession {
  if (config.provider === 'qwen') {
    return qwen.createStream(config.language, config.interimResults);
  }
  if (config.provider === 'deepgram') {
    return deepgram.createStream(config.language, config.interimResults);
  }
  throw new Error(`Streaming only supports Deepgram and Qwen-ASR (requested: ${config.provider})`);
}

export function getActiveSTTProvider(): STTProvider | null {
  const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (qwenKey) return 'qwen';
  if (process.env.DEEPGRAM_API_KEY || getKey('DEEPGRAM_API_KEY')) return 'deepgram';
  if (process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY')) return 'whisper';
  return null;
}
