# sidebar-for-claude

A side pane for Claude Code: the files Claude edited with their diffs, grouped by the prompt that caused them, by file or by commit, and a browser for the whole repo.

```
/plugin install sidebar-for-claude --marketplace alexlittle0/sidebar-for-claude
```

- **prompts**: each prompt you sent, with how long its turn took, the shell commands it ran and the files it changed
- **files**: each file Claude changed, stepping through its edits as diffs or whole files
- **commits**: the same files under the commit that took them in; a commit's line reverts it with `git revert`
- **repo**: the repository's file tree; open a file to read it, see its diff against HEAD, open it in nvim or ask Claude to explain it

`/sidebar` opens or closes the pane.
