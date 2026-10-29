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