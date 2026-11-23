# pi-subconscious

Scheduled tasks and chat-triggered private reflections using the system-installed `pi --mode rpc`,
native settings, sessions, models, and configured tools.

## Scheduled tasks

An embedding application creates a `TaskScheduler`. It reads
`tasks/*.js` and `tasks/*.ts` inside each user’s profile, runs one due task at a
time, and lets background jobs start only while no frontend chat is active. Foreground turns are
never held back: queueing concurrent inference is the model backend's job, not the gate's. Scheduled tasks do not
need a separate service or a per-user scheduler.

[The scheduled-tasks skill](skills/tasks/SKILL.md) is the complete authoring guide:
file headers, intervals, deterministic code, inference prompts, fresh/continuing
sessions, editing and removing tasks, and stored progress. Pi discovers this skill
when the package is installed. No real tasks are supplied or installed.

Optional `@start_time HH:mm` schedules one daily run instead of an interval.
Optional `@quiet_window 30m` waits for foreground inactivity before starting,
with no cutoff time. Neither field has a default or affects tasks that omit it.
The host supplies the scheduler's `timeZone`; otherwise it uses the system
timezone. See the authoring guide for examples.

A minimal deterministic task:

```js
/**
 * @every 5 minutes
 * @mode deterministic
 */
export default async ({ user }) => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('tasks/example.txt', `Hello from ${user}\n`);
};
```

A continuing inference task:

```js
/**
 * @every 13h
 * @mode inference
 * @session continue
 * @model my-provider/my-model
 */
export default 'Continue the work described in this task’s notebook.';
```

Inference tasks use the host's `executionCwd`, or their owner's directory when none is supplied. The installed `pi` command loads that directory's ordinary configuration. Task ownership, source paths and saved sessions remain associated with the originating user.

Intervals include calendar months, such as `@every 6 months`. Inference defaults
to `@session fresh` unless the definition says `continue`.

Optional `@model provider/model-id` selects a configured Pi model for each
inference run, including continued sessions. It uses Pi's native `--model`
option and does not change profile or global defaults. Omit it to retain Pi's
normal default/resume model selection. Deterministic tasks do not use a model.

Optional `@soul none` disables the pi-modular-soul package for that inference
process: no SOUL content, loading instructions, tools, or commands are added.
It also applies when continuing a task with a saved SOUL selection. Omit it to
keep the execution profile's normal SOUL behavior. Other Pi instructions and
tools remain available. Requires pi-modular-soul with `--soul none` support.

Optional `@thinking <level>` sets the reasoning level for each inference run:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It uses Pi's
native `--thinking` option, is clamped to the model's capabilities, and does
not change profile or global defaults. Omit it for the profile default.

Optional `@tools` and `@exclude_tools` select the inference run's tools with
Pi's native `--tools` and `--exclude-tools` flags. `@tools` is a comma-separated
allowlist; a list of only `+name`/`-name` entries adds to or removes from the
profile defaults instead. `@exclude_tools` is a comma-separated denylist and
applies to every tool, MCP tools included. Omit both for the execution
profile's normal tool selection.

The host application uses `TaskScheduler` from `src/tasks.js` and `runTask` from
`src/task-runner.js`. Foreground sessions register a busy claim on the scheduler’s
existing `Gate`; they are never made to wait for background work, so extensions stay
hardware-agnostic and the model backend owns inference queueing. Task execution happens
in a separate process using the selected execution profile.
A task worker holds the existing process lock while it runs.

Pass the same `gate` to `TaskScheduler` and each reflection `startService(config, { gate })`
to share one FIFO background queue across users. A background job keeps its place
while no chat is active. Pi handles tool execution, compaction,
retry and cancellation; tools do not acquire scheduling locks.
The embedding application owns the coordinator's lifetime; clients connect to
the running coordinator and never start a competing process.

The foreground `run_task({task: "example.js"})` tool queues an on-demand run
without changing its regular schedule. Hosts connect it with
`startService(config, { gate, enqueueTask: (name, key) => scheduler.request(userId, name, key) })`.
Requests are saved in the owner's existing task progress file and submitted to
the shared queue immediately, without waiting for a scheduler tick. Scheduled
time and quiet periods are skipped; background jobs still wait for active chats.

## Install

Requires Linux, Node.js 22.18+, and Pi 1.5.2+.

```sh
git clone <repository-url>
cd pi-subconscious
npm install
pi install .
```

Private task files, configuration, credentials, state, and generated files belong
outside the package repository.

## Chat-triggered reflections

The coordinator handles thoughts set aside from a
frontend chat with `subconscious_reflect`. Reflections keep their exact source
conversation and can return selected context there with `subconscious_return`,
or end silently with `subconscious_finish`. They do not automatically prompt the
frontend.

Private reflection tools also include `subconscious_source`,
`subconscious_start_chat`, and `subconscious_chats`. Reflections use the same turn
boundaries and retain accepted-action recovery and transcript inspection.

### Configuration

Use the `subconscious` section of the profile’s `.pi/settings.json`:

```json
{
  "subconscious": {
    "dataDir": "./subconscious",
    "initiallyPaused": true
  }
}
```

`dataDir` resolves from the profile directory. The native Pi agent directory
supplies package configuration. Model selection uses the execution profile's ordinary Pi settings.
Configure tools in the private execution profile using normal Pi settings.
Its optional `subconscious.allowedTools` list restricts private reflections to
those exact names; otherwise they use that profile's active tools.

The error-retry option is `errorRetryMs` (30000). Foreground busy claims are
event-driven (run start/settle, compaction, shutdown); a crashed owner's claim
is cleared by a pid liveness check when background work next asks for admission.

The embedding application starts the coordinator with `startService(config)`
and owns its lifetime. `subconscious.cwd` selects the private execution profile;
it does not change the originating owner or coordinator store. A host can supply
`--agent-dir` to select Pi’s native agent directory. Shutdown lets a current turn
finish; use an equivalent supervisor when the host restarts.

### Controls

`/subconscious status`, `pause`, `resume`, `list`, `read <id>`, `actions`,
`resolve <JSON>`, and `notifications` use the existing coordinator. The CLI
supports the same commands, plus `stop` and `ack ID`, against the running
coordinator.

Pause is durable and lets the current turn finish. It controls chat-triggered
reflections; the shared scheduled-task queue is configured by the host application.
Inspection reads existing state and transcripts without starting a model turn.
Private transcript contents are not automatically published to frontend chats.

## Development

Run current behavioral tests locally with controlled providers. No tests contact
a live inference service. Deployment hosts run production builds and brief health
checks, not test suites.
