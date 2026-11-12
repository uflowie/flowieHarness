# flowie daemon

One local Node process that hosts every workspace's agent and serves the web UI's API.

```sh
npm install --ignore-scripts   # from the repo root
npm run daemon                 # http://127.0.0.1:7878 (serves web/dist once built)
npm test -w daemon             # end-to-end test with the faux model provider
```

Environment: `FLOWIE_PORT` (default 7878), `FLOWIE_DATA_DIR` (default `~/.flowie`), `FLOWIE_ALLOWED_ORIGINS`
(comma-separated browser origins besides the daemon's own, e.g. a Vite dev server), `PI_CODING_AGENT_DIR` (default
`~/.pi/agent`), `FLOWIE_FAKE=1` (a fake model that streams Markdown and runs `bash` when asked, for UI work).

## Model

- **Project**: a git repository, registered by path. **Workspace**: one of its worktrees, main included. Worktrees are
  always read from `git worktree list`, so ones made outside flowie show up too.
- **One agent per workspace**: each workspace has its own pi-durable Harness (`<data>/workspaces/<id>/harness.sqlite`)
  whose root conversation is the agent, working in the worktree. Subagents and forks are further conversations in it.
- Harnesses open in-process on first use and close after 10 minutes without use, watchers, or running work. At startup
  every workspace with data is opened and resumed, so a run the last daemon left unfinished continues.
- Models and credentials come from pi: the built-in providers, API keys from the environment, and pi's `auth.json`
  (shared with the pi CLI under the same file lock).
- Default model: `<data>/settings.json`, `{ "defaultModel": { "provider", "modelId" }, "defaultThinkingLevel"? }`,
  else pi's `defaultProvider`/`defaultModel`/`defaultThinkingLevel` if this catalog knows the model. New agents start
  with it, and an agent without a stored model or thinking level takes it when its workspace opens; a choice made in
  the UI stays. Read at each workspace open, so an edit needs no restart.
- Tools: pi-durable's `read`, `write`, `edit`, `bash`. The prompt adds the cwd and the `AGENTS.md`/`CLAUDE.md` files of
  pi's agent directory and the worktree, reread before each request.
- Access: listens on 127.0.0.1 only and refuses foreign `Host` and `Origin` headers. A `daemon.lock` keeps a second
  daemon off the same data directory.

## HTTP API

JSON in and out; errors are `{ "error": "..." }` with 400 (invalid input, git refused), 404, 409 (busy/idle conflicts).

| Method and path | Body | Does |
|---|---|---|
| `GET /api/projects` | | Projects with their workspaces and each one's `status` |
| `POST /api/projects` | `{ path }` | Register the repository containing `path` |
| `DELETE /api/projects/:id` | | Unregister (nothing on disk changes) |
| `POST /api/projects/:id/worktrees` | `{ name?, base? }` | New worktree on branch `name` (default: a random unused name like `brave-otter`) from `base` (default: the main checkout's branch) |
| `DELETE /api/workspaces/:id[?force=1]` | | `git worktree remove`; its agent data moves to `<data>/archive/` |
| `GET /api/directories?path=` | | The folders in `path` on the daemon's machine (default home; `~` is home), git repositories marked, with shortcuts |
| `GET /api/models` | | Models with credentials, and the defaults |
| `GET /api/workspaces/:id` | | Workspace, status, agent (`model`, `thinkingLevel`, `cwd`), usage |
| `POST /api/workspaces/:id/agent` | `{ model?: { provider, modelId } \| null, thinkingLevel? }` | Change the agent; `null` restores the default |
| `POST /api/workspaces/:id/submit` | `{ content, whenBusy?, requestId? }` | User input: a string, or `{type:"text",text}` / `{type:"image",data,mimeType}` parts. While busy: `followUp` (default) or `steer` |
| `POST /api/workspaces/:id/continue` | | Retry a run that ended without an answer |
| `POST /api/workspaces/:id/abort` | | Stop the running work, withdraw queued input |
| `POST /api/workspaces/:id/compact` | `{ instructions? }` | Summarize older context |
| `POST /api/workspaces/:id/reset` | `{ handoff? }` | Start a fresh context (history stays) |
| `GET /api/workspaces/:id/entries?min=&max=&order=&limit=&cursor=&conversation=` | | History between entry IDs `min` and `max` (inclusive), newest first unless `order=ascending` |

## WebSocket `/api/ws`

Client sends `{ type: "watch", sub, workspace, conversation?, from?, min? }` and `{ type: "unwatch", sub }`.

The daemon sends:

- `statuses` once, then `status` on every change, for every workspace: `opening`, `idle` (with the last `runFailure`
  reason, if any), `busy`, `closed`, `failed`.
- Per watch: `value` (a Durable `ConversationView`: a window of the newest entries plus the `pi.live`, `pi.inbox`,
  `pi.agent` and `pi.usage` documents), then `ops` to apply with `applyImmutable` from `@earendil-works/chord/delta`,
  until `end`. Streaming answers and tool output arrive as ops on `docs["pi.live"]`. After a reconnect, watch again
  with `from` set to the entry after the newest one the client has.
