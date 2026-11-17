#!/usr/bin/env node
/**
 * pi-tail — live, read-only view of a Pi RPC / JSON event log, rendered with
 * the installed Pi's own TUI components.
 *
 *   pi-tail [-f] [-n N] [--cwd DIR] [file]
 *
 * The file is the JSONL event stream `pi --mode rpc` (or `pi --mode json`)
 * writes to stdout. Like tail(1): without -f the transcript is rendered once
 * to stdout (the last 10 lines; -n N / -n +N as in tail); with no file or `-` it is read from
 * stdin. -f follows the file in Pi's TUI until you quit (q / Ctrl-C).
 */
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyTerminalSettings, initPiTheme, loadPiEnvironment } from "./pi-environment.mjs";
import { loadPiRuntime } from "./pi-runtime.mjs";
import { createTranscriptView } from "./transcript-view.mjs";

export const USAGE = "Usage: pi-tail [-f] [-n N] [--cwd DIR] [file]";

/** tail(1) line count: `N` (last N lines) or `+N` (from line N on). */
function lineCount(value) {
	if (!/^[+-]?\d+$/.test(value ?? "")) throw new Error(`Invalid line count: ${value}`);
	return value.startsWith("+") ? value : Math.abs(Number(value));
}

/** Apply a tail(1) line count (see lineCount) to rendered lines. */
export function selectLines(rendered, lines) {
	if (lines === undefined) return rendered;
	if (typeof lines === "string") return rendered.slice(Math.max(Number(lines.slice(1)) - 1, 0));
	return lines === 0 ? [] : rendered.slice(-lines);
}

export const DEFAULT_LINES = 10;

export function parseArgs(argv) {
	const options = { follow: false, lines: undefined, cwd: undefined, target: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "-f" || arg === "--follow") options.follow = true;
		else if (arg === "-n" || arg === "--lines") options.lines = lineCount(argv[++index]);
		else if (/^-n[+-]?\d+$/.test(arg)) options.lines = lineCount(arg.slice(2));
		else if (arg.startsWith("--lines=")) options.lines = lineCount(arg.slice("--lines=".length));
		else if (arg === "--cwd") options.cwd = argv[++index];
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg !== "-" && arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		else if (options.target === undefined) options.target = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	if (options.follow && options.lines !== undefined) throw new Error("-n cannot be combined with -f");
	if (options.follow && (options.target === undefined || options.target === "-")) {
		throw new Error("-f needs a file: the terminal UI reads keys from stdin");
	}
	return options;
}

function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
		process.stdin.on("error", reject);
	});
}

/**
 * Incremental JSONL reader: feed text, get parsed event objects. Lines that are
 * not JSON objects are skipped, and a trailing `\r` (a PTY's line ending) is
 * ignored.
 */
export function createLogReader(onEvent) {
	let pending = "";
	const line = (raw) => {
		const text = raw.replace(/\r$/, "").trim();
		if (!text.startsWith("{")) return;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			return;
		}
		onEvent(event);
	};
	return {
		push(chunk) {
			pending += chunk;
			let newline;
			while ((newline = pending.indexOf("\n")) >= 0) {
				line(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
			}
		},
		end() {
			if (pending) line(pending);
			pending = "";
		},
	};
}

function readFrom(file, offset) {
	const size = fs.statSync(file).size;
	if (size <= offset) return { text: "", offset: size < offset ? 0 : offset, truncated: size < offset };
	const buffer = Buffer.alloc(size - offset);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buffer, 0, buffer.length, offset);
	} finally {
		fs.closeSync(fd);
	}
	return { text: buffer, offset: size, truncated: false };
}

function readRange(fd, start, end) {
	const buffer = Buffer.alloc(end - start);
	fs.readSync(fd, buffer, 0, buffer.length, start);
	return buffer;
}

/**
 * Events the transcript can start from without losing anything after them:
 * a run, or a user / assistant message (an assistant message carries its own
 * tool calls; a tool result message does not, so it is not a boundary).
 */
function isBoundary(text) {
	if (!/"type"\s*:\s*"(agent_start|message_start)"/.test(text)) return false;
	try {
		const event = JSON.parse(text.replace(/\r$/, ""));
		return event.type === "agent_start" || (event.type === "message_start" && ["user", "assistant"].includes(event.message?.role));
	} catch {
		return false;
	}
}

/**
 * The last `count` rendered lines of a log file, like tail(1) without reading
 * the whole file: render from the latest event boundary near the end and move
 * the start back (reading more of the file when needed) until the rendering has
 * more lines than requested, so the cut never lands on the first component's
 * leading spacing. `renderText(text)` renders log text to lines.
 */
export function tailRenderedLines(file, count, renderText, { chunkSize = 256 * 1024 } = {}) {
	if (count === 0) return [];
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		let start = size;
		let text = "";
		// Byte offsets (within `text`) of boundary lines, latest last.
		let boundaries = [];
		let tried = 0;
		for (let window = chunkSize; ; window *= 4) {
			const newStart = Math.max(0, size - window);
			if (newStart < start) {
				const more = readRange(fd, newStart, start).toString("utf8");
				// Begin on a whole line; the partial first line is read next round.
				const cut = newStart === 0 ? 0 : more.indexOf("\n") + 1;
				const head = cut === 0 && newStart > 0 ? "" : more.slice(cut);
				const found = [];
				for (let at = 0; at < head.length; ) {
					const newline = head.indexOf("\n", at);
					const end = newline < 0 ? head.length : newline;
					if (isBoundary(head.slice(at, end).trim())) found.push(at);
					at = end + 1;
				}
				boundaries = [...found, ...boundaries.map((offset) => offset + head.length)];
				text = head + text;
				start = newStart + Buffer.byteLength(more.slice(0, cut));
				if (head === "") start = newStart + Buffer.byteLength(more);
			}
			// Try 1, 2, 4, ... boundaries back from the end.
			for (let back = Math.max(1, tried * 2); back <= boundaries.length; back *= 2) {
				tried = back;
				const rendered = renderText(text.slice(boundaries[boundaries.length - back]));
				if (rendered.length > count) return rendered.slice(-count);
			}
			if (start === 0 || newStart === 0) return renderText(text).slice(-count);
		}
	} finally {
		fs.closeSync(fd);
	}
}

export function createViewerInputListener({ tui, getView, quit, onChange }) {
	const key = (data, name) => tui.matchesKey?.(data, name) ?? false;
	return (data) => {
		// Input listeners run before Pi's focused-component key-release filter.
		// Toggle once per press, not again on release or while holding the key.
		if (tui.isKeyRelease?.(data) || tui.isKeyRepeat?.(data)) return { consume: true };
		if (key(data, "q") || key(data, "ctrl+c") || data === "q" || data === "\x03") quit();
		else if (key(data, "ctrl+o") || data === "\x0f") {
			const view = getView();
			view.setToolsExpanded(!view.expanded);
		} else if (key(data, "t") || data === "t") getView().toggleThinking();
		else return { consume: true };
		onChange();
		return { consume: true };
	};
}

/**
 * Render a Pi event log with Pi's components.
 *
 * - `file`: the log. Without `follow`, omit it to read stdin.
 * - `cwd`: directory whose Pi settings, themes and extensions are loaded, and
 *   that tool paths are shown relative to (default: process.cwd()).
 * - `follow`: follow the file in Pi's TUI until q / Ctrl-C, which exits the
 *   process. Otherwise render once to stdout and resolve to 0.
 * - `lines`: without `follow`, print only the last N rendered lines (a
 *   number; only the end of the file is read), or from line N on ("+N").
 *   Undefined prints everything. The CLI defaults to 10, like tail(1).
 * - `status()`: text shown before the key hints in the status line, refreshed
 *   on every poll (default: the file path).
 */
export async function runViewer({ file, cwd = process.cwd(), follow = false, lines, status } = {}) {
	if (follow && !file) throw new Error("runViewer: follow needs a file");
	if (file && !fs.existsSync(file)) throw new Error(`No such file: ${file}`);
	const statusPrefix = status ?? (() => file);
	const runtime = await loadPiRuntime();
	// Settings, themes and extension renderers, as Pi loads them for `cwd`.
	const environment = await loadPiEnvironment(runtime, { cwd });
	applyTerminalSettings(runtime, environment);
	const newView = (tui) => createTranscriptView({ runtime, tui, cwd, render: environment.render });

	let decoder = new TextDecoder();
	if (!follow) {
		initPiTheme(runtime, environment);
		for (const message of environment.diagnostics) process.stderr.write(`${message}\n`);
		const width = process.stdout.columns || 120;
		const renderText = (text) => {
			const view = newView({ requestRender() {} });
			const reader = createLogReader((event) => view.apply(event));
			reader.push(text);
			reader.end();
			return view.container.render(width);
		};
		const rendered =
			file && typeof lines === "number"
				? tailRenderedLines(file, lines, renderText)
				: selectLines(renderText(decoder.decode(file ? fs.readFileSync(file) : await readStdin())), lines);
		if (rendered.length === 0) return 0;
		await new Promise((resolve) => process.stdout.write(`${rendered.join("\n")}\n`, resolve));
		return 0;
	}

	const { Container, ProcessTerminal, Spacer, Text } = runtime.tui;
	// Pi >= 1.5 renders regular (scrollback) mode with TuiMainScreen; older
	// pi-tui releases export the TUI class itself.
	const Screen = runtime.tui.TuiMainScreen ?? runtime.tui.TUI;
	if (typeof Screen !== "function") throw new Error("Unsupported pi-tui: no TuiMainScreen or TUI export");
	const settingsManager = environment.settingsManager;
	const ui = new Screen(
		new ProcessTerminal(),
		settingsManager?.getShowHardwareCursor?.(),
		runtime.agent.getAgentDir?.(),
	);
	if (settingsManager?.getClearOnShrink) ui.setClearOnShrink?.(settingsManager.getClearOnShrink());
	const theme = initPiTheme(runtime, environment, ui);
	if (environment.diagnostics.length > 0) {
		const diagnostics = new Container();
		for (const message of environment.diagnostics) diagnostics.addChild(new Text(`\x1b[31m${message}\x1b[0m`, 1, 0));
		diagnostics.addChild(new Spacer(1));
		ui.addChild(diagnostics);
	}
	let view = newView(ui);
	let reader = createLogReader((event) => view.apply(event));
	const statusText = new Text("", 1, 0);
	let statusValue;
	/** Refresh the status line; true when its text changed. */
	const statusLine = () => {
		const prefix = statusPrefix();
		const hints = `q quit · ctrl+o ${view.expanded ? "collapse" : "expand"} tools · t thinking`;
		const value = `\x1b[2m${prefix ? `${prefix} · ` : ""}${hints}\x1b[0m`;
		if (value === statusValue) return false;
		statusValue = value;
		statusText.setText(value);
		return true;
	};
	ui.addChild(view.container);
	ui.addChild(statusText);

	let offset = 0;
	const poll = () => {
		const chunk = readFrom(file, offset);
		if (chunk.truncated) {
			// The file was replaced; start over.
			const index = ui.children.indexOf(view.container);
			decoder = new TextDecoder();
			view = newView(ui);
			reader = createLogReader((event) => view.apply(event));
			ui.children.splice(index, 1, view.container);
		}
		offset = chunk.offset;
		if (chunk.text.length) reader.push(decoder.decode(chunk.text, { stream: true }));
		// Polling an idle file must not re-render the whole transcript.
		const statusChanged = statusLine();
		if (chunk.truncated || chunk.text.length || statusChanged) ui.requestRender();
	};

	const quit = () => {
		clearInterval(timer);
		ui.stop();
		process.exit(0);
	};
	ui.addInputListener(createViewerInputListener({
		tui: runtime.tui,
		getView: () => view,
		quit,
		onChange() {
			statusLine();
			ui.requestRender();
		},
	}));

	poll();
	ui.start();
	theme.start();
	const timer = setInterval(poll, 200);
	return undefined;
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	// Without a file, read stdin, unless it is a terminal nobody is piping into.
	if (options.help || (options.target === undefined && process.stdin.isTTY)) {
		console.log(USAGE);
		return options.help ? 0 : 2;
	}
	const file = options.target === undefined || options.target === "-" ? undefined : path.resolve(options.target);
	// Like tail(1): the last 10 lines unless -n says otherwise.
	const lines = options.follow ? undefined : (options.lines ?? DEFAULT_LINES);
	return runViewer({ file, cwd: options.cwd, follow: options.follow, lines });
}

/** Run `run()` as a CLI entry point: exit with its code, or keep following. */
export function runCli(run) {
	run().then(
		(code) => {
			// Loaded extensions may keep timers alive; a finished one-shot run exits.
			if (typeof code === "number") process.exit(code);
		},
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}

const entry = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
	// Pi's module graph is large; cache its compiled code across runs (Node >= 22.1).
	module.enableCompileCache?.();
	runCli(main);
}
