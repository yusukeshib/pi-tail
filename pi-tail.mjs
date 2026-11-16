#!/usr/bin/env node
/**
 * pi-tail — live, read-only view of a Pi RPC / JSON event log, rendered with
 * the installed Pi's own TUI components.
 *
 *   pi-tail <file> [--print] [--cwd DIR]
 *
 * The file is the JSONL event stream `pi --mode rpc` (or `pi --mode json`)
 * writes to stdout. Follow mode tails the file until you quit (q / Ctrl-C).
 * --print renders the current transcript once to stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyTerminalSettings, initPiTheme, loadPiEnvironment } from "./pi-environment.mjs";
import { loadPiRuntime } from "./pi-runtime.mjs";
import { createTranscriptView } from "./transcript-view.mjs";

export const USAGE = "Usage: pi-tail <file> [--print] [--cwd DIR]";

export function parseArgs(argv) {
	const options = { print: false, cwd: undefined, target: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--print") options.print = true;
		else if (arg === "--cwd") options.cwd = argv[++index];
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (!options.target) options.target = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return options;
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
 * Render `file` with Pi's components.
 *
 * - `cwd`: directory whose Pi settings, themes and extensions are loaded, and
 *   that tool paths are shown relative to (default: process.cwd()).
 * - `print`: render the current transcript once to stdout and resolve to 0.
 *   Otherwise follow the file until q / Ctrl-C, which exits the process.
 * - `status()`: text shown before the key hints in the status line, refreshed
 *   on every poll (default: the file path).
 */
export async function runViewer({ file, cwd = process.cwd(), print = false, status } = {}) {
	if (!file) throw new Error("runViewer: file is required");
	if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
	const statusPrefix = status ?? (() => file);
	const runtime = await loadPiRuntime();
	// Settings, themes and extension renderers, as Pi loads them for `cwd`.
	const environment = await loadPiEnvironment(runtime, { cwd });
	applyTerminalSettings(runtime, environment);
	const newView = (tui) => createTranscriptView({ runtime, tui, cwd, render: environment.render });

	const decoder = new TextDecoder();
	if (print) {
		initPiTheme(runtime, environment);
		for (const message of environment.diagnostics) process.stderr.write(`${message}\n`);
		const view = newView({ requestRender() {} });
		const reader = createLogReader((event) => view.apply(event));
		reader.push(decoder.decode(fs.readFileSync(file)));
		reader.end();
		const width = process.stdout.columns || 120;
		await new Promise((resolve) => process.stdout.write(`${view.container.render(width).join("\n")}\n`, resolve));
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
	const statusLine = () => {
		const prefix = statusPrefix();
		const hints = `q quit · ctrl+o ${view.expanded ? "collapse" : "expand"} tools · t thinking`;
		statusText.setText(`\x1b[2m${prefix ? `${prefix} · ` : ""}${hints}\x1b[0m`);
	};
	ui.addChild(view.container);
	ui.addChild(statusText);

	let offset = 0;
	const poll = () => {
		const chunk = readFrom(file, offset);
		if (chunk.truncated) {
			// The file was replaced; start over.
			const index = ui.children.indexOf(view.container);
			view = newView(ui);
			reader = createLogReader((event) => view.apply(event));
			ui.children.splice(index, 1, view.container);
		}
		offset = chunk.offset;
		if (chunk.text.length) reader.push(decoder.decode(chunk.text, { stream: true }));
		statusLine();
		ui.requestRender();
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
	if (options.help || !options.target) {
		console.log(USAGE);
		return options.help ? 0 : 2;
	}
	return runViewer({ file: path.resolve(options.target), cwd: options.cwd, print: options.print });
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
if (entry === import.meta.url) runCli(main);
