# ADR-0023: macOS session navigator (Herdr layout)

- Status: adopted
- Date: 2026-10-12

## Context

The Mac app opened every session in its own window. With many Agents running, the
desktop filled with terminal windows. Herdr shows the same Agents in one window,
with a sidebar of workspaces ("spaces"). Users asked for that view as an option, not
as a replacement for standalone windows.

## Decision

- **One session engine, two containers.** `TerminalSessionController` owns one
  session's terminal, conversation view, connections, notification-route checks
  and attachments. It has no window. `TerminalWindowController` (standalone) and
  `SessionNavigatorController` (navigator) only host its view. Neither mode forks
  terminal or chat behaviour.
- **Setting.** `session.windowMode` (`standalone` by default, or `navigator`) in
  Settings → 通用 → 会话窗口. `ControlCenterModel.open` routes the list, notifications
  and 新建对话 to the selected container. Changing the setting moves open sessions
  immediately. Standalone windows are adopted back to front, so the front window
  stays on screen. Leaving navigator mode turns the session on screen into a window
  and detaches the others. A move only re-parents the session's view: the process,
  connection, draft and screen are kept.
- **Grouping.** The sidebar groups the active Host's sessions by the Herdr workspace
  label already present in `session_list_result`. Sessions without a workspace (TB
  PTYs) go in a last group, 其他会话. Groups sort by label, and rows by session ID in
  natural order, so status changes never reorder the list. Unnamed Herdr Agents,
  whose name falls back to the workspace label, are titled by their Agent kind.
  Duplicate titles in one group get the pane suffix. Workspaces that share a label
  share a group. This avoided a protocol change to send workspace IDs or cwd. The
  cwd is not used for grouping: it changes as an Agent works and would move rows.
- **Local source.** 本机 lists the current Herdr snapshot using the same executable
  and server environment as native attachment. A persisted Host context cannot
  supply Herdr membership. Only Host-owned PTYs from a context no older than 30
  seconds supplement the list. Reads run off the UI thread; cancelled reads and
  results from before a Host switch cannot replace the selected Host's list.
- **Live limit.** At most four sessions stay attached: the one on screen plus the
  most recently viewed. Each attached session holds a Host connection and, for native
  Herdr terminals, the pane's control lease, which can block other clients (the
  phone falls back to the compatible transport). Older sessions are closed rather
  than suspended, because a hidden WKWebView and terminal buffer for every visited
  Agent would also be unbounded. A session whose conversation send is still
  waiting for its receipt is never closed by navigation: closing it would turn the
  send into `uncertain` (结果未知). Closing the navigator window detaches
  everything, exactly like closing a session window.
- **Focus.** Clicking a row focuses the session. Arrow keys in the list keep focus
  in the list: the current event at selection time decides. A hidden session, or
  one attaching while the user browses the list, never takes focus.
  ⌥⌘↓/⌥⌘↑ step through rows and focus the session. The navigator answers the
  same ⇧⌘T/⇧⌘D view switches as a standalone window.
- **Chrome.** The navigator follows the system appearance. The terminal surface
  stays fixed dark inside the detail area, and the conversation view follows the
  system, as in standalone windows. The detail has no duplicate session, directory
  or Host heading; window controls stay above the sidebar. Switching Hosts clears
  the visible detail until a session is selected, retaining recent connections.

## Consequences

- Returning to any of the last four sessions is instant. Older ones reattach and
  redraw like a newly opened window.
- The sidebar identifies the selected Host and session; the Window menu retains
  the session title without spending another row on it in the detail.
- Verification: `swift test` (`SessionDirectoryTests`, `SessionNavigatorTests`)
  covers grouping, focus with real key events, the live limit, the unconfirmed-send
  exception, and moves between containers with the same process.
  `node scripts/test-session-navigator.mjs` checks Host viewer counts against a
  disposable Relay/Host.
- Not done: Herdr's tab/pane split layout inside one workspace, a branch label (not
  on the wire), and restoring the navigator's open sessions at launch.
