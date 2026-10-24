export type Hunk = { oldStart: number; newStart: number; lines: string[] }

export type FileEdit = {
  id: string
  file: string
  tool: 'Edit' | 'Write' | 'Bash'
  isNew: boolean
  isDeleted?: boolean
  added: number
  removed: number
  hunks: Hunk[]
  // When it was recorded, ms since the epoch.
  at: number
  // The repository's commit at the time, "a1b2c3d Subject", when the file is in one.
  commit?: string
  // The whole file just before and just after, kept for recent edits only.
  before?: string
  after?: string
}

export type FileFocus = { id?: string; mode: 'diff' | 'file'; isHidden?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'edit-tracker-for-claude': { edits: FileEdit[]; expanded: string[]; focus: Record<string, FileFocus>; heads: Record<string, string> }
  }
}
