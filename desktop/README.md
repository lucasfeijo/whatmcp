# WhatMCP desktop

React + Tauri 2 app for macOS ARM64 and Windows x64. Portuguese consumer UI:

- **Buscar:** text, meaning and hybrid search, conversation/person/date/type filters,
  real match provenance, surrounding messages, copy and jump to conversation.
- **Conversas:** thread navigation, paginated messages, date jumps, audio playback,
  preserved transcripts and per-recording transcription.
- **Atividade:** manual sync, transcription and embedding jobs; available/missing
  audio counts; pending segments and affected-message counts; backlog lists, retry,
  cancellation and persisted job history.
- **Ajustes:** validated edits to supported config fields, optimistic revision check,
  atomic replacement, unknown-field preservation and redacted credentials; explicit
  profile selection, capture authorization and update controls.
- **Updates:** official Tauri updater, explicit check/notes/confirmation/progress,
  mandatory signature verification, no installation during jobs. Disabled until a
  public key and signed release feed are configured.

## Data and process boundaries

First launch offers **Configure my WhatsApp** or **Explore the demo**. The demo has
an always-visible notice linking back to setup. The four-step wizard selects an
app-owned or explicitly chosen existing profile, explains platform connection and
permissions, saves optional search/transcription settings, and offers manual first
sync. Text browsing needs no cloud key. Completed setup remembers the chosen profile;
unfinished setup resumes from the last completed step. A missing/incompatible saved
profile falls back to the demo with recovery instructions, without migrating data.

App-owned profiles live under `com.whatmcp.desktop/profiles/demo` and `profiles/archive`
in platform-specific Application Support/AppData. The app does not discover or open
`~/.whatmcp` until explicitly selected. The selector accepts `~/` and clears stale
warnings on success. Profile switches discard replies from the previous runtime.
Startup preferences are atomically saved in the app-owned `desktop-state.json` and
contain no API key. Settings can reopen the guided flow at any time.
Existing profiles must have the current schema: selection does not migrate them.
Reading works without a provider key; requested jobs/config edits write the selected
profile. Updates preserve that directory outside the application bundle.

Production communication is private inherited stdin/stdout: WebView → allowlisted
Rust commands → bundled Node 22 backend. No HTTP/MCP listener is started. The
development localhost preview accepts only its own synthetic demo. There are no
generic filesystem, shell, SQL or arbitrary executable commands exposed to UI.

Workers use the existing WhatMCP SQLite sync lock. Closing, cancellation or lease
expiry terminates only the app-owned worker process tree. No launch agent, service,
MCP config or existing scheduler is installed, stopped or changed. Completed archive
work persists; interrupted job history is recoverable. Selecting an existing profile
can still overlap reads with an existing server; production migration coordination
and long-running backend compatibility need an integration test before rollout.

## macOS collection and FDA

The native collector only reads the fixed WhatsApp group-container DB and referenced
audio files. Node receives private capture copies. Sources reject symlinks/traversal;
copies have limits and cancellation deadlines. DB/WAL are copied with before/after
metadata checks and retries, then validated and backed up with SQLite **on the copy**.
Live SQLite shared-memory files are never opened or created. This reduces source
interference but is not a transactional lock on a concurrently changing live store:
a busy source can fail and require retry. Stronger live-snapshot validation remains
part of real-platform testing. Private DB captures are deleted after import; copied
media stays with the archive.

Full Disk Access is user-granted persistent TCC authorization in System Settings.
The five-minute app lease is an application policy, not temporary native FDA.
Revoking it stops this app's capture job; removing OS access is a separate user action.
The app is distributed outside App Sandbox. Private pipes are narrower than a
listener, but the trusted Node runtime is not OS-confined from other readable files.
Neither the helper's actual TCC attribution nor FDA persistence across ad hoc updates
has been verified. Test first-grant, denial, expiry, revocation, upgrades and parent/
helper identity in a disposable macOS VM before live collection. No FDA was granted
or requested during development tests.

Apple Speech **and Dictation** use SpeechAnalyzer and require macOS 26+. Their helper
is compiled into the bundle; users don't need Xcode. Model downloads and speech
permissions remain user actions. Real Apple/OpenAI transcription is not tested here.

## Platform requirements

End users do not need Node/Rust/Xcode. macOS 13+ supports archive browsing; Apple
transcription requires 26+. Windows uses the existing external **WAren6** adapter;
its configured installation and a supported local WhatsApp source are required for
live sync. Local Whisper uses the backend's existing faster-whisper adapter: select an already
installed Python environment and local CTranslate2 model in Settings. The wizard can explicitly download Apple speech assets. Other external tools
(FFmpeg/FFprobe, local Whisper/Python/model, WAren6) still require an existing installation;
they are checked or configured through the wizard and Settings, not installed globally. Audio conversion needs **FFmpeg/FFprobe** installed or absolute executable
paths selected in Settings. These tools are not installed automatically or bundled
by this PR. GPT transcription/real semantic search need an OpenAI key, may incur
provider costs and transmit the corresponding audio/text. The local key is stored
in the existing config.json format with restrictive file mode, not moved to Keychain.

## Build and validation

```
npm ci
npm ci --prefix desktop
npm run prepare:runtime --prefix desktop
npm test -- --test-concurrency=2
# Startup/profile persistence and recovery:
cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline
cd desktop
npm run tauri -- build --bundles app,dmg  # macOS; nsis on Windows
```

Use Node 22.23.2 / Rust 1.95.0 and an Xcode 26 SDK for the Speech helper. Run local
development with HOME, TMPDIR, npm/Cargo/Swift caches and WHATMCP_HOME redirected to
a disposable workspace; do not point it at a real archive for fixture tests. Finder
file-provider metadata on a Documents-based output can prevent macOS signing; put
the generated bundle/build target under `/tmp`, not a synced Documents directory.
Do not clear metadata on installed applications.

The installer workflow builds real `.dmg` and NSIS `.exe` artifacts on PRs and main.
macOS is ad hoc signed for executable integrity, with no Developer ID/notarization.
Windows has no Authenticode signature. Gatekeeper/SmartScreen installation UX and
real permissions remain VM/manual checks. CI does not install on users' machines,
publish a GitHub Release or merge the PR.

## Update setup (not performed by this PR)

The separate manual workflow skips until repository variable
`TAURI_UPDATER_PUBLIC_KEY` exists; it additionally requires the protected secret
`TAURI_SIGNING_PRIVATE_KEY` (and password secret if encrypted). These are Tauri update
signatures, distinct from paid OS signing. Obtain owner approval before creating or
storing a persistent private key. There is no credential generation/upload step.
Restrict access to that workflow and its signing secret before enabling it.

The workflow uploads signed packages and `.sig` artifacts only; publication is a
separate owner action. Assemble `latest.json` using the Tauri static-feed schema,
matching `darwin-aarch64` / `windows-x86_64`, immutable artifact URLs and signatures,
and host it at the configured GitHub Releases endpoint. Test accepted and tampered
packages, restart/data preservation, interrupted downloads and Mac FDA continuity in
disposable VMs before publishing. No update channel is active in default PR builds.

Primary references: [Tauri updater](https://v2.tauri.app/plugin/updater/),
[Tauri resources](https://v2.tauri.app/develop/resources/),
[Apple app access to files](https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac),
[Apple file permissions and responsible code](https://developer.apple.com/forums/thread/678819),
[Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox),
[Apple SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer).
