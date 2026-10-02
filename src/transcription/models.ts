import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, type Config, type TranscriptionModel,
  TRANSCRIPTION_MODELS } from '../config.ts';

const exec = promisify(execFile);
const SWIFT_SOURCE = join(import.meta.dirname, 'AppleTranscribe.swift');
const APPLE_BINARY = join(DATA_DIR, 'bin', 'apple-transcribe');

function appleBinary(): string {
  if (process.platform !== 'darwin') throw new Error('Apple transcription requires macOS');
  if (existsSync(APPLE_BINARY) && statSync(APPLE_BINARY).mtimeMs >= statSync(SWIFT_SOURCE).mtimeMs) {
    return APPLE_BINARY;
  }
  mkdirSync(join(DATA_DIR, 'bin'), { recursive: true, mode: 0o700 });
  const temp = `${APPLE_BINARY}.${randomUUID()}`;
  try {
    execFileSync('swiftc', ['-parse-as-library', '-O', SWIFT_SOURCE, '-o', temp],
      { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    renameSync(temp, APPLE_BINARY);
  } catch (e) {
    throw new Error(`Cannot compile Apple transcription helper: ${(e as Error).message}`);
  }
  return APPLE_BINARY;
}

export interface ModelAvailability { model: TranscriptionModel; available: boolean; reason: string }

/** Asset download is always an explicit setup/CLI action, never a transcription fallback. */
export async function installAppleModel(model: TranscriptionModel, locale: string): Promise<void> {
  if (model === 'gpt-transcribe' || process.platform !== 'darwin') {
    throw new Error('Apple speech assets require macOS and an Apple model');
  }
  await exec(appleBinary(), ['install', model, locale], { timeout: 600_000 });
}

export async function availableModels(cfg: Config): Promise<ModelAvailability[]> {
  const locale = cfg.transcriptionLocale ?? 'pt-BR';
  const out: ModelAvailability[] = [];
  for (const model of TRANSCRIPTION_MODELS) {
    if (model === 'gpt-transcribe') {
      out.push({ model, available: !!cfg.openaiKey,
        reason: cfg.openaiKey ? 'API key configured; project access checked on use'
          : 'OpenAI API key missing' });
    } else if (process.platform !== 'darwin') {
      out.push({ model, available: false, reason: 'requires macOS' });
    } else {
      try {
        const { stdout } = await exec(appleBinary(), ['probe', model, locale], { timeout: 30_000 });
        const result = JSON.parse(stdout) as { available: boolean; reason: string };
        out.push({ model, ...result });
      } catch (e) {
        out.push({ model, available: false, reason: (e as Error).message.split('\n')[0] });
      }
    }
  }
  return out;
}

export class TranscriptionError extends Error {
  retryable: boolean;
  pauseModel: boolean;
  constructor(message: string, retryable: boolean, pauseModel = false) {
    super(message);
    this.retryable = retryable;
    this.pauseModel = pauseModel;
  }
}

export async function transcribeSegment(model: TranscriptionModel, locale: string,
  wavPath: string, apiKey: string | null): Promise<string> {
  if (model !== 'gpt-transcribe') {
    try {
      const { stdout } = await exec(appleBinary(), ['transcribe', model, locale, wavPath],
        { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
      return (JSON.parse(stdout) as { text: string }).text.trim();
    } catch (e) {
      const error = e as NodeJS.ErrnoException & { killed?: boolean };
      throw new TranscriptionError(error.killed
        ? 'Apple transcription timed out after five minutes'
        : 'Apple transcription failed; check Speech permission and language asset',
      !!error.killed);
    }
  }
  if (!apiKey) throw new TranscriptionError('OpenAI API key missing', false);
  const bytes = readFileSync(wavPath);
  if (bytes.byteLength > 25_000_000) {
    throw new TranscriptionError('converted segment exceeds the 25 MB API limit', false);
  }
  const body = new FormData();
  body.append('model', 'gpt-transcribe');
  body.append('languages[]', locale.split('-')[0]);
  body.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body,
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      if (attempt === 0) continue;
      throw new TranscriptionError('transcription network/timeout error', true);
    }
    if (response.ok) {
      const result = await response.json() as { text?: string };
      if (typeof result.text !== 'string') {
        throw new TranscriptionError('OpenAI transcription response had no text field', true);
      }
      return result.text.trim();
    }
    if ([403, 429].includes(response.status) || response.status >= 500) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new TranscriptionError(`OpenAI transcription HTTP ${response.status}`,
        response.status !== 403, response.status === 403);
    }
    throw new TranscriptionError(`OpenAI transcription HTTP ${response.status}`, false,
      response.status === 401);
  }
  throw new TranscriptionError('transcription retry exhausted', true);
}
