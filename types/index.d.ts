export type Hunk = { oldStart: number; newStart: number; lines: string[] }

export type FileEdit = {
  id: string
  file: string
  tool: 'Edit' | 'Write' | 'Bash' | 'Revert'
  isNew: boolean
  isDeleted?: boolean
  added: number
  removed: number
  hunks: Hunk[]
  // When it was recorded, ms since the epoch.
  at: number
  // The whole file just before and just after, kept for recent edits only.
  before?: string
  after?: string
}

// A commit seen landing in a repository holding tracked files.
export type Commit = { commit: string; root: string; at: number }

// The files of the repository Claude was started in, relative to its root.
export type Repo = { root: string; files: string[]; isGit?: boolean }

// A prompt that started a turn: its first line, the whole of it when longer, the shell commands the turn ran,
// and once the turn ended, how long it took and whether it was interrupted.
export type Prompt = { text: string; at: number; full?: string; commands?: string[]; ms?: number; isAborted?: boolean }

export type FileFocus = { id?: string; mode: 'diff' | 'file'; isHidden?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'sidebar-for-claude': {
      edits: FileEdit[]; expanded: string[]; focus: Record<string, FileFocus>; commits: Commit[]; view: 'prompts' | 'files' | 'commits' | 'repo'; folded: string[]
      repo: Repo; openDirs: string[]; viewing: string; viewingDiff: boolean; arming: string; prompts: Prompt[]; isClosed: boolean
    }
  }
}
