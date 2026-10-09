# Changelog

User-facing changes to s2s are recorded here. New changes belong under
**Unreleased** until a release is published. Package and handoff protocol
versions are independent.

## [Unreleased]

## [0.4.0] — 2026-10-09

### Added

- `s2s handoff --input context.json` accepts complete context from a JSON file,
  validates fields and generates artifact hashes and Git context automatically.
- Resume automatically checks artifacts, shows warnings before context, and
  distinguishes ready, blocked and completed tasks. Artifact mismatches return
  exit code `1` while keeping the handoff readable.

### Changed

- Removed the rename migration section from the README.
- Highlighted the meaning of s2s (Session to Session) at the top of the README.

## [0.3.0] — 2026-10-02

### Added

- `s2s list` lists handoff tasks, statuses, agent labels and creation times,
  with custom directory and JSON output support. Invalid files are reported.
- `s2s --version` displays the installed package version from any directory.
- Handoffs capture Git branch, commit and dirty state when available. Resume
  compares the current checkout and highlights differences and uncommitted work.
- This changelog to track user-facing changes and release notes.
- Included the changelog in the distributed package.

### Fixed

- Re-running `s2s init` now refreshes existing agent instructions while preserving
  project rules outside the managed block. Invalid or duplicate block markers
  are rejected without modifying the file.

### Changed

- Renamed the framework, package, CLI and protocol identifier to `s2s`
  (session to session). The default handoff directory is now `.s2s/`.
  Existing users must reinstall the renamed package, move their handoffs,
  change the JSON `protocol` value to `s2s` and regenerate agent instructions.

## [0.2.0]

### Added

- Project setup through `s2s init`, with agent instructions in `AGENTS.md`.
- Single-command handoff creation with task, summary, optional context and
  automatically hashed artifact references.
- Explicit `--replace` support for saving a complete replacement handoff.
- Installation instructions for GitHub dependencies and npm-free local clones.

### Changed

- Project setup no longer adds `.s2s/` to `.gitignore`, allowing reviewed
  handoffs to be committed and shared with teammates.
- Existing ignore rules are preserved; setup explains how to remove explicit
  `.s2s` rules when sharing handoffs.

## [0.1.0] — Initial implementation

This section describes the initial package baseline, not a published release.

### Added

- Version 1.0 of the JSON handoff protocol for tasks, summaries, agent labels,
  decisions, evidence, questions, next steps and artifact references.
- Node.js SDK with TypeScript declarations and a JSON Schema.
- CLI commands to create, edit, validate, verify and render handoffs.
- SHA-256 artifact checks for changed, missing or unavailable files.
- Workspace boundary checks for artifact paths and symlinks.
- Automated tests, documentation and the MIT license.
