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
- **The input stream must stay open for the whole turn.** Closing it early means the CLI cannot ask
  for anything mid-turn, so permission requests are auto-denied.
- **`pathToClaudeCodeExecutable: resolveClaudePath()`.** Without it the SDK runs its own bundled
  binary (`@anthropic-ai/claude-agent-sdk-<platform>`, ~224 MB) instead of the one the app
  resolved. Passing the app's binary keeps auth and version identical to what the user's terminal
  uses (`apiKeySource: "none"` = the terminal's OAuth login).

Permissions round-trip through `canUseTool` → `chat:permission_request` → renderer modal →
`chat:permission_response` → the promise resolves with `{behavior:'allow'|'deny'}`. The shield
toggle picks `permissionMode`: `bypassPermissions` (no `canUseTool`) vs `default`. Every path out
of a turn (`finishTurn`, `pump`'s `finally`) must settle pending permission promises and emit `chat:permission_resolved`, or the
renderer modal never closes.

**`AskUserQuestion` rides the same `canUseTool` callback**, and the wiring is counter-intuitive:

- The tool only appears in the session's tool list **when `canUseTool` is supplied**. Without a
  permission surface it is absent, which is why bare `-p` can never show a picker.
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
new process per turn, so the app also keeps them (`sessionAllowedTools`, `sessionDirectories`,
`sessionAcceptEdits`) and passes them as `allowedTools` / `additionalDirectories` / `permissionMode`
on every `startLive`. Reset on new chat / resume / cwd change. The CLI decides the rule's breadth —
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
`whenReady`); the permission shield is not — it resets to "allow all" on every new conversation.

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
session's `cwd` — transcripts are stored per project folder, so `resume` fails from another folder.
Delete = `deleteSession()`, which also removes it from the terminal's `/resume`. The app no longer
keeps its own copy; the old `userData/conversations.json` is left on disk but unused.

### Per-folder CLI info (`probeFolder`)

Commands (skills, plugins, MCP prompts), models and MCP status come from an idle query per folder:
`initializationResult()` gives commands + models in one round trip; `mcpServerStatus()` is polled until
nothing is `pending` (≤10s). Cached per cwd, failures are not cached. While a live session exists its
`supportedCommands()` / `mcpServerStatus()` are used instead, MCP status is refreshed after every turn,
and `commands_changed` system messages are pushed as `chat:commands`.

### Renderer layout

React 19 + `react-router-dom` v7 with `createHashRouter` (hash routing because `file://` loading rules out `BrowserRouter`). One route: `/` → `chat.page.tsx`. Streaming chat state lives in the `useClaudeChat` hook (`src/renderer/hooks/useClaudeChat.ts`); subscriptions to IPC events are set up per-message-send and torn down on `chat:done`. UI uses antd + FontAwesome + SCSS modules (`*.module.scss`).

## Conventions

- TypeScript paths are bare relative imports — no path aliases configured.
- Two ESLint configs exist (`.eslintrc` and `.eslintrc.json`); `.eslintrc.json` is the richer one (prettier + `simple-import-sort`). Don't add a third.
- 4-space indentation in `.ts`/`.tsx` (matches existing files; not enforced by config).
