import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Glossary, RosettaConfig } from "../types";
import { JsoncError, parseJsonc } from "./jsonc";
import { PathResolutionError, resolveTargetPath } from "./paths";

export const ROSETTA_DIR = ".rosetta";
export const CONFIG_FILE = "config.json";
export const LOCK_FILE = "lock.json";

export interface FileConfig {
	/** Path or glob of source files, relative to the project root. */
	pattern: string;
	format?: "json" | "jsonc";
	context?: string;
	lockedKeys?: string[];
	preservedKeys?: string[];
	ignoredKeys?: string[];
}

export interface EngineConfig {
	model?: string;
	baseURL?: string;
	apiKeyEnv?: string;
	temperature?: number;
	/** Locale (or `*`) → brand voice text or a `.md`/`.txt` path. */
	brandVoice?: Record<string, string>;
	rules?: string | string[];
	/** Inline glossary or a path to a JSON/JSONC glossary file. */
	glossary?: Glossary | string;
	batchSize?: number;
	concurrency?: number;
	retries?: number;
	timeoutMs?: number;
}

export interface ProjectConfig {
	$schema?: string;
	sourceLocale: string;
	targetLocales: string[];
	files: FileConfig[];
	engine?: EngineConfig;
}

export interface Project {
	/** Absolute project root (the directory containing `.rosetta/`). */
	root: string;
	/** Absolute path of the `.rosetta/` directory. */
	dir: string;
	configPath: string;
	lockPath: string;
	config: ProjectConfig;
	warnings: string[];
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const TOP_LEVEL = new Set([
	"$schema",
	"sourceLocale",
	"targetLocales",
	"files",
	"engine",
]);
const LINGO_ONLY = new Set(["orgId", "engineId", "github", "version"]);
const FILE_FIELDS = new Set([
	"pattern",
	"format",
	"context",
	"lockedKeys",
	"preservedKeys",
	"ignoredKeys",
]);
const ENGINE_FIELDS = new Set([
	"model",
	"baseURL",
	"apiKeyEnv",
	"temperature",
	"brandVoice",
	"rules",
	"glossary",
	"batchSize",
	"concurrency",
	"retries",
	"timeoutMs",
]);
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Validate a parsed config. Returns the typed config plus warnings; throws
 * `ConfigError` listing every problem with its field path.
 */
export function validateConfig(raw: unknown): {
	config: ProjectConfig;
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isObject(raw)) throw new ConfigError("config must be a JSON object");

	for (const key of Object.keys(raw)) {
		if (LINGO_ONLY.has(key)) {
			warnings.push(
				`"${key}" is a Lingo.dev setting and is ignored by Rosetta.`,
			);
		} else if (!TOP_LEVEL.has(key)) {
			errors.push(`unknown field "${key}"`);
		}
	}

	const { sourceLocale, targetLocales, files, engine } = raw;
	if (typeof sourceLocale !== "string" || !LOCALE.test(sourceLocale)) {
		errors.push(`sourceLocale must be a locale code like "en"`);
	}
	if (!isStringArray(targetLocales) || targetLocales.length === 0) {
		errors.push("targetLocales must be a non-empty array of locale codes");
	} else {
		targetLocales.forEach((locale, i) => {
			if (!LOCALE.test(locale)) {
				errors.push(`targetLocales[${i}] "${locale}" is not a locale code`);
			}
			if (locale === sourceLocale) {
				errors.push(`targetLocales[${i}] must not equal sourceLocale`);
			}
		});
		if (new Set(targetLocales).size !== targetLocales.length) {
			errors.push("targetLocales contains duplicates");
		}
	}

	if (!Array.isArray(files) || files.length === 0) {
		errors.push("files must be a non-empty array");
	} else {
		files.forEach((file, i) => {
			const at = `files[${i}]`;
			if (!isObject(file)) {
				errors.push(`${at} must be an object`);
				return;
			}
			for (const key of Object.keys(file)) {
				if (!FILE_FIELDS.has(key)) errors.push(`${at}: unknown field "${key}"`);
			}
			if (typeof file.pattern !== "string" || !file.pattern) {
				errors.push(`${at}.pattern must be a non-empty string`);
			} else {
				if (file.pattern.startsWith("/") || file.pattern.includes("\\")) {
					errors.push(
						`${at}.pattern must be relative with forward slashes (got "${file.pattern}")`,
					);
				}
				if (typeof sourceLocale === "string") {
					try {
						resolveTargetPath(file.pattern, sourceLocale, "xx");
					} catch (error) {
						if (error instanceof PathResolutionError) {
							errors.push(`${at}.pattern: ${error.message}`);
						} else throw error;
					}
				}
			}
			if (
				file.format !== undefined &&
				file.format !== "json" &&
				file.format !== "jsonc"
			) {
				errors.push(`${at}.format must be "json" or "jsonc"`);
			}
			if (file.context !== undefined && typeof file.context !== "string") {
				errors.push(`${at}.context must be a string`);
			}
			for (const field of ["lockedKeys", "preservedKeys", "ignoredKeys"]) {
				if (file[field] !== undefined && !isStringArray(file[field])) {
					errors.push(`${at}.${field} must be an array of strings`);
				}
			}
		});
	}

	if (engine !== undefined) {
		if (!isObject(engine)) {
			errors.push("engine must be an object");
		} else {
			for (const key of Object.keys(engine)) {
				if (!ENGINE_FIELDS.has(key))
					errors.push(`engine: unknown field "${key}"`);
			}
			for (const field of ["model", "baseURL", "apiKeyEnv"]) {
				if (engine[field] !== undefined && typeof engine[field] !== "string") {
					errors.push(`engine.${field} must be a string`);
				}
			}
			for (const field of [
				"temperature",
				"batchSize",
				"concurrency",
				"retries",
				"timeoutMs",
			]) {
				const value = engine[field];
				if (
					value !== undefined &&
					(typeof value !== "number" || !Number.isFinite(value) || value < 0)
				) {
					errors.push(`engine.${field} must be a non-negative number`);
				}
			}
			if (
				engine.brandVoice !== undefined &&
				(!isObject(engine.brandVoice) ||
					!Object.values(engine.brandVoice).every((v) => typeof v === "string"))
			) {
				errors.push('engine.brandVoice must map locales (or "*") to strings');
			}
			if (
				engine.rules !== undefined &&
				typeof engine.rules !== "string" &&
				!isStringArray(engine.rules)
			) {
				errors.push("engine.rules must be a string or an array of strings");
			}
			if (
				engine.glossary !== undefined &&
				typeof engine.glossary !== "string" &&
				!isObject(engine.glossary)
			) {
				errors.push("engine.glossary must be an object or a file path");
			}
		}
	}

	if (errors.length > 0) {
		throw new ConfigError(
			`Invalid .rosetta/config.json:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}
	return { config: raw as unknown as ProjectConfig, warnings };
}

/** Walk up from `cwd` to the nearest `.rosetta/config.json`. */
export function findConfig(cwd: string = process.cwd()): string | undefined {
	let dir = resolve(cwd);
	while (true) {
		const candidate = join(dir, ROSETTA_DIR, CONFIG_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Load and validate a project config (found by walking up from `cwd`). */
export function loadConfig(
	options: { cwd?: string; configPath?: string } = {},
): Project {
	const configPath = options.configPath
		? resolve(options.cwd ?? process.cwd(), options.configPath)
		: findConfig(options.cwd);
	if (!configPath || !existsSync(configPath)) {
		throw new ConfigError(
			options.configPath
				? `Config not found: ${options.configPath}`
				: "No .rosetta/config.json found in this directory or any parent. Run `rosetta init`.",
		);
	}

	let raw: unknown;
	try {
		raw = parseJsonc(readFileSync(configPath, "utf8")).value;
	} catch (error) {
		if (error instanceof JsoncError) {
			throw new ConfigError(`${configPath}: ${error.message}`);
		}
		throw error;
	}
	const { config, warnings } = validateConfig(raw);

	const dir = dirname(configPath);
	const root = basename(dir) === ROSETTA_DIR ? dirname(dir) : dir;
	return {
		root,
		dir,
		configPath,
		lockPath: join(dir, LOCK_FILE),
		config,
		warnings,
	};
}

function readReference(project: Project, value: string): string | undefined {
	if (!/\.(md|txt)$/i.test(value)) return undefined;
	const path = resolve(project.dir, value);
	if (!existsSync(path)) {
		throw new ConfigError(
			`engine file not found: ${value} (looked in ${path})`,
		);
	}
	return readFileSync(path, "utf8").trim();
}

/**
 * Build `Rosetta` constructor options from the project's `engine`, reading
 * brand-voice and glossary files and applying env overrides
 * (`ROSETTA_MODEL`, `ROSETTA_BASE_URL`). The API key is resolved from
 * `engine.apiKeyEnv` (default `ROSETTA_API_KEY`), then `OPENROUTER_API_KEY`.
 */
export function resolveEngine(
	project: Project,
	env: Record<string, string | undefined> = process.env,
): Omit<RosettaConfig, "apiKey"> & {
	apiKey: string | undefined;
	apiKeyEnv: string;
} {
	const engine = project.config.engine ?? {};
	const model = env.ROSETTA_MODEL || engine.model;
	if (!model) {
		throw new ConfigError(
			"engine.model is required in .rosetta/config.json (or set ROSETTA_MODEL).",
		);
	}

	const variations: Record<string, string> = {};
	for (const [locale, value] of Object.entries(engine.brandVoice ?? {})) {
		variations[locale] = readReference(project, value) ?? value;
	}

	let glossary: Glossary | undefined;
	if (typeof engine.glossary === "string") {
		const path = resolve(project.dir, engine.glossary);
		if (!existsSync(path)) {
			throw new ConfigError(
				`engine.glossary file not found: ${engine.glossary}`,
			);
		}
		try {
			glossary = parseJsonc(readFileSync(path, "utf8")).value as Glossary;
		} catch (error) {
			throw new ConfigError(`${engine.glossary}: ${(error as Error).message}`);
		}
	} else {
		glossary = engine.glossary;
	}

	const apiKeyEnv = engine.apiKeyEnv ?? "ROSETTA_API_KEY";
	return {
		apiKey: env[apiKeyEnv] || env.OPENROUTER_API_KEY || undefined,
		apiKeyEnv,
		model,
		baseURL: env.ROSETTA_BASE_URL || engine.baseURL,
		temperature: engine.temperature,
		brandVoice: { variations },
		rules:
			typeof engine.rules === "string" ? [engine.rules] : (engine.rules ?? []),
		glossary,
		batchSize: engine.batchSize,
		concurrency: engine.concurrency,
		retries: engine.retries,
		timeoutMs: engine.timeoutMs,
	};
}
