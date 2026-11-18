# dsh-session-delete

**English** · [中文](README.zh.md) · Companion spec: [dsh-session-layout](https://github.com/wadwaw7/dsh-session-layout)

DeepSeek Harness can archive a session but not delete one: archived logs stay under
`~/.dsh/sessions`, and the session folder inside the project is never touched.
This plugin removes all three sides of a session at once:

1. **Session storage** — `<sessionPersistence.root>/<workspace>/<sessionId>/`
2. **Workspace record** — `workspace.detachSession(id)`, plus removal from `archivedSessionIds`
3. **Project session folder** — the subdirectory under `<cwd>/<session folder>/` whose
   `.session.json` says `provider=dsh` **and** `thread_id === sessionId`

Matching uses `thread_id` only — never the title, never the date — so other sessions in the
same workspace keep their folders. Directories without host metadata, same-id folders created
by another AI, and symlink or junction targets are always preserved.

## How it decides which folder to delete

```text
Session being deleted             project workspace
┌────────────────────┐           ┌──────────────────────────────────────────┐
│ id: session-59f0…  │           │ 会话/                                    │
└─────────┬──────────┘           │ ├─ 2026-11-18-1945-site-audit/           │
          │                      │ │  └─ .session.json                      │
          │  thread_id match     │ │     provider: dsh                      │
          ├─────────────────────▶│ │     thread_id: session-59f0…  ✅ DELETE │
          │                      │ ├─ 2026-11-18-2010-other-task/          │
          │                      │ │  └─ .session.json                      │
          │                      │ │     thread_id: session-77ab…  ✅ KEEP   │
          │                      │ └─ 2026-11-19-manual-notes/             │
          │                      │    └─ (no .session.json)      ✅ KEEP   │
          └──────────────────────┴──────────────────────────────────────────┘
```

## Project layout this plugin expects

```text
<workspace>/
├─ AGENTS.md                        workspace rules shared by every agent
├─ 会话/                            session folders (name configurable)
│  └─ 2026-11-18-1945-site-audit/
│     ├─ .session.json              ← the only thing deletion matches on
│     ├─ 会话说明.md                 notes: goal / decisions / results
│     ├─ 归档索引.md                 table of every artifact produced
│     └─ 证据/                       evidence, backups, one-off scripts
└─ <project-directory>/             product source, build output, real docs
```

The plugin never looks inside `<project-directory>/`: deleting a session cannot touch source
code, as long as process files stay in the session folder.

## Better accuracy with dsh-session-layout

The [dsh-session-layout](https://github.com/wadwaw7/dsh-session-layout) skill defines that
layout. Follow it and deletion becomes both more precise and safer:

| Convention | Effect when deleting |
| --- | --- |
| Every session folder has `.session.json` with the real session id | Exactly one folder is matched |
| Folder names stay `YYYY-MM-DD-HHMM-<topic>`, no session id inside | Name collisions cannot cause a wrong delete; matching is metadata-only |
| Each AI writes its own `provider` | Same-named folders from Codex and others are left untouched |
| Product source lives in the project directory; only process files sit in the session folder | Deleting a session never touches source code |
| One-off scripts live inside the session folder, not the workspace root | Scripts are cleaned up together with the session |

A folder without `.session.json`, or with incomplete metadata, is always kept: the plugin
never guesses. That is precisely where a wrong delete gets blocked. Thirty seconds before
deleting:

```bash
cat "会话/<dir>/.session.json"                             # 1. which session owns this folder
grep -rl '"thread_id": "<sessionId>"' 会话/*/.session.json # 2. any duplicate claim
find "会话/<dir>" -type l                                 # 3. symlinks (deletion is refused)
```

## Entries

| Entry | Behaviour |
| --- | --- |
| Sidebar session row menu → **Delete session** | Confirm, then delete (recommended) |
| `/list-sessions` | List every session: id, title, archived state |
| `/delete-session <sessionId>` | Delete from the command line |
| `/purge-archived` | Remove every archived session |

## Install

### Marketplace (recommended)

Settings → Plugin Marketplace → search `dsh-session-delete` → Install → restart DSH.

### Manual

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-delete" "<this repo>"
```

Then register it in the profile `package.json`. Both entries are required — without the
dependency the Plugin page will not list it:

```json
{
  "dependencies": { "dsh-session-delete": "link:<this repo>" },
  "dsh": { "profile": { "bundles": ["…", "dsh-session-delete"] } }
}
```

## Configuration

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    sessionFolders: ["会话"]   # optional, defaults to ["会话"]
```

## Safety boundaries

- A target that is running, in maintenance, has queued input, or owns related tasks is
  refused; running work is never cancelled automatically.
- Before deleting, the plugin checks load state, the native write lock, unique storage and the
  directory boundary (realpath; symlinks and junctions are refused).
- Folders are staged on the same volume, then the edges (workspace, archive, pin) are
  released, and only then is the staged copy removed. A registry-stage failure rolls the
  folder and its edges back.
- If the final cleanup fails, the staging path and the error are returned — success is never
  reported falsely.

## Implementation

- Host (`lib/index.js`, `lib/lifecycle.js`): injects
  `commands / sessionPersistence / workspaceRegistry / agents / agentLoop / sessions / connection`
  and serves `POST /api/session.delete` (`{ sessionId }` → `{ ok, dirs, local }`). Only the
  native `AgentHandle` captured inside this plugin's lifetime gets `dispose()`, to release the
  write lock.
- Client (`client.js`, ModuleLoader bundle): `ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)`
  with `order: 500`, right after the official Archive entry; reloads the page on success.

## Compatibility

- Targets DSH 0.2.x on both desktop and web profiles.
- Host interfaces are injected; no `@deepseek-ai/*` runtime copy is bundled.

## Disclosure

- No cloud dependency, no outbound data, no API keys stored.
- Local reads and writes only, on session storage and the project's session folders; the
  deletion target is always chosen by the user.

## License

MIT
