import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runLegacy } from "./legacy";
import {
	CONFIG_FILE,
	ConfigError,
	loadConfig,
	type Project,
	type ProjectConfig,
	ROSETTA_DIR,
} from "./project/config";
import {
	buildConfig,
	detectProject,
	importLingo,
	renderConfig,
} from "./project/init";
import { JsoncError } from "./project/jsonc";
import { LockfileError } from "./project/lock";
import { PathResolutionError } from "./project/paths";
import {
	type CheckResult,
	check,
	type LocaleResult,
	type PushResult,
	plan,
	purge,
	push,
} from "./project/workflow";
import { RosettaRequestError } from "./rosetta";
import type { Translator } from "./types";

/** Exit codes — see docs/spec-v1.md §11. */
export const EXIT = { ok: 0, failed: 1, usage: 2, stale: 3 } as const;

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface CliIO {
	cwd: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Whether prompts are possible (stdin is a TTY). */
	interactive: boolean;
	confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
	/** Inject a translation engine (tests). */
	translator?: Translator;
}

// ---------------------------------------------------------------------------
// Argument parsing

type FlagKind = "boolean" | "value" | "list";

const GLOBAL_FLAGS: Record<string, FlagKind> = {
	config: "value",
	json: "boolean",
	quiet: "boolean",
	help: "boolean",
};

const COMMAND_FLAGS: Record<string, Record<string, FlagKind>> = {
	init: {
		"from-lingo": "boolean",
		source: "value",
		target: "list",
		pattern: "list",
		model: "value",
		yes: "boolean",
	},
	push: {
		locale: "list",
		key: "list",
		force: "boolean",
		yes: "boolean",
		estimate: "boolean",
		"dry-run": "boolean",
		"backfill-missing": "boolean",
	},
	check: { locale: "list" },
	status: { locale: "list", "exit-code": "boolean" },
	purge: { locale: "value", yes: "boolean" },
	pull: {},
};

const POSITIONALS = new Set(["push", "check", "status"]);
const ALIASES: Record<string, string> = { y: "yes", h: "help", v: "version" };

export interface ParsedArgs {
	command: string | undefined;
	positionals: string[];
	flags: Record<string, string | string[] | boolean>;
}

export function parseCli(argv: string[]): ParsedArgs {
	const args = [...argv];
	const flags: ParsedArgs["flags"] = {};
	const positionals: string[] = [];
	let command: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("-") || arg === "-") {
			if (!command) command = arg;
			else positionals.push(arg);
			continue;
		}
		if (arg === "--version" || arg === "-v") {
			flags.version = true;
			continue;
		}

		let name = arg.startsWith("--")
			? arg.slice(2)
			: (ALIASES[arg.slice(1)] ?? arg.slice(1));
		let inline: string | undefined;
		const eq = name.indexOf("=");
		if (eq !== -1) {
			inline = name.slice(eq + 1);
			name = name.slice(0, eq);
		}
		const kind =
			GLOBAL_FLAGS[name] ??
			(command ? COMMAND_FLAGS[command]?.[name] : undefined);
		if (!kind) {
			throw new UsageError(
				command
					? `Unknown flag "${arg}" for \`rosetta ${command}\`. See \`rosetta ${command} --help\`.`
					: `Unknown flag "${arg}". See \`rosetta --help\`.`,
			);
		}
		if (kind === "boolean") {
			if (inline !== undefined)
				throw new UsageError(`${arg} doesn't take a value.`);
			flags[name] = true;
			continue;
		}
		const value = inline ?? args[++i];
		if (
			value === undefined ||
			(inline === undefined && value.startsWith("-"))
		) {
			throw new UsageError(`Missing value for --${name}.`);
		}
		if (kind === "list") {
			const list = (flags[name] as string[] | undefined) ?? [];
			list.push(
				...value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean),
			);
			flags[name] = list;
		} else {
			flags[name] = value;
		}
	}

	if (command && !COMMAND_FLAGS[command] && command !== "translate-catalog") {
		throw new UsageError(
			`Unknown command "${command}". See \`rosetta --help\`.`,
		);
	}
	if (command && positionals.length > 0 && !POSITIONALS.has(command)) {
		throw new UsageError(
			`\`rosetta ${command}\` doesn't take arguments (got "${positionals[0]}").`,
		);
	}
	return { command, positionals, flags };
}

const list = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.length > 0 ? value : undefined;

// ---------------------------------------------------------------------------
// Help

const HELP: Record<string, string> = {
	main: `rosetta — free, open-source, self-run localization (a DIY Lingo.dev)

Usage: rosetta <command> [options]

Commands:
  init      Create .rosetta/config.json (detects locale files; --from-lingo imports Lingo.dev)
  push      Translate new and changed strings, prune removed ones, update .rosetta/lock.json
  check     Fail if any translation is stale, missing, or broken (no API key needed)
  status    Show what push would do
  purge     Delete a locale's translations so the next push redoes them
  pull      No-op (Rosetta runs locally — there's nothing to pull)

Global options:
  --config <path>   Use a specific config file (default: nearest .rosetta/config.json)
  --json            Machine-readable output on stdout
  --quiet           Only print errors
  -h, --help        Show help for a command
  -v, --version     Print the version

Exit codes: 0 ok · 1 translation failed · 2 usage/config error · 3 stale (check)

Environment: ROSETTA_API_KEY (or OPENROUTER_API_KEY), ROSETTA_MODEL, ROSETTA_BASE_URL, CI
Docs: https://github.com/ian/rosetta`,
	init: `rosetta init [options]

Create .rosetta/config.json. Without flags, detects <source>.json-style files
and infers target locales from sibling files.

Options:
  --from-lingo         Import .lingo/config.json (or legacy i18n.json)
  --source <locale>    Source locale (default: en)
  --target <locale>    Target locale (repeatable or comma-separated)
  --pattern <path>     Source file path or glob (repeatable)
  --model <id>         Model id for engine.model
  -y, --yes            Don't prompt for confirmation`,
	push: `rosetta push [patterns...] [options]

Translate what changed since the last push and write target files + lock.
Positional patterns limit the run to matching source files.

Options:
  --locale <code>      Only these locales (repeatable)
  --key <pattern>      Retranslate matching keys even if unchanged (repeatable)
  --force              Retranslate everything in scope (asks unless --yes)
  -y, --yes            Don't prompt (implied when CI is set)
  --estimate           Show the plan and estimated tokens; don't translate
  --dry-run            Alias for --estimate
  --backfill-missing   Accepted for Lingo.dev compatibility (always on)`,
	check: `rosetta check [patterns...] [--locale <code>]

Exit 3 if any target is stale (source changed), missing, untracked, has extra
keys, or fails validation (placeholders, ICU, tags). Never calls a model.`,
	status: `rosetta status [patterns...] [--locale <code>] [--exit-code]

Show per-locale counts of what push would translate, adopt, copy, and remove.
--exit-code exits 3 when anything is out of date.`,
	purge: `rosetta purge --locale <code> [--yes]

Delete that locale's target files and lock entries.`,
	pull: `rosetta pull

Rosetta translates locally in \`push\`, so there's nothing to pull. Exists so
scripts written for Lingo.dev keep working.`,
};

// ---------------------------------------------------------------------------
// Output helpers

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summarize(
	counts: {
		translated: number;
		adopted: number;
		copied?: number;
		removed: number;
		kept?: number;
	},
	verbs: { translated: string; adopted: string; removed: string },
): string {
	const parts: string[] = [];
	if (counts.translated) parts.push(`${counts.translated} ${verbs.translated}`);
	if (counts.adopted) parts.push(`${counts.adopted} ${verbs.adopted}`);
	if (counts.removed) parts.push(`${counts.removed} ${verbs.removed}`);
	return parts.length > 0 ? parts.join(" · ") : "up to date";
}

function version(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		const path = join(dir, "package.json");
		if (existsSync(path)) {
			const pkg = JSON.parse(readFileSync(path, "utf8")) as {
				name?: string;
				version?: string;
			};
			if (pkg.name === "rosetta-i18n") return pkg.version ?? "unknown";
		}
		dir = dirname(dir);
	}
	return "unknown";
}

// ---------------------------------------------------------------------------
// Commands

interface Context {
	io: CliIO;
	args: ParsedArgs;
	json: boolean;
	quiet: boolean;
	out: (text: string) => void;
}

function load(ctx: Context): Project {
	const project = loadConfig({
		cwd: ctx.io.cwd,
		configPath: ctx.args.flags.config as string | undefined,
	});
	if (!ctx.json)
		for (const warning of project.warnings)
			ctx.io.stderr(`warning: ${warning}`);
	return project;
}

function autoYes(ctx: Context): boolean {
	return ctx.args.flags.yes === true || Boolean(ctx.io.env.CI);
}

async function confirmOrFail(
	ctx: Context,
	question: string,
	flag = "--yes",
): Promise<boolean> {
	if (autoYes(ctx)) return true;
	if (!ctx.io.interactive || ctx.json) {
		throw new UsageError(
			`${question.replace(/\?$/, "")} requires confirmation — pass ${flag}.`,
		);
	}
	return ctx.io.confirm(`${question} [y/N] `);
}

async function cmdInit(ctx: Context): Promise<number> {
	const { io, args } = ctx;
	const root = io.cwd;
	const configPath = join(root, ROSETTA_DIR, CONFIG_FILE);
	if (existsSync(configPath)) {
		throw new UsageError(
			`${relative(root, configPath)} already exists — edit it instead.`,
		);
	}

	const sourceLocale = (args.flags.source as string | undefined) ?? "en";
	let warnings: string[] = [];
	let config: ProjectConfig;
	if (args.flags["from-lingo"]) {
		const imported = importLingo(root);
		warnings = imported.warnings;
		config = buildConfig({
			...imported.config,
			targetLocales: list(args.flags.target) ?? imported.config.targetLocales,
			engine: {
				...imported.config.engine,
				...(args.flags.model ? { model: args.flags.model as string } : {}),
			},
		});
		warnings.unshift(`Imported ${imported.source}.`);
	} else {
		const patterns = list(args.flags.pattern);
		const detected = patterns ? undefined : detectProject(root, sourceLocale);
		config = buildConfig({
			sourceLocale,
			targetLocales: list(args.flags.target) ?? detected?.targetLocales ?? [],
			files: patterns
				? patterns.map((pattern) => ({ pattern }))
				: (detected?.files ?? []),
			engine: args.flags.model
				? { model: args.flags.model as string }
				: undefined,
		});
	}

	if (!ctx.json && !ctx.quiet) {
		for (const warning of warnings) io.stderr(warning);
		io.stdout(`Source:  ${config.sourceLocale}`);
		io.stdout(`Targets: ${config.targetLocales.join(", ")}`);
		io.stdout(
			`Files:\n${config.files.map((f) => `  ${f.pattern}`).join("\n")}`,
		);
		io.stdout(`Model:   ${config.engine?.model}`);
	}
	if (!autoYes(ctx) && io.interactive && !ctx.json) {
		if (
			!(await io.confirm(`Write ${ROSETTA_DIR}/${CONFIG_FILE}? [Y/n] `, true))
		) {
			io.stderr("Aborted.");
			return EXIT.failed;
		}
	}

	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, renderConfig(config));

	if (ctx.json) {
		ctx.out(
			JSON.stringify(
				{ command: "init", ok: true, configPath, config, warnings },
				null,
				2,
			),
		);
	} else if (!ctx.quiet) {
		io.stdout(`\n✓ Wrote ${ROSETTA_DIR}/${CONFIG_FILE}`);
		io.stdout(
			"\nNext:\n  1. Set ROSETTA_API_KEY (or OPENROUTER_API_KEY) and review `engine` (model, brandVoice, rules)\n  2. rosetta push     # existing translations are adopted, not re-translated\n  3. Commit .rosetta/ and the translated files",
		);
	}
	return EXIT.ok;
}

function printPushLocale(ctx: Context, result: LocaleResult): void {
	if (ctx.json || (ctx.quiet && result.ok)) return;
	if (result.ok) {
		ctx.io.stdout(
			`✓ ${result.locale.padEnd(6)} ${result.file}  ${summarize(result, {
				translated: "translated",
				adopted: "adopted",
				removed: "removed",
			})}`,
		);
		return;
	}
	ctx.io.stdout(
		`✗ ${result.locale.padEnd(6)} ${result.file}  not written — ${plural(result.errors.length, "error")}:`,
	);
	for (const error of result.errors.slice(0, 10)) {
		ctx.io.stdout(
			`    ${error.key || "(file)"}  ${error.rule}: ${error.message}`,
		);
	}
	if (result.errors.length > 10)
		ctx.io.stdout(`    …and ${result.errors.length - 10} more`);
}

async function cmdPush(ctx: Context): Promise<number> {
	const { args, io } = ctx;
	const project = load(ctx);
	const estimate =
		args.flags.estimate === true || args.flags["dry-run"] === true;
	const force = args.flags.force === true;

	if (force && !estimate) {
		const scope =
			args.positionals.length > 0
				? args.positionals.join(", ")
				: "every configured file";
		const ok = await confirmOrFail(
			ctx,
			`Retranslate ${scope} (overwriting existing translations)?`,
		);
		if (!ok) {
			io.stderr("Aborted.");
			return EXIT.failed;
		}
	}

	const result: PushResult = await push(project, {
		patterns: args.positionals,
		locales: list(args.flags.locale),
		keys: list(args.flags.key),
		force,
		estimate,
		env: io.env,
		translator: io.translator,
		onLocale: (locale) => printPushLocale(ctx, locale),
	});

	if (ctx.json) {
		ctx.out(JSON.stringify(result, null, 2));
	} else if (estimate && result.estimate) {
		let keys = 0;
		let input = 0;
		let output = 0;
		for (const row of result.estimate) {
			keys += row.keys;
			input += row.estimatedInputTokens;
			output += row.estimatedOutputTokens;
			if (!ctx.quiet) {
				io.stdout(
					`  ${row.locale.padEnd(6)} ${row.file}  ${row.keys ? `${plural(row.keys, "key")} · ~${row.estimatedInputTokens.toLocaleString("en-US")} in / ~${row.estimatedOutputTokens.toLocaleString("en-US")} out tokens` : "up to date"}`,
				);
			}
		}
		io.stdout(
			keys === 0
				? "Nothing to translate."
				: `Estimate: ${plural(keys, "key")} · ~${input.toLocaleString("en-US")} input / ~${output.toLocaleString("en-US")} output tokens (heuristic, not a quote)`,
		);
	} else if (!ctx.quiet) {
		const failed = result.locales.filter((l) => !l.ok).length;
		const u = result.usage;
		if (u.requests > 0) {
			io.stdout(
				`${plural(u.requests, "request")} · ${u.inputTokens.toLocaleString("en-US")} input / ${u.outputTokens.toLocaleString("en-US")} output tokens`,
			);
		}
		if (failed > 0) {
			io.stderr(
				`${plural(failed, "locale")} not written. Fix the errors above and run \`rosetta push\` again.`,
			);
		}
	}
	return result.ok ? EXIT.ok : EXIT.failed;
}

function printCheck(ctx: Context, result: CheckResult): void {
	for (const locale of result.locales) {
		if (locale.ok) {
			if (!ctx.quiet)
				ctx.io.stdout(`✓ ${locale.locale.padEnd(6)} ${locale.file}`);
			continue;
		}
		ctx.io.stdout(
			`✗ ${locale.locale.padEnd(6)} ${locale.file}${locale.error ? `  ${locale.error}` : ""}`,
		);
		for (const entry of locale.stale.slice(0, 10)) {
			ctx.io.stdout(
				`    ${(entry.key || "(file)").padEnd(40)} ${entry.reason}${entry.message ? `: ${entry.message}` : ""}`,
			);
		}
		if (locale.stale.length > 10)
			ctx.io.stdout(`    …and ${locale.stale.length - 10} more`);
	}
	const stale = result.locales.filter((l) => !l.ok).length;
	ctx.io.stdout(
		stale === 0
			? "All translations are up to date."
			: `${stale} of ${plural(result.locales.length, "locale file")} out of date. Run \`rosetta push\`.`,
	);
}

function cmdCheck(ctx: Context): number {
	const project = load(ctx);
	const result = check(project, {
		patterns: ctx.args.positionals,
		locales: list(ctx.args.flags.locale),
	});
	if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
	else printCheck(ctx, result);
	return result.ok ? EXIT.ok : EXIT.stale;
}

function cmdStatus(ctx: Context): number {
	const project = load(ctx);
	const { jobs } = plan(project, {
		patterns: ctx.args.positionals,
		locales: list(ctx.args.flags.locale),
	});
	const locales = jobs.map((job) => {
		const counts = {
			translate: 0,
			adopt: 0,
			copy: 0,
			keep: 0,
			remove: job.removed.length,
		};
		for (const item of job.items) {
			if (item.action !== "omit") counts[item.action]++;
		}
		return {
			locale: job.locale,
			sourceFile: job.sourceFile,
			file: job.targetFile,
			upToDate:
				!job.error &&
				counts.translate === 0 &&
				counts.adopt === 0 &&
				counts.remove === 0 &&
				job.targetExists,
			counts,
			...(job.error ? { error: job.error } : {}),
			items: job.items
				.filter(
					(item) => item.action === "translate" || item.action === "adopt",
				)
				.map((item) => ({
					key: item.key,
					action: item.action,
					reason: item.reason,
				})),
			removed: job.removed,
		};
	});
	const ok = locales.every((l) => l.upToDate);

	if (ctx.json) {
		ctx.out(JSON.stringify({ command: "status", ok, locales }, null, 2));
	} else {
		let lastSource = "";
		for (const locale of locales) {
			if (locale.sourceFile !== lastSource) {
				ctx.io.stdout(locale.sourceFile);
				lastSource = locale.sourceFile;
			}
			const detail = locale.error
				? locale.error
				: summarize(
						{
							translated: locale.counts.translate,
							adopted: locale.counts.adopt,
							removed: locale.counts.remove,
						},
						{
							translated: "to translate",
							adopted: "to adopt",
							removed: "to remove",
						},
					);
			if (!ctx.quiet || !locale.upToDate)
				ctx.io.stdout(`  ${locale.locale.padEnd(6)} ${detail}`);
		}
	}
	return ctx.args.flags["exit-code"] && !ok ? EXIT.stale : EXIT.ok;
}

async function cmdPurge(ctx: Context): Promise<number> {
	const locale = ctx.args.flags.locale as string | undefined;
	if (!locale) throw new UsageError("purge requires --locale <code>.");
	const project = load(ctx);
	if (!project.config.targetLocales.includes(locale)) {
		throw new UsageError(
			`"${locale}" isn't in targetLocales (${project.config.targetLocales.join(", ")}).`,
		);
	}
	if (!(await confirmOrFail(ctx, `Delete all ${locale} translations?`))) {
		ctx.io.stderr("Aborted.");
		return EXIT.failed;
	}
	const { deleted } = purge(project, locale);
	if (ctx.json)
		ctx.out(
			JSON.stringify({ command: "purge", ok: true, locale, deleted }, null, 2),
		);
	else if (!ctx.quiet) {
		ctx.io.stdout(
			`✓ Purged ${locale}: deleted ${plural(deleted.length, "file")}. Run \`rosetta push\` to retranslate.`,
		);
	}
	return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Entry

function defaultIO(): CliIO {
	return {
		cwd: process.cwd(),
		env: process.env,
		stdout: (text) => process.stdout.write(`${text}\n`),
		stderr: (text) => process.stderr.write(`${text}\n`),
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		confirm: async (question, defaultYes = false) => {
			const rl = createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			try {
				const answer = (await rl.question(question)).trim().toLowerCase();
				return answer === "" ? defaultYes : answer === "y" || answer === "yes";
			} finally {
				rl.close();
			}
		},
	};
}

const EXPECTED_ERRORS = [
	UsageError,
	ConfigError,
	PathResolutionError,
	LockfileError,
	JsoncError,
	RosettaRequestError,
];

/** Run the CLI and return an exit code. `io` is injectable for tests. */
export async function run(
	argv: string[],
	ioOverrides: Partial<CliIO> = {},
): Promise<number> {
	const io: CliIO = { ...defaultIO(), ...ioOverrides } as CliIO;
	const wantsJson = argv.includes("--json");
	let command: string | undefined;

	try {
		if (argv[0] === "translate-catalog") {
			io.stderr(
				"warning: `translate-catalog` is deprecated and will be removed in v2. See `rosetta --help`.",
			);
			await runLegacy(argv);
			return EXIT.ok;
		}

		const args = parseCli(argv);
		command = args.command;
		if (args.flags.version) {
			io.stdout(version());
			return EXIT.ok;
		}
		if (!command || args.flags.help) {
			io.stdout(HELP[command ?? "main"] ?? HELP.main);
			return command || args.flags.help ? EXIT.ok : EXIT.usage;
		}

		const ctx: Context = {
			io,
			args,
			json: args.flags.json === true,
			quiet: args.flags.quiet === true,
			out: io.stdout,
		};
		switch (command) {
			case "init":
				return await cmdInit(ctx);
			case "push":
				return await cmdPush(ctx);
			case "check":
				return cmdCheck(ctx);
			case "status":
				return cmdStatus(ctx);
			case "purge":
				return await cmdPurge(ctx);
			case "pull":
				if (!ctx.json) {
					io.stdout(
						"Nothing to pull: Rosetta translates locally in `rosetta push`, so results are already on disk.",
					);
				} else ctx.out(JSON.stringify({ command: "pull", ok: true }));
				return EXIT.ok;
		}
		return EXIT.usage;
	} catch (error) {
		const expected = EXPECTED_ERRORS.some((type) => error instanceof type);
		const message = error instanceof Error ? error.message : String(error);
		const code = expected ? EXIT.usage : EXIT.failed;
		if (wantsJson) {
			io.stdout(
				JSON.stringify(
					{
						command,
						ok: false,
						error: { type: (error as Error)?.name ?? "Error", message },
					},
					null,
					2,
				),
			);
		} else {
			io.stderr(`rosetta: ${message}`);
			if (
				!expected &&
				error instanceof Error &&
				error.stack &&
				io.env.ROSETTA_DEBUG
			) {
				io.stderr(error.stack);
			}
		}
		return code;
	}
}

// Resolve symlinks — a package bin is a symlink in node_modules/.bin, so
// `process.argv[1]` is the link path while `import.meta.url` is the real file.
let isMain = false;
if (process.argv[1]) {
	try {
		isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		isMain = false;
	}
}

if (isMain) {
	run(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
