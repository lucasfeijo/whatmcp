import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndex } from '../src/index/indexer.ts';
import { openStore } from '../src/db/index.ts';
import { runTranscription, importMediaManifest } from '../src/transcription/worker.ts';
import { resolveMediaPath } from '../src/transcription/media.ts';
import { embedMissing } from '../src/index/embed.ts';
import type { Config } from '../src/config.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-audio-test-'));
  const mediaRoot = join(dir, 'media');
  mkdirSync(mediaRoot);
  writeFileSync(join(mediaRoot, 'voice.ogg'), 'fake audio bytes');
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
    CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT);
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY, ZSTANZAID TEXT, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER,
      ZTEXT TEXT, ZMESSAGEDATE REAL, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER,
      ZPARENTMESSAGE INTEGER, ZMEDIAITEM INTEGER
    );
    INSERT INTO ZWACHATSESSION VALUES (1, '123@s.whatsapp.net', 'Ana');
    INSERT INTO ZWAMEDIAITEM VALUES (1, 'voice.ogg');
  `);
  const add = db.prepare('INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?,?,?,?,?)');
  const apple = (unix: number) => unix - 978307200;
  add.run(1, 'before', 0, 0, 'antes', apple(1_700_000_000), 1, null, null, null);
  add.run(2, 'voice', 0, 3, 'legenda', apple(1_700_000_001), 1, null, null, 1);
  add.run(3, 'after', 0, 0, 'depois', apple(1_700_000_002), 1, null, null, null);
  db.close();
  const store = join(dir, 'archive.sqlite');
  runIndex(store, { chatstorage: '', snapshotPath: source, mediaSourceId: 'import' });
  const cfg: Config = {
    store, chatstorage: source, openaiKey: null, openaiModel: 'text-embedding-3-small',
    openaiDims: 1536, syncIntervalHours: 0, transcriptionModel: 'apple-speech',
    transcriptionLocale: 'pt-BR', mediaSourceId: 'import', mediaRoots: { import: mediaRoot },
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
  };
  return { dir, source, store, mediaRoot, cfg };
}

function mockOptions(transcribe: (n: number) => string | Promise<string>) {
  let n = 0;
  return {
    duration: async () => 601,
    convert: async (_cfg: Config, _src: string, _segment: number, dest: string) => {
      writeFileSync(dest, 'wav');
    },
    transcribe: async () => transcribe(n++),
  };
}

test('audio enters its chronological position; re-running keeps the same windows', async () => {
  const f = fixture();
  try {
    const result = await runTranscription(f.cfg, mockOptions((n) => ['fala um', 'fala dois'][n]));
    assert.equal(result.processed, 1);
    assert.equal(result.published, 1);
    const db = openStore(f.store);
    const first = db.prepare('SELECT id, text, content_hash FROM windows').all() as
      { id: number; text: string; content_hash: string }[];
    assert.equal(first.length, 1);
    assert.match(first[0].text, /antes.*legenda Áudio transcrito \(apple-speech\): fala um fala dois.*depois/s);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM window_message_parts').get() as any).n), 3);
    assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'fala'").get() as any).n), 1);
    db.close();
    const again = await runTranscription(f.cfg, mockOptions(() => { throw new Error('duplicate work'); }));
    assert.equal(again.processed, 0);
    const check = openStore(f.store);
    assert.deepEqual(check.prepare('SELECT id, text, content_hash FROM windows').all(), first);
    check.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('saved segments survive failure and resume without retranscribing', async () => {
  const f = fixture();
  try {
    const first = await runTranscription(f.cfg, mockOptions((n) => {
      if (n === 1) throw new Error('temporary model failure');
      return 'first segment';
    }));
    assert.equal(first.failed, 1);
    const db = openStore(f.store);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM transcript_segments').get() as any).n), 1);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM active_transcripts').get() as any).n), 0);
    db.exec("UPDATE audio_transcripts SET status = 'processing', lease_until = 1");
    db.close();
    let calls = 0;
    const second = await runTranscription(f.cfg, mockOptions(() => { calls++; return 'second segment'; }));
    assert.equal(second.processed, 1);
    assert.equal(calls, 1);
    const check = openStore(f.store);
    assert.equal((check.prepare('SELECT text FROM audio_transcripts WHERE status = ?').get('done') as any).text,
      'first segment second segment');
    check.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('model switch retains old active windows until the new result is complete', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg, mockOptions(() => 'old model'));
    const db = openStore(f.store);
    const old = (db.prepare('SELECT text FROM windows').get() as any).text;
    db.close();
    const switched = { ...f.cfg, transcriptionModel: 'apple-dictation' as const };
    const failed = await runTranscription(switched, mockOptions(() => { throw new Error('retry'); }));
    assert.equal(failed.published, 0);
    const interim = openStore(f.store);
    assert.equal((interim.prepare('SELECT text FROM windows').get() as any).text, old);
    interim.close();
    const done = await runTranscription(switched, mockOptions(() => 'new model'));
    assert.equal(done.published, 1);
    const final = openStore(f.store);
    assert.match((final.prepare('SELECT text FROM windows').get() as any).text, /new model/);
    assert.equal((final.prepare('SELECT model FROM active_transcripts').get() as any).model,
      'apple-dictation');
    final.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('vector-pending state clears only after the published window hashes have vectors', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg, mockOptions(() => 'spoken text'));
    const db = openStore(f.store);
    assert.equal((db.prepare('SELECT status FROM thread_projection_state').get() as any).status,
      'vectors_pending');
    const hashes = db.prepare('SELECT DISTINCT content_hash FROM windows').all() as
      { content_hash: string }[];
    for (const row of hashes) db.prepare(`INSERT INTO window_vectors
      (content_hash, model, dim, created_at, vec) VALUES (?, ?, ?, ?, ?)`)
      .run(row.content_hash, 'openai/text-embedding-3-small@1536', 1536, 0,
        new Uint8Array(1536 * 4));
    db.close();
    await embedMissing(f.store, { model: 'text-embedding-3-small', dimensions: 1536,
      apiKey: 'not-used' });
    const check = openStore(f.store);
    assert.equal((check.prepare('SELECT status FROM thread_projection_state').get() as any).status,
      'current');
    check.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('permanent model errors require an explicit retry after correction', async () => {
  const f = fixture();
  try {
    const failed = await runTranscription(f.cfg, mockOptions(() => {
      throw new Error('model unavailable');
    }));
    assert.equal(failed.failed, 1);
    const db = openStore(f.store);
    db.exec("UPDATE audio_transcripts SET status = 'permanent_error'");
    db.close();
    const skipped = await runTranscription(f.cfg, mockOptions(() => {
      throw new Error('must not retry automatically');
    }));
    assert.equal(skipped.processed, 0);
    assert.equal(skipped.failed, 0);
    const retried = await runTranscription(f.cfg, {
      ...mockOptions(() => 'works after correction'), retryErrors: true,
    });
    assert.equal(retried.processed, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('explicit Windows-style manifest links only known messages and paths stay within root', () => {
  const f = fixture();
  try {
    const db = openStore(f.store);
    const manifest = join(f.dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify([
      { message_id: '123@s.whatsapp.net:voice', relative_path: 'voice.ogg' },
      { message_id: 'unknown', relative_path: 'voice.ogg' },
      { message_id: '123@s.whatsapp.net:voice', relative_path: '../escape.ogg' },
    ]));
    assert.deepEqual(importMediaManifest(db, 'import', f.mediaRoot, manifest),
      { imported: 0, rejected: 2 });
    db.close();
    assert.throws(() => resolveMediaPath(f.mediaRoot, '../escape.ogg'));
    const outside = join(f.dir, 'outside.ogg');
    writeFileSync(outside, 'bytes');
    symlinkSync(outside, join(f.mediaRoot, 'link.ogg'));
    assert.throws(() => resolveMediaPath(f.mediaRoot, 'link.ogg'));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
