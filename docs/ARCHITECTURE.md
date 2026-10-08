# Architecture and data guarantees

WhatMCP maintains its own archive rather than treating WhatsApp's local store as
a cache. The [desktop guide](../desktop/README.md) covers native process boundaries,
capture policy, packaging, and platform validation separately.

## Sources and the archive

The ChatStorage reader understands the supported WhatsApp Core Data schema on
macOS and in compatible, prepared SQLite files. Windows live acquisition uses
the external WAren6 adapter and imports its validated unified database. iPhone
backup extraction and decryption happen outside WhatMCP; see
[iPhone history](IPHONE.md) and [file import](IMPORT.md).

Imports upsert messages into `archive.db`. They do not truncate message history
before a full scan or remove rows because the source no longer contains them.
Message IDs use the chat and stanza ID where available, with a source-row fallback.
This makes repeated imports idempotent when stable source IDs are available.

For ChatStorage, incremental import remembers the highest source primary key.
If the source's maximum falls below that watermark, the importer detects a rebuilt
store and performs a full pass. Source edits require a full scan; source deletions
are intentionally not mirrored. File imports can only add history actually
present in the selected file.

The archive and configuration live outside the application bundle and checkout.
Deleting or updating application code should not delete the archive. Back up the
profile using the [SQLite consistency guidance](USAGE.md#backups).

## Retrieval units

Single messages such as “yes” or “send it tomorrow” lack useful context. The
chunker groups consecutive messages in a thread into conversation windows,
rendered with speaker names. Current defaults split at more than 30 minutes of
silence and cap each window at 40 messages and 4,000 rendered characters. Long
text and transcripts are also split to respect character and token budgets.

The window hash includes thread, speakers, and rendered text, excluding timestamps.
Vectors are keyed by this content hash and model configuration. Unchanged content
can reuse its embedding; interrupted embedding passes resume missing work.
See [chunker](../src/index/chunker.ts) and [embedder](../src/index/embed.ts).

## Search and context

Keyword search uses SQLite FTS5/BM25. Semantic search uses OpenAI embeddings and
cosine similarity over stored vectors. Hybrid search combines their rankings
with Reciprocal Rank Fusion: keywords help with names and exact phrases, while
vectors help with paraphrases and multilingual queries.

Results carry strong/weak labels and underlying match information. A weak result
means “closest available text,” not a confirmed answer. `npm run wa -- calibrate`
measures the archive's similarity to unrelated probe queries and saves fitted
thresholds; it uses the configured embedding API.

Retrieval helps navigate the history. `search_messages` returns conversation
windows; `get_conversation` expands a result into individual messages around a
timestamp. `list_messages_since` enumerates messages independently of relevance
ranking. See [MCP usage](USAGE.md#mcp-tools).

## Audio processing

Only recordings with accessible media bytes can be transcribed. Transcription
caches results by audio hash, provider, pipeline revision, and language. Completed
segments persist so interrupted work can resume. Published transcript text becomes
part of the search windows; embedding those windows sends the transcript text to
the configured embedding service, even when audio transcription was local.

The [audio guide](AUDIO.md) covers conversion, media inventory, local model setup,
reprocessing, retry behavior, and missing files.

## Interfaces and process boundaries

The native desktop app communicates through allowlisted Tauri/Rust commands and
private stdin/stdout with its bundled Node backend. It does not start the HTTP
server or an MCP listener. The localhost development preview always uses synthetic
fixtures and cannot switch to real user data.

The CLI and MCP servers reuse the archive/index/search layers. MCP supports stdio
and optional Streamable HTTP. HTTP access uses host checks and bearer authentication;
remote access additionally needs TLS through a configured tunnel or proxy. Its
web dashboard stays loopback-only and has separate session authentication. OAuth
grants expose read tools; `sync_archive` is limited to local/static-token use.
See [remote access](REMOTE.md) for the deployment and authentication model.

## Security and practical limits

WhatsApp is a read source. There is no message-send, reaction, join, or leave API.
Sync writes to the WhatMCP archive. Every MCP response fences retrieved message
text as untrusted data using an unpredictable boundary. This reduces prompt
injection ambiguity but does not make received messages trusted instructions.

The archive is plaintext SQLite. WhatMCP requests `0700` profile directories and
`0600` configuration/database files; these Unix modes do not enforce Windows ACLs.
Use Windows folder permissions and OS-managed disk encryption as appropriate.
Provider keys remain in the selected profile's `config.json`, not Keychain.

History coverage depends on the source, sender names can be missing, and reply
threading is not implemented. Images and videos are not semantically embedded.
OS FDA authorization is persistent; the desktop capture deadline is a separate
app policy. Real TCC attribution and permissions across ad hoc app updates require
disposable macOS testing; fixture CI does not prove those behaviors.
