# ADR-0024: Conversation repositories and the macOS file inspector

- Status: adopted
- Date: 2026-10-13

## Context

Clicking a file path in a macOS terminal opened a Quick Look preview, which shows
many source and config files only as an icon. Git review covered one repository:
the session's working directory. An Agent often changes files elsewhere, such as
a sibling package, a dotfiles checkout, or a second clone. The user then had to
leave the app to see what the conversation changed. Pictures that changed could
not be compared with their committed version at all.

## Decision

- **Which repositories belong to a conversation.** The session's own working
  directory, plus every repository holding a file the Agent changed according to
  its *own* structured record: Codex `FileChange` items, `patch_apply_*` events and
  `apply_patch` calls, and Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool
  calls. Terminal text and shell commands are never parsed, because a guess would
  widen what the Host lets a client read. The record is located from Herdr's
  `agent_session` exactly as for the graphical conversation view (`docs/agent-chat/`), and
  its claimed session id is checked. It is read incrementally from the last
  offset, so polling a long conversation costs only the new lines. TB PTY sessions
  have no record, so they keep their single working-directory repository.
- **Readable roots.** Those repositories become readable roots of that session
  for `session_file_read` and `session_directory_list`, alongside the working
  directory and `TB_FILE_PREVIEW_ROOTS`. A repository the Agent never changed is
  not one. `review_snapshot.repository` accepts only a path the same session's
  `review_repositories_result` listed (re-checked uncached before refusing), so a
  client cannot name an arbitrary Host directory.
- **Committed versions.** `session_file_read.revision = 'HEAD'` reads a file as
  committed, for the "before" side of a changed or deleted picture. Its `version`
  is `HEAD:<blob id>`: if HEAD moves between chunks, the read restarts instead of
  mixing two files. A client treats a reply without that prefix as an older Host
  that ignored `revision`, and never shows the working copy as "before".
- **Private files.** One rule, `isPrivatePath` in `packages/review` (environment
  files, keys, credentials, `.ssh`, `.aws`, `.termbridge`…), now governs both file
  previews and Git diffs. A private file is still listed as changed, because the
  user should know that the Agent touched it. Its hunks are dropped and it carries
  `private: true`. An untracked private file is not read at all, and HEAD reads
  of private files are refused. Before this change, a diff could carry an `.env`
  file's contents to the client.
- **One inspector window.** macOS keeps one reusable 文件与改动 window. Its 文件
  mode is the lazy directory tree. Its 改动 mode stacks the conversation's
  repositories, each with its changed files, plus the files this conversation
  touched that have nothing uncommitted now. A repository shows its overview: every
  file's hunks, linked to that file. A file shows its diff or the whole file. A
  changed image shows committed and working versions side by side over a
  checkerboard. Clicking a link with a line (`:12`, `:12:4`, `#L12`) opens the file
  at that line.
- **Every file gets a view.** A native code view (CodeEditTextView 0.12.1,
  Swift/CoreText viewport layout, line numbers,
  full-width line backgrounds, the find bar) shows text: about 50 syntaxes are
  coloured, recognised by file name, extension or shebang. Any other text is shown
  plain, after trying UTF-8/16 and GB18030, Big5, Shift JIS and Windows-1252. Text
  is shown as text whatever type its extension claims (`.ts`). Images and PDF use
  Quick Look (SVG offers its source too), as do audio, video and office documents.
  Anything else shows a hex dump of its first 64 KB. The MIT-licensed editor core
  is vendored with unchanged upstream source hashes under `Vendor/CodeEditTextView`;
  its manifest uses only DequeModule instead of the Collections umbrella and
  omits the lint build plugin. Runtime dependency notices are bundled; the existing bounded syntax
  highlighter is reused. No WebView is added, and nothing is fetched to render a
  page. This inspector uses the component in read-only mode; remote file saving
  requires a separate version-checked Host contract.
- **Files load without a preceding file click.** Entering Files asks the Host for
  `session_directory_list` with `path: "."`. Its canonical response establishes
  the root; the client never guesses a local path for a remote session. A file
  click may reveal a different permitted root while that request is in flight,
  in which case the late root response is ignored. Directory and snapshot
  requests have bounded waits with visible errors and an explicit refresh path.
- **Compatibility.** A Host without `review_repositories` stays silent; after
  10 s the inspector falls back to the working directory's `review_snapshot`, and
  says that updating the Host shows the other repositories. Older clients ignore
  the new fields: a private file shows as a file with no lines.

## Consequences

- What a client may read now depends on what the Agent did. Opening a
  conversation can make a repository it edited readable, but only through the
  same bounded, sensitive-checked reads as before.
- Repository roots are cached for 60 s per session, because a file read asks for
  them on every 128 KiB chunk. A repository the Agent starts editing appears
  within a minute, or immediately on the next `review_repositories`.
- Verification: `packages/review` (`index.test.ts`: conversation repositories,
  committed contents, private files, the end-of-file marker),
  `packages/host/src/conversationFiles.test.ts` and `sessionFiles.test.ts`,
  scenario 21 of `scripts/test.ts`, the macOS `CodePreviewTests`, and
  `scripts/test-desktop-files.ts --ui`. The last runs a real Relay, Host and fake
  Herdr against two Git repositories and drives the inspector window, including
  the image comparison and the private file.
