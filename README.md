# pi-tail

Follow a [Pi](https://github.com/earendil-works/pi) event log and render it the
way Pi renders its own chat, with the installed Pi's TUI components
(`AssistantMessageComponent`, `ToolExecutionComponent`, …).

The input is the JSONL event stream that `pi --mode rpc` or `pi --mode json`
writes to stdout. Save that stream to a file and point `pi-tail` at it, while
the agent is still running or afterwards.

```sh
pi --mode rpc > run.jsonl          # or any process that records Pi's stdout
pi-tail run.jsonl                  # follow live
pi-tail run.jsonl --print          # render once to stdout
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
pi-tail <file> [--print] [--cwd DIR]
```

- Follow mode re-reads the file every 200 ms and starts over if it shrinks.
- Keys: `q` / `Ctrl-C` quit, `Ctrl-O` expand or collapse tool output, `t`
  toggle thinking blocks.
- `--print` renders the current transcript once to stdout.
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
ignored, so a log may carry other records. Reading the stream from stdin is not
supported yet: the terminal UI reads keys from stdin.

## Library

```js
import { runViewer } from "@yusukeshib/pi-tail";

await runViewer({
  file: "/path/to/run.jsonl",
  cwd: "/path/to/project",
  status: () => "worker · running", // shown before the key hints
});
```

`runViewer({ print: true })` resolves to `0` after printing. In follow mode it
resolves once the UI is running, and quitting exits the process.

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
