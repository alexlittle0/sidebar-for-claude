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
  const repo = { commits: [['aaaaaaa', 0, 'First commit']] as [string, number, string][] }
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', ($: unknown, e: any) => {
    if (e.argv[0] === 'printenv') return done(0, '/home/me\n')
    if (!isRepo) return done(128)
    if (e.argv[1] === 'rev-parse') return done(0, '/repo\n')
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      opened.push(e.argv[4])

      return done(0, 'the running nvim\n')
    }
    if (e.argv[1] === 'ls-files') return done(0, 'README.md\0src/app.py\0src/lib/util.py\0')
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
  return { disk, repo, opened, setEffect: (change: () => unknown) => (effect = change as () => void) }
}

const mount = async ($: any, bodyColumns = 80) =>
  $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns } } as never)

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
  expect(records.map((b: any) => b.text.replace(/\d\d:\d\d:\d\d/, 'T'))).toEqual(['○ #1 T write +2 -0', '● #2 T shell +1 -0'])
  const docstring = '@@ -1,2 +1,3 @@\n def f():\n+    """Return one."""\n     return 1'
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(docstring)

  await ui.press({ key: 'older:/repo/a.py' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,2 @@\n+def f():\n+    return 1')
  await ui.press({ key: 'latest:/repo/a.py' })
  await ui.press({ key: 'file:/repo/a.py' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(docstring)
  await ui.press({ key: 'diff:/repo/a.py' })

  await ui.press({ key: records[1].key })
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

  // A commit folds its files away behind its line.
  await committed.press({ key: 'commit:bbbbbbb Add docstring' })
  expect(await listed(committed)).toEqual(['▾ uncommitted', '/repo/a.py', '▸ bbbbbbb Add docstring (2 files)'])
  await committed.press({ key: 'commit:bbbbbbb Add docstring' })

  // A file under a commit steps through only that commit's edits, numbered as in its whole history.
  await committed.press({ key: 'toggle:bbbbbbb Add docstring\t/repo/a.py' })
  const picked = (await committed.findAll({ type: 'Button' })).filter((b: any) => /^rec:/.test(b.key))
  expect(picked.map((b: any) => b.text.replace(/\d\d:\d\d:\d\d/, 'T'))).toEqual(['○ #1 T write +2 -0', '● #2 T shell +1 -0'])
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
