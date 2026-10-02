-- Audio references and resumable transcription are separate from source messages.
-- Existing archives retain their windows and vectors until a conversation is
-- explicitly projected and published with transcripts.
CREATE TABLE audio_media (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id),
  source_id     TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes    INTEGER,
  mtime_ms      INTEGER,
  duration_s    REAL,
  sha256        TEXT,
  availability  TEXT NOT NULL DEFAULT 'unknown',
  checked_at    INTEGER
);
CREATE INDEX idx_audio_media_source ON audio_media(source_id, availability);

CREATE TABLE audio_media_sources (
  source_id      TEXT PRIMARY KEY,
  last_source_pk INTEGER NOT NULL DEFAULT 0,
  last_run_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audio_transcripts (
  message_id     TEXT NOT NULL REFERENCES messages(id),
  audio_sha256   TEXT NOT NULL,
  model          TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  locale         TEXT NOT NULL,
  status         TEXT NOT NULL,
  text           TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_until    INTEGER,
  error_code     TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY(message_id, audio_sha256, model, model_revision, locale)
);
CREATE INDEX idx_audio_transcripts_status ON audio_transcripts(model, status, lease_until);

CREATE TABLE transcript_segments (
  message_id     TEXT NOT NULL,
  audio_sha256   TEXT NOT NULL,
  model          TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  locale         TEXT NOT NULL,
  segment_no     INTEGER NOT NULL,
  text           TEXT NOT NULL,
  PRIMARY KEY(message_id, audio_sha256, model, model_revision, locale, segment_no),
  FOREIGN KEY(message_id, audio_sha256, model, model_revision, locale)
    REFERENCES audio_transcripts(message_id, audio_sha256, model, model_revision, locale)
);

CREATE TABLE thread_projection_state (
  thread_id          TEXT PRIMARY KEY REFERENCES threads(id),
  desired_generation INTEGER NOT NULL DEFAULT 1,
  active_generation  INTEGER NOT NULL DEFAULT 0,
  desired_model      TEXT,
  active_model       TEXT,
  status             TEXT NOT NULL DEFAULT 'dirty',
  updated_at         INTEGER NOT NULL DEFAULT 0
);

-- The active transcript selection is deliberately explicit. A normal sync may
-- rebuild text windows without accidentally publishing a new, half-ready model.
CREATE TABLE active_transcripts (
  message_id     TEXT PRIMARY KEY REFERENCES messages(id),
  audio_sha256   TEXT NOT NULL,
  model          TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  locale         TEXT NOT NULL
);

CREATE TABLE candidate_transcripts (
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  generation     INTEGER NOT NULL,
  message_id     TEXT NOT NULL REFERENCES messages(id),
  audio_sha256   TEXT NOT NULL,
  model          TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  locale         TEXT NOT NULL,
  PRIMARY KEY(thread_id, generation, message_id)
);

CREATE TABLE candidate_windows (
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  generation   INTEGER NOT NULL,
  ordinal      INTEGER NOT NULL,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  msg_count    INTEGER NOT NULL,
  speakers     TEXT NOT NULL,
  text         TEXT NOT NULL,
  first_msg_id TEXT NOT NULL,
  last_msg_id  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parts_json   TEXT NOT NULL,
  PRIMARY KEY(thread_id, generation, ordinal)
);
CREATE INDEX idx_candidate_hash ON candidate_windows(content_hash);

CREATE TABLE window_message_parts (
  window_id  INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  part_no    INTEGER NOT NULL,
  PRIMARY KEY(window_id, message_id, part_no)
);
CREATE INDEX idx_window_parts_message ON window_message_parts(message_id);

-- Audio conversations must be revisited because their old windows were built
-- without the audio's chronological position. This only marks them; migration
-- does not contact a model or modify the currently searchable windows.
INSERT INTO thread_projection_state(thread_id, desired_generation, updated_at)
SELECT DISTINCT thread_id, 1, CAST(strftime('%s','now') AS INTEGER)
FROM messages WHERE kind = 'audio';
