# Electron And Local-First Apps

Use this module for Electron, local-first desktop apps, local AI/TTS runtimes, and privileged renderer/main boundaries.

## Stack Boundaries

- Renderer never accesses the database, privileged filesystem, secrets, native APIs, local model runtimes, or sidecars directly.
- Renderer communicates with the local backend only through a secure preload bridge and validated IPC.
- Main process owns database access, privileged filesystem access, secrets, local runtimes, workers, sidecars, voice managers, and artifact assembly.
- Shared contracts should be canonical and validated at every boundary, commonly with Zod in TypeScript apps.

## Content Isolation

- Treat EPUB, HTML, imported documents, and rendered external content as untrusted.
- Do not expose `file://` directly to untrusted content.
- Do not expose preload APIs to content iframes.
- Block scripts and external navigation by default unless a reader/runtime requires a documented exception.
- Before changing a fragile reader integration, read the project troubleshooting docs and preserve documented sandbox/StrictMode constraints.

## Local AI, TTS, And Audio

- Renderer never calls Python, Swift, MLX, PyTorch, ffmpeg, or model runtimes directly.
- Use adapters and supervised sidecars/processes controlled by the main process.
- Keep model/voice-specific tags out of generic UI and services; pass canonical narration/prosody contracts between layers.
- Voice cloning requires explicit recorded consent before a cloned voice becomes available.
- Voice samples, cloned voices, voice embeddings, books, audio, and manifests stay local by default and must not enter logs or exports without explicit confirmation.

## Jobs And Workers

- Heavy processing should run in workers or supervised sidecars.
- Jobs should persist status, progress, errors, cancellation when possible, and retry state when appropriate.
- UI should observe jobs without blocking.
- Workers must not access UI.
- Payloads crossing worker or IPC boundaries must be validated.
- Heavy LLM/TTS jobs should respect resource governors; do not run expensive inference in parallel without justification and benchmarks.

## Derived Artifacts

- Treat generated artifacts such as audiobooks, previews, indexes, and rendered files as derived.
- Keep canonical manifests, chapter/audio metadata, or database records as source of truth.
- Rebuild derived artifacts atomically from canonical metadata rather than appending in-place when consistency matters.
