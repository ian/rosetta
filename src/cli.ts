import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rosetta } from "./rosetta";
import type { Glossary } from "./types";

export const HELP = Symbol("help");

export interface CatalogOptions {
	/** Path to the source catalog JSON. */
	input: string;
	/** Target locales to write. */
	targets: string[];
	/** Source locale. */
	source: string;
	/** Directory to write `<target>.json` into. Defaults to the input's dir. */
	outDir: string;
	context?: string;
	brandVoice?: string;
	glossaryPath?: string;
	model?: string;
	baseURL?: string;
	concurrency?: number;
	batchSize?: number;
	retries?: number;
	/** Print the plan without calling the model or writing files. */
	dryRun?: boolean;
	/** Only translate keys missing from an existing target file. */
	merge?: boolean;
}

/** Minimal surface the catalog runner needs — the real `Rosetta` or a fake. */
export interface TranslateClient {
	translate(
		data: Record<string, unknown>,
		options: {
			source: string;
			target: string;
			context?: string;
		},
	): Promise<Record<string, unknown>>;
}

const COMMAND = "translate-catalog";

function takeValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined) throw new Error(`Missing value for ${flag}`);
	return value;
}

function toInt(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${flag} expects a non-negative integer, got "${value}"`);
	}
	return parsed;
}

/**
 * Parse CLI arguments for `translate-catalog`.
 * Returns `HELP` for `--help`, throws a `UsageError` message otherwise.
 */
export function parseArgs(argv: string[]): CatalogOptions | typeof HELP {
	const args = [...argv];
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		return HELP;
	}

	const command = args.shift();
	if (command !== COMMAND) {
		throw new Error(
			`Unknown command "${command}". Try \`rosetta-i18n --help\`.`,
		);
	}

	let input: string | undefined;
	const targets: string[] = [];
	const options: Partial<CatalogOptions> = { source: "en" };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--target":
				targets.push(takeValue(args, ++i, arg));
				break;
			case "--source":
				options.source = takeValue(args, ++i, arg);
				break;
			case "--out":
				options.outDir = resolve(takeValue(args, ++i, arg));
				break;
			case "--context":
				options.context = takeValue(args, ++i, arg);
				break;
			case "--brand-voice":
				options.brandVoice = takeValue(args, ++i, arg);
				break;
			case "--glossary":
				options.glossaryPath = resolve(takeValue(args, ++i, arg));
				break;
			case "--model":
				options.model = takeValue(args, ++i, arg);
				break;
			case "--base-url":
				options.baseURL = takeValue(args, ++i, arg);
				break;
			case "--concurrency":
				options.concurrency = toInt(takeValue(args, ++i, arg), arg);
				break;
			case "--batch-size":
				options.batchSize = toInt(takeValue(args, ++i, arg), arg);
				break;
			case "--retries":
				options.retries = toInt(takeValue(args, ++i, arg), arg);
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--merge":
				options.merge = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`Unknown flag "${arg}".`);
				if (input) throw new Error(`Unexpected argument "${arg}".`);
				input = resolve(arg);
		}
	}

	if (!input) throw new Error("Missing input catalog path.");
	if (targets.length === 0) {
		throw new Error("At least one --target <locale> is required.");
	}

	options.input = input;
	options.targets = targets;
	options.outDir = options.outDir ?? dirname(input);
	return options as CatalogOptions;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readJsonIfExists(
	path: string,
): Promise<Record<string, unknown>> {
	try {
		return await readJson(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

/** Keys present in `input` but missing from `existing` (top-level). */
export function missingKeys(
	input: Record<string, unknown>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(input).filter(([key]) => !(key in existing)),
	);
}

/**
 * Translate a catalog into each target locale and write `<outDir>/<target>.json`.
 * The `client` is only required when not running `--dry-run`.
 */
export async function runCatalog(
	options: CatalogOptions,
	client?: TranslateClient,
): Promise<void> {
	const input = await readJson(options.input);
	const keys = Object.keys(input).length;

	if (options.dryRun) {
		console.log(
			`[rosetta] dry run — ${keys} keys ${options.source} → ${options.targets.join(", ")}`,
		);
		console.log(`[rosetta] would write to ${options.outDir}/`);
		return;
	}

	if (!client) throw new Error("A translate client is required.");

	for (const target of options.targets) {
		const outputPath = join(options.outDir, `${target}.json`);
		const existing = options.merge ? await readJsonIfExists(outputPath) : {};

		const payload = options.merge ? missingKeys(input, existing) : input;
		const payloadKeys = Object.keys(payload);

		if (payloadKeys.length === 0) {
			console.log(`[rosetta] ${target} — up to date, skipping`);
			continue;
		}

		const translated = await client.translate(payload, {
			source: options.source,
			target,
			context: options.context,
		});

		const result = options.merge ? { ...existing, ...translated } : translated;
		const written = Object.keys(translated).length;
		await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

		console.log(
			`[rosetta] ${target} → ${outputPath} (${written}/${payloadKeys.length} keys)`,
		);
	}
}

/** Build a real Rosetta client from CLI options + env. */
export async function buildClient(options: CatalogOptions): Promise<Rosetta> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error(
			"OPENROUTER_API_KEY is not set (pass it in the environment, or use --dry-run).",
		);
	}

	let glossary: Glossary | undefined;
	if (options.glossaryPath) {
		glossary = JSON.parse(
			await readFile(options.glossaryPath, "utf8"),
		) as Glossary;
	}

	return new Rosetta({
		apiKey,
		model:
			options.model ??
			process.env.ROSETTA_MODEL ??
			"anthropic/claude-sonnet-4.5",
		baseURL: options.baseURL ?? process.env.ROSETTA_BASE_URL,
		brandVoice: {
			variations: {
				"*": options.brandVoice ?? process.env.ROSETTA_BRAND_VOICE ?? "",
			},
		},
		glossary,
		batchSize: options.batchSize,
		concurrency: options.concurrency,
		retries: options.retries,
		// translate-catalog keeps its 0.x behavior: skip failed keys, write the rest.
		onBatchError: "skip",
	});
}

const HELP_TEXT = `rosetta-i18n — translate a JSON catalog with an LLM

Usage:
  rosetta-i18n translate-catalog <input.json> --target <locale> [--target <locale>...] [options]

Options:
  --target <locale>     Target locale (repeatable, required)
  --source <locale>     Source locale (default: en)
  --out <dir>           Output directory (default: the input file's directory)
  --merge               Only translate keys missing from existing <target>.json
  --context <text>      Broad context passed to the model
  --brand-voice <text>  Brand voice briefing (default: ROSETTA_BRAND_VOICE)
  --glossary <file>     JSON file of per-locale exact term mappings
  --model <id>          Model id (default: ROSETTA_MODEL or claude-sonnet-4.5)
  --base-url <url>      OpenAI-compatible endpoint (default: ROSETTA_BASE_URL)
  --concurrency <n>     Parallel batches in flight
  --batch-size <n>      Keys per request
  --retries <n>         Retries per batch
  --dry-run             Print the plan without calling the model
  -h, --help            Show this help

Example:
  OPENROUTER_API_KEY=sk-... rosetta-i18n translate-catalog messages/en.json \\
    --target es --target pt-BR --merge --context "Next.js UI catalog"
`;

export function printHelp(): void {
	console.log(HELP_TEXT);
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === HELP) {
		printHelp();
		return;
	}

	if (parsed.dryRun) {
		await runCatalog(parsed);
		return;
	}

	const client = await buildClient(parsed);
	await runCatalog(parsed, client);
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
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[rosetta] ${message}`);
		process.exit(1);
	});
}
