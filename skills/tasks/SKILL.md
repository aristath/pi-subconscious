---
name: scheduled-tasks
description: Create, edit, or remove scheduled Pi tasks. Tasks are JS or TS files in the current user's tasks/ directory and can run code or a native Pi inference session.
---

# Scheduled tasks

Task files belong in `tasks/` under the user's profile working directory.
Use a descriptive `.js` or `.ts` filename. Start the file with a schedule header:

```js
/**
 * @every 5 minutes
 * @mode deterministic
 */
export default async function ({ cwd, user, signal }) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('tasks/example.txt', `Hello from ${user}\n`);
}
```

`@every` is the interval between scheduled starts. It accepts seconds, minutes,
hours, days, weeks, calendar months, and years, including shorthand such as
`5m`, `13h`, and `6 months`. A newly discovered file first becomes due after its
interval. Editing the interval recalculates it from the last start; editing the
body alone keeps its schedule.

### Daily start and quiet period

These fields are optional and have no defaults. A task without them keeps its
normal interval behavior. For a daily task, use `@start_time` instead of `@every`:

```js
/**
 * @start_time 00:00
 * @quiet_window 30m
 * @mode inference
 * @session fresh
 */
export default 'Carry out the work described in this task.';
```

`@start_time HH:mm` makes the task eligible once per local day from that time,
using the scheduler's `timeZone` supplied by its host (or the system timezone
when none is supplied). There is no closing time: a delayed task
runs when it can. Missed days do not accumulate duplicate runs.

`@quiet_window` requires a fixed duration such as `10m` or `30 minutes` without
frontend activity. The timer starts when the last foreground response finishes;
active chats still take priority. Host startup begins a fresh quiet period.
This field also works with `@every`, without requiring `@start_time`.
Other tasks do not reset the quiet timer, and a task waiting for quiet does not
block eligible tasks. Once started, normal foreground-priority rules apply.

`@mode deterministic` runs the exported function once, with the user's profile
as its current directory. The arguments are the absolute `cwd`, the username
`user`, and an `AbortSignal`. Await all work before returning; a task is not a
place to start a detached service or leave timers running.

The header is ordinary JavaScript comment text. TypeScript uses Node's native
type stripping; use erasable types and explicit file extensions for local imports.
The scheduler reads headers without executing the files. Imports and the task
body execute only when the task is picked up.

## Inference

```js
/**
 * @every 13h
 * @mode inference
 * @session continue
 */
export default 'Continue the work described in this task.';
```

An inference task exports either a prompt string or an async function returning
a prompt string. That function receives the same arguments as a deterministic
task, so it can gather deterministic input before forming the prompt.

`@session fresh` starts a new conversation each run and is the default.
`@session continue` reopens this task's previous conversation. Each task has its
own conversation; it does not reuse a frontend chat. Native Pi loads the execution profile's
settings, extensions, model, and permitted tools. The prompt is passed as a task custom
message; the scheduler does not add an agenda or require a particular result.

Add `@model provider/model-id` to the task header to choose its inference model.
The model must be available in the execution profile's Pi configuration.
This selects the model on every run, including a continued session, without
changing shared or profile defaults. Omit it for Pi's normal default/resume
behavior. Deterministic tasks do not call a model.

Use `@soul none` in an inference task header to run without SOUL content,
SOUL instructions, or SOUL tools. This requires pi-modular-soul with
`--soul none` support and applies to both fresh and continued task sessions.
Other Pi instructions and tools still apply. Omit the header for normal SOUL
loading from the execution profile.

Add `@thinking <level>` to an inference task header to set the reasoning level
for every run: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
It uses Pi's native `--thinking` option, is clamped to the model's capabilities,
and does not change profile or global defaults. Omit it for the profile default.

### Execution profile

The host can supply an `executionCwd` for inference. Pi loads that working directory's normal `.pi/settings.json`, extensions, SOUL and tools. The task function still receives its originating owner's `cwd` and `user`. Return explicit source paths in the prompt when referring to that owner's files. Execution profile configuration is separate from task ownership and saved task progress.

For example, a less frequent task can use:

```js
/**
 * @every 6 months
 * @mode inference
 * @session fresh
 */
export default 'Review the project notes and reconsider any open questions.';
```

These are examples of file structure, not tasks to install automatically.

## Queue and frontend priority

All users share one queue. The oldest due task runs first. No second task starts
until that task finishes, including while it is waiting for a frontend chat.
Overdue intervals do not create a backlog of duplicate occurrences.

Frontend chats always take priority. Tasks wait while any frontend chat is
running. If a message arrives during a Pi turn, that turn (model response and its
tools) finishes, then the task waits before its next turn. It resumes when frontend
chats are idle. A deterministic function is one step, so keep it reasonably bounded.

### Run on demand

From a foreground chat, call `run_task({task: "example.js"})` to queue a task
without waiting for its scheduled time or quiet period. Its regular schedule
does not change. The request enters the shared execution queue immediately,
without waiting for a scheduler tick. It starts when chats are idle and earlier
background work has finished. The tool returns a queued receipt, not the
task's result; do not wait in the chat or claim that its work is finished.
Queued requests survive restarts. Repeating the same tool invocation does not
queue another run. Separate invocations request separate runs.

## Changes and stored progress

- Add a task by creating its file. It is discovered on the next scheduler tick.
- Modify its header or body by editing that file.
- Remove it by deleting the file. An occurrence already running is allowed to finish.
- Moving or renaming a file gives it a new task identity and schedule.

Scheduling progress lives in `.pi/runtime/tasks.json` inside the profile.
Inference conversations live in `tasks/.sessions/<task-filename>/`. Do not edit
the progress file to implement task logic; use ordinary files or notebooks for
the task's own working data.

Started occurrences are not automatically replayed after a service crash.
Their next scheduled occurrence remains recorded. Continued conversations survive
restarts. A failed task reports its error and leaves the queue available for the
next task. Fix its file; it will be attempted at its next scheduled time.

Tasks are executable automation code. Do not put secrets or personal tasks in
the package repository. Store them only in the owning user's profile.
