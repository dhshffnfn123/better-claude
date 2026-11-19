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
  reload before judging tab restore. **The dev app's CLI processes** = children of *its* Electron main
  process (the one with your `--user-data-dir`, no `--type=`) whose command is the `claude` binary with
  `--output-format stream-json` — `pgrep -f claude` also matches electron-forge (the repo path contains
  "better-claude-app"), and the owner's installed app has CLI children of its own.
  **Port 9333 is not ours alone**: another local session's tooling once drove the dev window over CDP on
  9333 (navigated it to its own web app), and our scripts then ran against that page — check the page URL
  in `json/list` before acting, or use uncommon ports. **A message sent while tabs are re-opening** (a
  Fast Refresh remount, the window navigated away and back) can run in the home folder — `tabFor` creates
  an unknown tab with `os.homedir()`; a test conversation and its auto memory landed in
  `~/.claude/projects/-Users-<you>/` (reproduced). Reload fully and check the cwd bar before sending.
  The cwd bar is the renderer's copy: after a hot reload (an edit of a component + `chat.page.module.scss` while the app ran)
  it kept showing the test folder while main's tab was in the home folder, and it happened again — check main's
  `cwd` (`electronAPI.listInstructions(tabId)` returns it; for a tab main doesn't know yet that call creates it in the home
  folder too, which `tabs:open` later resets). A test project inside this repo (`node_modules/.harness-…`) must be its own git
  repo (`git init`) — auto memory is per repository, so otherwise it would share this repo's memories (the owner's). Verify
  with `listInstructions(tabId, true)` after putting an empty `MEMORY.md` in the expected folder: the AutoMem path. A test window
  kept on top: `W.setFocusable(false)` so it can't take the owner's keystrokes, and turn its sound / macOS notifications off
  (`better-claude:notification-sound` / `better-claude:os-notifications` = `off`). localStorage belongs to the dev renderer's
  origin `http://localhost:<vite port>`, and the port moves when other dev servers hold 5173…: after a restart on another
  port every localStorage setting (sound, notifications, 답변 처음으로, 기억 알림) was back to its default.
- **Background tasks in tests**: the CLI keeps their output under `/private/tmp/claude-<uid>/<project path>/` — delete
  the test project's folder there too. A `pkill -f <pattern>` that Claude runs also matches *your* monitoring shell if
  its command line contains the pattern (it was killed, exit 144) — keep such strings out of your own commands.
- **An occluded window stops rendering**: `visibilityState` is `hidden`, rAF never fires, scroll events
  and smooth scrolling stall — scroll-driven UI looks broken in tests. `setBackgroundThrottling(false)`
  did not survive a reload; `W.setAlwaysOnTop(true, "floating"); W.showInactive()` (from the main
  debugger) brings it forward without taking keyboard focus.
- **Main's module scope from the inspector**: `Runtime.evaluate` only sees globals, but a *conditional* breakpoint
  (`Debugger.setBreakpointByUrl` on `.vite/build/main.js`, condition `(<side effect>, false)`) runs inside the function
  without pausing — e.g. `(globalThis.__x = {tabs, folderInfo}, false)` in an IPC handler you then trigger, or
  `(flow.deadline = 0, false)` to test a timeout. Remove the breakpoint afterwards. Main rebuilds on save but keeps
  running the old bundle until restarted (the forge `rs` needs stdin, which the `sleep |` pipe holds) — restart the app.
- **MCP login tests**: never against the owner's config (no `CLAUDE_CONFIG_DIR` = their keychain item). Start the app
  with `CLAUDE_CONFIG_DIR=<isolated dir>`, register a local fake OAuth MCP server there (`claude mcp add` with the same
  variable), and swap `require("electron").shell.openExternal` in main (the bundle calls `electron.shell.openExternal`
  at call time) to capture the URL; finish the login by fetching it (302 → the CLI's callback). The test token lands in
  a separate keychain item (`Claude Code-credentials-<hash>`, see "MCP server login") — report its name to the owner
  rather than deleting keychain items yourself.
- **Settings-writing commands in a test folder inside a git worktree write the *main checkout's* project
  settings**: the CLI takes the repository's main worktree as the project root, so `/output-style Concise`
  run in `<worktree>/node_modules/<harness>/proj` landed in `<main checkout>/.claude/settings.local.json`
  (`CLAUDE_CONFIG_DIR` only isolates user-level settings; reproduced and reverted). `git init` the test folder
  first so it is its own project. Never let the "/" menu run commands you did not type in full: before the
  fix below, "/usage" + Enter ran `/usage-credits`, which opens claude.ai in the browser.

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
  `result` (otherwise `for await` waits forever) — or, with next-request suggestions on, once the
  suggestion arrives / after `SUGGESTION_WAIT_MS` (see below). If the query options changed (`optionsKey()`), or
  when the tab's conversation is reset (`resetConversation`: `tabs:open`, cwd change, session delete)
  or the tab is closed, the process is closed — `q.close()` also kills its background shells (verified).
- **Stop is immediate and does not wait for main.** The renderer closes the turn itself
  (`finishRef` in `useClaudeChat`: listeners off, running tools marked 중지됨, modals closed).
  `chat:stop` marks the session `stopped` — `pump` then forwards nothing more — and sends **no**
  `chat:done` (a late one would end the *next* turn). The process is reaped in the background
  (`interrupt()` ≤1s, then `close()`). `stopEpoch` cancels a `sendTurn` that is still between awaits
  (spawning the CLI / waiting for the previous process).
  **While background tasks run, stop ends only the turn** (`stopTurnOnly`; `hasRunningBackground` = a non-ambient
  `bgMembers` entry). Closing the process (above) also killed the dev server / agents, so a message sent during a
  background task could not be cancelled without losing the task (owner's report). `q.interrupt()` alone still killed
  background *agents* (shells survived — measured): the CLI spares them only when the consumer declares
  **`perTaskStopAffordance: true`** (we do — the panel's per-task ×/"이 작업 중지"); absent, it fails closed and kills
  them. The interrupted turn's late frames would look like a CLI-started turn (new reply), so `pump` drops everything
  but `background_tasks_changed` until that turn's `result` (or `INTERRUPT_WAIT_MS` 5 s) — `endInterrupt`; `sendTurn`
  awaits `interrupting` before pushing the next message ("지금 보내기"), or the CLI folds it into the dying turn. The
  panel's 모두 중지 is `background:stop_all` = the old full stop (`stopEverything`). Verified: a background loop and a
  background agent kept running across a stopped reply (same CLI pids, no phantom reply), the next message was answered
  in the same process, 지금 보내기 interrupted a slow foreground command and answered in ~1 s, 모두 중지 killed the loop,
  and stop without background tasks behaves as before.
- **Background tasks on screen** — they used to be an 11px grey "⚙ 백그라운드 N" at the far end of the cwd bar, a
  10px half-transparent "⚙ N" on the tab, and a floating popover that covered the chat and closed on any outside
  click; the tool row that launched a task showed ✓ while the task ran for minutes (the owner: "눈에 안 띈다"). Now:
  **the dock** above the input (`BackgroundDock.tsx`, passed to `ChatInput` as `top`): one card per running task —
  spinner, kind icon, name (`taskName`: Claude's description, a trailing "in background" dropped), elapsed time, and
  for shells the **last output line** (`getBackgroundOutput(…, 2000)` every 2 s, visible tab only; shell output — this line,
  the panel log and 로그 복사 — goes through `terminalText` (`src/renderer/terminal-text.ts`): colour/cursor codes such as
  Vite's `ESC[2m…ESC[22m` used to show as "[2m7:30:01 PM[22m", and `\r`-overwritten progress lines keep their last text), for agents their
  activity; agent-launched tasks fold into their agent's card (`parentTaskId`); ≤3 cards + "+N"; finished tasks stay
  as ✓/✗ (red) cards for 15 s (`RECENT_DONE_MS`), then the dock disappears. **Their age is measured with the real
  clock at render** (+ a timer for the next expiry): it used to be the 1 s ticker's value (`useNow`), which stops while
  the tab is hidden or nothing runs — a task that finished while you were in another tab (or a card re-rendered for
  another reason in its last second) kept "방금 끝남" on screen forever (reproduced: 63 s after the end; fixed: gone at
  15 s, also after coming back from another tab). **Clearing** (the owner asked for it): × on a finished card, or
  "완료 지우기" next to 패널로 보기 — dock only (`dismissed`, keyed by id + end time, renderer state of the always-mounted
  dock). Deliberately not the panel's history: the finished records are the only place a finished task's log can be
  read again, and the launch rows' "완료 · 3:02" links depend on them; the panel keeps its own 지우기 for that. No stale
  "running" entries were found in `bgMembers` — the CLI's `background_tasks_changed` follows each `task_notification`,
  and `pump`'s `finally` sends `running: []` when the process ends (traced with a raw-frame probe and in the app) —
  except a stopped session: "모두 중지" then the panel's 지우기 re-sent the dying task as running until the process
  exited, so `sendBackground` sends no running tasks for a `stopped` session. A card opens **the panel**
  (`BackgroundPanel` in `BackgroundTasksPanel.tsx`, the files panel's slot, state `bgView` in the shell — agent >
  background > preview > instructions > files): task list (agent-launched ones nested under their agent, finished
  ones below with 지우기) + the selected task's detail — a big log (60 KB tail, re-read every 1.5 s while running)
  that follows new output unless scrolled up ("맨 아래로"), 로그 복사, 이 작업 중지; agents show activity, recent tools,
  received prompt, 한 일 전체 보기. **Launch rows** (`ToolRow` + `BackgroundBadge`, via `BackgroundLinksContext` from
  `ChatTabView`, keyed by `toolUseId` = `task_started.tool_use_id`): spinner + "백그라운드 · 실행 중 1:51" →
  "완료 · 3:02" / "실패 · 코드 1" / "중지됨", click → that task in the panel; with no task info (after a reload/restart
  or 지우기) a plain "백그라운드" badge from the input's `run_in_background`. The tab shows a coloured pill with a
  spinner (`--c-task-text` / `--c-on-task`). Verified in the app (running, failed with exit 1, stopped from the panel,
  agent finished, follow/scroll, light and dark, 480 px).
  Data (`BackgroundTasksPanel` used to be the popover): `pump` keeps
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
  not be written yet at notification time. **Killed by another command ≠ failed**: the CLI reports any non-zero exit
  as `failed`, so a dev server Claude killed to restart it showed a red "실패 · 코드 143" (the owner: "별론데"; in the
  owner's real transcripts 74 of 77 "failed" were 143/144). `recordFinishedTask` turns `failed` + an exit code in
  `TERMINATED_EXIT_CODES` (129 HUP, 130 INT, 137 KILL, 143 TERM, 144 — measured for a `pkill`ed process) into
  `status: "stopped"` + `terminated: true` → "종료됨" in gray, with "다른 명령(kill 등)이 도중에 끝냈습니다 …" in the panel
  instead of the CLI's "failed" summary; crashes (134, 139 …) and ordinary codes stay 실패. **Unless it never ends by
  itself**: a dev server / watcher / endless loop ends normally only when killed, so `looksLongRunning(command,
  description)` (`LONG_RUNNING_COMMAND`: dev/serve/server/start/preview/watch/vite (not `vite build`)/nodemon/uvicorn/
  `http.server`/`tail -f`/`while true` …, path words like `/dev/null` or `src/server.ts` excluded; or Claude's
  description "… dev server / server / watch …") turns it into `status: "completed"` + `terminated` → ✓ 완료, with
  "dev 서버·감시처럼 스스로 끝나지 않는 명령이라 …" in the panel. A guess by name (the owner chose it knowing that) —
  checked against 51 sample commands/descriptions; a miss just falls back to gray 종료됨. The SDK's status is
  only completed/failed/stopped (the transcript's own `killed` = time limit arrives as stopped); `statusInfo()` still
  falls back to 중지됨 for anything unknown. Verified: a `pkill`ed background script → 종료됨, `exit 3` → 실패 · 코드 3,
  a killed `python3 -m http.server` → ✓ 완료. `chat:background` sends `{running, finished}`; both carry `toolUseId` and
  `parentTaskId`. At the moment a task finishes it is briefly in both lists (record → membership update) — the
  renderer prefers the finished record (`runningOnly`, `allTasks`). `background:output` takes an optional byte count.
  **Tokens per task**: agents show `usedTokens` — the sum over the agent's own model calls (input + cache write + cache
  read + output), added in `recordTaskArtifacts` from each subagent `assistant` message's `message.usage`, once per
  `message.id` (a response arrives as one message per content block, usage repeated; the largest value wins). That is
  the same accounting as the tab total below. `task_progress`'s `total_tokens` (the CLI's "N tokens") is the agent's
  last context size, not consumption — only a fallback. Shell tasks call no model and show no tokens. Shown in the
  dock card ("토큰 85K"), the panel rows and the detail ("도구 5회 · 토큰 84,530" — verified with a 5-tool agent).
- **"에이전트가 한 일" panel** (`AgentPanel.tsx`, main `agents:get`): what an agent (Agent tool; older name
  `Task` — `isAgentTool`) was told, every tool it used with results, and its full report (the main reply
  only keeps a 500-char preview). Opens from an agent row in a reply or the activity panel ("한 일 보기"),
  or from a `local_agent` item in the background panel (task id = agent id), in the files panel's slot
  (same width). The shell's `agentView` keeps a stack — an agent's own agent rows open that agent, ← goes
  back — and closes it when the tab's conversation changes. Main maps the call's tool_use id → agent id:
  live from `task_started` (`task_id` *is* the agent id, with `tool_use_id` — verified), otherwise
  `listSubagents(sid)` + each transcript's first entry (`getSubagentMessages(sid, id, {limit: 1})`), whose
  `parent_tool_use_id` is the spawning call (cached per session, `agentIdsBySession`; nested agents too —
  verified). The transcript (`<session>/subagents/agent-<id>.jsonl`) goes through
  `sessionToMessages(entries, {subagent: true})` and renders with `MessageItem` (`senderLabel` = agent type,
  `markReport` labels the last text "최종 보고"); the first user entry is the collapsed "받은 지시" — markdown via
  `PromptMarkdown` (as is the background panel's "받은 지시 보기"; both used to be raw pre-wrap text). Stats:
  tool_use count, first→last entry time, tokens = the last response's input + cache + output (the CLI's
  "N tokens"). Status: `tab.taskStatuses` (every `task_notification` — `finishedTasks` keeps only background
  ones, so foreground agents showed "끝남" before) → "실행 중" while the live process still has it
  (`bgMembers`, or `taskInfo` during the turn; re-read every 2 s) → otherwise "끝남" (reopened conversations).
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
  session's first entry there is no fork point: a fresh session is started (`replaceFirst`), and the old
  one is deleted only after a reply in the new session **succeeds** (`commitReplaceFirst`: our turn's
  `result` with `subtype: "success"`, not `is_error`, `num_turns > 0` — `/cost` also "succeeds"). It used
  to be deleted as soon as the new session id appeared, i.e. before any API call, so a retry that failed
  (usage limit, offline, bad model) had already destroyed the original (reproduced with a bad model id).
  Now a failed retry leaves both sessions; the tab stays on the new one (it is what the screen shows) and a
  later success there deletes the old. If no new session appears at all (the CLI failed to start, stop),
  `restoreReplaceFirst()` puts the old session back. Files the discarded reply edited are not rewound.
  While a failed retry is pending the old conversation is still in the sidebar, so the delete is guarded:
  it is skipped when any tab has that session open, or when its last transcript entry differs from the one
  recorded at `prepareReplace` (`lastUuid` — continued in another tab or the terminal). Before, continuing the
  original elsewhere and then succeeding in the retry tab deleted the original *with* the new turns (verified
  fixed, also with the other tab closed first). Retrying again from the failed attempt chains the pending
  replace (`prev`), so one success deletes the original and the failed attempt — before, the original was
  forgotten and stayed next to the new one (verified). Grants are copied, not moved, to the new session (the
  old one lives until the commit). A deletion is announced with `sessions:changed` so the sidebar refreshes
  (it happens after `result`, i.e. may land after the turn-end refresh).
- **Any earlier point: "여기서 다시" (user messages) and "여기까지 새 탭으로" (replies).** "여기서 다시" is
  the edit path generalised: an inline editor on that message (`MessageItem` edit mode `rewrite`; the
  messages below are dimmed while it is open), then `rewriteFrom` drops it and everything below and sends
  with `replaceUuid` = its uuid → `prepareReplace` → `resumeSessionAt` (verified on an earlier message: the
  model forgot the later turns, and `getSessionMessages` then shows only the new branch — the old one stays
  in the file, unreachable). Nothing changes until 보내기, so there is no half-rewound state to persist.
  "파일도 … 되돌리기" (off by default; the editor dry-runs `rewindFiles` to count files, hidden when 0)
  runs **before** the send: rewriting the first message starts a new session and deletes the old one,
  checkpoints included. Images are resent from `imagePayloads` (kept on live user messages — preview URLs
  can't be resent) or parsed from a loaded message's data URLs. Fork = `chat:fork` → `forkSession(sid,
  {upToMessageId: replyUuid, title: "… (갈래)"})`; `replyUuid` = the reply's last transcript entry — live
  from every main-chain assistant / tool_result message's `uuid` (`chat:reply_uuid`, applied at turn end;
  stream uuids equal transcript uuids — verified), loaded from `sessionToMessages`. The fork opens in a new
  tab right after its source (`openFork` in the shell, settings inherited) and takes the session's "항상
  허용" grants along. **Forks have no file checkpoints** (`rewindFiles` → "No file checkpoint found for this
  message." — verified). Each copied transcript line carries `forkedFrom`, but `getSessionMessages` drops it,
  so the app records its own forks in `userData/fork-points.json` (`{forkSid: {until}}`) and marks the copied
  messages `copied` (no 파일 되돌리기); for forks made elsewhere `explainRewind` turns the CLI error into a
  Korean explanation. Both actions are hidden while responding and on messages before the last compaction
  divider (their entries were summarized away).
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
streamed (e.g. API error frames) are sent whole. **A follow-up turn the CLI starts on its own** begins with
`turnActive` false: the first block's deltas arrive before `chat:turn_start` and the renderer drops them, and
`beginTurn` clears `streamedMessageIds`, so that first block is sent whole — and then the response's id is
marked streamed again (`autoTurnMessageId` in `pump`). Without that, a response shaped [thinking, text]
streamed its text *and* re-sent it whole: the follow-up reply showed its text twice (fixed; verified with a
[thinking, text] follow-up after a background Bash).

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

**Per-tab cumulative usage** (header chip `UsageMeter.tsx`: the active tab's total; click → every open tab's tokens and
cost + the sum; a row switches to that tab). Source: `result.modelUsage` summed over models (`totalsFromModelUsage`) —
per the SDK it covers *every* model call (main loop, Task subagents, sidechains, compaction, workflow agents), is
cumulative across turns, and a resumed session continues from the totals its transcript saved — so with the app's
process-per-turn model the latest result already carries the whole conversation (verified: 52K → 156K → 348K over
three turns, the background agent's 85K included). `result.usage` is main-loop-only and per-turn — not used. Sent with
`chat:cost` (`usage`), saved per session next to the cost (`session-stats.json`) and restored the same way; zero
totals (local `/cost`, startup errors) never overwrite. Tabs restored but not opened yet read their saved totals via
`sessions:stats` when the popover opens. Formatting lives in `src/renderer/token-format.ts`.

**Cost and context survive reopening**: both only arrive at a turn's end, so a restored tab or an
old conversation showed nothing. `saveSessionStats` keeps the last `chat:cost` / `chat:context` per
session (`userData/session-stats.json`, newest 300, plus `maxTokensByModel`); `restoreSessionStats`
(run inside `loadChangedFilesFromSession`, which already walks the transcript) re-sends them. If the
transcript is newer than the saved value (continued in the terminal) the context is recomputed from the
last main-chain response's usage = input + cache-creation + cache-read, **without** output — that is
what the CLI's `getContextUsage({detail: "summary"})` reports (verified equal: 38,473; adding the output
was off by exactly that reply's output tokens). Cost can't be recomputed, so it stays hidden then.

**Next-request suggestion ("다음 요청 추천")** = SDK `promptSuggestions: true`: ~2–3 s after `result` the CLI
emits `{type: "prompt_suggestion", suggestion}` — at most one per turn, sometimes none (nothing obvious to
suggest, near plan limits, after errors, plan mode). It uses the parent's prompt cache, and it comes with
the app's process-per-turn model too, even on a conversation's first turn (verified).
- **The CLI finishes that request even after its input closes** and only then exits, so closing the input
  at `result` as before made a message sent within ~3 s (e.g. the queued draft, sent at turn end) wait for
  the old process. `finishTurn` therefore leaves the input open up to `SUGGESTION_WAIT_MS` (8 s) while
  suggestions are on: such a message goes into the same process (verified by CLI pid), and `pump` ends the
  input as soon as the suggestion arrives — the CLI exits right after. A suggestion that arrives while a
  turn is active is dropped (main checks `turnActive`, the renderer `isLoading`).
- `chat:suggestion {text}` → `useClaudeChat`'s `suggestion` (a subscription that outlives the turn — it
  arrives after `chat:done`; cleared on send, reset, load) → `ChatInput`: shown only when the input is
  empty (no attachments either) and not responding. It is drawn by an overlay (`.suggestGhost`: one line
  with … + a `Tab` keycap) over a transparent placeholder (kept for screen readers) — Chromium does not
  draw `text-overflow` in a textarea placeholder, so a long suggestion was silently cut and the Tab hint
  with it. **Tab** fills the input without sending (to edit first) and uses the suggestion up.
- On/off: a switch in the notification settings popover, `settings.json` `promptSuggestions` (default on),
  `suggestions:get/set`; `src/renderer/suggestion-setting.ts` shares the value between components. It is
  deliberately **not** in `optionsKey()` (that would restart processes with background tasks): switching
  off marks live sessions `suggestions = false` (their suggestions are dropped) and ends the input of an
  idle waiting one. Measured: that CLI still finishes the suggestion it is making and exits 2–3 s later; a
  message sent meanwhile waits for it, then goes to a new process without suggestions. Sending right
  after a reply with a changed `optionsKey` setting waits the same 2–3 s — `q.close()` does not cut the
  request short either — and the previous reply is still in the model's context (verified).

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
  validates, ≤50 tabs) = `{tabs: [{id, sessionId, cwd, title, customTitle, model, effort, ultracode, fastMode}],
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
  (middle-truncated), title, a coloured pill with a spinner and N while the tab has running background tasks (a dev
  server in a tab you're not looking at stays visible), close. Tabs are 200px
  (`width`, not `flex-basis` — with a basis the auto-width list sized to the tabs' content and they
  shrank to ~110px with room to spare) and shrink to 96px, then the list scrolls sideways with its
  scrollbar hidden: `useOverflowScroll` turns vertical wheel into horizontal scroll (Chromium does not
  do this by itself — verified) and fades the edge that hides tabs (`tabListFadeLeft/Right`, a mask).
  **Drag to reorder**: HTML5 drag with its own type (`application/x-bc-tab`, so `ChatTabView`'s file drop ignores it);
  the half of the tab under the pointer picks before/after (a gold bar, `tabDropBefore/After::before`), the empty strip
  after the last tab = the end; `onMove(id, beforeId)` → the shell's `moveTab` reorders `TabMeta[]`, which is what
  `tabs.json` saves, so the order survives a restart and ⌘1–9 follow it (verified: before a tab, to the end, saved).
  **Tab names** (the owner: same-folder tabs were hard to tell apart): double-click a tab → its title becomes an input
  (`TabTitleEditor`; Enter or blur saves, Esc cancels, empty or equal to the automatic title clears it). Stored as
  `TabMeta.customTitle` next to the automatic `title` (first message → the CLI's session summary, which keeps updating
  underneath), shown bold, used by the usage popover and the notification title ("이름 · 폴더"); the tab-only name never
  renames the CLI session (the sidebar keeps its own title). Verified: save, Esc, clear, a reload, the close button's
  double-click ignored. Blur saves — a test that typed through separate CDP calls lost the edit box to a window blur.
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
Markdown links render with `target="_blank"` (`MARKDOWN_COMPONENTS` in `MessageItem.tsx`). **Every markdown
view must use them** (`Markdown` from `MessageItem.tsx`): a plain `<a href="#설치">` (a CLAUDE.md table of contents,
GFM footnotes) is an in-page navigation — no `will-navigate` — that sets the URL hash, `createHashRouter` reads it as
the route `/설치`, nothing matches and the whole UI becomes React Router's 404 screen, kept across reloads
(reproduced in the 지침 panel, which used to render a bare `ReactMarkdown`). For a markdown *file* (지침 panel, files
panel) pass `baseDir` = the file's folder: `urlTransform` → `resolveAgainst` makes relative links and images absolute
against it (scheme, `/`, `#`, `~` left alone) — a README's `docs/pic.png` is relative to the README, not the tab's cwd.
`prompt` (agent prompts, `PromptMarkdown`) adds `src/renderer/remark-prompt.ts`: react-markdown **drops raw HTML**, and a
block that starts with a tag line (`<context>` … up to a blank line) vanishes *with its text* — prompts are often split
into such tags, so `remarkHtmlAsText` shows tags as text (comments dropped, inline `<br>` = line break); and
`remarkSoftBreaks` keeps single newlines as line breaks (prompts are often one item per line). Replies keep plain
markdown rules. Line breaks are done in mdast, not CSS: a `p` rule under `.promptMarkdown` (`:global(p)` or a
`:global {}` block) made stylelint's no-descending-specificity compare it with every `:global(.hljs-…)` rule (+88 errors).

### IPC contract

All renderer↔main calls go through `window.electronAPI` (defined in `src/preload.ts`, typed in `src/declarations.d.ts`). When you add a channel:

1. Register the handler in `src/main.ts` (`ipcMain.handle(...)` or `event.sender.send(...)`).
2. Expose it in `src/preload.ts` via `contextBridge`.
3. Add the type to the `Window.electronAPI` interface in `src/declarations.d.ts`.

All three must agree. Anything about one conversation is per tab: the request takes `tabId` first and
the event is sent with `send(tab, …)` and added to `TAB_EVENTS` in the preload (see Tabs).

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

**Background-task notifications in loaded sessions are not "나" messages.** When a background task ends, the CLI
writes its `<task-notification>…</task-notification>` block as a user-role entry; reopened conversations showed it as the
owner's own bubble with raw XML. `taskNotificationKind` recognises it by the transcript flag, never by text:
`getSessionMessages` passes the entry's `origin` through (`{kind: "task-notification", producer, runId}`, older CLIs
`{kind: "task-notification"}`), so a real message that merely mentions the tag stays a message; entries with an
`origin.subkind` (a scheduled task's stored prompt, a peer session's message) are left alone. Two shapes, measured on the
owner's transcripts (11 notifications, CLI 2.1.296–2.1.325): after a reply had ended (prev = assistant text) the notification
is the first entry of the follow-up turn the CLI started itself → `sessionToMessages` closes the reply and the next entries
form a new reply, exactly as live (`chat:turn_start`); its input tokens go nowhere (live shows them on no user message either).
A task that ended mid-turn is delivered after a tool result as `isQueuedCommand: true` → skipped, the reply continues (live:
same turn). `loadChangedFilesFromSession` counts only the first kind as a new turn (`beginTurn` does the same live). Verified
with `loadSessionMessages` on four real transcripts (no notification bubbles; split replies where the CLI started a turn,
none where it was queued) and a fake transcript (a typed message quoting the tag stays a bubble).

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
and `commands_changed` system messages are pushed as `chat:commands`. The command list is also re-sent at every
turn end (`reportCommands`) — the per-folder cache never refreshed, so a skill made between messages or a plugin
installed in the terminal stayed out of the "/" menu until the app restarted — and `commands:list(tabId, true)`
re-probes the folder (the input calls it for a name it does not know, see below).

### Slash commands (`src/renderer/slash-commands.ts`)

The CLI is the source of truth: the "/" menu is its list (`supportedCommands`, with `aliases`), and everything not
listed below is sent as typed. In SDK mode a **local command's output arrives as a plain `assistant` message** (and
`result.local_command`), so it already showed live as the reply — measured for every builtin with a probe that drives
the SDK like the app (`query()` + push input, isolated `CLAUDE_CONFIG_DIR`). What the owner saw as "slash commands
mostly don't work" (measured, CLI 2.1.325 / SDK 0.3.319):

- **Sent, works, output shown**: skills (bundled, plugin, project — prompt-type, model call), `/compact`, `/context`,
  `/rename` (session title → sidebar, terminal `/resume`), `/goal`, `/recap`, `/output-style` (project
  `.claude/settings.local.json`) and `/autocompact` (user settings) — both survive the next process —, `/agents` (says
  its wizard was removed), `/list-agents`, `/reload-plugins`, `/reload-skills`, `/advisor` (writes `advisorModel` to user
  settings — read from the CLI, not run), `/init`, `/security-review` (fails "origin/HEAD" without a remote),
  `/config key=value`, `/mcp reconnect|enable|disable`, `/usage-credits` (opens the browser by design). Not run (cost,
  remote, or side effects): `/ultrareview`, `/schedule`, `/loop`, `/batch`, `/deep-research`, `/design*`,
  `/team-onboarding`, `/import`, `/heapdump`, `/auto-mode-setup`, `/__remote-workflow`, `/workflow-launch-exec`.
- **Reopened conversations lost every local output** — `getSessionMessages` does not return the transcript's
  `system/local_command` entries (not even with `includeSystemMessages`), so only "/context" was left. `sessions:messages`
  now scans the JSONL (`localCommandOutputs`: line by line, JSON only for `"subtype":"local_command"` lines;
  `<local-command-stdout|stderr>`) and `sessionToMessages` puts each output as the reply after its command (`/compact`
  excluded — its divider is the result, live shows no text either).
- **Done by the app instead** (`APP_COMMANDS`, tagged 앱 in the menu): `/model` and `/effort` are "this session only" in
  the CLI = this process, and the app starts a new process for the next message, so they were silently lost; `/fast`
  answers "not available in the Agent SDK"; `/clear` (`/reset`, `/new`) emits `conversation_reset` and an empty reply
  while the app kept resuming the old session. Now: `/model [name]` → the tab's model (aliases from the CLI's model
  list, display names, or any `claude-…` id; bare → the select's native picker via `showPicker()`, which needs the
  Enter's user activation — notice as fallback), `/effort [level | ultracode on|off]`, `/fast [on|off]`, `/clear` → a new
  conversation in this tab (`tabs:open` with no session + `clearedTab`; asks first while responding or with
  background tasks, like a folder change), bare `/config` (`/settings`) → 설정, bare `/mcp` → the MCP popover,
  `/usage` (`/cost`, `/stats`) → the usage popover (`UsageMeter openSignal`), `/help` → 사용 가이드, `/memory` → 지침 panel,
  `/tasks` (`/bashes`) → background panel, `/resume` → sidebar, `/plugin` (`/plugins`) → 확장 → 플러그인 (`pluginCommandTarget`:
  `install|uninstall|enable|disable|details <id>` focuses that plugin; `marketplace …` stays a terminal notice with the shell
  command). Feedback is an `info` notice in the tab (new level).
- **Terminal only** (`TERMINAL_COMMANDS`, tagged 터미널): the CLI answers "/X isn't available in this environment" for
  its interactive-only builtins (`/status`, `/login`, `/logout`, `/permissions`, `/hooks`, `/theme`, `/add-dir`,
  `/rewind`, `/export`, `/exit`, …), and `/color`, `/focus` are marked `terminalOriented` by the CLI itself (no visible
  effect in the app). Not sent; a Korean notice says so and where the app has the equivalent. (`/plugin` used to be here —
  plugin management has no SDK API; the app now runs the shell's `claude plugin …` itself, see 확장 window.)
  Unlisted ones the owner is likely to type are added to the menu (`EXTRA_TERMINAL`, only after a letter is typed).
- **Unknown names** (`/install`): the CLI hands them to the model as text ("cmd_unknown_model_fallback"), which looked
  like the command ran and did nothing. Not sent: the list is re-probed first (a plugin just installed, a skill just
  written), then a notice (`/install` → "use /plugin install <id>"). Only lowercase command-like first words count — paths
  (`/Users/…`, `/tmp 정리해 줘`) are text, and a leading space sends anything as text. A custom command with the same
  name as a terminal/app one wins (sent).
- **Menu keys**: exact name first, then custom commands, then shorter names — the old CLI order turned "/usage" + Enter
  into `/usage-credits` (it opened the browser — happened during testing) and "/plugin" into the `/plugin-authoring`
  skill. Enter runs only a builtin whose full name is typed; on a partial name it fills the name (as Tab does); picking
  a skill / custom / plugin command, or a builtin with an `argumentHint`, fills "/name " for arguments — skills often
  take arguments without declaring a hint (the owner's `/datahub-executing-plans <plan> 1 …`). A typed line with
  arguments is sent unchanged, multi-line included (verified: the skill got `$ARGUMENTS` with the newline).
- **Skill files are re-read by the next process**: edited between two messages, the next reply used the new text
  (verified in the app with a test skill: V1 → V2). But a message sent while the previous CLI is still alive — within
  `SUGGESTION_WAIT_MS` after a reply, or while background tasks run — goes into the same process, which keeps the
  skill text it loaded: it answered with the old V2 after an edit to V3; `/reload-skills` in that process made the next
  call use the new text (V4). So `/reload-skills` is harmless and only needed right after an edit inside that window.
- `system/informational` (warning/suggestion) now shows as a warning notice — e.g. `/goal`'s "Goal cleared after an
  unrecoverable error … Run /goal again" arrived only that way.

### MCP server login (`McpStatus.tsx`, main "MCP 서버 로그인", `src/main/services/mcp-login.ts`)

The cwd bar's "MCP n/m" popover (moved out of `chat.page.tsx` into `McpStatus.tsx`) logs in to any OAuth MCP server
(Notion, Figma, Linear, claude.ai connectors) — it used to say "터미널에서 claude를 실행해 /mcp로 인증한 뒤 ↻". Rows:
`needs-auth` → [로그인], `failed` → [다시 연결], `connected` http/sse → [로그아웃] (confirm first). Everything below was
measured with CLI 2.1.325 / SDK 0.3.319 against a fake OAuth MCP server, in an isolated `CLAUDE_CONFIG_DIR`.

- **The SDK methods are undeclared**: `Query` has `mcpAuthenticate(name, redirectUri?, {redirectUriOnly?})`,
  `mcpClearAuth(name)`, `mcpSubmitOAuthCallbackUrl(name, url)` in `sdk.mjs` but not in `sdk.d.ts` — `McpAuthMethods`
  (narrow type) + `typeof … === "function"` guards. Missing → the old terminal hint (`unavailable`, no button until ↻).
- **Flow**: a dedicated idle query in the tab's cwd per login, keyed globally by server name (`mcpLogins` — tokens are
  not per folder; a second click joins). `mcpAuthenticate` replies after OAuth discovery + client registration with
  `{authUrl, requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", state, callbackPort}`. **The
  CLI does not open the browser in SDK mode** (`skipBrowserOpen: true`; only our fetch hit `/authorize`) → main opens it
  with `shell.openExternal`, only https or http on loopback hosts (`isOpenableAuthUrl`). The CLI's callback listener
  (`127.0.0.1:<callbackPort>`, `redirect_uri=http://localhost:<port>/callback`) lives in that CLI process, so the query
  stays open until success / [취소] / 5 min (the CLI's own "Authentication timeout" is also 5 min); closing it kills the
  listener (port → ECONNREFUSED — verified). On success the CLI stores the token and reconnects the server itself.
- **Starting a login wipes the server's stored token first** (the flow's first step, "clear stored credentials"), so
  cancelling a login on a stale "인증 필요" row would log out a working server. `runMcpLogin` waits for the server's own
  status (`settledMcpStatus`) and stops with "done" when it is already connected.
- **Success / failure**: `pollMcpLogin` reads `mcpServerStatus()` every 1.5 s — `connected` = success. A denial in the
  browser leaves the status at `needs-auth` forever, so it also asks whether the CLI is still waiting:
  `mcpSubmitOAuthCallbackUrl(name, "http://localhost/callback")` (no code, no error) is refused with "Invalid callback
  URL: missing authorization code" while waiting — checked *before* the flow's submitter runs, so the login is not
  touched — and with "No active OAuth flow for server" once the callback arrived or failed. The submitter goes away when
  the callback arrives, *before* the token exchange, hence a 10 s grace (`MCP_LOGIN_END_GRACE_MS`) before "로그인을 마치지
  못했습니다" (measured: connected 0.6 s after the callback).
- **After a login / logout / claude.ai connect** (`refreshMcpEverywhere`): `folderInfo` is cleared and every known tab is
  re-probed (`pushFolderInfo` — commands too: the server's MCP prompts come and go); tabs in the login's folder get the
  auth query's list at once (no flicker); live sessions get `reconnectMcpServer(name)` — **another CLI process picks up
  the new token on reconnect** (verified with a second process and with an app tab holding an injected live session;
  after a logout the same reconnect turns it `needs-auth`). `reconnectMcpServer` throws when the result is not
  `connected` ("Server status: needs-auth") — caught, the status is sent anyway.
- **claude.ai connectors** reply `{authUrl, requiresUserAction: true, callbackExpected: false}` (from the CLI source):
  main opens the URL and closes the query; the row says to finish on claude.ai and [다시 확인] = `mcp:reconnect` (live
  session reconnect, else a re-probe). Not verified for real (the isolated config has no claude.ai login) — the UI path
  was checked by patching the reply in the debugger.
- **Logout** = `mcpClearAuth` on the tab's live session, else a short-lived idle query: the CLI revokes the tokens at the
  server's `revocation_endpoint` (the fake server saw both revoked), deletes them and reconnects → `needs-auth`. Only
  http/sse (`Cannot clear auth for server type "…"` otherwise). The storage is shared with the terminal `claude` — the
  confirm says so.
- **Where tokens live**: the CLI's secure storage — on macOS the keychain item `Claude Code-credentials` (key `mcpOAuth`,
  the same item as the Claude login); the CLI read-modify-writes it, the app never touches it. With `CLAUDE_CONFIG_DIR`
  set the item is `Claude Code-credentials-<first 8 hex of sha256(dir)>` — use that for tests.
- **Errors** (`explainMcpLoginError`, CLI strings from its `mcp_authenticate` handler): `Server not found: X`,
  `… blocked by enterprise managed policy`, `MCP server X is disabled — enable it (mcp_toggle) before authenticating`
  ("꺼져 있습니다 — 터미널에서 /mcp로 켤 수 있습니다"), `… is not approved for this project …`, `Server type "stdio" does
  not support OAuth authentication`, `Unsupported control request subtype` (→ terminal hint); others are shown as is.
- **State** goes to every window as `mcp:login` (`{name, phase, seq}`, phases starting / waiting / claudeai / done /
  error / cancelled — app-wide, not a tab event); `mcp:login_states` restores waiting rows after a reload (verified).
  Renderer store `src/renderer/mcp-login.ts` (drops states with a lower `seq`, forgets "done" after 20 s, a connected
  row forgets its finished state, ↻ forgets errors and the claude.ai hint). The chip spins while a login waits.

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
- **Documents open rendered** (`docKind` / `showDoc` in `FileViewer`, 소스 = the highlighted text, whose highlight
  memo is skipped while the rendered view shows): `.md/.markdown/.mdx` → 보기 = the reply `Markdown` with `baseDir`
  (relative images load; click → lightbox via `ImageViewer`); `.html/.htm` → 미리보기 = `previewFile` + `PreviewFrame`,
  the same sandboxed `bc-preview://` serving as reply previews (its own css/js/images under those rules).
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

### Instructions panel (`InstructionsPanel.tsx`, "지침 N" in the cwd bar)

지침 = files Claude reads in every conversation (CLAUDE.md …, written by people); 기억 = auto memory Claude
writes itself. Two tabs in one panel, in the files panel's slot (agent > background > preview > this > files; opening
it closes the others, the files toggle closes it). The cwd-bar chip shows the instruction tokens.

- **Which files: ask the CLI.** An idle query in the tab's cwd/model with the chat's system prompt →
  `getContextUsage({detail: "full"})` (token-count API, ~0.5 s, no conversation cost; `summary` as fallback) →
  `memoryFiles {path, type, tokens}`. Measured types: Project (CLAUDE.md found walking *up* from the cwd —
  parent folders too —, its `@imports`, `.claude/rules/*.md` without `paths:`), Local (CLAUDE.local.md), User
  (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `/CLAUDE.md`), Managed (read-only), AutoMem (MEMORY.md). `totalTokens`
  of that idle query = a fresh conversation's starting context. Cached per cwd + model + system prompts
  (`instructionCache`; the prompts are part of that starting context); `invalidateInstructions()` clears it on
  every app write/delete and when Claude Write/Edits an instruction-like path (`trackFileEdits`'s `onEdited` →
  `isInstructionLike`), and sends `chat:instructions` to every tab (300 ms debounce). A single memory file
  (`isMemoryTopicFile` — not MEMORY.md) only refreshes the lists (`notifyInstructions`): it is not read at
  conversation start, so re-spawning the CLI to recount would be wasted. The chip asks only once the tab is `opened` (before `tabs:open`, main's tab is in the home folder).
- **Loaded mid-conversation**: a sub-folder's CLAUDE.md (when Claude reads a file there) and rules with
  `paths:` (when it touches a matching file) are not in `memoryFiles`; the CLI writes them to the transcript as
  `attachment {type: "nested_memory", path, displayPath}` (measured). `nestedFromTranscript` finds
  `<configDir>/projects/*/<sid>.jsonl` and reads it **incrementally** (`NestedScan`: byte offset + a
  `StringDecoder` for split UTF-8 + the unfinished last line; starts over if the file shrank) — it used to
  re-read the whole transcript at every turn end while the panel was open, and transcripts reach 100+ MB. It
  infers the trigger by path — the latest file Claude handled inside that
  folder / matching the rule's globs. "The tool right before it" was wrong when two files were read at once
  (reproduced). The SDK's `InstructionsLoaded` hook has the exact trigger, but only live.
- **Edits apply from the next message, mid-conversation too**: on resume the CLI re-reads instruction files and
  appends the changed file's *whole* content as a new `instructions` attachment before the next user message
  (verified: added "end every reply with 🍌" → the next reply ended with 🍌). So every save grows each continuing
  conversation by that file's size — the editor warns for files ≥ 5,000 tokens (`BIG_TOKENS`).
- **Writes are confined**: `instructions:read/write/delete_memory` accept only paths from the tab's last
  `instructions:list` (`instructionPaths`; Managed → read-only) or `.md` files directly in its memory dir — never
  an arbitrary renderer path. Save = temp file + rename onto the *realpath* (a `CLAUDE.md → AGENTS.md` symlink stays
  a symlink); no folders are created (a deleted cwd is not resurrected). The renderer sends the mtime it loaded;
  a different mtime → `{conflict}` → 다시 불러오기 / 그래도 덮어쓰기 (verified with an outside edit). Unsaved text lives in
  a module-level `drafts` map (survives closing the panel / switching tabs; a dot marks it). Creatable: user-level,
  `<cwd>/CLAUDE.md` (when no project CLAUDE.md), `<cwd>/CLAUDE.local.md` with a `git check-ignore` note (`isGitIgnored`).
- **Auto memory**: one file per memory (frontmatter `name`, `description`, `metadata.type`) + the MEMORY.md
  index (`- [title](file.md) — hook`); only MEMORY.md is loaded at start (it is the only AutoMem entry). The
  memory dir is per *git repository* — a folder inside another repo shares that repo's memories — so the measured
  AutoMem path is the source of truth. Deleting a memory removes the file and its index line (`removeFromIndex`);
  files missing from the index are flagged "목록에 없음" (Claude doesn't know they exist).
- Names keep the file name whole and shorten the folder part (`FileName` → `MiddleName`, `shortPath`; a long rule
  file name used to run over the token count). Text on `--c-accent-soft` uses `--c-accent-soft-text` —
  `--c-accent-ink` is ink *on* the accent colour and nearly black in dark mode. The "기억" badge uses
  `--c-memory-badge-text` (the header's `--c-ultra` was 2:1 on the light panel); 규칙/가져옴 are outlined.
- Markdown goes through `Markdown` (see "Links never navigate the app window"), wrapped in `TabIdContext`, with
  `baseDir` = the file's folder so relative links and images resolve next to the file; `ImageViewer` around the
  bubble makes its images open in the lightbox.

### Memory toast — "클로드는 이것을 기억할 것입니다" (`MemoryToast.tsx`, `memory-toast-setting.ts`)

When Claude saves something to its auto memory, a card fades in at the middle of the window with what it remembered.

- **Detection (main, `noteMemorySaved`)**: `trackFileEdits`' `onEdited`, which only the live `pump` passes — the transcript
  recompute (`loadChangedFilesFromSession`) passes none, so reopening a conversation never toasts (verified). A successful
  Write/Edit/MultiEdit of a memory *topic* file (`isMemoryTopicFile`), subagents included; an edit of only the MEMORY.md index
  toasts nothing (Claude edits the index after every save — verified: an index-only Edit, no event). What it remembered = the
  frontmatter `description` (else `name`; the renderer falls back to the file name) — from the Write's input, or read from disk
  after an Edit. `updated` = Edit/MultiEdit, or a Write onto an existing file: the structured result on the SDK user message
  (`tool_use_result` = FileWriteOutput, `type: "update"` — measured, one result per message) is trusted when the message holds
  that one result; otherwise the result text ("File created successfully at…" / "The file … has been updated"). `staged` writes
  (held for review, file unchanged) are skipped. Event `chat:memory_saved {path, name?, description?, updated}` (`memorySaved`
  in `TAB_EVENTS`); main always sends — the switch lives in the renderer.
- **Toast** (`MemoryToasts`, rendered once by the shell): one at a time from per-tab queues (newest 3 kept; the same path is
  merged — text from the newer, "고침" only if the earlier one was an update too). Only the visible tab's queue is shown, and
  only while `document.visibilityState` is visible (a minimized window keeps them, and a shown one waits); switching tabs
  closes the other tab's toast at once. 0.2 s fade + scale in, 3 s hold, 0.6 s fade with an 18 px upward drift, 150 ms gap
  (the times in the component and the SCSS must match); `prefers-reduced-motion` → opacity only (checked with CDP
  emulation). Hover pauses it (1.5 s more after the pointer leaves). The layer is `pointer-events: none`, only the card is
  clickable; z-index 25 = above the sidebar, below the modal scrim (a permission modal is never covered). Backticks in the
  description render as code; "고침" marks an update.
- **Click** → the shell's `openMemoryFromToast`: that tab, instructions panel, 기억 view with that memory open
  (`focusMemory` prop; the panel takes it once and clears it via `onFocusDone`, so coming back to the tab doesn't reopen it).
  A memory that isn't listed yet (a repo's first memory: the 기억 list needs MEMORY.md) is opened when the list next arrives
  (`chat:instructions` after the index write — verified by adding the file and its index line after the click); switching
  to 지침 or opening another file cancels the wait (verified).
- **Switch**: 설정 → "기억 알림" (default on; `localStorage` `better-claude:memory-toast` = `on` | `off`), applies to every
  tab at once; switching off closes the visible toast and drops the queues.
- Verified in the dev app (Haiku): a new memory, two memories in one reply (queued), Edit and Write-over-existing (고침), an
  index-only edit (nothing), a memory saved in a hidden tab (shown on switching back), off → nothing / on → shown, kept after a
  reload, click → the memory opens, light and dark; a memory saved while the window was covered by another app's full-screen
  window was held and shown once the page became visible.

### HTML preview (`HtmlPreview.tsx`, `src/main/services/previews.ts`)

HTML/SVG in replies is shown drawn, like Claude.ai's artifacts. Code blocks whose language is `html`/`htm`/`svg`
(or `xml` / none starting with `<svg`, or none starting with `<!doctype html`/`<html`) get **미리보기 | 코드** tabs:
code while the reply streams (`ReplyLiveContext` from `MessageItem` — the block may be unfinished), preview once it
is done, unless the user picked a tab. A `.html` file written by Write/Edit/MultiEdit gets a card under its tool row
(`HtmlFileCard`). "크게 보기" / the card open `PreviewPanel` in the files panel's slot (agent > background > preview >
instructions > files; `PreviewOpenContext` from `ChatTabView`, state `previewView` in the shell). JSX/React components are not
previewed (they need a build).

- **Isolation**: HTML is served from `bc-preview://<id>/` (scheme registered as privileged/standard before `ready`,
  `protocol.handle` after) and shown in `<iframe sandbox="allow-scripts">` — no `allow-same-origin`. Measured from
  inside the frame: `self.origin` = "null", `window.electronAPI` undefined (preloads don't run in subframes),
  `parent.document` / `parent.electronAPI` / cookies / `localStorage` / `top.location` → SecurityError, `window.open`
  opens nothing. Each response carries its own CSP: https scripts/styles/fonts/images may load (libraries — the
  owner's choice; canvas-confetti from jsDelivr loaded), `connect-src 'none'` (fetch blocked — verified),
  `form-action 'none'`. The app's own CSP (`index.html`) only adds `frame-src bc-preview:`.
- **Things generated pages use that the sandbox would break**: `localStorage`/`sessionStorage` throw in an opaque
  origin, and a todo-app style page died on its first line — `withInjected` puts an in-memory `Storage` stand-in
  right after `<head>` (before page scripts; lost on reload). Module scripts (`type="module"`) and `@font-face` fonts
  are CORS requests from origin `null`, refused for a non-CORS scheme — the scheme is `corsEnabled` and responses
  carry `Access-Control-Allow-Origin: *` (verified: module + import + font load; fetch to the same host, the web and
  another preview host stay blocked; `self.origin` still "null"). Cookies still throw.
- **A preview could navigate its frame to any website** (`location.href = …` — reproduced): neither the app CSP's
  `frame-src` nor Electron's `will-frame-navigate` caught a frame's self-initiated navigation (the event did not
  fire — measured), so `installPreviewProtocol` cancels every http(s) `subFrame` request in
  `session.defaultSession.webRequest.onBeforeRequest` (the app has no other iframes; the filter's `types:
  ["subFrame"]` keeps other requests off the main process). The frame turns blank; 미리보기 again reloads it.
- **What is served**: code blocks by text — id = sha256 of the HTML, so a re-render keeps the same `src` and the
  frame does not reload. LRU of 300 entries / 64M chars, and serving an entry makes it recent too (it used to go by
  registration order only, so a streaming block evicted previews still on screen → "not found" on remount).
  While the reply streams, a block switched to 미리보기 re-registers at most once a second (`LIVE_REFRESH_MS`) —
  before, every 50 ms flush gave a new id and reloaded the frame (verified: +1.0 s, +2.0 s). Files:
  `previews:file` checks `canViewPath` (cwd or Claude-changed) and registers the HTML file's **directory** per tab,
  serving only static web files from it (html/css/js/images/fonts/media), never dot-segments or other types,
  realpath must stay inside — verified: `card.css` 200; `.env`, `data.json`, encoded `../`, `.git/config` 404 — and
  each file must itself pass `canViewPath` (checked by the path as opened, since Claude-changed files are recorded
  under the app's spelling, `/tmp` not `/private/tmp`). Before, an `.html` outside the cwd (Desktop, /tmp) exposed
  its whole folder to the page; now only files Claude wrote there load (verified: its css 200, a sibling js 404).
  `?v=<mtime>` makes a reopened file reload. The 404 body is Korean ("미리보기를 찾을 수 없습니다").
- **Height**: served HTML gets a tiny reporter (ResizeObserver → `parent.postMessage({bcPreviewHeight})`; the parent
  accepts it only from its own frame's window). It measures the **body box** — `documentElement.scrollHeight` never
  drops below the viewport, so previews only ever grew (reproduced). Inline 48–560 px, 240 by default; pages sized to
  `100vh` stay at the current height — unless the body adds margins/padding on top of the viewport height (default
  8 px margin, content-box padding): then each report is viewport + k and the frame grows to 560. The reporter goes
  before the *last* `</body>` (the first can be inside a script string).
- **Width**: a reply bubble shrinks to its content and an iframe's default width is 300 px, so the page was cut —
  `.previewBoxInline {width: 2000px; max-width: 100%}` makes the bubble take its max width.
- **Lazy**: inline frames mount only within ~600 px of the visible part of their scroll box (IntersectionObserver
  with `root` = the nearest scrolling ancestor — with the default root the margin applies to the window only, the
  message list clipped first, and a preview vanished — state lost — as soon as it left view) — each preview is its
  own document/process; hidden tabs have none. Verified: 200 px out of view stays, ~640 px away unmounts.
- SVG renders through `<img src="data:image/svg+xml,…">` (no scripts in images), on a checkerboard by default. As an
  image it is a standalone XML document: a missing `xmlns` (common in HTML-inline SVG) is added (`svgDocument`), and
  SVG that still fails to parse (`&nbsp;`) shows a notice instead of a broken image. An empty block is not a preview
  kind. The background toggle (밝게/어둡게/체크무늬, `--c-preview-light/-dark`) only changes the backdrop — a page that paints
  its own background keeps it. Inline SVG is capped at 420×240 (an unsized one used to grow to the bubble's width) and
  a click opens the lightbox, where the `<img>` is sized by the SVG's aspect ratio (`--ar` set on load; `width:
  min(80vw, 960px, 80vh × ar)`) — a fixed box letterboxed it and the checkerboard bands looked like transparent
  margins in the picture. Verified: 2:1 → 960×480, 1:3 → 221×662, a 24 px icon → 662×662.

### Figma (`src/shared/figma.ts`, `src/shared/mcp-tools.ts`, `figma-*.ts` in the renderer)

The official Figma plugin (`figma@claude-plugins-official`, server `plugin:figma:figma` → remote `mcp.figma.com/mcp`)
gives Claude Figma tools; the app adds UI around them. No real Figma call was made while building any of it (not
logged in, no seat) — everything below was verified with fake transcripts and events injected from the main inspector.

- **One switch for all of it**: 사이드바 설정 → Figma → "Figma 기능" (`src/renderer/figma-setting.ts`, localStorage
  `better-claude:figma-features`, default on, `useFigmaFeatures()` + `figmaFeaturesOn()`/`onFigmaFeaturesChange()` for
  non-hook code). Off hides only the app's Figma UI and applies to every tab at once (verified on → off → on, also across
  a reload); the plugin/MCP keeps working and Claude keeps calling it.
- **MCP tool rows** — two layers. Generic (`src/shared/mcp-tools.ts` + `src/renderer/mcp-tool-display.ts`, no server
  knowledge): `mcp__<server>__<tool>` (the CLI replaces characters outside `[a-zA-Z0-9_-]` with `_`, so
  `plugin:figma:figma` → `plugin_figma_figma`) → "서버 · 도구" (`plugin_<p>_<s>` with p = s shows once: `figma`,
  `context7`) + an input summary (query/url/path/name/… first, never multi-line code). Decorators register by id
  (`registerMcpToolDecorator`) and patch title/detail/icon/links/image name; `useMcpDisplayVersion()` re-renders rows when
  a decorator's output changes (the switch). Figma layer (`figma-tool-display.ts`, imported once by
  `renderer/main.tsx`): Figma logo (`FigmaLogo.tsx` = the plugin's full-colour icon) + "Figma · 디자인 정보 읽기" etc.
  (labels in `FIGMA_TOOLS`), "노드 12:34" instead of the meaningless file key, "Figma에서 열기" =
  `https://www.figma.com/design/<fileKey>?node-id=12-34` (`/board/` for FigJam tools), and for write tools a "만든 보드
  열기"/"만든 파일 열기" from a Figma file URL in the result. Result URLs: main scans the *whole* tool-result text
  (`resultFigmaLinks` → `chat:tool_result.links`, `LoadedTool.resultLinks`) because the preview is only 500 chars; asset
  URLs (`figma.com/api/mcp/asset/…`) are not file URLs and are skipped; links in read-tool results (e.g. a library list)
  are not "made" and are not shown. Links are `<a target=_blank>` → the link guard → `shell.openExternal` (verified with
  `openExternal` stubbed). MCP image results (`get_screenshot`) already showed as thumbnails — both result shapes, the
  Anthropic `{source: {base64}}` and MCP `{data, mimeType}`, verified live and loaded; the thumbnail is named "Figma 노드
  12:34" (`imageName`).

### 사용 가이드 (`UserGuide.tsx`, content in `user-guide.ts`)

Sidebar "사용 가이드" (under 새 대화; the sidebar items have icons — 새 대화, 사용 가이드, 확장, 설정) opens a modal over
the tab view — chats keep running underneath. **설정** (last, `SettingsDialog.tsx`, same header as the guide) holds
general settings that have no header button of their own — for now the 답변 처음으로 target and the 기억 알림 switch
(the switch component is `Switch` from `NotificationSettings.tsx`) in "대화 화면", and the Figma section (see Figma).
Left: contents
(sections with item counts, follows scrolling); right: one card per feature (설명 + 쓰는 방법 lines); top: search over
title/body/how lines. Text markup: `[[⌘T]]` = keycap, `{i:shield}` = the app's own icon (`ICONS` in `UserGuide.tsx`),
backticks = code. `since: "v5"` shows a version badge. Esc clears the search first, then closes. **The guide is
hand-written: when a feature or its button/label changes, update its entry in `user-guide.ts`.**

### 확장 window (`extensions/ExtensionsDialog.tsx`, opened through `src/renderer/extensions-open.ts`)

One large modal for what extends Claude — the owner's picture: CLAUDE.md = post-it, skills = manuals in a drawer, hooks =
automatic sensors, MCP = phone lines, plugins = kits bundling them; costs and safety matter. Sidebar **확장** (`faPuzzlePiece`,
between 사용 가이드 and 설정) opens it over the tab view like the guide (same `guideHeader`/`guideClose`, chats keep running,
Esc or the scrim closes). Left nav: 플러그인 · 스킬 · 훅 · 대화 시작 비용 (each with a one-line hint from the picture above); the
header shows the folder the folder-dependent tabs describe = the **active tab's cwd** (`MiddleName`). Narrower than 720 px the
nav shrinks to icons.

- **Opening contract** — `openExtensions(tab: "plugins" | "skills" | "hooks" | "cost", focus?: string)`: module-level listeners
  like `jump-setting.ts`; the shell (`useExtensionsRequest`) opens the window or, if open, switches it. `focus` = what to find in
  that tab — plugins: a plugin id `name@marketplace` or name; skills: the name Claude invokes (`plugin:skill` for plugin
  skills, bare for personal/project ones); hooks: a plugin id; cost: unused. Every call has a new `seq`, so the same focus
  again re-finds it. The sidebar reopens the last viewed tab (`lastExtensionsTab`).
- **Tab bodies** are separate components in `src/renderer/pages/main/extensions/` — `PluginsTab`, `SkillsTab`, `HooksTab`,
  `CostTab` — each `(props: ExtensionsTabProps) = {tabId, cwd, focus?}`. The body is keyed by tab + request seq + tabId + cwd, so
  it remounts (fresh data) when another tab/folder is shown or a new request arrives; keep caches in main or module scope.
- **Host** (`extensions-host.ts`, `useExtensionsHost()`): `close()`, `openMcp()` (close + the cwd bar's MCP popover, for a
  server's [로그인]), `openInstructions()` (close + the 지침 panel). Inner overlays (confirm boxes, search fields) take Esc first:
  listen on `window` in the **capture** phase and `preventDefault()` — the window ignores a prevented Esc.
- Styles live in `extensions/extensions.module.scss` (not the shared `chat.page.module.scss`), tab-specific parts below the
  shell's.

**플러그인 tab** (`PluginsTab.tsx`; main `plugins:list|details|available|run|busy|cancel`; `src/main/services/plugins.ts`). The SDK
can only `reloadPlugins()`; installing needs the CLI, so main runs the app's own binary (`resolveClaudePath()`) as
`claude plugin …` in the tab's cwd (stdin closed — non-interactive; `process.env`, so `CLAUDE_CONFIG_DIR` carries over). The UI
says settings are shared with the terminal's claude. Measured with CLI 2.1.325:

- **Shapes**: `list --json` = array `{id, version, scope, enabled, installPath, installedAt, projectPath?, mcpServers?, …}` —
  `enabled` is the effective state *for the cwd*; project/local installs of other repos are listed too (with their
  `projectPath`, `enabled: false`) → main marks `here` (user/managed scope, or the cwd inside `projectPath`) and the tab shows
  the rest under "다른 레포에만 설치됨" (no switches — manage them from a tab in that repo). `list --json --available` =
  `{installed, available[]}` (~3,800–4,100: `pluginId, name, description, marketplaceName, source, version?, installCount?` —
  counts only on ~310 directory entries; installed ones are excluded). Mutations with `--json` print **one JSON line last on
  stdout** (`{command, outcome: "ok"|"failed", plugin, pluginId, scope, message, failureCode?, shownCommand?}`), human text may
  precede it on stdout (`parseCliJson` takes the last JSON line; `pluginCliText` keeps the rest for error details). `details
  <name>` is text only and works only for installed plugins (`parsePluginDetails`: Skills/Agents/Hooks/MCP/LSP lists,
  "Always-on: ~N tok", the per-component always-on/on-invoke table) — the cards' contents and "대화마다 ~N 토큰" (an estimate).
- **Scopes**: user = 모든 프로젝트, project = 팀 공유 (`<repo>/.claude/settings.json`), local = 이 레포에서 나만
  (`.claude/settings.local.json`); the repo = `projectRootFor` (walk up to `.git`; a worktree → its main checkout). The home
  folder is not a repo: its "project settings" would be `~/.claude/settings.json` = the user settings, so repo scopes are
  refused there (main and the radio). Install defaults to 이 레포에서 나만 (the owner's "try it locally first"). `enable` runs
  without `--scope` (auto-detect finds a local override); `disable`/`uninstall` pass the record's scope. Turning off a
  user/project plugin asks where (everywhere/team vs 이 레포에서 나만 = `disable --scope local`). Re-enabling such a local
  override makes the CLI record the plugin at local scope too (the *next* `list` shows a second record for the same id —
  reconcile), so here-records are grouped per id into one card with several scope badges, and 지우기 offers one button per
  scope (uninstalling only the user record left the plugin enabled through the local one — seen).
- **Risk and login**: hooks and MCP servers are flagged "내 권한으로 프로그램 실행" (hook events; stdio = 이 컴퓨터의 프로그램 with
  its command, http/sse = 원격 서버 host). A plugin MCP server's status comes from the folder's MCP list as
  `plugin:<plugin>:<server>` (e.g. `plugin:figma:figma`, scope `dynamic`); `needs-auth` → "MCP 목록에서 로그인" → `host.openMcp()`
  (the cwd bar popover's [로그인], F1). 찾아보기's page shows the source (`describePluginSource`: GitHub/GitLab links from
  url/git-subdir/github sources, marketplace repo + path for relative sources, npm; http(s) links only, opened by the link
  guard) and always warns that hooks/MCP servers run code with the owner's permissions.
- **Command-source plugins** (`source: {source: "command", command, mode}`): install fails with `failureCode:
  "command_source_refused"` + `shownCommand {kind, pluginId, command, mode, catalogRevision, sha256}` → the page shows that
  command in a red box ("명령을 실행하고 설치") and only then re-runs with `--accept-command <sha256>`. **The CLI ignores
  `--accept-command` inside a Claude Code session** (`CLAUDECODE`… in the env — a dev app started from an agent's shell
  inherits it): it answers the same refusal with `acceptCommandMatched: true` and the stdout line "--accept-command is ignored
  inside a Claude Code session" → "Claude Code 안에서 띄운 앱이라 CLI가 확인을 받지 않습니다 — 터미널에서 …". The app does not
  strip those variables (that guard exists to stop an agent from accepting for the user). So an accepted install was not
  verified; the owner's Dock-launched app has no such variables.
- **One mutating command at a time** (`pluginOp`, app-wide): a second gets `busy`. Timeouts: install 5 min, uninstall 2 min,
  enable/disable 1 min, lists 30–90 s. 취소 (install) = SIGTERM, SIGKILL after 3 s; a reopened window picks up a running op
  (`plugins:busy`, polled every second) and refreshes when it ends. Verified with a marketplace entry whose git URL points to a
  local server that never answers: busy banner, the second op refused, close/reopen kept the banner, 취소, and a 4 s timeout
  (patched through the inspector) → "시간이 너무 오래 걸려 멈췄습니다".
- **After a change** (`afterPluginChange`): details/available caches cleared, `invalidateInstructions()` (plugin skills are in
  the start context), `folderInfo.clear()` + `pushFolderInfo` for tabs without a live CLI ("/" menu, MCP list), and live
  sessions get `q.reloadPlugins()` **in the background** → `chat:commands`/`chat:mcp`. Not awaited: the reload reconciles
  marketplaces and waited forever on that never-answering git source (normally 66 ms, measured). Verified with a live session
  injected into a tab: disabling a plugin pushed the list without its skill ~450 ms later, enabling brought it back.
- **Testing**: only with an isolated `CLAUDE_CONFIG_DIR` + a local marketplace (`claude plugin marketplace add <dir>`, dummy
  plugins: a skill, an echo hook, a tiny stdio MCP server, a command-source one) and test folders that are their own git repos.
  A dev app launched from an agent's shell became the frontmost app (keystrokes!) — start it with `--inspect-brk`, resume from a
  script and, as soon as `BrowserWindow.getAllWindows()` has the window, `setFocusable(false)` + `app.hide()` (macOS gives the
  previous app back) + `showInactive()`; `setActivationPolicy("accessory")` alone did not help.

**스킬 tab** (`SkillsTab.tsx`, main `skills:list|read|write|create|reveal`, `src/main/services/skills.ts`). Every skill the
tab's folder can use, grouped 개인 / 이 프로젝트 / 플러그인 · <name> / 옛 명령 / 관리자 / 기본 제공 (CLI built-ins like `dataviz`);
per row name, description, always-on tokens, 직접 부를 때만, `/name`. Detail = rendered SKILL.md (frontmatter stripped, `Markdown`
with `baseDir` = the skill folder), 부르는 법, the folder's other files (read-only viewer), 편집 for personal and project skills.
Measured with CLI 2.1.325 / SDK 0.3.319:

- **Three sources, merged in `listSkills`**: `getContextUsage({detail: "full"}).skills.skillFrontmatter` = `{name, source,
  pluginName, pluginId, path, tokens}` (sources `userSettings` / `projectSettings` / `plugin` / `policySettings` / `built-in` /
  `syncedSkills`) — taken from the shared `measureInstructions` (its `skills`, plus `skillCounts` = total/included), not a
  second query; `disable-model-invocation` skills are **not** in it (not in the context → 0 tokens). `supportedCommands()` has every skill
  incl. manual-only plugin ones, with decorated descriptions (`… (user)`, `… (project)`, `(figma) …` — `cleanDescription`).
  And the files on disk, scanned the way the CLI does (read from its code, then verified with nested test folders): personal
  `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/<name>/SKILL.md` (+ `commands/**/*.md`); project = every folder **from the cwd up to
  the git root, root included, home excluded** (home's `.claude` is the personal one; outside git: up to just below home, or `/`), each
  `.claude/skills/<name>/SKILL.md` and `.claude/commands/**/*.md`. Below the cwd is not read at start (the CLI discovers those
  when Claude works there), above the git root never. A linked **git worktree** without its own `<root>/.claude/skills` reads
  the main checkout's instead. Folders holding `.claude-plugin` are plugins, not skills; command subfolders become `:` names
  (`commands/team/standup.md` → `/team:standup`). Managed: `/Library/Application Support/ClaudeCode/.claude/skills` (read-only).
  The name is the folder name. Manual-only plugin skills have no path in the context list — found next to a sibling skill's
  path or under `installed_plugins.json`'s `installPath`.
- **Freshness**: the measurement is cached per cwd/model (`instructionCache`), the command list per folder. `listSkills`
  re-asks both (refresh) when a skill file/folder, `installed_plugins.json` or `settings.json` is newer than the measurement,
  or a personal/project skill on disk is unknown to the CLI; ↻ forces it. Claude's own Write/Edit of a skill file goes through
  `noteInstructionEdit` → `invalidateInstructions` (skill descriptions are part of a new conversation's starting context).
- **Editing = the instructions panel's rules**: `skills:read/write` accept only paths from the tab's last `skills:list`
  (`access` map in skills.ts, per tab id); other files in a listed skill folder are readable when their realpath stays inside
  it (a symlink to `package.json` was refused); writes only for personal/project SKILL.md / command files; mtime conflict →
  다시 불러오기 / 그래도 덮어쓰기; `writeFileAtomic` (temp + rename onto the realpath); unsaved text in the module-level `drafts`
  (kept across closing the window — verified, with the dot on the row). Plugin skills are read-only (overwritten on update).
- **새 스킬**: 개인 = `<config>/skills/<name>/SKILL.md`; 이 프로젝트 = the git root's `.claude/skills` (worktree without one →
  the main checkout's, which is what the CLI reads; outside git → the cwd's; never in the home folder). Name kebab-case ≤64, not
  any command name or alias (builtins included) and no existing folder — checked in main too. Frontmatter `name`,
  `description` (one line; quoted as a JSON string when YAML needs it — `: `, ` #` …, the CLI parsed it back verbatim),
  `disable-model-invocation: true` when 직접 부를 때만. Never overwrites: the folder is created with a non-recursive `mkdir`
  (fails if it exists) and SKILL.md is `link`ed from a temp file.
- **After a write** (`skillsChanged` in main): `invalidateInstructions()`, every tab folder re-probed, live sessions
  `q.reloadSkills()` + `reportCommands` (a message sent within the suggestion wait / during background tasks goes to the same
  process, which otherwise keeps the old text), other tabs `pushFolderInfo` — the "/" menu shows a new skill at once (verified).
- `focus` (`openExtensions("skills", name)`) selects and scrolls to the row; it waits for the first fresh list (the cached one
  may predate the skill) and then says "찾지 못했습니다" if the folder has no such skill.

**Skills in replies** (`ToolRow` in `ActivityPanel.tsx`, `SkillRef.tsx`, `src/renderer/skill-names.ts`):

- **What the transcript holds** (measured, CLI 2.1.325): Claude's call = tool_use `Skill` with input `{skill: "name", args?}`
  (plugin skills `plugin:skill`), result text `Launching skill: name`, then a user entry with `isMeta: true` and
  `sourceToolUseID` whose text starts "Base directory for this skill: …" (the skill body). A skill I type (`/name args`) is the
  entry `<command-message>name</command-message><command-name>/name</command-name><command-args>args</command-args>` (shown as
  "/name args" by `describeCommandEntry`) followed by the same kind of `isMeta` body entry. `getSessionMessages` does not return
  the `isMeta` entries, so reopened conversations show no stray body bubble (verified).
- **Tool row**: `skillCallOf` → "📖 스킬 · name · args" (args collapsed to one line, middle-truncated), the whole row opens
  `openExtensions("skills", name)` with a "보기 ›" hint (agent rows keep "한 일 보기"). The activity panel, the reply and the agent
  panel all draw `ToolRow`, live and reopened alike.
- **Chip on my message** (`SkillChip`, above the bubble like attachment cards): the message starts with `/name` and `name` is one
  of the tab's custom commands — `skill-names.ts` keeps one subscription per tab to the "/" menu's list (`commands:list` +
  `chat:commands`; built-ins and MCP prompts `mcp__…` excluded), dropped 30 s after the last chip unmounts. The `subscribe` given
  to `useSyncExternalStore` must be stable (`useCallback`): a new function each render made React resubscribe, the store dropped
  and re-fetched the list on every render and the renderer locked up (happened in testing). The text sent is unchanged.
- Verified in the dev app with a real Haiku turn (`/start-banana` → Claude calls `Skill({skill: "banana-word"})`): chip at
  send time, activity-panel row during the turn, reply row, both again after an app restart; 보기 on each opens that skill.

**훅 tab** (`HooksTab.tsx`, main `hooks:list|reveal`, `src/main/services/hooks.ts`) — read-only:

- **Source = the CLI's `/hooks` listing**: control request `get_hooks_listing`, sent through the undeclared
  `Query.getHooksListing()` in `sdk.mjs` (SDK 0.3.319; narrow `HooksListingMethod` type + `typeof` guard, like
  `mcpAuthenticate`; an SDK without that method → the Query's own undeclared `request({subtype: "get_hooks_listing"})`) on a
  fresh idle query in the tab's cwd — the current files, not what a live process loaded. Rows:
  `{event, matcher ('' = none), source (userSettings / projectSettings / localSettings / policySettings / pluginHook /
  sessionHook …), sourceLabel, pluginName, type (command / prompt / agent / http / mcp_tool), displayText (= statusMessage when
  set), commandText, timeout, statusMessage, runsInBackground (async), runsOnce, condition, disabled}`; `events` in lifecycle
  order with the CLI's summaries; `policy`, `safeMode`, `bareMode`; `errors` = settings files that failed to parse — their hooks
  are dropped (a broken `settings.local.json` → "Invalid or malformed JSON", that hook gone). `pluginName` is the plugin **id**
  (`hookplug@ext2-market`); `sourceLabel` always says "~/.claude/settings.json", even under `CLAUDE_CONFIG_DIR`.
- **Which files** (read from the CLI's code, verified): personal `<config>/settings.json`; project = **`<cwd>/.claude/settings.json`
  — the cwd itself, not the repo root** (hooks at the root listed nothing from a subfolder cwd, while that root's
  `settings.local.json` was read); 이 레포에서 나만 = `<canonical git root>/.claude/settings.local.json` (the main checkout's root
  for a worktree; the cwd when that root is home); managed `/Library/Application Support/ClaudeCode/managed-settings.json`;
  plugins = enabled plugins' `<installPath>/hooks/hooks.json`. `settingsFiles()` computes them (the footer list and each card's
  파일 → Finder); `hooks:reveal` only shows files from the tab's last list.
- **Fallback** when the SDK/CLI lacks the request (or "Unsupported control request"): the same files parsed directly + enabled
  plugins' hooks, with a banner that it may differ. Forced with conditional breakpoints: without `getHooksListing` the `request`
  path still got the CLI's list; without both, the files gave the same 8 hooks in the same event order as the CLI's list.
- UI: warning banner (stronger when project/plugin hooks exist — "다른 사람이 넣었을 수 있습니다"), read-only note, policy /
  safe-mode / parse-error banners; per event the Korean moment ("도구를 쓰기 직전") + event name + CLI summary; a card = matcher
  (모든 도구 / 모든 경우, SessionStart's startup → 새로 시작 …), type (명령 실행 / 모델에게 묻기 …), source badge (개인 · 이 레포에서
  나만 accent, 프로젝트 outlined warning, 플러그인 purple, 관리자 muted), the command/prompt in mono (3-line clamp — the toggle shows
  only when the text really overflows), status message / timeout / async / once / condition. `focus` = plugin id → that plugin's
  hooks only (matched on the name before `@`) with 모두 보기; a plugin without hooks says so. Empty state explains what hooks are.
- Verified with an isolated config + a local test plugin: 8 hooks from user, project, local and plugin sources, plugin focus,
  figma (no hooks), a broken settings file, the fallback, reveal (and `/etc/hosts` refused), light and dark.

**대화 시작 비용 tab** (`CostTab.tsx`, main `extensions:start_cost`): how many tokens a fresh conversation in this folder uses
before anything is said, and from what. It is the 지침 panel's measurement (`measureInstructions`, same cache key cwd + model +
system prompts), which now keeps the whole `getContextUsage({detail: "full"})` answer: `categories` (`id`/`kind` — classify
on those, not the English name), `memoryFiles`, `skills.skillFrontmatter` (`name` is what Claude invokes — `figma:figma-use`
for plugin skills — with `source` plugin / userSettings / projectSettings / built-in and `pluginId`), `mcpTools` (`serverName`
normalized: `plugin_tiny-mcp_tiny`; `isLoaded: false` = deferred), `mcpInstructions`, `agents` (`pluginId`). **MCP tools need
the servers connected first**: a freshly spawned CLI answers while its servers are still `pending` and reports no MCP tools
(measured), so this tab asks with `settle` = `initializationResult()` + `settleMcp` (≤10 s) and keeps that measurement in the
cache (`mcpSettled`; the chip and the panel reuse it, an unsettled one is re-measured for the tab). Shown: the total ("컨텍스트
창 N의 x%", model, time), bars for the `used` categories sorted by size (the empty conversation's 10-token "Messages" row is
hidden), the `deferred` sum as a note ("필요할 때만 불러오는 도구 … 빠져 있습니다" — MCP tools are deferred by default, measured),
then memory files (→ `host.openInstructions()`), skills grouped by plugin / 내 스킬 / 이 프로젝트 / 기본 (a plugin group →
`openExtensions("plugins", pluginId)`, a skill → `openExtensions("skills", name)`), MCP servers with their status at
measuring time (`plugin:<name>:…` → the plugins tab; `needs-auth` servers listed as "빠져 있음" with a link to the MCP list) and
agents. It says the value is measured by the token-count API, not estimated (`full: false` → "어림값"). Without a login (the
isolated test config) the CLI still answers "full" but with its own estimates (CLAUDE.md 40,703 vs 47,744 measured with the
owner's login) — the note can't tell those apart. Verified with the owner's config (read-only: 61,704 tokens, CLAUDE.md 77 %,
figma skills 2,525, two needs-auth servers) and the isolated one (plugin, project and built-in skill groups, a connected stdio
MCP server with one deferred tool, a project agent; every link).

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
  stayed hidden. **Its target is a setting** (사이드바 설정 → "답변 처음으로" 버튼 기준, `src/renderer/jump-setting.ts`,
  localStorage `better-claude:jump-reply`, shared by every tab like `suggestion-setting.ts`): 보고 있는 답변 (`reading`,
  default, the behaviour above) or 마지막 답변 (`last` — someone asked for it): the newest Claude reply (the greeting,
  `data-greeting`, doesn't count) whenever its first line is off screen — above → ↑, below (scrolled up into older
  replies) → ↓ — labelled "마지막 답변 처음으로"; none while that first line is visible. Verified both modes with two
  long replies (from the middle of the first, from the bottom, at the second's start) and after a reload.
- **Files dropped anywhere on the tab** (message list included, not just the input box) attach to the
  message: `ChatTabView` owns the drag handlers (depth counter for nested enter/leave, files only — text
  drags are ignored) and calls the `addFiles` that `ChatInput` registers via `onRegisterAddFiles`. **A file dragged
  from the files panel** (tree / Claude 수정 / Git rows are `draggable`) carries `FILE_DRAG_TYPE` = its cwd-relative path
  (only that type — with `text/plain` the textarea would paste the path as text); the overlay says "@로 넣습니다" and the
  drop adds an @ mention through `onRegisterAddMention`.
- **Attachments in a sent message are cards** (`src/renderer/attachments.ts`): Claude still gets the same text in front
  of the message ("첨부 파일 — 아래 경로의 파일을 Read 도구로 읽어주세요:" + `- path` lines, the @ "참조 파일" block, the
  no-path note), built by `buildAttachmentText`; `parseAttachments` reads it back off the message so `UserContent` draws
  file cards (type-coloured icon tile from `FILE_ICONS` via `iconVars`, name + `~` folder through `MiddleName`, "@ 참조"
  tag, ⌘+click → IDE) above the bubble and only the typed text inside it. No separate storage: live and loaded
  conversations look the same (verified after a reload). The input's file chips use the same card parts.
- **Long content folds** (`Collapsible.tsx`): reply code blocks (`CODE_FOLD_PX` 360) and my messages (`USER_FOLD_PX`
  300) taller than 1.3× that show only that height with a fade and "전체 보기 · N줄" / "전체 보기"; height is measured
  (ResizeObserver on the content, so one long unbroken line counts; 0 while the tab is hidden), and folding back
  scrolls the box into view. ⌘F expands a folded box holding the match (`EXPAND_EVENT` on `[data-collapsed]`) and
  measures again on a **timer**, not rAF — an occluded window never runs rAF and the jump landed off screen.
  Edit diffs keep their own 220px scroll box.
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
- **Images in replies** (`useReplyImages` / `ImageStrip` / `MarkdownImage` in `MessageItem.tsx`,
  `src/renderer/image-refs.ts`, main `src/main/services/images.ts`). Thumbnails under a **tool row**:
  images inside the tool result (a Read of an image returns `[{type: "image", source: {type: "base64",
  media_type, data}}]` — verified; MCP's `{type: "image", data, mimeType}` too; sent as
  `chat:tool_result.images`, ≤4), image files written by Write/Edit, and for other tools (Bash…) image
  paths in their input/output **whose mtime is after the tool started** (`startedAt` − 2 s; loaded
  sessions use the transcript entry time) — so `ls *.png` shows nothing. Under a **text bubble**: image
  paths the text mentions (inline code, links, bare paths — a Korean particle may follow the extension:
  "chart.png에"; fenced code is skipped). `![](path)` renders in place, capped at 400×260 (`.mdImage`; a big
  screenshot used to fill the bubble at 520×360), click → full size; web images become links (the CSP
  blocks them). Each image shows once per reply, tools first — it lands under the command that made it,
  not under "chart.png를 만들겠습니다". Paths resolve in main (`images:resolve`, ≤24 per call; the renderer
  caches hits 20 s and never misses, since the file often appears after the text) and resolve again when
  the turn ends (`isLive`). An image = image extension **and** matching magic bytes (svg: `<svg` in the
  first 4 KB); any location (Claude saves to /tmp, the Desktop…) — only image bytes are ever read.
  Thumbnails ≤1.5 MB go as is, larger ones are shrunk to 640 px with `nativeImage` (fallback: the original
  up to 8 MB); clicking loads the original (`images:read`: paths resolved for this tab or inside the files
  panel's scope, ≤30 MB) into the lightbox (`useLightbox(rootRef, tabId)` in `Lightbox.tsx` — one for replies (root =
  the tab's message list), the agent panel (its body), the input's attached images (the strip) and, via `ImageViewer`,
  the files/지침 panels' markdown; ×, outside click or Esc closes). **Top bar**: name (`data-zoom-name`, path in
  `data-zoom-path`) and size; **실제 크기** when the picture is shrunk (button or click the picture — the clicked point stays
  under the pointer; drag to pan, a click without dragging fits again); **복사** draws it on a canvas → PNG →
  `clipboard:write_image` (`nativeImage`; SVG scaled to 1600 px); **Finder** for pictures with a path (`files:reveal`
  now also allows the tab's resolved image paths). Size/actual/copied are keyed by `src` instead of being reset in an
  effect — a data-URL picture finished loading before the effect ran and the measured size was wiped (reproduced). **‹ › / ←→ step through the root's other images**: every element that opens the lightbox carries
  `data-zoomable` and passes itself (`OpenImage(src, from)`); the list = the root's visible `[data-zoomable]` in document
  order, with an "N / M" counter (no arrows for a single image; at the ends the arrow is dimmed, not hidden — a hidden
  one let the click fall through to the scrim and close). Stepping = `el.click()` on the neighbour, so each image's
  own open path (thumbnail → original from main, SVG as is) is reused; its thumbnail shows first, and `wantRef` drops
  a slower original of an image already stepped past. Verified: 4 images in a reply (← → keys, buttons, a 2.3 MB
  original), the files panel's README (its 2 images only). Tool-result previews now join text blocks instead of
  `JSON.stringify`-ing the array (the image base64 used to be the preview). Loaded conversations keep
  result images for the newest 40 tools / 40 M chars (`limitLoadedImages`); older ones show a count. Files
  panel: image files render as images (size, dimensions; click toggles actual size only when shrunk), svg
  has 그림/소스. SVG is only drawn through `<img>` (no scripts run there), never inline in the DOM. A
  checkerboard sits behind images (`--c-img-check-a/b`, light in both themes so dark strokes on a
  transparent background stay visible).
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

**Streaming must stay cheap** — every tab stays mounted and several can stream at once. Text chunks are
batched (`CHUNK_FLUSH_MS` = 50 ms in `useClaudeChat`; tools/compaction flush at once, `finish` flushes what is
left), markdown is a memoized component (`Markdown` in `MessageItem`, `MarkdownView` in the instructions
panel) so only the segment whose text changed is re-parsed, and `ToolDiff` memoizes its LCS. Before, every
chunk re-parsed the whole reply twice (an effect re-synced the edit draft on each chunk) and each turn's
start/end re-parsed every message of the conversation (the `isLoading`-dependent callbacks change every
item's props, so `memo(MessageItem)` alone cannot skip them). `InstructionsPanel` is `memo`'d because the shell
re-renders on any tab's state change.

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

- Paths and file names in the UI: `MiddleName` (`MiddleName.tsx`) — the front shrinks with "…", the file name (or
  the last 12 characters) always shows. Never end-ellipsis a path (the owner's rule: the file name is what matters).
- TypeScript paths are bare relative imports — no path aliases configured.
- Two ESLint configs exist (`.eslintrc` and `.eslintrc.json`); `.eslintrc.json` is the richer one (prettier + `simple-import-sort`). Don't add a third.
- 4-space indentation in `.ts`/`.tsx` (matches existing files; not enforced by config).
- `chat.page.module.scss` is shared by most components (`MessageItem`, `ActivityPanel`, `QuestionModal`,
  `QuestionCard`, …), so a new class name can silently merge with an existing one (`.questionText` /
  `.questionHeader` already belonged to the modal). Run stylelint — `no-duplicate-selectors` catches it.
