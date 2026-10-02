# Audio transcription

Transcription is disabled by default. `npm run setup` asks whether to enable it,
lists models available on the current computer, estimates the accessible backfill,
and asks separately before starting it. The three configured values are
`apple-speech`, `apple-dictation` (macOS), and `gpt-transcribe` (macOS or Windows).
Set `transcription_model` to `null` to disable new transcription. The embedding
model is a separate setting.

`gpt-transcribe` uploads audio to OpenAI. The Apple models run locally and may
need a language asset downloaded during setup. All published transcript text is
part of the normal conversation windows, so `npm run embed` sends that text to
the configured embedding API. A key alone never enables audio upload.

## Media files

The macOS adapter links an audio message to `ZMEDIAITEM.ZMEDIALOCALPATH` and
resolves it below WhatsApp's `Message` group-container directory. Paths that are
absolute, leave the configured root, or follow a symlink outside it are rejected.
The SQLite reference does not guarantee that the audio file is still on disk.

On Windows, supply a compatible `ChatStorage.sqlite` as described in
[File import](IMPORT.md). The native WhatsApp Windows database and cache are not
read automatically. If the SQLite file contains `ZMEDIAITEM` paths and matching
files have been extracted, set the root explicitly:

```sh
npm run wa -- media import --root=/path/to/extracted/Message --source=import
```

For files saved separately, use a JSON manifest with unambiguous stable message
IDs. Each entry is `{ "message_id": "chat-jid:stanza-id", "relative_path": "voice.ogg" }`.
Unknown messages and unsafe paths are rejected; a filename alone does not prove
which message an audio belongs to.

```sh
npm run wa -- media import --root=/path/to/files --source=import --manifest=/path/to/manifest.json
```

## Resume and publish

```sh
npm run wa -- transcribe-models   # availability and reason on this host
npm run wa -- transcribe --limit=100
npm run wa -- doctor
npm run embed                  # estimate first; sends new text windows to OpenAI
```

`transcribe` runs independently of the five-minute message-sync watchdog. It
stores each completed audio segment and resumes incomplete files on the next run.
One worker holds a separate lock, and each model call has a timeout. Successful
results are composed in timestamp and message-ID order with original text and
captions. A conversation's FTS windows switch in one database transaction after
its accessible audio files are ready. If embeddings are not yet available, FTS
is published with missing vectors reported by `doctor`; `embed` resumes by
content hash. Old transcripts and vectors remain in the database when the chosen
transcription model changes, while the previous conversation windows stay active
until the new generation is complete.

After fixing a persistent permission, language asset, or API access error, use
`npm run wa -- transcribe --retry-errors`. Persistent errors are not retried in a
background loop.

`npm run sync` continues to import messages and media references. It does not
perform transcription inside sync. This avoids blocking routine sync on a model
download, a privacy dialog, or the transcription API. To process new audio,
run `transcribe` again. Windows imports need a refreshed compatible source file
and extracted media; a scheduled Windows importer is not included.
