import { expect, test } from 'claude-code/testing'

const PLUGIN = 'sidebar-for-claude'
const PANE = {
  component: 'Pane',
  requestId: 'sidebar',
  props: { title: 'Sidebar', isFocused: false, bodyColumns: 80, placement: 'dock' },
}

// An in-memory disk standing in for the file system, git (a repo at /repo when `isRepo`) and the session.
const fake = (on: any, isRepo: boolean) => {
  const disk = new Map<string, string>()
  // Commits newest first, each with its time in seconds.
  const opened: string[] = []
  // The line each opened file was opened at.
  const lines: string[] = []
  // Files as git has them by `REV:/path`, the files the last commit changed, what a revert does, and every git call.
  const repo = {
    commits: [['aaaaaaa', 0, 'First commit']] as [string, number, string][],
    blobs: new Map<string, string>(),
    changed: [] as string[],
    revert: (hash: string): { exitCode: number; stderr?: string } => ({ exitCode: 128 }),
    calls: [] as string[],
  }
  const found = (path: string) => {
    const text = disk.get(path)
    if (text === undefined) throw new Error('missing')

    return text
  }
  const done = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('fs.read', ($: unknown, e: any) => ({ value: found(e.path) }))
  on('fs.stat', ($: unknown, e: any) => ({ value: { kind: 'file', size: found(e.path).length, mtimeMs: 0, isLink: false } }))
  on('fs.exists', ($: unknown, e: any) => ({ value: disk.has(e.path) }))
  on('fs.write', ($: unknown, e: any) => {
    disk.set(e.path, e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  // The panes open, as the engine lists them.
  const panes = new Set<string>()
  on('ui.open', ($: unknown, e: any) => {
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: unknown, e: any) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: 'Sidebar', isShown: true, isFocused: false, isPlaced: true })) }))
  on('process.run', ($: unknown, e: any) => {
    if (e.argv[0] === 'printenv') return done(0, '/home/me\n')
    if (!isRepo) return done(128)
    if (e.argv[0] === 'git') repo.calls.push(e.argv.slice(1).join(' '))
    if (e.argv[1] === 'rev-parse') return done(0, '/repo\n')
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      opened.push(e.argv[4])
      lines.push(e.argv[5])

      return done(0, 'the running nvim\n')
    }
    if (e.argv[1] === 'ls-files') return done(0, 'README.md\0src/app.py\0src/lib/util.py\0')
    if (e.argv[1] === 'show') {
      const [rev, path] = e.argv[2].split(':')
      const text = repo.blobs.get(`${rev}:${path.startsWith('./') ? `${e.init?.cwd}/${path.slice(2)}` : `/repo/${path}`}`)

      return text === undefined ? done(128) : done(0, text)
    }
    if (e.argv[1] === 'revert' && e.argv[2] === '--abort') return done(0)
    if (e.argv[1] === 'revert') {
      const { exitCode, stderr = '' } = repo.revert(e.argv[3])

      return { value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === 'diff') return done(0, repo.changed.map(f => `${f}\0`).join(''))
    if (e.argv[1] === 'log' && e.argv[2] === '-1') return done(0, `${repo.commits[0][0]}\0${repo.commits[0][1]}\n`)
    if (e.argv[1] === 'log') return done(0, repo.commits.map(c => `${c.join('\0')}\n`).join(''))
    if (e.argv[1] === 'status') {
      const files = [...disk.keys()].filter(f => f.startsWith('/repo/'))

      return done(0, files.map(f => `?? ${f.slice('/repo/'.length)}\0`).join(''))
    }

    return done(128)
  })

  // Tools whose effect on the disk each call says.
  let effect = () => {}
  for (const tool of ['Bash', 'Write', 'Edit']) {
    on('tool.call', { tool }, () => {
      const result = (effect as () => unknown)()

      return { result: result ?? { stdout: '', stderr: '', interrupted: false } }
    })
  }
  return { disk, repo, opened, lines, panes, setEffect: (change: () => unknown) => (effect = change as () => void) }
}

// The pane, on the files view unless another is named.
const mount = async ($: any, bodyColumns = 80, view = 'files') => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns } } as never)
  await ui.press({ key: `view:${view}` })

  return ui
}

const rows = async (ui: any) =>
  (await ui.findAll({ type: 'Button' })).filter((b: any) => /^toggle:/.test(b.key)).map((b: any) => b.text)

test('edits list newest first, step through time, fold, and show the whole file', async ($, on) => {
  const { disk, repo, setEffect } = fake(on, true)
  const call = async (tool: string, input: object, change: () => unknown) => {
    setEffect(change)
    await $.tool.call({ tool, input } as never)
  }

  await call('Write', { file_path: '/repo/a.py', content: '' }, () => {
    disk.set('/repo/a.py', 'def f():\n    return 1\n')

    return { type: 'create', filePath: '/repo/a.py', content: 'def f():\n    return 1\n', structuredPatch: [], originalFile: null }
  })
  await call('Bash', { command: 'python add_docs.py' }, () => {
    disk.set('/repo/a.py', 'def f():\n    """Return one."""\n    return 1\n')
    disk.set('/repo/b.txt', 'hello\n')
  })
  await call('Bash', { command: 'ls' }, () => {})

  const ui = await mount($)
  expect(await rows(ui)).toEqual(['▸ /repo/b.txt +1 -0 new', '▸ /repo/a.py +3 -0 new (2 edits)'])

  await ui.press({ key: 'toggle:/repo/a.py' })
  const records = (await ui.findAll({ type: 'Button' })).filter((b: any) => /^rec:/.test(b.key))
  expect(records.map((b: any) => b.text.replace(/\d\d:\d\d:\d\d/, 'T'))).toEqual(['● #2 T shell +1 -0', '○ #1 T write +2 -0'])
  const docstring = '@@ -1,2 +1,3 @@\n def f():\n+    """Return one."""\n     return 1'
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(docstring)

  await ui.press({ key: 'older:/repo/a.py' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,2 @@\n+def f():\n+    return 1')
  await ui.press({ key: 'latest:/repo/a.py' })
  await ui.press({ key: 'file:/repo/a.py' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(docstring)
  await ui.press({ key: 'diff:/repo/a.py' })

  await ui.press({ key: records[0].key })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'fold:/repo/a.py' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.press({ key: 'toggle:/repo/a.py' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()

  await call('Bash', { command: 'rm b.txt' }, () => disk.delete('/repo/b.txt'))
  const after = await mount($)
  expect((await rows(after))[0]).toBe('▸ /repo/b.txt +1 -1 deleted (2 edits)')
  await after.unmount()

  // The files view lists each file once; the commits view lists each commit's files under a line naming it.
  const listed = async (ui: any) =>
    (await ui.findAll({ type: 'Text' }))
      .map((t: any) => t.text)
      .filter((t: string) => /^[▸▾] /.test(t))
      .map((t: string) => (/─$/.test(t) ? t.replace(/ ─+$/, '') : t.split(' ')[1]))
  repo.commits.unshift(['bbbbbbb', Date.now() / 1000, 'Add docstring'])
  await call('Bash', { command: 'git commit -am "Add docstring"' }, () => {})
  await call('Bash', { command: "sed -i 's/one/One/' a.py" }, () => {
    disk.set('/repo/a.py', 'def f():\n    """Return One."""\n    return 1\n')
  })
  const committed = await mount($, 40)
  expect(await listed(committed)).toEqual(['/repo/a.py', '/repo/b.txt'])
  await committed.press({ key: 'view:commits' })
  expect(await listed(committed)).toEqual(['▾ uncommitted', '/repo/a.py', '▾ bbbbbbb Add docstring', '/repo/b.txt', '/repo/a.py'])

  // A commit folds its files away behind its line, its name cut to keep the revert button.
  await committed.press({ key: 'commit:bbbbbbb Add docstring' })
  expect(await listed(committed)).toEqual(['▾ uncommitted', '/repo/a.py', '▸ bbbbbbb Add docst… (2 files)'])
  await committed.press({ key: 'commit:bbbbbbb Add docstring' })

  // A file under a commit steps through only that commit's edits, numbered as in its whole history.
  await committed.press({ key: 'toggle:bbbbbbb Add docstring\t/repo/a.py' })
  const picked = (await committed.findAll({ type: 'Button' })).filter((b: any) => /^rec:/.test(b.key))
  expect(picked.map((b: any) => b.text.replace(/\d\d:\d\d:\d\d/, 'T'))).toEqual(['● #2 T shell +1 -0', '○ #1 T write +2 -0'])
  await committed.press({ key: 'view:files' })
  await committed.unmount()

  // Two changes far apart are two hunks, each with up to 3 lines of context.
  const lines = Array.from({ length: 20 }, (_, k) => `line ${k + 1}`)
  await call('Bash', { command: 'generate' }, () => disk.set('/repo/c.txt', `${lines.join('\n')}\n`))
  await call('Bash', { command: 'sed' }, () => {
    const changed = [...lines]
    changed[1] = 'LINE 2'
    changed[17] = 'LINE 18'
    disk.set('/repo/c.txt', `${changed.join('\n')}\n`)
  })
  const view = await mount($)
  await view.press({ key: 'toggle:/repo/c.txt' })
  expect((await view.find({ type: 'Code' }))?.props.source).toBe(
    [
      '@@ -1,5 +1,5 @@', ' line 1', '-line 2', '+LINE 2', ' line 3', ' line 4', ' line 5',
      '@@ -15,6 +15,6 @@', ' line 15', ' line 16', ' line 17', '-line 18', '+LINE 18', ' line 19', ' line 20',
    ].join('\n'),
  )
  await view.unmount()
})

test('outside git, files a shell command names are caught', async ($, on) => {
  const { disk, setEffect } = fake(on, false)
  disk.set('/home/me/notes/todo.txt', 'milk\n')
  disk.set('/home/me/.config/app.conf', 'a = 1\n')
  const bash = async (command: string, change: () => unknown) => {
    setEffect(change)
    await $.tool.call({ tool: 'Bash', input: { command } } as never)
  }

  await bash("cd ~/notes && sed -i 's/milk/oat milk/' todo.txt", () => disk.set('/home/me/notes/todo.txt', 'oat milk\n'))
  await bash('cat >> ~/.config/app.conf <<EOF\nb = 2\nEOF', () => disk.set('/home/me/.config/app.conf', 'a = 1\nb = 2\n'))
  await bash('cd /home/me/notes && echo hi > fresh.md', () => disk.set('/home/me/notes/fresh.md', 'hi\n'))

  const ui = await mount($)
  expect(await rows(ui)).toEqual(['▸ ~/notes/fresh.md +1 -0 new', '▸ ~/.config/app.conf +1 -0', '▸ ~/notes/todo.txt +1 -1'])
  await ui.unmount()
})

test('rows stay on one line and keep the file name in a thin pane', async ($, on) => {
  const { disk, setEffect } = fake(on, false)
  const file = '/home/me/work/some/deeply/nested/folder/register.tsx'
  disk.set(file, 'a\n')
  setEffect(() => {
    disk.set(file, 'b\n')

    return { filePath: file, oldString: 'a', newString: 'b', originalFile: 'a\n', structuredPatch: [] }
  })
  await $.tool.call({ tool: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } } as never)

  for (const [bodyColumns, expected] of [
    [80, '▸ ~/work/some/deeply/nested/folder/register.tsx +1 -1'],
    [30, '▸ …/folder/register.tsx +1 -1'],
    [20, '▸ …/register.tsx'],
    [12, '▸ register…'],
  ] as const) {
    const ui = await mount($, bodyColumns)
    expect((await rows(ui))[0]).toBe(expected)
    await ui.unmount()
  }
})

test('each edit is saved to disk', async ($, on) => {
  const { disk, setEffect } = fake(on, false)
  const saved = '/home/me/.local/share/sidebar-for-claude/s1.json'
  disk.set('/home/me/a.py', 'a\n')
  setEffect(() => {
    disk.set('/home/me/a.py', 'b\n')

    return { filePath: '/home/me/a.py', oldString: 'a', newString: 'b', originalFile: 'a\n', structuredPatch: [] }
  })
  await $.tool.call({ tool: 'Edit', input: { file_path: '/home/me/a.py', old_string: 'a', new_string: 'b' } } as never)

  const list = JSON.parse(disk.get(saved) ?? '[]')
  expect(list.map((x: any) => [x.file, x.before, x.after])).toEqual([['/home/me/a.py', 'a\n', 'b\n']])
})

test('an empty pane gets the saved edits back', async ($, on) => {
  const { disk } = fake(on, false)
  const edit = {
    id: 'x', file: '/home/me/a.py', tool: 'Edit', isNew: false, added: 1, removed: 1, at: 0,
    hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }],
  }
  disk.set('/home/me/.local/share/sidebar-for-claude/s1.json', JSON.stringify([edit]))

  await $.command.run({ command: 'sidebar', args: '' } as never)
  const ui = await mount($)
  expect(await rows(ui)).toEqual(['▸ ~/a.py +1 -1'])
  await ui.unmount()
})

test('the repo tab shows the folder tree and opens a file', async ($, on) => {
  const { disk, opened, setEffect } = fake(on, true)
  const asked: string[] = []
  const toasts: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('prompt.submit', ($: unknown, e: any) => {
    asked.push(e.text)

    return { text: e.text }
  })
  on('ui.toast', ($: unknown, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  disk.set('/repo/src/app.py', 'print(1)\n')
  setEffect(() => {
    disk.set('/repo/src/app.py', 'print(2)\n')

    return { filePath: '/repo/src/app.py', oldString: '1', newString: '2', originalFile: 'print(1)\n', structuredPatch: [] }
  })
  await $.tool.call({ tool: 'Edit', input: { file_path: '/repo/src/app.py', old_string: '1', new_string: '2' } } as never)

  const ui = await mount($)
  await ui.press({ key: 'view:repo' })
  const tree = async () =>
    (await ui.findAll({ type: 'Button' })).filter((b: any) => /^(dir|open):/.test(b.key)).map((b: any) => b.text)
  expect(await tree()).toEqual(['▸ src/ ● 1 edited', '  README.md'])
  await ui.press({ key: 'dir:src' })
  expect(await tree()).toEqual(['▾ src/ ● 1 edited', '  ▸ lib/', '    app.py edited', '  README.md'])
  await ui.press({ key: 'open:src/app.py' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('print(2)\n')

  // An open file's menu opens it in nvim, or asks Claude to explain it.
  await ui.press({ key: 'nvim:src/app.py' })
  expect(opened).toEqual(['/repo/src/app.py'])
  expect(toasts).toEqual(['Opened /repo/src/app.py in the running nvim'])
  await ui.press({ key: 'explain:src/app.py' })
  expect(asked).toEqual(['Explain /repo/src/app.py to me: what it does, how it works, and how it fits into the project.'])
  await ui.press({ key: 'open:src/app.py' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

test('an edit can be asked about and opened at its line', async ($, on) => {
  const { disk, opened, lines, setEffect } = fake(on, true)
  const asked: string[] = []
  on('prompt.submit', ($: unknown, e: any) => {
    asked.push(e.text)

    return { text: e.text }
  })
  const call = async (tool: string, input: object, change: () => unknown) => {
    setEffect(change)
    await $.tool.call({ tool, input } as never)
  }
  await call('Write', { file_path: '/repo/a.py', content: '' }, () => {
    disk.set('/repo/a.py', 'a\nb\nc\n')

    return { type: 'create', filePath: '/repo/a.py', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null }
  })
  await call('Edit', { file_path: '/repo/a.py', old_string: 'c', new_string: 'C' }, () => {
    disk.set('/repo/a.py', 'a\nb\nC\n')

    return { filePath: '/repo/a.py', oldString: 'c', newString: 'C', originalFile: 'a\nb\nc\n', structuredPatch: [] }
  })

  const ui = await mount($)
  await ui.press({ key: 'toggle:/repo/a.py' })
  const text = async (key: string) => (await ui.find({ type: 'Button', key }))?.text

  // Asking why sends the edit's diff along.
  await ui.press({ key: 'why:/repo/a.py' })
  expect(asked[0]).toMatch(/^Why did you make edit #2 to \/repo\/a.py \(at \d\d:\d\d:\d\d\)\?/)
  expect(asked[0]).toContain('```diff\n@@ -1,3 +1,3 @@\n a\n b\n-c\n+C\n```')

  // Opened at the first changed line.
  await ui.press({ key: 'nvim:/repo/a.py' })
  expect([opened, lines]).toEqual([['/repo/a.py'], ['3']])

  await ui.unmount()
})

test('the repo tab shows a file\'s changes since the last commit', async ($, on) => {
  const { disk, repo } = fake(on, true)
  on('session.cwd', () => ({ value: '/repo' }))
  disk.set('/repo/README.md', 'one\ntwo\n')
  repo.blobs.set('HEAD:/repo/README.md', 'one\n')

  const ui = await mount($)
  await ui.press({ key: 'view:repo' })
  await ui.press({ key: 'open:README.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one\ntwo\n')
  await ui.press({ key: 'asdiff:README.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,2 @@\n one\n+two')
  repo.blobs.set('HEAD:/repo/README.md', 'one\ntwo\n')
  await ui.press({ key: 'asdiff:README.md' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'asfile:README.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one\ntwo\n')
  await ui.unmount()
})

test('a commit is reverted on a second press, in a new commit holding the files it puts back', async ($, on) => {
  const { disk, repo, setEffect } = fake(on, true)
  const toasts: string[] = []
  on('ui.toast', ($: unknown, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  disk.set('/repo/a.py', 'a\n')
  setEffect(() => {
    disk.set('/repo/a.py', 'b\n')

    return { filePath: '/repo/a.py', oldString: 'a', newString: 'b', originalFile: 'a\n', structuredPatch: [] }
  })
  await $.tool.call({ tool: 'Edit', input: { file_path: '/repo/a.py', old_string: 'a', new_string: 'b' } } as never)
  const now = Math.floor(Date.now() / 1000)
  repo.commits.unshift(['bbbbbbb', now + 1, 'Change a'])
  setEffect(() => {})
  await $.tool.call({ tool: 'Bash', input: { command: 'git commit -am "Change a"' } } as never)

  const ui = await mount($)
  await ui.press({ key: 'view:commits' })
  const text = async (key: string) => (await ui.find({ type: 'Button', key }))?.text
  const lines = async () =>
    (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).filter((t: string) => /^[▸▾] .* ─+$/.test(t)).map((t: string) => t.replace(/ ─+$/, ''))
  expect(await lines()).toEqual(['▾ bbbbbbb Change a'])

  // Git refusing the revert is aborted and its reason shown.
  repo.revert = () => ({ exitCode: 1, stderr: 'error: your local changes would be overwritten by revert.\n' })
  expect(await text('revert:bbbbbbb Change a')).toBe(' revert')
  await ui.press({ key: 'revert:bbbbbbb Change a' })
  expect(await text('revert:bbbbbbb Change a')).toBe(' press again to revert')
  expect(repo.calls.filter(c => c.startsWith('revert'))).toEqual([])
  await ui.press({ key: 'revert:bbbbbbb Change a' })
  expect(repo.calls.filter(c => c.startsWith('revert'))).toEqual(['revert --no-edit bbbbbbb', 'revert --abort'])
  expect(toasts.at(-1)).toBe("Couldn't revert bbbbbbb: your local changes would be overwritten by revert.")
  expect(await text('revert:bbbbbbb Change a')).toBe(' revert')

  // A clean revert lands as a new commit, its files under it.
  repo.revert = () => {
    disk.set('/repo/a.py', 'a\n')
    repo.commits.unshift(['ccccccc', now + 2, 'Revert "Change a"'])
    repo.changed = ['a.py']
    repo.blobs.set('HEAD~1:/repo/a.py', 'b\n')
    repo.blobs.set('HEAD:/repo/a.py', 'a\n')

    return { exitCode: 0 }
  }
  await ui.press({ key: 'revert:bbbbbbb Change a' })
  await ui.press({ key: 'revert:bbbbbbb Change a' })
  expect(toasts.at(-1)).toBe('Reverted bbbbbbb in a new commit, ccccccc')
  expect(await lines()).toEqual(['▾ ccccccc Revert "Change a"', '▾ bbbbbbb Change a'])
  await ui.press({ key: 'toggle:ccccccc Revert "Change a"\t/repo/a.py' })
  const records = (await ui.findAll({ type: 'Button' })).filter((b: any) => /^rec:/.test(b.key))
  expect(records.map((b: any) => b.text.replace(/\d\d:\d\d:\d\d/, 'T'))).toEqual(['● #2 T revert +1 -1'])
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-b\n+a')
  await ui.unmount()
})

test('the prompts tab groups each prompt\'s files under it, newest first', async ($, on) => {
  const { disk, setEffect } = fake(on, true)
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('prompt.submit', ($: unknown, e: any) => ({ text: e.text }))
  const edit = async (file: string, text: string) => {
    now += 1000
    setEffect(() => {
      disk.set(file, text)

      return { type: 'create', filePath: file, content: text, structuredPatch: [], originalFile: null }
    })
    await $.tool.call({ tool: 'Write', input: { file_path: file, content: text } } as never)
  }
  // Prompts typed at the terminal, as saved: a test can raise only a plugin's.
  disk.set('/home/me/.local/share/sidebar-for-claude/s1.prompts.json', JSON.stringify([
    { text: 'Add a parser', at: 1_002_000 },
    { text: 'Fix the README', at: 1_005_000 },
  ]))

  await edit('/repo/old.py', 'x\n')
  now += 1000
  await edit('/repo/parse.py', 'p\n')
  await edit('/repo/test_parse.py', 't\n')
  now += 1000
  // A plugin's prompt (the why? button's) starts no group of its own.
  await $.prompt.submit({ text: 'Why did you make edit #1 to /repo/parse.py?' } as never)
  await edit('/repo/README.md', 'r\n')
  await $.command.run({ command: 'sidebar', args: '' } as never)

  const ui = await mount($, 80, 'prompts')
  const lines = async () =>
    (await ui.findAll({ type: 'Text' }))
      .map((t: any) => t.text)
      .filter((t: string) => /^[▸▾] /.test(t))
      .map((t: string) => (/─$/.test(t) ? t.replace(/ ─+$/, '').replace(/\d\d:\d\d:\d\d/, 'T') : t.split(' ')[1]))
  expect(await lines()).toEqual([
    '▾ T Fix the README', '/repo/README.md',
    '▾ T Add a parser', '/repo/test_parse.py', '/repo/parse.py',
    '▾ before the first prompt seen', '/repo/old.py',
  ])
  await ui.press({ key: 'commit:prompt:1002000' })
  expect(await lines()).toEqual([
    '▾ T Fix the README', '/repo/README.md', '▸ T Add a parser (2 files)', '▾ before the first prompt seen', '/repo/old.py',
  ])
  // No revert on a prompt's line.
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /^revert:/.test(b.key))).toEqual([])
  await ui.unmount()
})

test('/sidebar opens the pane, closes it when open, and a closed pane stays closed', async ($, on) => {
  const { panes } = fake(on, false)
  on('command.register', () => ({ value: undefined }))
  on('session.start', ($: unknown, e: any) => e)
  await $.session.start({ cwd: '/home/me' } as never)
  expect([...panes]).toEqual(['sidebar'])
  expect(await $.command.run({ command: 'sidebar', args: '' } as never)).toEqual({ text: 'Sidebar closed.' })
  expect([...panes]).toEqual([])
  await $.session.start({ cwd: '/home/me' } as never)
  expect([...panes]).toEqual([])
  expect(await $.command.run({ command: 'sidebar', args: '' } as never)).toEqual({ text: 'Sidebar opened.' })
  expect([...panes]).toEqual(['sidebar'])
})

test('an open prompt shows the whole prompt, how long its turn took and the commands it ran', async ($, on) => {
  const { disk, setEffect } = fake(on, true)
  on('turn.complete', ($: unknown, e: any) => ({ text: e.answer }))
  disk.set('/home/me/.local/share/sidebar-for-claude/s1.prompts.json', JSON.stringify([
    { text: 'Add a parser', at: 1, full: 'Add a parser\nwith tests', commands: ['pytest'], ms: 1000 },
    { text: 'Fix the README', at: 2 },
  ]))
  await $.command.run({ command: 'sidebar', args: '' } as never)

  // The running turn's commands are its prompt's, one line each.
  setEffect(() => disk.set('/repo/README.md', 'r\n'))
  await $.tool.call({ tool: 'Bash', input: { command: 'cd /repo && echo r > README.md' } } as never)
  for (let k = 0; k < 9; k++) await $.tool.call({ tool: 'Bash', input: { command: `\n  ls ${k}\n  pwd` } } as never)

  const ui = await mount($, 80, 'prompts')
  const about = async () =>
    (await ui.findAll({ type: 'Text' }))
      .map((t: any) => t.text)
      .filter((t: string) => !/^([▸▾] |\/| [+-]| new$)/.test(t) && t.trim() && !/^(prompts|files|commits|repo)$/.test(t))
  expect((await about()).slice(0, 10)).toEqual([
    'running… · 10 commands', '$ cd /repo && echo r > README.md', '$ ls 0', '$ ls 1', '$ ls 2', '$ ls 3', '$ ls 4', '$ ls 5', '$ ls 6', '… 2 more',
  ])

  // Its end closes it; a later turn another prompt started (a plugin's) leaves it alone.
  await $.turn.complete({ answer: 'Done.', durationMs: 125_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'Why.', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await $.tool.call({ tool: 'Bash', input: { command: 'git status' } } as never)
  const saved = JSON.parse(disk.get('/home/me/.local/share/sidebar-for-claude/s1.prompts.json')!)
  expect(saved[1].ms).toBe(125_000)
  expect(saved[1].commands.length).toBe(10)
  expect((await about())[0]).toBe('took 2m 5s · 10 commands')

  // A prompt that changed no files is listed too, its whole text under its line.
  expect((await about()).slice(-4)).toEqual(['Add a parser\nwith tests', 'took 1s · 1 command', '$ pytest', 'No file changes.'])
  await ui.unmount()
})
