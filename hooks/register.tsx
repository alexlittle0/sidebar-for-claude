import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Commit, FileEdit, FileFocus, Hunk, Repo } from '../types'

const PANE = 'sidebar'
const MAX_EDITS = 200
const MAX_DIFF_LINES = 400
const MAX_FILE = 1_000_000
const MAX_WATCHED = 100
const SNAPSHOTS_PER_FILE = 20
const MAX_SNAPSHOT = 100_000
const MAX_SAVED = 3_500_000
const WHOLE_FILE = 1_000_000_000
const MAX_REPO_FILES = 20_000
// What a Code element draws at most.
const MAX_SHOWN = 100_000
// Folders a listing outside git skips.
const SKIPPED = ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'dist', 'build', 'target']
const TOOL_LABEL = { Edit: 'edit', Write: 'write', Bash: 'shell' }

const edits = atom({ plugin: 'sidebar-for-claude', key: 'edits' } as const, [])
const expanded = atom({ plugin: 'sidebar-for-claude', key: 'expanded' } as const, [])
const focus = atom({ plugin: 'sidebar-for-claude', key: 'focus' } as const, {} as Record<string, FileFocus>)
const commits = atom({ plugin: 'sidebar-for-claude', key: 'commits' } as const, [] as Commit[])
// The pane lists each file once, the files of each commit, or the whole repository.
const view = atom({ plugin: 'sidebar-for-claude', key: 'view' } as const, 'files' as 'files' | 'commits' | 'repo')
// The commits folded away in the commits view.
const folded = atom({ plugin: 'sidebar-for-claude', key: 'folded' } as const, [] as string[])
const repo = atom({ plugin: 'sidebar-for-claude', key: 'repo' } as const, { root: '', files: [] } as Repo)
// The repository view's open folders, and the file shown in it ('' for none), relative to the root.
const openDirs = atom({ plugin: 'sidebar-for-claude', key: 'openDirs' } as const, [] as string[])
const viewing = atom({ plugin: 'sidebar-for-claude', key: 'viewing' } as const, '')

// A text's lines; a final newline ends the last line rather than starting another.
const toLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// Line diff of two texts as unified hunks with `context` lines around each change.
const diffTexts = (before: string, after: string, context = 3): Hunk[] => {
  const a = toLines(before)
  const b = toLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)

  // Every line of the result, marked ' ', '-' or '+'.
  const ops: string[] = a.slice(0, head).map(l => ` ${l}`)
  if (am.length * bm.length <= 4_000_000) {
    // Longest common subsequence over the changed middle.
    const w = bm.length + 1
    const lcs = new Uint32Array((am.length + 1) * w)
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push(` ${am[i++]}`)
        j++
      } else if (i < am.length && (j === bm.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        ops.push(`-${am[i++]}`)
      } else {
        ops.push(`+${bm[j++]}`)
      }
    }
  } else {
    ops.push(...am.map(l => `-${l}`), ...bm.map(l => `+${l}`))
  }
  ops.push(...a.slice(a.length - tail).map(l => ` ${l}`))

  // Group changes into hunks, merging those close enough to share context.
  const hunks: Hunk[] = []
  let hunk: Hunk | null = null
  let last = -Infinity
  let oldNo = 1
  let newNo = 1
  for (let k = 0; k < ops.length; k++) {
    const isChange = ops[k][0] !== ' '
    if (isChange && (!hunk || k - last > 2 * context)) {
      const from = Math.max(0, k - context, last + context + 1)
      hunk = { oldStart: oldNo - (k - from), newStart: newNo - (k - from), lines: ops.slice(from, k) }
      hunks.push(hunk)
    } else if (isChange && hunk) {
      hunk.lines.push(...ops.slice(last + 1, k))
    } else if (hunk && k - last === context + 1) {
      hunk.lines.push(...ops.slice(last + 1, k))
      hunk = null
    }
    if (isChange) {
      hunk!.lines.push(ops[k])
      last = k
    }
    if (ops[k][0] !== '+') oldNo++
    if (ops[k][0] !== '-') newNo++
  }
  if (hunk) hunk.lines.push(...ops.slice(last + 1, last + 1 + context))

  return hunks
}

// Hunks as diff text, each header's line counts taken from its lines.
const diffSource = (hunks: Hunk[]) =>
  hunks
    .map(h => {
      const del = h.lines.filter(l => l[0] === '-').length
      const ins = h.lines.filter(l => l[0] === '+').length
      const ctx = h.lines.length - del - ins

      // An empty side is numbered from the line before it, as unified diffs do.
      const oldStart = ctx + del === 0 ? h.oldStart - 1 : h.oldStart
      const newStart = ctx + ins === 0 ? h.newStart - 1 : h.newStart

      return `@@ -${oldStart},${ctx + del} +${newStart},${ctx + ins} @@\n${h.lines.join('\n')}`
    })
    .join('\n')

const clockTime = (at: number) => {
  const d = new Date(at)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const shortPath = (file: string) => file.replace(/^\/home\/[^/]+/, '~')

// Fits a path into `room` columns: drops leading folders first ("…/app/main.py"),
// then cuts the file name itself only when even that alone cannot fit.
const fitPath = (file: string, room: number) => {
  const full = shortPath(file)
  if (full.length <= room) return full
  const parts = full.split('/')
  const name = parts.pop()!
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const tail = ['…', ...parts.slice(parts.length - keep), name].join('/')
    if (tail.length <= room) return tail
  }
  if (name.length <= room) return name

  return `${name.slice(0, Math.max(1, room - 1))}…`
}

// `rel` resolved against `base`, `~/` against `home`, with `.` and `..` folded away.
const resolvePath = (base: string, home: string, rel: string) => {
  const full = rel.startsWith('~/') ? `${home}/${rel.slice(2)}` : rel.startsWith('/') ? rel : `${base}/${rel}`
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '' && part !== '.') out.push(part)
  }

  return `/${out.join('/')}`
}

let home = ''

const getHome = async ($: EngineInterface) => {
  if (!home) {
    const run = await $.process.run(['printenv', 'HOME']).catch(() => null)
    home = run?.exitCode === 0 ? run.stdout.trim() : ''
  }

  return home
}

// What git reports as changed or new in the repository holding `dir`: absolute path → status code.
const gitChanged = async ($: EngineInterface, dir: string) => {
  const changed = new Map<string, string>()
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], dir ? { cwd: dir } : undefined)
    if (top.exitCode !== 0) return changed
    const root = top.stdout.trim()
    const status = await $.process.run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root })
    if (status.exitCode !== 0) return changed
    const parts = status.stdout.split('\0')
    for (let k = 0; k < parts.length; k++) {
      if (parts[k].length < 4) continue
      const code = parts[k].slice(0, 2)
      changed.set(`${root}/${parts[k].slice(3)}`, code)
      // A rename or copy is followed by its source path.
      if (code[0] === 'R' || code[0] === 'C') k++
    }
  } catch {
    // Not a git repository, or no git.
  }

  return changed
}

// The file's text, or null when it is missing, too large or binary.
const readText = async ($: EngineInterface, file: string) => {
  try {
    if ((await $.fs.stat(file)).size > MAX_FILE) return null
    const text = await $.fs.read(file)

    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

// The file as git last committed it, or '' when git does not have it.
const committed = async ($: EngineInterface, file: string) => {
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const run = await $.process.run(['git', 'show', `HEAD:./${file.split('/').pop()}`], { cwd: dir }).catch(() => null)

  return run?.exitCode === 0 ? run.stdout : ''
}

// Reads the commits made since the first tracked edit in the repository holding `file`, timed by git.
const checkCommit = async ($: EngineInterface, file: string) => {
  const list = await read($, edits)
  if (list.length === 0) return
  const since = Math.min(...list.map(edit => edit.at))
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir }).catch(() => null)
  if (top?.exitCode !== 0) return
  const root = top.stdout.trim()
  const log = await $.process.run(['git', 'log', '-50', '--format=%h%x00%ct%x00%s'], { cwd: root }).catch(() => null)
  if (log?.exitCode !== 0) return
  const found = log.stdout
    .split('\n')
    .filter(line => line.includes('\0'))
    .map(line => {
      const [hash, time, subject] = line.split('\0')

      return { commit: `${hash} ${subject}`, root, at: Number(time) * 1000 }
    })
    .filter(c => c.at >= since)
  const was = (await read($, commits)).filter(c => c.root === root)
  if (JSON.stringify(was.map(c => c.commit)) === JSON.stringify(found.map(c => c.commit).reverse())) return
  await update($, commits, cur => [...cur.filter(c => c.root !== root), ...found.reverse()])
}

const savePath = async ($: EngineInterface) => {
  const id = await $.session.id().catch(() => '')
  const dir = await getHome($)

  return dir && id ? `${dir}/.local/share/sidebar-for-claude/${id}.json` : ''
}

// Records one change to a file: its diff, line counts and (while small) the whole file before and after.
const record = async (
  $: EngineInterface,
  change: { id: string; tool: FileEdit['tool']; file: string; isNew: boolean; isDeleted?: boolean },
  before: string | null,
  after: string | null,
  fallback: Hunk[] = [],
) => {
  // A commit made since the last check lands before this edit.
  await checkCommit($, change.file)
  const all = before !== null && after !== null ? diffTexts(before, after) : fallback
  const edit: FileEdit = { ...change, added: 0, removed: 0, hunks: [], at: await $.clock.now().catch(() => Date.now()) }
  let kept = 0
  for (const hunk of all) {
    edit.added += hunk.lines.filter(l => l[0] === '+').length
    edit.removed += hunk.lines.filter(l => l[0] === '-').length
    // Whole hunks only, so the diff view can always parse them.
    if (kept + hunk.lines.length <= MAX_DIFF_LINES || edit.hunks.length === 0) {
      edit.hunks.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: hunk.lines.slice(0, MAX_DIFF_LINES) })
      kept += hunk.lines.length
    }
  }
  // State holds plain JSON: absent fields are left out, never undefined.
  if (before !== null && before.length <= MAX_SNAPSHOT) edit.before = before
  if (after !== null && after.length <= MAX_SNAPSHOT) edit.after = after

  await update($, edits, list => {
    const next = [...list, edit].slice(-MAX_EDITS)
    // Older edits of the same file give up their snapshots.
    let seen = 0
    for (let k = next.length - 1; k >= 0; k--) {
      if (next[k].file === edit.file && ++seen > SNAPSHOTS_PER_FILE) {
        const { before: _b, after: _a, ...rest } = next[k]
        next[k] = rest
      }
    }

    return next
  })

  // Saved to disk too, so nothing that empties the pane loses them.
  try {
    const path = await savePath($)
    const list = await read($, edits)
    let text = JSON.stringify(list)
    if (text.length > MAX_SAVED) text = JSON.stringify(list.map(({ before: _b, after: _a, ...rest }) => rest))
    if (path) await $.fs.write(path, text)
  } catch {
    // The pane works without it.
  }
}

// Puts the saved edits back when the pane's history is empty.
// Checks each folder holding tracked files once.
const checkCommits = async ($: EngineInterface) => {
  const folders = new Map<string, string>()
  for (const edit of await read($, edits)) folders.set(edit.file.slice(0, edit.file.lastIndexOf('/')), edit.file)
  for (const file of folders.values()) await checkCommit($, file)
}

const restore = async ($: EngineInterface) => {
  if ((await read($, edits)).length > 0) return
  try {
    const path = await savePath($)
    if (!path || !(await $.fs.exists(path))) return
    const saved = JSON.parse(await $.fs.read(path))
    if (Array.isArray(saved) && saved.length > 0) {
      await update($, edits, cur => (cur.length > 0 ? cur : saved.slice(-MAX_EDITS)))
    }
  } catch {
    // Nothing to restore.
  }
}

// ---- Repository view ----

// Lists the files of the repository Claude was started in: git's own list (ignored files left out), else every file.
const scan = async ($: EngineInterface) => {
  try {
    const cwd = await $.session.cwd()
    if (!cwd) return
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => null)
    const isGit = top?.exitCode === 0
    const root = isGit ? top.stdout.trim() : cwd
    const skip = SKIPPED.map(name => `-name '${name}'`).join(' -o ')
    const listing = isGit
      ? await $.process.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
      : await $.process.run(['sh', '-c', `find . -type d \\( ${skip} \\) -prune -o -type f -print0 | head -z -n ${MAX_REPO_FILES}`], { cwd: root })
    if (listing.exitCode !== 0) return
    const files = [...new Set(listing.stdout.split('\0').filter(Boolean).map(f => f.replace(/^\.\//, '')))]
      .slice(0, MAX_REPO_FILES)
      .sort()
    const was = await read($, repo)
    if (was.root === root && was.files.join('\0') === files.join('\0')) return
    await update($, repo, () => ({ root, files }))
  } catch {
    // No folder to list.
  }
}

// Opens `$1` in the running nvim whose folder holds it most closely, bringing its tmux pane forward;
// with none, in a new tmux pane, else a new kitty window. Prints where.
const OPEN_IN_NVIM = `
f="$1"; run="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; best=""; bestlen=-1
for s in "$run"/nvim.*.0; do
  [ -S "$s" ] || continue
  pid=\${s##*/nvim.}; pid=\${pid%.0}
  cwd=$(readlink "/proc/$pid/cwd") || continue
  case "$f" in "$cwd"/*) len=\${#cwd} ;; *) len=0 ;; esac
  if [ "$len" -gt "$bestlen" ]; then best=$s; bestpid=$pid; bestlen=$len; fi
done
if [ -n "$best" ]; then
  # :edit, not --remote, which adds the file to the argument list and makes :q say "E173: 1 more file to edit".
  quoted=$(printf '%s' "$f" | sed "s/'/''/g")
  nvim --server "$best" --remote-expr "execute('edit ' . fnameescape('$quoted'))" >/dev/null || exit 1
  if [ -n "$TMUX" ]; then
    panes=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}')
    p=$bestpid
    for i in 1 2 3 4 5 6 7 8; do
      pane=$(printf '%s\\n' "$panes" | awk -v p="$p" '$1 == p { print $2 }')
      if [ -n "$pane" ]; then tmux select-window -t "$pane"; tmux select-pane -t "$pane"; break; fi
      p=$(awk '{ print $4 }' "/proc/$p/stat" 2>/dev/null)
      [ "\${p:-0}" -gt 1 ] || break
    done
  fi
  echo "the running nvim"; exit 0
fi
if [ -n "$TMUX" ]; then tmux split-window -h nvim "$f" && echo "a new tmux pane" && exit 0; fi
setsid -f kitty nvim "$f" >/dev/null 2>&1 && echo "a new kitty window"
`

const openInNvim = async ($: EngineInterface, file: string) => {
  const ran = await $.process.run(['sh', '-c', OPEN_IN_NVIM, 'sh', file]).catch(() => null)
  const where = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  $.ui.toast(where ? `Opened ${shortPath(file)} in ${where}` : `Couldn't open ${shortPath(file)} in nvim`)
}

// ---- Hooks ----

export const register: Register = on => {
  // Last known text of each file the pane shows.
  const known = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await restore($)
    await checkCommits($).catch(() => {})
    await $.command.register({ name: 'sidebar', description: 'Show the sidebar: files Claude edited, by file or commit, and the whole repository' })
    void $.ui.open({ id: PANE, title: 'Sidebar' })

    return next(e)
  })

  on('command.run', { command: 'sidebar' }, async $ => {
    await restore($)
    await checkCommits($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Sidebar' })

    return { text: 'Sidebar opened.' }
  })

  // Bash can change files too (sed, scripts, mv): snapshot the files it might touch, compare after.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const before = new Map<string, string | null>()
    // Files the command names that do not exist yet: it may create them.
    const missing = new Set<string>()
    let dirty = new Map<string, string>()
    let dir = ''
    try {
      const command = String(e.input.command ?? '')
      const homeDir = await getHome($)
      dir = await $.session.cwd().catch(() => '')
      const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(command)
      if (cd && (dir || cd[1].startsWith('/') || cd[1].startsWith('~/'))) {
        dir = resolvePath(dir, homeDir, cd[1].replace(/^["']|["']$/g, ''))
      }
      dirty = await gitChanged($, dir)

      // Words with a slash or a file extension are taken as file paths.
      const named: string[] = []
      for (const word of command.split(/[\s"'`;|&()<>=,]+/)) {
        if (named.length >= 50) break
        if (!/^[\w.~@+/-]+$/.test(word) || word.startsWith('-') || word.includes('//')) continue
        if (!word.includes('/') && !/\.[A-Za-z0-9]{1,10}$/.test(word)) continue
        if (/^[./]+$/.test(word)) continue
        if (word.startsWith('~') ? !homeDir || !word.startsWith('~/') : !word.startsWith('/') && !dir) continue
        named.push(resolvePath(dir, homeDir, word))
      }
      for (const file of named) if (!(await $.fs.exists(file).catch(() => true))) missing.add(file)

      const watch = new Set([...known.keys(), ...named.filter(f => !missing.has(f)), ...dirty.keys()].slice(0, MAX_WATCHED))
      for (const file of watch) before.set(file, known.get(file) ?? (await readText($, file)))
    } catch {
      // Never let the tracker break the command itself.
    }

    const ran = await next(e)

    try {
      const after = await gitChanged($, dir)
      const files = new Set([...before.keys(), ...missing, ...[...after.keys()].filter(f => !dirty.has(f))])
      let n = 0
      for (const file of files) {
        let old = before.get(file)
        if (old === undefined) {
          // Created by the command, or newly changed: compare against git's copy.
          const code = after.get(file) ?? '?'
          old = missing.has(file) || code.includes('?') || code.includes('A') ? '' : await committed($, file)
        }
        const now = await readText($, file)
        const id = `${e.tool_use_id}:${n++}`
        if (now === null) {
          if (old === null || old === '' || (await $.fs.exists(file).catch(() => true))) continue
          known.delete(file)
          await record($, { id, tool: 'Bash', file, isNew: false, isDeleted: true }, old, '')
        } else if (old !== null && now !== old) {
          known.set(file, now)
          await record($, { id, tool: 'Bash', file, isNew: old === '' && !before.has(file) }, old, now)
        }
      }

      // The command may have committed, or changed the repository's files.
      await checkCommits($)
      if ((await read($, view)) === 'repo') await scan($)
    } catch {
      // As above.
    }

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || (e.tool !== 'Edit' && e.tool !== 'Write')) return ran

    try {
      const r = ran.result as {
        type?: 'create' | 'update'
        filePath: string
        content?: string
        originalFile: string | null
        structuredPatch: Hunk[]
        staged?: boolean
      }
      if (r.staged) return ran
      const isNew = r.type === 'create'
      const before = isNew ? '' : (r.originalFile ?? known.get(r.filePath) ?? null)
      const after = r.content ?? (await readText($, r.filePath))
      await record($, { id: e.tool_use_id, tool: e.tool, file: r.filePath, isNew }, before, after, r.structuredPatch)
      if (after !== null) known.set(r.filePath, after)
      if (isNew && (await read($, view)) === 'repo') await scan($)
    } catch {
      // Never let the tracker break the edit itself.
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, edits)
    const by = await read($, view)
    // One column spare so a row never touches the edge and wraps.
    const columns = Math.max(4, (e.props.bodyColumns ?? 40) - 1)

    const tab = (name: 'files' | 'commits' | 'repo') => (
      <Button
        key={`view:${name}`}
        plain
        onPress={async () => {
          await update($, view, () => name)
          if (name === 'repo') await scan($)
        }}
      >
        <Text bold={by === name} dimColor={by !== name} underline={by === name}>{name}</Text>
      </Button>
    )
    const tabs = (
      <Box flexWrap="nowrap">
        {tab('files')}
        <Text> </Text>
        {tab('commits')}
        <Text> </Text>
        {tab('repo')}
      </Box>
    )

    if (by === 'repo') {
      const { root, files: all } = await read($, repo)
      if (!root) {
        return (
          <Box flexDirection="column">
            {tabs}
            <Text dimColor>Listing the repository…</Text>
          </Box>
        )
      }
      const dirs = await read($, openDirs)
      const shown = await read($, viewing)
      const edited = new Set(list.map(edit => edit.file))

      // Each folder's folders and files, '' the root.
      const inside = new Map<string, { dirs: Set<string>; files: string[] }>()
      const at = (dir: string) => {
        if (!inside.has(dir)) inside.set(dir, { dirs: new Set(), files: [] })

        return inside.get(dir)!
      }
      at('')
      for (const file of all) {
        const parts = file.split('/')
        for (let k = 1; k < parts.length; k++) at(parts.slice(0, k - 1).join('/')).dirs.add(parts.slice(0, k).join('/'))
        at(parts.slice(0, -1).join('/')).files.push(file)
      }

      // The shown file's text, cut to what a Code element draws.
      let source: string | null = null
      if (shown) source = await readText($, `${root}/${shown}`)
      const isCut = source !== null && source.length > MAX_SHOWN
      if (source !== null && isCut) source = source.slice(0, source.lastIndexOf('\n', MAX_SHOWN))

      // Folders first then files, each open folder's insides under it.
      const rows: JSX.Element[] = []
      const walk = (dir: string, depth: number) => {
        const indent = '  '.repeat(depth)
        for (const sub of [...at(dir).dirs].sort()) {
          const isOpen = dirs.includes(sub)
          const changed = [...edited].filter(file => file.startsWith(`${root}/${sub}/`)).length
          rows.push(
            <Button
              key={`dir:${sub}`}
              plain
              onPress={() => update($, openDirs, cur => (cur.includes(sub) ? cur.filter(d => d !== sub) : [...cur, sub]))}
            >
              <Text wrap="truncate-end">
                {indent}
                {isOpen ? '▾' : '▸'} <Text color="suggestion">{sub.split('/').pop()}/</Text>
                {changed > 0 && <Text color="warning"> ●</Text>}
                {changed > 0 && <Text dimColor> {changed} edited</Text>}
              </Text>
            </Button>,
          )
          if (isOpen) walk(sub, depth + 1)
        }
        for (const file of at(dir).files) {
          const isShown = file === shown
          const isEdited = edited.has(`${root}/${file}`)
          rows.push(
            <Button key={`open:${file}`} plain onPress={() => update($, viewing, cur => (cur === file ? '' : file))}>
              <Text wrap="truncate-end" bold={isShown}>
                {indent}  <Text color={isEdited ? 'warning' : undefined}>{file.split('/').pop()}</Text>
                {isEdited && <Text dimColor> edited</Text>}
              </Text>
            </Button>,
          )
          if (isShown) {
            rows.push(
              <Box key={`show:${file}`} flexDirection="column" paddingLeft={depth * 2 + 2}>
                <Box flexWrap="nowrap">
                  <Button key={`nvim:${file}`} plain onPress={() => openInNvim($, `${root}/${file}`)}>
                    <Text color="suggestion">open in nvim</Text>
                  </Button>
                  <Text dimColor> │ </Text>
                  <Button
                    key={`explain:${file}`}
                    plain
                    onPress={() =>
                      $.prompt.submit({
                        text: `Explain ${root}/${file} to me: what it does, how it works, and how it fits into the project.`,
                      })
                    }
                  >
                    <Text color="suggestion">explain</Text>
                  </Button>
                </Box>
                {source === null && <Text dimColor>Not shown: binary, over {MAX_FILE / 1_000_000} MB, or missing.</Text>}
                {source !== null && <Code source={source} path={file} startLine={1} />}
                {isCut && <Text dimColor>… cut at {MAX_SHOWN / 1000}k characters</Text>}
              </Box>,
            )
          }
        }
      }
      walk('', 0)

      return (
        <Box flexDirection="column">
          {tabs}
          <Text bold wrap="truncate-end">
            {fitPath(root, columns - 12)} <Text dimColor>{all.length} files</Text>
          </Text>
          {rows}
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>No edits yet. Files Claude changes will show up here.</Text>
        </Box>
      )
    }
    const open = await read($, expanded)
    const focused = await read($, focus)
    const shut = await read($, folded)
    // A commit's line, pressed to fold its files away or back.
    const breakLine = (label: string, count: number) => {
      const isShut = shut.includes(label)
      const text = `${isShut ? '▸' : '▾'} ${label}${isShut ? ` (${count} file${count === 1 ? '' : 's'})` : ''}`

      return (
        <Button
          key={`commit:${label}`}
          plain
          onPress={() => update($, folded, cur => (cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]))}
        >
          <Text dimColor wrap="truncate-end">{`${text} ${'─'.repeat(Math.max(0, columns - text.length - 1))}`}</Text>
        </Button>
      )
    }

    // Groups edits by file, the most recently edited first.
    const group = (some: FileEdit[]) => {
      const byFile = new Map<string, FileEdit[]>()
      for (const edit of some) {
        const fileEdits = byFile.get(edit.file) ?? []
        byFile.delete(edit.file)
        byFile.set(edit.file, [...fileEdits, edit])
      }

      return [...byFile.entries()].reverse()
    }
    const files = group(list)
    // Each edit's number in its file's whole history, and the file's copy before it.
    const number = new Map<string, number>()
    const previous = new Map<string, string | undefined>()
    for (const [, fileEdits] of files) {
      fileEdits.forEach((edit, k) => {
        number.set(edit.id, k + 1)
        previous.set(edit.id, fileEdits[k - 1]?.after)
      })
    }

    // The rows to show: each file once, or each commit's files under a line naming it.
    type Row = { key: string; file: string; fileEdits: FileEdit[]; bucket?: string; header?: number }
    let rows: Row[] = files.map(([file, fileEdits]) => ({ key: file, file, fileEdits }))
    if (by === 'commits') {
      // An edit belongs to the first commit after it in its repository; later edits are uncommitted.
      const all = (await read($, commits)).sort((a, b) => a.at - b.at)
      const buckets = new Map<string, FileEdit[]>()
      for (const edit of list) {
        const commit = all.find(c => edit.file.startsWith(`${c.root}/`) && c.at >= edit.at)
        const label = commit ? commit.commit : 'uncommitted'
        buckets.set(label, [...(buckets.get(label) ?? []), edit])
      }
      const labels = [...buckets.keys()].sort((a, b) => {
        const time = (label: string) => (label === 'uncommitted' ? Infinity : all.find(c => c.commit === label)!.at)

        return time(b) - time(a)
      })
      rows = labels.flatMap(label =>
        group(buckets.get(label)!).map(([file, fileEdits], k, all) => ({
          key: `${label}\t${file}`, file, fileEdits, bucket: label, header: k === 0 ? all.length : undefined,
        })),
      )
    }

    const setFocus = (file: string, change: Partial<FileFocus>) =>
      update($, focus, cur => ({ ...cur, [file]: { mode: 'diff', ...cur[file], ...change } }))
    const toggle = (file: string) =>
      update($, expanded, cur => (cur.includes(file) ? cur.filter(f => f !== file) : [...cur, file]))

    return (
      <Box flexDirection="column">
        {tabs}
        {rows.map(({ key, file, fileEdits, bucket, header }) => {
          // A folded commit shows only its line.
          if (bucket !== undefined && shut.includes(bucket)) return header !== undefined && breakLine(bucket, header)
          const isOpen = open.includes(key)
          const added = fileEdits.reduce((n, x) => n + x.added, 0)
          const removed = fileEdits.reduce((n, x) => n + x.removed, 0)
          const latest = fileEdits[fileEdits.length - 1]
          const tag = latest.isDeleted ? ' deleted' : fileEdits[0].isNew ? ' new' : ''

          // Extras are dropped, least important first, until the file name fits on one line.
          const name = file.split('/').pop()!
          const stats = ` +${added} -${removed}`
          const count = fileEdits.length > 1 ? ` (${fileEdits.length} edits)` : ''
          let room = columns - 2 - name.length
          const showStats = stats.length <= room
          if (showStats) room -= stats.length
          const showTag = showStats && tag.length <= room
          if (showTag) room -= tag.length
          const showCount = showTag && count.length <= room
          if (showCount) room -= count.length
          const path = fitPath(file, room + name.length)

          // The chosen edit (the latest unless picked) and how it is shown.
          const at = focused[key]
          const found = fileEdits.findIndex(x => x.id === at?.id)
          const idx = found === -1 ? fileEdits.length - 1 : found
          const edit = fileEdits[idx]
          const mode = at?.mode ?? 'diff'
          const isHidden = at?.isHidden === true
          const isLatest = idx === fileEdits.length - 1
          // Picking another edit shows it; picking the shown one again folds it away.
          const pick = (k: number) =>
            setFocus(key, k === idx ? { isHidden: !isHidden } : { id: fileEdits[k].id, isHidden: false })

          let view = <Text dimColor>No textual changes.</Text>
          if (mode === 'diff' && edit.hunks.length > 0) {
            view = <Code source={diffSource(edit.hunks)} format="diff" path={file} />
          } else if (mode === 'file' && edit.isDeleted) {
            view = <Text dimColor>The file was deleted in this edit.</Text>
          } else if (mode === 'file' && edit.after === undefined) {
            view = <Text dimColor>No copy of the whole file was kept for this edit (only the last {SNAPSHOTS_PER_FILE} edits of a file, up to {MAX_SNAPSHOT / 1000}k characters).</Text>
          } else if (mode === 'file' && edit.after !== undefined) {
            // The whole file right after the edit, its changed lines marked.
            const before = edit.before ?? previous.get(edit.id)
            const whole = before === undefined ? [] : diffTexts(before, edit.after, WHOLE_FILE)
            view = whole.length > 0
              ? <Code source={diffSource(whole)} format="diff" path={file} />
              : <Code source={edit.after} path={file} startLine={1} />
          }

          return (
            <Box key={`f:${key}`} flexDirection="column">
              {bucket !== undefined && header !== undefined && breakLine(bucket, header)}
              <Button key={`toggle:${key}`} plain onPress={() => toggle(key)}>
                <Text wrap="truncate-end">
                  {isOpen ? '▾' : '▸'} <Text bold={isOpen}>{path}</Text>
                  {showStats && <Text color="success"> +{added}</Text>}
                  {showStats && <Text color="error"> -{removed}</Text>}
                  {showTag && <Text color={latest.isDeleted ? 'error' : 'suggestion'}>{tag}</Text>}
                  {showCount && <Text dimColor>{count}</Text>}
                </Text>
              </Button>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2}>
                  {fileEdits.map((one, k) => (
                    <Button key={`rec:${one.id}`} plain onPress={() => pick(k)}>
                      <Text wrap="truncate-end" bold={k === idx} dimColor={k !== idx}>
                        {k === idx ? '●' : '○'} #{number.get(one.id)} {clockTime(one.at)} {TOOL_LABEL[one.tool]}
                        <Text color="success"> +{one.added}</Text>
                        <Text color="error"> -{one.removed}</Text>
                        {one.isDeleted && <Text color="error"> deleted</Text>}
                      </Text>
                    </Button>
                  ))}
                  <Box flexWrap="nowrap">
                    <Button key={`fold:${key}`} plain onPress={() => setFocus(key, { isHidden: !isHidden })}>
                      <Text dimColor>{isHidden ? '▸ show' : '▾ hide'}</Text>
                    </Button>
                    <Text dimColor> │ </Text>
                    {idx > 0 ? <Button key={`older:${key}`} label="◀" plain onPress={() => pick(idx - 1)} /> : <Text dimColor>◀</Text>}
                    <Text> </Text>
                    {!isLatest ? <Button key={`newer:${key}`} label="▶" plain onPress={() => pick(idx + 1)} /> : <Text dimColor>▶</Text>}
                    <Text> </Text>
                    {!isLatest ? (
                      <Button key={`latest:${key}`} label="latest" plain onPress={() => pick(fileEdits.length - 1)} />
                    ) : (
                      <Text dimColor>latest</Text>
                    )}
                    <Text dimColor> │ </Text>
                    <Button key={`diff:${key}`} plain onPress={() => setFocus(key, { mode: 'diff', isHidden: false })}>
                      <Text bold={mode === 'diff'} dimColor={mode !== 'diff'} underline={mode === 'diff'}>diff</Text>
                    </Button>
                    <Text> </Text>
                    <Button key={`file:${key}`} plain onPress={() => setFocus(key, { mode: 'file', isHidden: false })}>
                      <Text bold={mode === 'file'} dimColor={mode !== 'file'} underline={mode === 'file'}>file</Text>
                    </Button>
                  </Box>
                  {!isHidden && view}
                  {!isHidden && mode === 'diff' && edit.hunks.reduce((n, h) => n + h.lines.length, 0) >= MAX_DIFF_LINES && (
                    <Text dimColor>… diff cut at {MAX_DIFF_LINES} lines</Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
