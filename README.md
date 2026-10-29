# agent-memory

> Git-backed persistent memory tools for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/harness) agents — so sessions remember context across turns.

## What it does

This DSH Cordis plugin exposes **6 tools** that let an agent read, write, search, and manage a git repository of notes and docs. Every write operation auto-commits with a message, turning memory into a browsable, diff-able, rollback-able history. The agent-memory repo follows the [Agent Memory Repo spec](https://github.com/agentmemoryrepo/agentmemoryrepo).

```
memory_read    — read a file  (defaults to MEMORY.md)
memory_list    — list files/dirs in a subdirectory
memory_search  — regex search across the repo  (ripgrep if available, JS fallback)
memory_write   — write a file and git-commit it
memory_update  — append or replace a bullet line in a .md file and commit
memory_delete  — git-rm and commit  (MEMORY.md is protected)
```

---

## Tools reference

| Tool | Required args | Optional args |
|------|--------------|---------------|
| `memory_read` | — | `path` — relative path (`.md` appended if omitted; default: `MEMORY.md`) |
| `memory_list` | — | `path` — subdirectory to list (default: repo root) |
| `memory_search` | `query` (regex) | `path` — limit to subdirectory |
| `memory_write` | `content`, `path` | `message` — commit message (default: `Write <path>`) |
| `memory_update` | `entry` (bullet line) | `path` (default: `MEMORY.md`), `message`, `replace_pattern` — find-and-replace first matching line |
| `memory_delete` | `path` | `message` — commit message (default: `Remove <path>`) |

**`memory_delete` cannot remove `MEMORY.md`** — this is enforced at the plugin level.

---

## Installation

### 1. Install the bundle

In the DSH plugin manager (GUI or CLI), install `@local/agent-memory`.  
If your profile doesn't already have it:

```
# In DSH profile package.json, add the dependency
npm install @local/agent-memory --save
```

### 2. Point to your memory repo

Edit your profile's `cordis.patch.yml` (or equivalent DSH config) and set the `memoryPath` to your agent-memory git repository:

```yaml
# cordis.patch.yml (profile-level)
- insert:
    - id: agent-memory
      name: '@local/agent-memory'
      config:
        memoryPath: 'C:\Users\You\agent-memory'   # ← your absolute path
```

Or when registering the bundle, pass `memoryPath` in the config dict.

### 3. Ensure the memory repo is a git repo

```sh
# If you don't have one yet:
git init ~/agent-memory
echo "# Memory" > ~/agent-memory/MEMORY.md
git -C ~/agent-memory add MEMORY.md
git -C ~/agent-memory commit -m "Initial commit"
```

Set your git identity **inside the memory repo** (not globally) so agents' commits are attributed correctly:

```sh
git config user.name "Your Name"
git config user.email "you@example.com"
```

### 4. Restart DSH

Restart the harness (or reload the profile) for the plugin to activate.

---

## Memory repo structure

```
agent-memory/
├── .git/                   # git history — every write is a commit
├── MEMORY.md               # primary index; protected from deletion
└── *.md                    # topic files, bullet cross-references [[path]]
```

The repo must be **clean** (no uncommitted changes) before any `memory_write` or `memory_delete` call. This prevents accidental overwrites if two agents write simultaneously.

---

## Requirements

| Dependency | Notes |
|------------|-------|
| `git` on `PATH` | Used for every read/write operation |
| `@deepseek-ai/schemastery` | Required by `Config` schema; included as plugin dep |
| `ripgrep` (`rg`) on `PATH` | Optional — speeds up `memory_search`; falls back to JS if not found |

> **Windows note:** `rg` is available via `winget install BurntSushi.ripgrep-Windows` or download from [github.com/BurntSushi/ripgrep/releases](https://github.com/BurntSushi/ripgrep/releases).

---

## Security

- **Path escape is blocked.** Every file operation resolves the requested path and rejects it if it escapes the configured `memoryPath`. You cannot read, write, or delete files outside the memory root.
- **No uncommitted overwrites.** `memory_write` and `memory_delete` require a clean working tree first — concurrent writes would fail fast.
- **MEMORY.md is immutable** via this plugin. Use `memory_update` to edit it.

---

## How writes work (git flow)

```
memory_write / memory_update / memory_delete
  → require clean working tree (git status --porcelain)
  → perform fs operation
  → git add <file>          # never git add -A
  → git commit -m "<msg>"
```

The `git add <file>` (not `-A`) ensures only the intended file is staged — no accidental extra files.

---

## Automation examples

These are real agent workflows — how the 6 tools chain together for persistent, multi-session tasks.

---

### 1. Session startup (run every new conversation)

```json
[
  {
    "tool": "memory_list",
    "args": { "path": "." }
  },
  {
    "tool": "memory_read",
    "args": {}
  }
]
```

`memory_list` confirms the repo is reachable. `memory_read` with no args loads `MEMORY.md` — the agent's first action in every session per the spec. Add both to your agent's **system prompt bootstrap** so every conversation starts from memory without being asked.

---

### 2. Log a discovered fact or fix

```json
[
  {
    "tool": "memory_search",
    "args": { "query": "pipelines" }
  },
  {
    "tool": "memory_update",
    "args": {
      "entry": "- **OpenMontage pipelines** now working — venv at `Skills/OpenMontage/.venv/`, piper TTS voices still missing",
      "path": "MEMORY.md",
      "replace_pattern": "OpenMontage pipelines*"
    }
  }
]
```

`memory_search` checks whether the topic already exists before writing. If found, `memory_update` with `replace_pattern` updates the line in-place; if not found it appends instead. Every call auto-commits — the history shows exactly when and what was learned.

---

### 3. Track a pending task across sessions

```json
[
  {
    "tool": "memory_write",
    "args": {
      "path": "tasks/openmontage-setup.md",
      "content": "# OpenMontage Setup\n\n## Status\n- [x] Python 3.12 venv created\n- [x] piper-tts installed in venv\n- [ ] Download voices: `python -m piper.download_voices`\n\n## Notes\nCreated .env from .env.example. remotion-composer/node_modules kept (271MB) for rendering.\n",
      "message": "Track openmontage setup task"
    }
  }
]
```

`memory_write` creates topic files alongside `MEMORY.md`. Use `tasks/` as a subdirectory to separate live work from the index. When the task is done, use `memory_update` to check off items — the file stays, the history shows the evolution.

---

### 4. Save web research to the memory repo

```json
[
  {
    "tool": "memory_write",
    "args": {
      "path": "research/ripgrep-cli-research.md",
      "content": "# ripgrep CLI research\n\nDate: 2026-10-29\n\n## Source\nhttps://github.com/BurntSushi/ripgrep/releases/tag/15.2.0\n\n## Key findings\n- rg 15.2.0 requires no runtime deps on Windows\n- Install via `winget install BurntSushi.ripgrep-Windows`\n- Alternative: download zip from GitHub releases and add to PATH\n\n## Decision\nUse winget for easy upgrade path. Added to user PATH at `C:\\Users\\You\\bin\\rg\\rg.exe`.\n",
      "message": "Save ripgrep research findings"
    }
  },
  {
    "tool": "memory_update",
    "args": {
      "entry": "- `rg` 15.2.0 research: winget install path, no runtime deps (2026-10-29)",
      "message": "Link research in MEMORY.md"
    }
  }
]
```

First call creates the research file. Second call appends a link in `MEMORY.md` so the index points to the detail — the pattern is **small index, big files**.

---

### 5. Bullet-line TODOs in a file (append or replace)

```json
[
  {
    "tool": "memory_update",
    "args": {
      "entry": "- [ ] Download piper-tts voices (`python -m piper.download_voices` in OpenMontage venv)",
      "path": "tasks/openmontage-setup.md"
    }
  }
]
```

`memory_update` with only `entry` and `path` appends. With `replace_pattern` it does a find-and-replace on the first line containing that text — useful for updating a line that was already written.

```json
[
  {
    "tool": "memory_update",
    "args": {
      "entry": "- [x] Download piper-tts voices",
      "path": "tasks/openmontage-setup.md",
      "replace_pattern": "[ ] Download piper-tts"
    }
  }
]
```

---

### 6. Multi-session bug triage

```json
[
  {
    "tool": "memory_read",
    "args": { "path": "bugs/pending" }
  },
  {
    "tool": "memory_write",
    "args": {
      "path": "bugs/triage-2026-10-29.md",
      "content": "# Bug Triage — 2026-10-29\n\n## Memory plugin\n- Path escape blocking: verified working ✅\n- Clean-tree guard: verified working ✅\n- schemastery dep resolution: fixed by npm install in plugin dir ✅\n\n## REA (reverse-engineer-anything)\n- `npx rea-agents setup` not run yet — CLI fallback works fine\n",
      "message": "Log bug triage session"
    }
  }
]
```

`memory_read` at the start shows current state. `memory_write` creates a dated session log. Over time `bugs/` accumulates a timeline you can `memory_search` for patterns.

---

### 7. Write and schedule a future reminder

```json
[
  {
    "tool": "memory_update",
    "args": {
      "entry": "- **TODO 2026-11-05**: Run `python -m piper.download_voices` in OpenMontage venv — unblocks TTS",
      "message": "Schedule piper voices reminder for next week"
    }
  }
]
```

`memory_update` appends a dated bullet to `MEMORY.md`. On the scheduled date, the agent reads `MEMORY.md` and picks up the pending item — no external scheduler needed.

---

### 8. Full session wrap-up pattern

A complete end-of-session routine:

```json
[
  { "tool": "memory_read",  "args": {} },
  { "tool": "memory_list",  "args": {} },
  { "tool": "memory_search", "args": { "query": "Pending|TODO|tasks/" } },
  { "tool": "memory_update", "args": {
      "entry": "- **2026-10-29**: Plugin installed, all 6 tools verified, pushed to GitHub",
      "message": "Session wrap-up: plugin install session"
  }}
]
```

Running this at the end of every session ensures the next agent picks up exactly where this one left off.

---

## Uninstall

Remove the bundle from your profile:

```sh
# Remove from profile package.json
npm uninstall @local/agent-memory
```

The memory repo at `memoryPath` is untouched — it's just a directory on disk.

---

## File layout

```
agent-memory-plugin/        ← this repo
├── index.js                # plugin source (274 lines)
├── package.json            # npm package
├── cordis.patch.yml        # DSH Loader patch (config: memoryPath)
├── icon.svg                # plugin icon
└── locale/
    └── en.json             # i18n meta
```

---

## License

MIT — do whatever you want with it. Attribution welcome.