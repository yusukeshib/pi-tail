# pi-tail

Follow a [Pi](https://github.com/earendil-works/pi) event log and render it the
way Pi renders its own chat, with the installed Pi's TUI components
(`AssistantMessageComponent`, `ToolExecutionComponent`, …).

The input is the JSONL event stream that `pi --mode rpc` or `pi --mode json`
writes to stdout. The interface follows tail(1).

```sh
pi --mode json -p "Summarize README.md" > run.jsonl
pi-tail run.jsonl                  # the last 10 rendered lines
pi-tail -n 40 run.jsonl            # the last 40 rendered lines
pi-tail -n +1 run.jsonl            # the whole transcript
pi-tail -f run.jsonl               # follow live in Pi's TUI
pi --mode json -p "hi" | pi-tail   # read stdin
```

## Install

```sh
npm install -g @yusukeshib/pi-tail
```

Pi itself is not bundled. The Pi packages are loaded from, in order:

1. `PI_TAIL_PI_PACKAGE_DIR` (a `@earendil-works/pi-coding-agent` package directory)
2. the managed install (`~/.pi/agent/install/current-version`, or under `PI_CODING_AGENT_DIR`)
3. the `pi` on `PATH`
4. `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` resolvable from pi-tail

So the transcript is rendered by the same Pi release that you run.

## Usage

```
pi-tail [-f] [-n N] [--cwd DIR] [file]
```

- Without `-f`, the transcript is rendered once to stdout. With no file or
  `-`, the log is read from stdin until EOF.
- `-n N` / `--lines N` / `-nN` prints the last N rendered lines (default 10,
  as in tail(1)); `-n +N` prints from rendered line N on. For a file and
  `-n N`, only the end of the log is read: rendering starts at the latest run
  or message near the end and moves back until it fills N lines.
- `-f` / `--follow` follows the file in Pi's TUI. It re-reads the file every
  200 ms and starts over if it shrinks. Keys: `q` / `Ctrl-C` quit, `Ctrl-O`
  expand or collapse tool output, `t` toggle thinking blocks. `-f` needs a
  file (the TUI reads keys from stdin) and cannot be combined with `-n`.
- `--cwd DIR` is the agent's working directory (default: the current
  directory). It decides which Pi settings, themes and extensions are loaded,
  and tool paths are shown relative to it.

pi-tail sets up the environment the way Pi's interactive mode does for that
directory: settings (global and, for a trusted project, project), themes from
`settings.themes` and packages, terminal colors, keybindings, and the
extensions' tool, message and Markdown renderers. Extensions are loaded but no
session starts, so their session handlers never run; missing packages are
skipped, never installed; a project that Pi has not been told to trust is
loaded without its project-local resources.

Lines that are not JSON objects and event types pi-tail does not render are
ignored, so a log may carry other records.

## Library

```js
import { runViewer } from "@yusukeshib/pi-tail";

await runViewer({
  file: "/path/to/run.jsonl",
  cwd: "/path/to/project",
  follow: true,
  status: () => "worker · running", // shown before the key hints
});
```

Without `follow`, `runViewer` prints (the last `lines` lines, or from line
`"+N"` on, if given; everything otherwise; stdin
when `file` is omitted) and resolves to `0`. With `follow` it resolves once the
UI is running, and quitting exits the process.

Lower-level pieces are exported too: `createTranscriptView` (apply events,
read `.container`), `createLogReader`, `loadPiRuntime`, `loadPiEnvironment`,
`initPiTheme`, `applyTerminalSettings`, `createViewerInputListener`.

The event-to-component mapping mirrors Pi's interactive mode but is a separate
implementation, and it uses Pi's component APIs, so a Pi release that changes
them may need a pi-tail update.

## Development

```sh
bun test
```

Tests load the installed Pi (see Install).

## License

MIT
