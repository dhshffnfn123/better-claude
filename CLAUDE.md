# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Better Claude** — an Electron desktop app that wraps the local `claude` CLI binary. The renderer is a React chat UI; the main process spawns the user's installed `claude` executable in stream-JSON mode and proxies the streamed events back to the renderer over IPC.

Code, comments, and UI strings are in Korean. Match the existing language when editing.

## Commands

- `npm start` — run the app in dev mode (electron-forge + Vite, opens DevTools).
- `npm run package` — produce an unpackaged build under `out/`.
- `npm run make` — build distributables (Squirrel, ZIP, RPM, DEB).
- `npm run lint` — ESLint over `.ts`/`.tsx`.

**Build with Node 22 (`.nvmrc`), not Node 24.** On Node 24.16 `extract-zip` 2.0.1 (used by
`@electron/packager` to unpack the cached Electron zip) stalls after a few files, so `package`/`make`
hang forever at "Copying files" with ~0% CPU. Same zip extracts in <1s on Node 22.

There is no test runner configured.

**Typecheck with `npx -p typescript@5.6.3 tsc --noEmit -p .`, not the project's own `tsc`.** The pinned
TypeScript 4.5 cannot parse current `.d.ts` files in `node_modules`, and when there are syntax errors
it skips semantic checking entirely — it prints only `node_modules` errors and reports **no** errors in
`src`, even broken ones.

## Architecture

### Electron Forge + Vite (3 builds)

`forge.config.ts` runs three Vite builds: `src/main.ts` (main), `src/preload.ts` (preload), and `src/renderer/main.tsx` (renderer, named `main_window`). The renderer-side globals `MAIN_WINDOW_VITE_DEV_SERVER_URL` and `MAIN_WINDOW_VITE_NAME` are injected by `plugin-vite` and used in `src/main/windows/create-main-window.ts` to switch between dev-server and packaged file loading.

### Modules Vite cannot bundle: hand-copied

`vite-plugin` strips `node_modules` from the package, and two kinds of module cannot be bundled
into the CJS main bundle at all:

- **Native**: `node-pty` + its peer `node-addon-api`. (Note: nothing in `src/` imports `node-pty`
  any more — it is dead weight, ~58 MB of `prebuilds/` copied into every build.)
- **ESM-only**: `@anthropic-ai/claude-agent-sdk` ships only `sdk.mjs`. Rollup fails outright when
  asked to inline it into CJS, and a plain dynamic `import()` gets downleveled to `require()`.
  `src/main/services/claude-sdk.ts` hides the import behind `new Function("s", "return import(s)")`
  so it survives bundling — which only works if the package is on disk, hence the copy below.

They are listed in two places that must stay in sync:

- `vite.main.config.ts` → `rollupOptions.external` keeps them out of the main bundle.
- `forge.config.ts` → `NATIVE_MODULES` array + `packageAfterCopy` hook copies them into the packaged `node_modules/`. `AutoUnpackNativesPlugin` then pulls them out of asar.

When adding any other unbundlable module, add it in **both** places.

### `claude` CLI integration (`src/main.ts`)

Chat runs through **`@anthropic-ai/claude-agent-sdk`** (`query()`), not a hand-rolled
`child_process.spawn` + NDJSON parser. `sendTurn`/`startLive`/`pump` feed a push-queue prompt stream and
maps SDK messages onto the existing IPC events (`chat:chunk`, `chat:thinking`, `chat:tool_use`,
`chat:tool_result`, `chat:usage`, `chat:error`, `chat:done`).

Things that are load-bearing:

- **Turn end = the `result` whose `user_message_uuids` contains this turn's uuid — not the end of
  `query()`.** Each sent `SDKUserMessage` carries a `uuid`. While background work runs
  (`run_in_background` Bash, background agents, ultracode workflows) the CLI keeps going after
  `result`: it waits for the tasks, then starts a follow-up turn on its own, and only then exits.
  Treating "query ended" as "turn ended" (the old behaviour) pinned the UI in "responding" for the
  whole task — forever for a dev server. Results that don't carry our uuid are dropped: resuming a
  stopped session first flushes the old process's task notification as an empty `num_turns: 0`
  result. Local slash commands (`/cost`) also return `num_turns: 0`, but with the uuid.
- **`LiveSession` keeps the query alive across turns while background tasks exist**
  (`background_tasks_changed` count > 0). The input is a push queue (`createInputQueue`): a message
  sent meanwhile goes into the same process; a follow-up turn the CLI starts itself is announced with
  `chat:turn_start` and rendered as a new reply. With no background tasks, the input is closed at
  `result` (otherwise `for await` waits forever). If the query options changed (`optionsKey()`), or on
  `chat:new` / resume / cwd change, the process is closed — `q.close()` also kills its background
  shells (verified).
- **Stop is immediate and does not wait for main.** The renderer closes the turn itself
  (`finishRef` in `useClaudeChat`: listeners off, running tools marked 중지됨, modals closed).
  `chat:stop` marks the session `stopped` — `pump` then forwards nothing more — and sends **no**
  `chat:done` (a late one would end the *next* turn). The process is reaped in the background
  (`interrupt()` ≤1s, then `close()`). `stopEpoch` cancels a `sendTurn` that is still between awaits
  (spawning the CLI / waiting for the previous process).
- **Background task details panel** (click "백그라운드 N" → `BackgroundTasksPanel.tsx`). `pump` keeps
  per-session maps: membership from `background_tasks_changed` (`bgMembers`, replace-all), details from
  `task_started` (tool_use_id, prompt, subagent/workflow) and `task_progress` (current activity,
  tool uses, tokens, last tool, `summary` — enabled by `agentProgressSummaries: true`), tool inputs (to
  show a shell task's command), and shell output files parsed from the Bash tool_result text
  "…background with ID: <id>. Output is being written to: <path>.output" (`BG_OUTPUT_RE`). The SDK has
  no public method for the `get_task_output` control request, so `background:output` reads the tail
  of that file directly — keyed by task id only, never a renderer-supplied path. `background:stop` =
  `q.stopTask(id)` (stopping an agent also ends tasks it launched; others keep running — verified).
  The output-path tool_result arrives *after* `task_started`, so `recordTaskArtifacts` returns
  "changed" and `pump` re-sends the list then (otherwise an agent-launched shell showed no output).
  Agent activity: subagent tool_use/tool_result carry `parent_tool_use_id` = the Agent call's
  `task_started.tool_use_id`, recorded as `recentTools` (last 6, with status). Finished tasks:
  `task_notification` (status, summary, usage) → module-level `finishedTasks` (last 10, survives the
  CLI process exiting, cleared on new chat / resume / cwd change / "지우기"). Exit code is parsed from
  the summary ("… failed with exit code N") first — the output file's "[exited with code N]" line may
  not be written yet at notification time. `chat:background` sends `{running, finished}`.
- **Subagent messages (`parent_tool_use_id` set) never drive the main conversation.** The SDK
  emits subagent tool_use/tool_result (and stream events) by default. `pump` drops them while no
  turn is active — otherwise a background agent's tool call looked like a CLI-started follow-up turn
  and pinned the UI in "responding" for the agent's whole run (reproduced). During a turn they are
  forwarded with `parentToolUseId`: the renderer shows them only in the activity panel (indented),
  never in the reply segments, and their text/thinking/usage is not forwarded — matching loaded sessions.
- **Regenerate / edit truly replace the last user turn.** `chat:send(msg, images, replaceUuid)` →
  `prepareReplace` finds the transcript entry just before that user message and the next process
  starts with `resumeSessionAt` = that entry, so the old prompt and its replies leave the model's
  context too (before, the app just re-sent into the same session and the model saw both — reproduced).
  The live process is always closed first (resume point changes). If the replaced message is the
  session's first entry there is no fork point: a fresh session is started and the old one is
  deleted once the new session id appears (`replaceFirst`); if no new session appears (failure/stop)
  `restoreReplaceFirst()` puts the old session back. Files the discarded reply edited are not rewound.
- **The input stream must stay open for the whole turn.** Closing it early means the CLI cannot ask
  for anything mid-turn, so permission requests are auto-denied.
- **`pathToClaudeCodeExecutable: resolveClaudePath()`.** Without it the SDK runs its own bundled
  binary (`@anthropic-ai/claude-agent-sdk-<platform>`, ~224 MB) instead of the one the app
  resolved. Passing the app's binary keeps auth and version identical to what the user's terminal
  uses (`apiKeySource: "none"` = the terminal's OAuth login).

Permissions round-trip through `canUseTool` → `chat:permission_request` → renderer modal →
`chat:permission_response` → the promise resolves with `{behavior:'allow'|'deny'}`. The shield
toggle picks `permissionMode`: `bypassPermissions` vs `default`. **`canUseTool` is supplied in both
modes** — without it the CLI drops `AskUserQuestion` from the tool list, so in allow-all mode (the
owner's default) Claude could never ask a question. In bypass mode the CLI auto-approves regular
tools before consulting the callback; `askPermission` also returns allow immediately for any
non-question tool while `skipPermissions` is true (so flipping the shield to allow-all mid-turn takes
effect for the rest of that turn). The SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for
this combination — expected, harmless. Every path out
of a turn (`finishTurn`, `pump`'s `finally`) must settle pending permission promises and emit `chat:permission_resolved`, or the
renderer modal never closes.

**`AskUserQuestion` rides the same `canUseTool` callback**, and the wiring is counter-intuitive:

- The tool only appears in the session's tool list **when `canUseTool` is supplied** (verified in
  both modes). Without a permission surface it is absent, which is why bare `-p` can never show a picker.
- The full `{questions: [{question, header, options: [{label, description}], multiSelect}]}` payload
  arrives as `canUseTool`'s `input` — `askPermission` detects the tool name, routes it to
  `chat:question_request`, and `QuestionModal.tsx` renders it.
- **The answer goes back as `{behavior: 'deny', message}`.** That message becomes the tool_result
  the model reads (verified: the model answers from it correctly). `{behavior:'allow'}` — with or
  without `updatedInput` — lets the CLI's own implementation run, which has no UI to draw into and
  returns "The user did not answer the questions." `deny` is the only slot in the protocol that
  carries text back, so it is load-bearing here, not an error path.

Model/effort/ultracode: `effort` and `model` are SDK options; ultracode goes through
`extraArgs: {settings: '{"ultracode":true}'}` because `--effort ultracode` is rejected by the CLI.
`effectiveEffort()` pins effort to `xhigh` while ultracode is on.

The model picker is fed by `models:list` → `query.supportedModels()` on an idle query (an input
stream that never yields, so no turn starts). Rows are deduped by `resolvedModel` (the CLI lists
aliases like `default`/`opus` alongside real ids) and the app always stores/sends the real id.
Per-model `supportsEffort` / `supportsFastMode` / `supportsAdaptiveThinking` gate the effort
option, the fast toggle, and `thinking`; when the list is not loaded yet, everything is assumed
supported. `fastMode` rides the same `--settings` JSON as ultracode (there is only one `--settings`).

**System prompts are passed with `snapshot: false`, always** (even with no prompts:
`{type:'preset', preset:'claude_code', append: undefined, snapshot: false}`). The default (`snapshot`
omitted = record) freezes the system prompt into the transcript on the conversation's first request
and reuses it on every `resume` — and the app resumes on every turn — so a prompt added mid-conversation
was ignored and a removed one kept applying (both reproduced). Measured: no prompt-cache loss with
`snapshot: false` across turns, even with git status changing between them.

`thinking: {type: 'adaptive', display: 'summarized'}` is load-bearing: 5th-gen models default to
`display: 'omitted'`, which sends empty thinking text and the activity panel shows nothing.

On `result`, `pump` sends `chat:cost` (`total_cost_usd`, session-cumulative estimate) and
calls `getContextUsage({detail: 'summary'})` → `chat:context` **before** closing the input stream —
control requests only work while the query is alive. Safety-classifier refusals arrive as system
messages `model_refusal_fallback` / `model_refusal_no_fallback` and surface as `chat:error` notices.

**Streaming** (`includePartialMessages`): text/thinking go out from `stream_event` deltas; the
completed `assistant` message that follows is skipped for text/thinking when its `message.id` was
streamed (`streamedMessageIds`), but `tool_use` is still sent from it. Assistant messages that never
streamed (e.g. API error frames) are sent whole.

**"이 대화에서 항상 허용"**: `canUseTool`'s `suggestions` are narrowed to allow-rules, directories and
`setMode: acceptEdits`, re-targeted to `destination: 'session'` (never written to settings files),
and returned as `updatedPermissions`. Session rules die with the CLI process, and the app spawns a
new process per turn, so the app also keeps them per conversation (`grantsBySession`, keyed by
session id; `unsavedGrants` until a new conversation gets its id) and passes them as `allowedTools` /
`additionalDirectories` / `permissionMode` on every `startLive`. Reopening a conversation restores its
grants; an app restart drops them all (same as terminal `claude` session rules — intentional). The CLI decides the rule's breadth —
for `node -e …` it suggests the exact command only.

**File rewind** (`enableFileCheckpointing` + `rewindFiles(uuid)`): the uuid is the one we stamp on the
user message (`chat:turn_uuid`; for loaded sessions, the transcript entry's `uuid`). Rewinding to a
message restores files to just *before* that message; the conversation is untouched. Checkpoints live
in the session transcript, so with no live process `chat:rewind_files` resumes the session on an idle
input stream just to call it (verified across processes). Only Write/Edit changes are tracked, not
files Bash creates.

**Plan usage** comes from `rate_limit_event` (`unifiedWindows`, utilization 0–1), merged per window
type in main because each event may carry only one window. The `usage_EXPERIMENTAL…` API is avoided
on purpose.

Sessions resume via the `resume` option. Model, effort, ultracode, fastMode and system prompts are
persisted in `userData/settings.json` (`settings.save` in each setter, `loadChatSettings()` in
`whenReady`). The permission shield (`skipPermissions`) is deliberately **not** persisted: "allow
all" is the owner's preferred default, and "ask" is a per-conversation mode — main resets it to allow
all on `chat:new` and cwd change. The renderer must re-read it (`chat:get_permissions`) on mount and
after every new conversation (`startNewConversation`). The original bug was the UI not following that
reset: the shield kept showing "ask" while tools ran unasked.

### JSON files in `userData`

`settings.json` goes through `src/main/services/json-store.ts`. A missing
file yields the default; a file that fails to parse is **renamed** to `*.corrupt-<timestamp>.json`
before the default is returned — never treat a parse error as "empty" and write over it (that used
to wipe the app's old `conversations.json` history). Writes go to a temp file and `rename` over the original.

### PATH expansion before any spawn

`expandPathForChildProcesses()` (`src/main/services/path-expander.ts`) is called at the **top of `src/main.ts`, before any `import` that might trigger a spawn**. GUI-launched Electron inherits launchd's minimal PATH, so this prepends Homebrew, nvm versions (auto-discovered), volta, bun, cargo, fnm, etc. Anything that runs `claude`, `node`, or `open` depends on this — do not move the call.

### Multi-profile auth (the load-bearing weirdness)

macOS keychain has exactly one slot for `Claude Code-credentials` (service name in `keychain.ts`), so multiple accounts cannot coexist there. The workaround in `src/main/services/profiles.ts`:

- Each profile has its own `configDir` under `userData/profiles/<uuid>/` used as `CLAUDE_CONFIG_DIR`.
- Each profile's token is mirrored to `<configDir>/.credentials.backup` (mode 0600).
- On `profiles:select`: read current keychain → save into the **outgoing** profile's backup → load **incoming** profile's backup → write to keychain (or clear keychain if no backup, forcing re-login).
- On `will-quit`: restore the **terminal profile** (oldest profile by `createdAt`) into keychain, so the user's external terminal `claude` keeps working with the original account after the app exits.
- `useTerminalAuth: true` profiles are a special mode: they bypass the swap entirely and use `~/.claude` directly (no `CLAUDE_CONFIG_DIR` override, no keychain write). Used to share the terminal session in-app without risking it.

Touch this code carefully — losing the terminal token is the dominant failure mode.

### Links never navigate the app window

`src/main/windows/link-guard.ts` (`guardNavigation`, attached in `createMainWindow`): Electron's
default is to navigate the app window itself to a clicked link, leaving no way back to the chat.
`setWindowOpenHandler` + `will-navigate` open http(s)/mailto in the default browser and block
everything else — `file://` and relative links (e.g. `[main.ts](src/main.ts)`) are blocked rather than
opened, since `openExternal` on a file can execute it. Same-document navigation (reload) is allowed.
Markdown links render with `target="_blank"` (`MARKDOWN_COMPONENTS` in `MessageItem.tsx`).

### IPC contract

All renderer↔main calls go through `window.electronAPI` (defined in `src/preload.ts`, typed in `src/declarations.d.ts`). When you add a channel:

1. Register the handler in `src/main.ts` (`ipcMain.handle(...)` or `event.sender.send(...)`).
2. Expose it in `src/preload.ts` via `contextBridge`.
3. Add the type to the `Window.electronAPI` interface in `src/declarations.d.ts`.

All three must agree.

### External backend at `http://localhost:8080`

`src/main/services/api-client.ts` posts conversation/token-usage records and reads daily stats from a separate backend server (not in this repo). Failures are silently swallowed (`null` return); the app keeps working without it.

### Conversation history = the CLI's own session transcripts

The sidebar lists `listSessions()` (all projects, terminal sessions included) and opens one with
`getSessionMessages()` → `sessionToMessages()` (drops subagent entries, attaches `tool_result` to its
`tool_use`, shows `<command-name>` entries as `/cmd args`). Resuming moves `currentCwd` to the
session's `cwd`. The CLI finds the session from any folder, so if that folder no longer exists
the resume still succeeds and continues in whatever folder is current (verified). `chat:resume_session`
therefore returns `{cwd, cwdMissing}` and the renderer warns; `sessions:list` marks `cwdMissing` too.
Delete = `deleteSession()`, which also removes it from the terminal's `/resume`. The app no longer
keeps its own copy; the old `userData/conversations.json` is left on disk but unused.

### Per-folder CLI info (`probeFolder`)

Commands (skills, plugins, MCP prompts), models and MCP status come from an idle query per folder:
`initializationResult()` gives commands + models in one round trip; `mcpServerStatus()` is polled until
nothing is `pending` (≤10s). Cached per cwd, failures are not cached. While a live session exists its
`supportedCommands()` / `mcpServerStatus()` are used instead, MCP status is refreshed after every turn,
and `commands_changed` system messages are pushed as `chat:commands`.

### Work files panel (`FilesPanel.tsx`, header folder-tree button)

Right-hand panel, closed by default: the working folder as a lazily loaded tree (`files:list_dir` per
expanded folder), files Claude changed in this conversation marked, click a file to view it (highlight.js
`lib/common` + `github.css`; not highlighted above 400K chars) or its change history (`ToolDiff`).
Open/width/"바뀐 파일만" live in `localStorage` (`filesPanel.*`). Under 760px it overlays the chat.

- **Tracking lives in main** (`trackFileEdits`, called in `pump` for every message, subagents included,
  before the subagent drop): a Write/Edit/MultiEdit/NotebookEdit `tool_use` is remembered in
  `pendingEdits` and counted only when its `tool_result` is not an error (a failed Edit does not mark the
  file — verified). Bash-made changes are not tracked. Up to 50 hunks per file are kept for the history tab.
- **Paths**: `file_path` is resolved against `currentCwd` (Claude does send relative paths — observed), then
  mapped from the real path back to the app's spelling of the cwd (`toCwdPath`). The CLI works in the
  realpath (`/tmp` → `/private/tmp`; verified with a symlinked cwd), but the tree is drawn from the app's
  path, so without this the file landed in "작업 폴더 밖".
- **"방금"** = `lastTurn === turn`. `fileTurn` increments in `beginTurn`, which re-sends the list so the
  previous response's marks drop to "수정 N" as soon as a new response starts.
- **Reset** on `chat:new` / folder change / resume. Resume recomputes from the transcript
  (`loadChangedFilesFromSession`); `changedFilesGen` discards a recompute that finishes after the user
  already moved to another conversation (it used to leak into the new one). Edit times come from each
  entry's `timestamp` (`entryTime`) — present at runtime though `SessionMessage`'s type omits it;
  without it every history entry showed the time the conversation was opened.
- **File access is restricted in main**: `files:list_dir` / `files:read` / `files:reveal` accept only
  absolute paths inside `realpath(currentCwd)` or files Claude changed in this conversation (outside ones
  are listed under "작업 폴더 밖"). Symlinks pointing out of the cwd are refused. Reads cap at 1 MB; a NUL
  byte in the first 8 KB means binary.
- **Three views** (`filesPanel.view`; the old `filesPanel.onlyChanged` maps to "claude"): 전체 (tree),
  Claude 수정 (the tracking above), Git 변경 (everything since the last commit — Bash, editor, other
  conversations included). The file viewer's tabs follow: 내용 / Claude 수정 / Git 변경, opening on the
  one matching the view the file was clicked in.
- **Git 변경 is read-only** (`src/main/services/git-changes.ts`): `git status --porcelain=v2 -z --branch
  --untracked-files=all -- .` from the cwd (so only the cwd subtree — same scope as the tree and the file
  access rules) + `git diff HEAD --numstat` for +/− counts (`--cached` while the repo has no commit yet).
  Porcelain paths are repo-root-relative, so diffs run from the repo root; paths go through `toCwdPath`
  like Claude's edits. `git:diff` only accepts a path from the last status result (`lastGit`), never an
  arbitrary renderer path. Untracked files have nothing to diff against — main synthesizes an all-added
  unified diff so the renderer has one diff format. `GIT_OPTIONAL_LOCKS=0` keeps status off `index.lock`.
  Repo detection walks up for `.git` instead of parsing git's (localizable) error text. On macOS
  `/usr/bin/git` is a shim that pops an "install developer tools" dialog when the CLT are missing — it is
  only used if `xcode-select -p` succeeds. Refresh: Claude edits (`files:changed`), every turn end
  (`refreshKey` = `turnEnd.seq`), window focus, the ↻ button — debounced 300 ms, overlapping calls in main
  share one promise. The renderer types use `git.ok === false` for narrowing: `strict` is off, and `!git.ok`
  does not narrow the union.

### Send queue, notifications, copy, code blocks (renderer)

- **Typing while Claude responds** (`ChatInput.tsx`): the textarea stays enabled; Enter while loading
  queues a `Draft` (raw text + attachments; queuing again merges into it) shown as "응답이 끝나면 보냄".
  `useClaudeChat` exposes `turnEnd {seq, stopped}` from `finish`. Normal end → the draft is sent;
  stopped → it goes back into the input (in front of anything typed since — nothing is dropped); "지금
  보내기" = stop, then send (`sendAfterStopRef`). Changing conversation bumps `resetSignal`
  (`conversationSeq` in `chat.page`, in `startNewConversation` / `handleLoadSession`) → draft goes back to
  the input. That is load-bearing: `chat:new` mid-turn → `closeLive` → `pump`'s `finally` still sends
  `chat:done`, which would otherwise auto-send the draft into the *new* conversation.
- **Notifications** (`hooks/useNotificationSound.ts`): the renderer decides, main (`notify:show`) only
  displays. Turn done → chime always (as before) + macOS notification when `!document.hasFocus()`.
  Permission request / question → only when away: a different (descending) chime + notification.
  Notifications are `silent: true` — the app's own chime follows the volume setting (0–100, 50 = the
  original loudness). Main keeps each `Notification` in a Set (otherwise it is garbage-collected and the
  click handler is lost) and closes them all on `browser-window-focus`. Settings live in `localStorage`
  (`better-claude:notification-sound` / `-volume`, `better-claude:os-notifications`). The ad-hoc-signed
  dev Electron does get notifications presented on macOS 26 (`show` event fired — verified).
- **Copy buttons go through main** (`clipboard:write` → Electron `clipboard`): `navigator.clipboard`
  rejects when the document isn't focused (e.g. DevTools focused) — verified.
- **Code highlighting** is shared (`src/renderer/highlight.ts`). Chat fences render through the `pre`
  override in `MARKDOWN_COMPONENTS` (`CodeBlock`: language label + copy). Fences without a language are
  not highlighted (auto-detect misfires on command output). `github.css` (light, for the files panel) is
  global, so chat code blocks re-colour every one of its token selectors under `.codeBlockPre` (dark) —
  single-class selectors first, compound ones after (cascade + stylelint order).

### Renderer layout

React 19 + `react-router-dom` v7 with `createHashRouter` (hash routing because `file://` loading rules out `BrowserRouter`). One route: `/` → `chat.page.tsx`. Streaming chat state lives in the `useClaudeChat` hook (`src/renderer/hooks/useClaudeChat.ts`); subscriptions to IPC events are set up per-message-send and torn down on `chat:done`. UI uses antd + FontAwesome + SCSS modules (`*.module.scss`).

Hover tooltips are CSS-only (`data-tooltip` / `data-tooltip-dir="down"` → `::after` in
`styles/index.css`), centered by default. `src/renderer/tooltip-guard.ts` (installed in
`renderer/main.tsx`) measures the real `::after` box on `pointerover` and sets `data-tooltip-align`
(start/end) or flips `data-tooltip-dir` when the bubble would spill past the window or the nearest
`overflow` ancestor (header-right buttons, the first sidebar row). Just add `data-tooltip` — no manual
alignment needed.

Every Enter/keyboard handler on a text field must bail out on `isImeComposing(e)` (`ChatInput.tsx`).
Korean input sends Enter twice when the last syllable is still composing (first with `isComposing`);
acting on the first one sends the text and leaves the last syllable behind in the box.

## Conventions

- TypeScript paths are bare relative imports — no path aliases configured.
- Two ESLint configs exist (`.eslintrc` and `.eslintrc.json`); `.eslintrc.json` is the richer one (prettier + `simple-import-sort`). Don't add a third.
- 4-space indentation in `.ts`/`.tsx` (matches existing files; not enforced by config).
