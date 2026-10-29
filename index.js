import { resolve, sep } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin identity */
export const name = 'agent-memory';
export const inject = ['tools', 'fs', 'subprocess'];
export const Config = z.object({
  memoryPath: z.string().description('Absolute path to the agent memory repo root.'),
});

/** Reject paths that escape the memory root */
function resolveMemoryPath(root, relPath) {
  const full = resolve(root, relPath);
  if (!full.startsWith(root + sep) && full !== root) {
    throw new Error(`Path escapes memory root: ${relPath}`);
  }
  return full;
}

/** JsonSchemaNode for { type: 'text', text: string } — plain frozen object */
const TEXT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    type: Object.freeze({ type: 'string', enum: ['text'] }),
    text: Object.freeze({ type: 'string' }),
  }),
  required: ['type', 'text'],
});

const TEXT_OUTPUT = {
  schema: TEXT_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

/**
 * Run a git command via subprocess.
 * SubprocessOutcome only carries exitCode/signal — NO stdout/stderr.
 * Collection lives on handle.collected (stable after done resolves).
 * Capture text from handle.collected BEFORE destructuring the outcome.
 */
async function git(ctx, cwd, args, signal) {
  const handle = ctx.subprocess.spawn({
    argv: ['git', ...args],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    graceMs: 30_000,
    signal,
  });
  const { exitCode, signal: termSig } = await handle.done;
  const stdoutText = handle.collected.stdout
    ? handle.collected.stdout.readFrom(0).text
    : '';
  if (exitCode !== 0) {
    const stderrText = handle.collected.stderr
      ? handle.collected.stderr.readFrom(0).text
      : '';
    throw new Error(`git ${args.join(' ')} failed (${exitCode}${termSig ? ` [${termSig}]` : ''}): ${stderrText}`);
  }
  return stdoutText;
}

async function assertClean(ctx, root, signal) {
  const status = await git(ctx, root, ['status', '--porcelain'], signal);
  if (status.trim()) throw new Error(`Memory repo has uncommitted changes:\n${status}`);
}

/** Try to run rg; return null if not installed (exitCode 127 = not found).
 * Capture from handle.collected BEFORE destructuring — same reason as git(). */
async function tryRipgrep(ctx, argv, cwd, signal) {
  const rgHandle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    graceMs: 30_000,
    signal,
  });
  const { exitCode } = await rgHandle.done;
  const stdoutText = rgHandle.collected.stdout
    ? rgHandle.collected.stdout.readFrom(0).text
    : '';
  if (exitCode === 127) return null; // rg not found
  if (exitCode !== 0 && exitCode !== 1) {
    const errText = rgHandle.collected.stderr
      ? rgHandle.collected.stderr.readFrom(0).text
      : '';
    throw new Error(`ripgrep failed (${exitCode}): ${errText}`);
  }
  return stdoutText;
}

export function apply(ctx, config) {
  const root = config.memoryPath;

  // --- memory_read ---
  ctx.tools.register({
    name: 'memory_read',
    description: 'Read a file from the agent memory repo. Defaults to MEMORY.md if no path is given.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the memory repo (omit .md for Markdown per the spec).',
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const relPath = args.path
        ? args.path.endsWith('.md') ? args.path : args.path + '.md'
        : 'MEMORY.md';
      const full = resolveMemoryPath(root, relPath);
      const target = await ctx.fs.resolve(full);
      const text = await ctx.fs.readText(target, exec.signal);
      return { type: 'text', text };
    },
  });

  // --- memory_list ---
  ctx.tools.register({
    name: 'memory_list',
    description: 'List files and directories in the agent memory repo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: root).' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const relPath = args.path || '.';
      const full = resolveMemoryPath(root, relPath);
      const target = await ctx.fs.resolve(full);
      const entries = await ctx.fs.listDir(target, exec.signal);
      const lines = entries.map(e => `${e.type === 'directory' ? '[dir] ' : ''}${e.name}`);
      return { type: 'text', text: lines.join('\n') };
    },
  });

  // --- memory_search ---
  ctx.tools.register({
    name: 'memory_search',
    description: 'Search the agent memory repo for a regex pattern.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Regex pattern to search for.' },
        path: { type: 'string', description: 'Optional relative subdirectory to limit scope.' },
      },
      required: ['query'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = args.path ? resolveMemoryPath(root, args.path) : root;
      // Try ripgrep first
      const rgText = await tryRipgrep(ctx, ['rg', '--', args.query, '.'], cwd, exec.signal);
      if (rgText !== null) return { type: 'text', text: rgText };
      // Fallback: use ctx.fs to read and search manually
      const lines = [];
      try {
        const full = resolveMemoryPath(root, args.path || '.');
        const target = await ctx.fs.resolve(full);
        const entries = await ctx.fs.listDir(target, exec.signal);
        const regex = new RegExp(args.query);
        for (const entry of entries) {
          if (entry.type !== 'file') continue;
          try {
            const content = await ctx.fs.readText(entry.target, exec.signal);
            const matched = content.split('\n').filter(l => regex.test(l));
            for (const m of matched) {
              lines.push(`${entry.name}:${m}`);
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // ignore fs errors in fallback
      }
      return { type: 'text', text: lines.join('\n') };
    },
  });

  // --- memory_write ---
  ctx.tools.register({
    name: 'memory_write',
    description: 'Create or overwrite a file in the agent memory repo and commit it.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full UTF-8 text content to write.' },
        path: { type: 'string', description: 'Relative path for the new or existing file.' },
        message: { type: 'string', description: 'Git commit message.' },
      },
      required: ['content', 'path'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      await assertClean(ctx, root, exec.signal);
      const full = resolveMemoryPath(root, args.path);
      const target = await ctx.fs.resolve(full);
      // writeText(target, content, expected?, signal?) — unconditional write omits the intent
      await ctx.fs.writeText(target, args.content, undefined, exec.signal);
      await git(ctx, root, ['add', args.path], exec.signal);
      const msg = args.message || `Write ${args.path}`;
      await git(ctx, root, ['commit', '-m', msg], exec.signal);
      return { type: 'text', text: `Written and committed: ${args.path}` };
    },
  });

  // --- memory_update ---
  ctx.tools.register({
    name: 'memory_update',
    description: 'Append or replace a bullet entry in an existing memory file, then commit.',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The bullet entry (one line, starting with "- ").' },
        message: { type: 'string', description: 'Git commit message.' },
        path: { type: 'string', description: 'Relative path (default: MEMORY.md).' },
        replace_pattern: { type: 'string', description: 'If given, replace the first line containing this text instead of appending.' },
      },
      required: ['entry'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const relPath = args.path || 'MEMORY.md';
      const full = resolveMemoryPath(root, relPath);
      const target = await ctx.fs.resolve(full);
      let text = await ctx.fs.readText(target, exec.signal);
      if (args.replace_pattern) {
        const idx = text.indexOf(args.replace_pattern);
        if (idx === -1) throw new Error(`replace_pattern not found: ${args.replace_pattern}`);
        const end = text.indexOf('\n', idx);
        const rep = end === -1 ? args.entry : args.entry + text.slice(idx + args.entry.length, end);
        text = text.slice(0, idx) + rep + (end === -1 ? '' : text.slice(end));
      } else {
        text = text.trimEnd() + (text.endsWith('\n') ? '' : '\n') + args.entry + '\n';
      }
      await ctx.fs.writeText(target, text, undefined, exec.signal);
      await git(ctx, root, ['add', relPath], exec.signal);
      const msg = args.message || `Update ${relPath}`;
      await git(ctx, root, ['commit', '-m', msg], exec.signal);
      return {
        type: 'text',
        text: args.replace_pattern ? `Replaced matching line in ${relPath}` : `Appended entry to ${relPath}`,
      };
    },
  });

  // --- memory_delete ---
  ctx.tools.register({
    name: 'memory_delete',
    description: 'Remove a file from the agent memory repo and commit the deletion. MEMORY.md cannot be deleted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to delete.' },
        message: { type: 'string', description: 'Git commit message.' },
      },
      required: ['path'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (args.path === 'MEMORY.md') throw new Error('Cannot delete MEMORY.md.');
      await assertClean(ctx, root, exec.signal);
      await git(ctx, root, ['rm', args.path], exec.signal);
      const msg = args.message || `Remove ${args.path}`;
      await git(ctx, root, ['commit', '-m', msg], exec.signal);
      return { type: 'text', text: `Deleted and committed removal of ${args.path}` };
    },
  });
}