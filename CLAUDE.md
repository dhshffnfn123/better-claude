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

**The packaged macOS app is re-signed ad-hoc in `postPackage`** (`forge.config.ts`, skipped when a
real `osxSign` is configured). FusesPlugin re-signs the app right after flipping fuses
(`packageAfterCopy`), but that is *before* @electron/packager rewrites Info.plist (bundle id, names) —
so the finished app was signed as `com.github.Electron` with a modified Info.plist (`codesign
--verify`: "invalid Info.plist", error -67030), and macOS's notification daemon rejected every
notification from it: `usernoted … Denying message 3 from connection <LegacyConnection identifier:
io.handoo.better-claude>` (reproduced with a bundle in the same state; re-signing fixed it). Re-signed,
the first notification makes macOS ask for permission. To read such logs use **`/usr/bin/log show`** —
in zsh, plain `log` is a builtin and silently prints nothing.

There is no test runner configured. Verifying in the running app (CDP on `--remote-debugging-port`,
main via `--inspect`):

- **`npm start -- --user-data-dir=<dir>`** gives the dev app its own `settings.json` / `tabs.json`
  (Electron honours the switch — verified), so it can run next to the owner's installed app without
  the two overwriting each other's tabs.
- **Driving it**: menu items via `Menu.getApplicationMenu()…click(undefined, W)` from the main debugger
  (accelerators can't be synthesized); file drops via CDP `Input.dispatchDragEvent` with `data.files`; IDE
  launches are captured without opening the owner's IDE by swapping `require("child_process").execFile`
  in main (the bundle calls `child_process.execFile` at call time). Use a uniquely named test project
  folder — the sidebar lists *every* session in `~/.claude/projects`, so bulk-delete tests must filter to it.
- **Harness gotchas**: launched in the background, `electron-forge start` quits as soon as its stdin closes —
  keep it open (`sleep 86400 | npx electron-forge start -- …`). Every tab view stays mounted, so
  `querySelector("[data-chat-input]")` finds a *hidden* tab's input first (and sends there) — filter by
  `offsetParent`. CDP `Emulation.setEmulatedMedia` lasts only while that CDP session stays attached; for
  one-shot scripts set `nativeTheme.themeSource` from main. A Fast Refresh that fails ("… export is
  incompatible") remounts the whole shell without a page load and restored tabs can come up empty —
  reload before judging tab restore.
- **An occluded window stops rendering**: `visibilityState` is `hidden`, rAF never fires, scroll events
  and smooth scrolling stall — scroll-driven UI looks broken in tests. `setBackgroundThrottling(false)`
  did not survive a reload; `W.setAlwaysOnTop(true, "floating"); W.showInactive()` (from the main
  debugger) brings it forward without taking keyboard focus.

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
  `result` (otherwise `for await` waits forever). If the query options changed (`optionsKey()`), or
  when the tab's conversation is reset (`resetConversation`: `tabs:open`, cwd change, session delete)
  or the tab is closed, the process is closed — `q.close()` also kills its background shells (verified).
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
  `task_notification` (status, summary, usage) → the tab's `finishedTasks` (last 10, survives the
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
- **The answer is shown back in the reply** (`QuestionCard.tsx`, parsing in
  `src/renderer/question-answers.ts`): instead of the old "⚠ AskUserQuestion {json}" tool row (the
  answer comes back as an `is_error: true` tool_result, so it looked like a failure), the reply shows each
  question with "내 답" — waiting / answered / 건너뜀 (skip = empty answers → `(skipped)`) / 답하지 않음
  (stop → "The user did not answer the questions."). No separate storage: the card re-reads the
  tool_result text `formatQuestionAnswers` produced, so live turns and loaded conversations match.
  Format = `The user answered:` + one `- <header or question>: <answer>` line per question, in order.
  Inside an answer the picked options are joined with ", " and typed text goes on its own line starting
  `Other: ` (the tool's name for free text) — main tells them apart because the modal sends
  `[...picked labels, typed text]` and only picks equal an option label. The card shows picks as ✓ chips
  and the typed text separately under "직접 입력" (before, "로그인, 검색, 메모…" ran together and the
  card could not tell where the options ended). The parser also reads the older form (typed text appended
  after the picks with ", "), matching option labels longest-first so labels containing ", " work.
  Multi-line answers are **indented two spaces** on continuation lines (otherwise a typed line starting
  with "- " read as the next question). The model reads this form correctly and kept picks and typed
  text apart in its own summary — verified.
  Answer previews are kept to 4000 chars (`toolResultPreview`; other tools 500). The activity panel row
  reads "질문 · <questions>" and turns ✓ once answered.

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

**Compaction** (`/compact`, or automatic when the context fills) shows as a divider inside the reply, not
as a "나" message. Live order (measured): `system/status {status: "compacting"}` → `status {status: null,
compact_result, compact_error}` → `compact_boundary {compact_metadata: {trigger, pre_tokens, post_tokens}}`
→ a user message with `isSynthetic: true` whose text (a string *or* text blocks) starts "This session is
being continued from a previous conversation" = the summary. `/compact` then ends with a replay
`<local-command-stdout>Compacted` and `result num_turns: 0`; automatic compaction happens between steps
of a turn (after a tool result) and the same turn just continues. `handleSdkMessage` turns these into
`chat:compact {phase: start|done|failed|boundary|summary}`: the activity panel says "대화를 요약하는 중…"
(`/compact`) or "대화가 길어 앞부분을 요약하는 중…", and the boundary pushes a `{kind: "compact"}` segment
(`CompactDivider` in `MessageItem.tsx`: trigger, pre → post tokens, "요약 보기"). The summary is shown as
plain pre-wrap text with the model-facing sentences (`cleanCompactSummary`) removed — rendered as markdown
its indented lists spread into big gaps. Failures are not surfaced: a failed `/compact` already replies
"Error: No messages to compact", and automatic compaction fails silently in the CLI too
(`compact_error: "too_few_groups"` happens routinely). Reopened, `getSessionMessages` starts at the last
boundary (older messages live only in the summary); the summary entry carries `isCompactSummary` — match
on that, not on the text, or a user pasting an old summary becomes a divider — and turns into a reply
with a `restored` segment ("이전 대화 요약"). The transcript writes the `/compact` command entry *after*
the summary, so `sessionToMessages` moves it back in front. The SDK gives loaded sessions no compact
metadata (with `includeSystemMessages` the boundary entry is `{}`), so loaded dividers have no token counts.
Zero-token badges are hidden (`/compact`, `/cost`). The `<local-command-stdout>` line is written ~100 ms
after `result`, i.e. after `saveSessionStats`, so it is left out of the transcript's "last entry" time —
otherwise every reopen after `/compact` treated the saved cost/context as stale and showed nothing
(reproduced). To test automatic compaction cheaply, start the app with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`
(the SDK passes `process.env` to the CLI): it compacts at almost every step.

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
on purpose. Each window carries `receivedAt`, is saved to `userData/rate-limits.json` and loaded at
startup (`loadSavedRateLimits`) — without that the header was empty after every restart until the first
reply; the tooltip says "HH:MM에 받은 값 — 다음 응답 때 갱신됩니다", and windows past `resetsAt` are dropped.

**Cost and context survive reopening**: both only arrive at a turn's end, so a restored tab or an
old conversation showed nothing. `saveSessionStats` keeps the last `chat:cost` / `chat:context` per
session (`userData/session-stats.json`, newest 300, plus `maxTokensByModel`); `restoreSessionStats`
(run inside `loadChangedFilesFromSession`, which already walks the transcript) re-sends them. If the
transcript is newer than the saved value (continued in the terminal) the context is recomputed from the
last main-chain response's usage = input + cache-creation + cache-read, **without** output — that is
what the CLI's `getContextUsage({detail: "summary"})` reports (verified equal: 38,473; adding the output
was off by exactly that reply's output tokens). Cost can't be recomputed, so it stays hidden then.

**Settings changed mid-response apply from the next message** — the running CLI keeps the options it was
spawned with (`optionsKey()`; the set_* handlers only update the tab). Verified via the transcript: a reply
switched Haiku→Sonnet mid-way stayed Haiku to the end, the next message was Sonnet. So when the active tab
is responding, changing model / effort / fast / ultracode, or the shield to "확인 모드" (bypass keeps
auto-approving for the rest of the reply; "전체 허용" applies at once and withdraws that part), shows a pill
before the model select (`settingHint` on `TabMeta`): "다음 메시지부터 적용됩니다" — not while idle, where
that is the expected behaviour anyway. It stays while the tab keeps responding (the old settings are still
answering), at least `SETTING_HINT_MIN_MS` (4 s) after the change, and goes away the moment a new message
is sent (`onUserMessage`) — that message already uses the new settings. The SDK could apply changes live
(`q.setModel()` hits the next API step of the running reply — measured; `applyFlagSettings` for
fast/effort/ultracode); the owner chose the notice instead.
System prompts are global (in every tab's `optionsKey`), so `ChatInput`'s add/remove goes through the
shell's `promptHooks`: `confirm()` asks first when any tab has running background tasks (their next
message restarts the CLI and ends them — before, silently), `changed()` marks every responding tab with
the hint and puts the background warning notice in tabs that have tasks. Changing the tab's working
folder starts a new conversation, so it now also asks while the tab is responding (it used to ask only
for background tasks, and a response in progress was silently cut off and the conversation cleared).

Sessions resume via the `resume` option. Model, effort, ultracode and fastMode are per tab (see Tabs);
the last values set in any tab, and the system prompts, are persisted in `userData/settings.json`
(`settings.save` in each setter, `loadChatSettings()` in `whenReady`) as `defaults` for tabs that have
nothing to inherit from. The permission shield (`skipPermissions`, per tab) is deliberately **not**
persisted: "allow all" is the owner's preferred default, and "ask" is a per-conversation mode — main
resets it to allow all whenever a tab's conversation is reset (`resetConversation`), and the renderer
mirrors every reset (`tabs:open` returns the value; folder change / session delete apply `clearedTab`).
The original bug was the UI not following that reset: the shield kept showing "ask" while tools ran unasked.

### Tabs (parallel conversations)

Each tab is an independent conversation with its own CLI process, so several can respond at once.

- **main keeps one `ChatTab` per tab id** (`tabs` map, created on first use by `tabFor(event, tabId)`).
  Everything that used to be a module-level "current conversation" lives on it: `cwd`, `sessionId`,
  model/effort/ultracode/fastMode, `skipPermissions`, `live`, `stopEpoch`, `replaceFirst`,
  `unsavedGrants`, changed files, finished background tasks, the git status cache. Still global:
  `defaults`, system prompts, `grantsBySession` (keyed by session id), plan usage (one account — the
  header shows it for all tabs), the per-folder probe cache.
- **IPC**: every per-tab request takes `tabId` first; every per-tab event goes out through
  `send(tab, channel, payload)` as `(tabId, payload)`. The preload exposes them as `onTabEvent(name, cb)`
  (`TAB_EVENTS` maps names to channels), and `src/renderer/tab-events.ts` (`onTab(event, tabId, cb)` /
  `onAnyTab`) keeps **one** `ipcRenderer` listener per channel and routes by tab id, instead of every
  tab stacking its own listeners. Pending permission promises remember their tab;
  `settlePendingPermissions(tab, …)` settles only that tab's, so stopping one tab never answers another's modal.
- **`tabs:open(tabId, init)`** (re)starts a tab: `resetConversation`, applies `{cwd, sessionId, model,
  effort, ultracode, fastMode}` (missing values keep the tab's own, which start from `defaults`),
  recomputes changed files from the session, probes the folder, and returns
  `{cwd, cwdMissing, sessionMissing, model, effort, ultracode, fastMode, skipPermissions}`.
  A restored tab's session may be gone (deleted in the terminal, or cleaned up by the CLI as old):
  `getSessionMessages` returns `[]` for a missing session and resuming it fails every send with "No
  conversation found with session ID" (both verified), so `tabs:open` checks `getSessionInfo` (no `dir`
  = all projects; `undefined` = missing; on error assume it exists), clears `sessionId` and returns
  `sessionMissing` — the tab becomes a new conversation in the same folder, with a notice.
  The renderer calls it lazily (`ensureOpened`) the first time a tab is shown, so restored tabs nobody
  looks at cost nothing; after the await it re-checks the tab's `gen` and opens again if the tab was
  repurposed meanwhile. **`tabs:close`** bumps `stopEpoch`, restores a pending `replaceFirst`, closes
  the live query (the CLI process is gone after closing a responding tab — verified) and settles its
  permissions. The renderer asks first when the tab is responding or has background tasks; closing
  the last tab opens a fresh one with the same folder and settings.
- **Persistence**: `userData/tabs.json` through json-store (`tabs:load` / `tabs:save`, `cleanSavedTabs`
  validates, ≤50 tabs) = `{tabs: [{id, sessionId, cwd, title, model, effort, ultracode, fastMode}],
  activeId}`, saved 400 ms after a change. A restart brings back the tabs and the active one; the
  permission shield and running work do not survive.
- **Settings are per tab.** A new tab inherits the current tab's folder and model/effort/ultracode/fast.
- **Renderer**: `chat.page.tsx` is the shell — `TabMeta[]`, sidebar, header, cwd bar, files panel
  (`key={active.id}`), notifications, persistence. `ChatTabView` (memoized) is one per tab and **all of
  them stay mounted**; inactive ones are `display: none`, so typed text, the send queue, scroll
  position, open modals and streams survive switching. Status flows up through per-tab `callbacks`
  (cached per id so the memo holds): loading, attention (permission/question → orange `!` on the tab;
  the modal only shows in that tab), turn end (a tab that finishes while you're elsewhere gets a dot),
  the first user message (title, until the CLI's session summary arrives via `refreshSessions`).
- **Opening a conversation from the sidebar**: already open in a tab → switch to it ("열린 탭" badge);
  the current tab is blank (never sent) → open it there; otherwise → a new tab. Deleting a session
  clears every tab that had it (main in `sessions:delete`, renderer `clearedTab`).
- **Tab strip** (`TabStrip.tsx`): status icon (orange `!` / spinner / unseen dot), folder name
  (middle-truncated), title, `⚙ N` while the tab has running background tasks (same count as its
  "백그라운드 N" — a dev server in a tab you're not looking at stays visible), close. Tabs are 200px
  (`width`, not `flex-basis` — with a basis the auto-width list sized to the tabs' content and they
  shrank to ~110px with room to spare) and shrink to 96px, then the list scrolls sideways with its
  scrollbar hidden: `useOverflowScroll` turns vertical wheel into horizontal scroll (Chromium does not
  do this by itself — verified) and fades the edge that hides tabs (`tabListFadeLeft/Right`, a mask).
- **Closing the window, reloading or quitting while work runs asks first** — decided in main, so it
  works even if the renderer is stuck. `busySummary()`: a tab is responding while a `chat:send` is in
  flight (`tab.sending`, covers spawning the CLI) or its live turn is active (CLI-started follow-ups
  too); background = non-ambient `bgMembers`. `confirmStopWork()` shows a sync `showMessageBoxSync`
  ("응답 중인 탭 N개, 백그라운드 작업 M개가 있습니다"). Hooks: `before-quit` (asks once, then `quitting`
  stops the window `close` handler from asking again), `guardWindow()` on every created window (`close`
  asks; `closed` → `disposeTabsOf` — on macOS the app outlives its window and the CLIs kept running
  headless, permission requests unanswerable, and reopening killed the active tab's work), and the
  View menu's own 새로고침 items (the `reload` role cannot ask). A renderer that starts again (reload,
  DevTools ⌘R) calls `tabs:load` first, which disposes that webContents' leftover tabs. `send()` drops
  events from a disposed tab, so a late `chat:done` from a closed CLI cannot end a turn in the tab
  restored under the same id. **Signals don't ask** (`installSignalQuit`, called in `whenReady`):
  Chromium installs its own SIGINT/SIGTERM/SIGHUP handler before `ready` — first signal = graceful
  quit through `before-quit` (so it showed the dialog), next one = default action, i.e. instant death
  that orphaned the CLI and its `sleep` (both verified). Node's `process.on` only registers with the OS
  for a signal's first listener, so it must run after `ready` to win; a second signal disposes all
  tabs and `app.exit`s. macOS logout/shutdown is not a signal (it arrives as `before-quit`) and asks.
- **Shortcuts** live in the app menu (`src/main/menu.ts`): ⌘T new tab, ⌘W close tab (the default
  menu's ⌘W closed the whole window), ⌘⇧W close window, ⌃Tab / ⌃⇧Tab next/previous, ⌘1–8, ⌘9 last.
  Items send `menu:tab` to the focused window; the shell acts on it. Verified by clicking the menu items
  from main — synthetic key events (CDP `Input.dispatchKeyEvent`, `webContents.sendInputEvent`) never
  reach the native menu, so the accelerators themselves can't be tested that way.

### JSON files in `userData`

`settings.json` and `tabs.json` go through `src/main/services/json-store.ts`. A missing
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

All three must agree. Anything about one conversation is per tab: the request takes `tabId` first and
the event is sent with `send(tab, …)` and added to `TAB_EVENTS` in the preload (see Tabs).

### External backend at `http://localhost:8080`

`src/main/services/api-client.ts` posts conversation/token-usage records and reads daily stats from a separate backend server (not in this repo). Failures are silently swallowed (`null` return); the app keeps working without it.

### Conversation history = the CLI's own session transcripts

The sidebar lists `listSessions()` (all projects, terminal sessions included) and opens one with
`getSessionMessages()` → `sessionToMessages()` (drops subagent entries, attaches `tool_result` to its
`tool_use`, shows `<command-name>` entries as `/cmd args`). Opening one in a tab sets the tab's `cwd` to
the session's `cwd`. The CLI finds the session from any folder, so if that folder no longer exists
the resume still succeeds and continues in whatever folder is current (verified). `tabs:open`
therefore returns `{cwd, cwdMissing}` and the renderer warns; `sessions:list` marks `cwdMissing` too.
Delete = `deleteSession()`, which also removes it from the terminal's `/resume`. The app no longer
keeps its own copy; the old `userData/conversations.json` is left on disk but unused. The sidebar
filters by **project name** (the cwd's folder name, case-insensitive — the owner asked for just that)
and has a 선택 mode: check conversations (모두 선택 = everything currently filtered), 삭제 asks once
(how many, how many are open in tabs and will be cleared, background tasks that will end) and deletes
them one by one with the same rules as a single delete.

**Token badges on loaded messages** ("N tokens" next to 나 / Claude): live turns take them from
`result.usage` (input → the user message, output → the reply). `sessionToMessages` rebuilds the same
numbers from each response's `message.usage` in the transcript — the sum over a turn's responses equals
`result.usage` (verified on a tool-using turn: 2+2 / 83+7 = 4 / 90). The transcript writes one response
as several lines (one per content block) that all repeat the same usage, so it counts **once per
`message.id`** — per line came out 2–3× too high. Before this, restored tabs (every app start) showed
no badges at all.

### Per-folder CLI info (`probeFolder`)

Commands (skills, plugins, MCP prompts), models and MCP status come from an idle query per folder:
`initializationResult()` gives commands + models in one round trip; `mcpServerStatus()` is polled until
nothing is `pending` (≤10s). Cached per cwd, failures are not cached. While a live session exists its
`supportedCommands()` / `mcpServerStatus()` are used instead, MCP status is refreshed after every turn,
and `commands_changed` system messages are pushed as `chat:commands`.

### Work files panel (`FilesPanel.tsx`, header folder-tree button)

Right-hand panel, closed by default: the working folder as a lazily loaded tree (`files:list_dir` per
expanded folder), files Claude changed in this conversation marked, click a file to view it (highlight.js
`lib/common`, colours from `--c-syn-*`; not highlighted above 400K chars) or its change history (`ToolDiff`).
Open/width/"바뀐 파일만" live in `localStorage` (`filesPanel.*`). Under 760px it overlays the chat.

- **Tracking lives in main** (`trackFileEdits`, called in `pump` for every message, subagents included,
  before the subagent drop): a Write/Edit/MultiEdit/NotebookEdit `tool_use` is remembered in
  `pendingEdits` and counted only when its `tool_result` is not an error (a failed Edit does not mark the
  file — verified). Bash-made changes are not tracked. Up to 50 hunks per file are kept for the history tab.
- **Paths**: `file_path` is resolved against the tab's `cwd` (Claude does send relative paths — observed), then
  mapped from the real path back to the app's spelling of the cwd (`toCwdPath`). The CLI works in the
  realpath (`/tmp` → `/private/tmp`; verified with a symlinked cwd), but the tree is drawn from the app's
  path, so without this the file landed in "작업 폴더 밖".
- **"방금"** = `lastTurn === turn`. `fileTurn` increments in `beginTurn`, which re-sends the list so the
  previous response's marks drop to "수정 N" as soon as a new response starts.
- **"내역 지우기"** (bar at the top of the Claude 수정 view): empties the list and marks, files untouched
  (`files:clear_changed`). Only edits whose result lands after that moment count again — `trackFileEdits`
  skips results with `at <= tab.changesClearedAt`, for live edits and for the transcript recompute alike
  (an edit in flight at the moment of clearing finishes after it, so it shows up in both). Because
  reopening a conversation recomputes from the whole transcript, the time is kept **per session** in
  `userData/changes-cleared.json` (newest 200); without it the cleared list came back on every app start.
  The bar shows "파일 N · <time>에 지운 뒤" so the shorter list isn't mistaken for broken tracking.
- **Reset** whenever the tab's conversation is reset; opening a session recomputes from the transcript
  (`loadChangedFilesFromSession`); `changedFilesGen` discards a recompute that finishes after the user
  already moved to another conversation (it used to leak into the new one). Edit times come from each
  entry's `timestamp` (`entryTime`) — present at runtime though `SessionMessage`'s type omits it;
  without it every history entry showed the time the conversation was opened.
- **File access is restricted in main**: `files:list_dir` / `files:read` / `files:reveal` accept only
  absolute paths inside `realpath(tab.cwd)` or files Claude changed in this conversation (outside ones
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
  `useClaudeChat` exposes `turnEnd {seq, stopped, failed}` from `finish`. Normal end → the draft is sent;
  stopped **or failed** (an error-level notice during the turn — usage limit, bad model…; retry warnings
  don't count) → it goes back into the input (in front of anything typed since — nothing is dropped;
  sending it after an error just failed again); "지금
  보내기" = stop, then send (`sendAfterStopRef`). Changing the tab's conversation (a session loaded into
  it, folder change, session delete) bumps `resetSignal` (`conversationSeq` in `ChatTabView`, on a new
  `load` / `resetToken`) → draft goes back to the input. That is load-bearing: a reset mid-turn →
  `closeLive` → `pump`'s `finally` still sends `chat:done`, which would otherwise auto-send the draft
  into the *new* conversation.
- **Notifications** (`hooks/useNotificationSound.ts`): the shell decides (per tab, in its `callbacks`),
  main (`notify:show`) only displays. Title = the tab's folder name (last path segment), body = what
  happened + a one-line summary; clicking it switches to the tab that raised it (`tabId` → main →
  `notify:clicked` → shell). Turn done → chime always (as before) + macOS notification when
  `!document.hasFocus()`. Permission request / question → a different (descending) chime when away
  **or when it is in a tab you are not looking at** (its modal is hidden there), + notification when away.
  Notifications are `silent: true` — the app's own chime follows the volume setting (0–100, 50 = the
  original loudness). The slider is squared (`volumeGain`): loudness is heard logarithmically, and the
  old linear gain spanned only −6…+6 dB between 25 and 100 ("barely changes"). Squared: 25 = −12 dB,
  100 = +12 dB. The app cannot be louder than the Mac's output volume (the owner keeps it low and
  wants only alerts louder) — raising the system volume around each chime was rejected (blasts
  whatever else is playing, dangerous in earphones, can be left high). Instead, above 50 the chime
  itself morphs (`chimeShape`) to sound louder at the same peak: longer ring (0.38 → 0.7 s), a 40 ms
  hold at the top, a 3rd harmonic in the 2–4 kHz band. ≤50 is sample-identical to before. Measured by
  rendering the real `scheduleNotes` into an `OfflineAudioContext` (K-weighted momentary loudness):
  100% is +5.6 dB over the squared-only chime (−10.7 LUFS vs −27.7 at 50), peak 0.89 — no clipping. Main keeps each `Notification` in a Set (otherwise it is garbage-collected and the
  click handler is lost) and closes them all on `browser-window-focus`. Settings live in `localStorage`
  (`better-claude:notification-sound` / `-volume`, `better-claude:os-notifications`). The ad-hoc-signed
  dev Electron does get notifications presented on macOS 26 (`show` event fired — verified).
- **"답변 처음으로"** (`ChatTabView`, top-right pill): while the Claude reply that crosses the top edge of
  the message list has its start hidden (>48px above, and >40px of it still below the edge), the
  button jumps to that reply's header (12px margin) and releases bottom-following. The reply at the top
  edge is found by binary search over `:scope > [data-msg-id]` (`MessageItem` sets `data-msg-id` /
  `data-role`). It is measured on scroll **and** after `messages` change / the tab becomes visible —
  right after a conversation loads, the scroll event can come before layout settles and the button
  stayed hidden.
- **Files dropped anywhere on the tab** (message list included, not just the input box) attach to the
  message: `ChatTabView` owns the drag handlers (depth counter for nested enter/leave, files only — text
  drags are ignored) and calls the `addFiles` that `ChatInput` registers via `onRegisterAddFiles`.
- **⌘F find** (`FindBar.tsx`; 편집 menu: 찾기 ⌘F, 다음 ⌘G, 이전 ⇧⌘G → `menu:tab` "find…" → the active tab's
  `TabViewApi`). Searches only the visible tab's message list. Not `webContents.findInPage` — it also
  matches the find box's own text and searches the whole window. Text nodes are grouped by their block
  ancestor (p/li/pre/td/div…) and matched case-insensitively, so a phrase across inline formatting
  ("`src/demo.ts:2` 이고") is found but nothing spans two paragraphs; matches are painted with the CSS
  Custom Highlight API (`::highlight(bc-find)` / `bc-find-current` in `index.css` — the DOM is untouched,
  so React doesn't fight it). The registry is document-global: `paintedBy` makes a tab that just went
  hidden clear only its own paint. Re-searches at most every 300 ms while a reply streams. Highlight
  tokens set the text colour too (code blocks are dark in both themes); dark-mode colours were raised
  after the old dim gold vanished on the dark "나" bubble (contrast 1.1).
- **File paths in replies open in JetBrains IDEs** (`src/main/services/jetbrains.ts`, `file-links.ts`):
  inline code that looks like a path (`src/main.ts:120`) gets a dotted underline once main confirms the
  file exists (`editor:resolve` on hover, cached 10 s) and opens with **⌘+click** (plain clicks select
  text); markdown links that aren't http/mailto/# open on a plain click (they used to do nothing — the
  link guard blocks file URLs). The file viewer has the same button. No setting: each IDE's
  `options/recentProjects.xml` says which projects it opened, so the IDE that most recently opened the
  innermost project containing the file wins, else the most recently used IDE. Launch = what Toolbox's
  `webstorm`/`idea` scripts do: `open -na <App>/Contents/MacOS/<exe> --args --line N <file>`. `:N`,
  `:N:C` and `#LN` become the line; only existing regular files open (viewed, never executed).
  `<html class="meta-down">` (`meta-key.ts`) turns the underline solid while ⌘ is held.
- **Copy buttons go through main** (`clipboard:write` → Electron `clipboard`): `navigator.clipboard`
  rejects when the document isn't focused (e.g. DevTools focused) — verified.
- **Code highlighting** is shared (`src/renderer/highlight.ts`). Chat fences render through the `pre`
  override in `MARKDOWN_COMPONENTS` (`CodeBlock`: language label + copy). Fences without a language are
  not highlighted (auto-detect misfires on command output). No highlight.js theme CSS is imported: chat
  code blocks (dark in both themes) colour tokens under `.codeBlockPre` with `--c-synd-*`; the file viewer
  colours them under `.codeBody` with `--c-syn-*` (light = the github theme's exact colours, dark = the
  `--c-synd-*` palette). Both keep github's selector order — single-class selectors first, compound ones
  after; the `.codeBody` block sits after `.codeBlockPre` with a stylelint-disable comment, because
  stylelint ignores what is inside `:global()` and sees them as the same selectors.

### Colours and dark mode (`src/renderer/styles/theme.css`)

Every colour the renderer uses is a CSS variable in `theme.css` (imported first in `renderer/main.tsx`):
`:root` = light values, `@media (prefers-color-scheme: dark) { :root { … } }` = dark overrides; a token
without a dark line is the same in both (header/sidebar/code-block colours were already dark). `--c-*`
are colours, `--sh-*` whole `box-shadow` values (dark adds a 1px light ring — shadows vanish on dark
backgrounds). SCSS must not use colour literals any more — add a token (role name, not hue) instead.
Tokens are split by role even when the light value is the same (`#3a3d35` is `--c-text` but also
`--c-sidebar-bg` / `--c-tooltip-bg`), because the roles diverge in dark. Don't reuse names that
components set inline: `--fill` (notification slider %) and `--icon` / `--icon-dark` (`FILE_ICONS` in
`ChatInput.tsx` pass per-file-type icon colours this way so `.mentionIcon` can switch them in dark).

- **Which theme** = main's `nativeTheme.themeSource` (`system` | `light` | `dark`), persisted as
  `settings.json` `theme`, applied in `loadChatSettings()` before the window exists; `theme:get` /
  `theme:set` IPC; header button `ThemeSettings.tsx`. Setting `themeSource` is what flips the renderer's
  `prefers-color-scheme` (live, no reload) and native UI (select popups, dialogs); `color-scheme: light
  dark` on `:root` lets default controls/scrollbars follow. Nothing in the renderer stores the theme.
- **Window `backgroundColor`** (`create-main-window.ts`, `SPLASH_BG`) = the splash colour for the current
  theme (`--c-header-bg`); without it the default white flashed before the first paint in dark mode.
- **Light mode was moved to tokens without visual change** — verified by compiling the SCSS, replacing
  every `var(--token)` with its light value and diffing against the pre-token CSS (identical), plus
  computed-style comparisons in the running app (file-viewer tokens, @mention icons, whole panels).
  To preview dark without touching settings: CDP `Emulation.setEmulatedMedia` with
  `prefers-color-scheme: dark`, or set `nativeTheme.themeSource` from a main-process debugger.

### Renderer layout

React 19 + `react-router-dom` v7 with `createHashRouter` (hash routing because `file://` loading rules out `BrowserRouter`). One route: `/` → `chat.page.tsx`, the tab shell (see Tabs). Streaming chat state lives in `useClaudeChat(tabId, callbacks)` (`src/renderer/hooks/useClaudeChat.ts`, one per `ChatTabView`); its IPC subscriptions go through `tab-events.ts`, are set up per message send and torn down on `chat:done`. UI uses antd + FontAwesome + SCSS modules (`*.module.scss`).

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
- `chat.page.module.scss` is shared by most components (`MessageItem`, `ActivityPanel`, `QuestionModal`,
  `QuestionCard`, …), so a new class name can silently merge with an existing one (`.questionText` /
  `.questionHeader` already belonged to the modal). Run stylelint — `no-duplicate-selectors` catches it.
