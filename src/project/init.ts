import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	ConfigError,
	type FileConfig,
	type ProjectConfig,
	validateConfig,
} from "./config";
import { parseJsonc } from "./jsonc";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	".nuxt",
	".turbo",
	".vercel",
	".rosetta",
	".lingo",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
]);
const LOCALE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const MAX_FILES = 20_000;

/** List .json/.jsonc files under root, skipping build output and deps. */
function walk(root: string): string[] {
	const out: string[] = [];
	const visit = (rel: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= MAX_FILES) return;
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
					visit(path);
			} else if (/\.jsonc?$/.test(entry.name)) {
				out.push(path);
			}
		}
	};
	visit("");
	return out.sort();
}

function isLocaleDoc(root: string, path: string): boolean {
	try {
		const { value } = parseJsonc(readFileSync(join(root, path), "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}

export interface Detection {
	files: FileConfig[];
	/** Locales found next to the detected source files. */
	targetLocales: string[];
}

/**
 * Find likely source-locale files: `<source>.json`, `*.<source>.json`,
 * `*_<source>.json`, or anything under a `<source>/` directory. Directories
 * with several source files collapse to a `dir/<source>/**\/*.json` glob.
 * Target locales are inferred from sibling files/directories.
 */
export function detectProject(root: string, sourceLocale: string): Detection {
	const all = walk(root);
	const candidates = all.filter((path) => {
		const segments = path.split("/");
		const name = segments.at(-1) ?? "";
		const stem = name.replace(/\.jsonc?$/, "");
		const byName =
			stem === sourceLocale ||
			stem.endsWith(`.${sourceLocale}`) ||
			stem.endsWith(`_${sourceLocale}`);
		const byDir = segments.slice(0, -1).includes(sourceLocale);
		return (byName || byDir) && isLocaleDoc(root, path);
	});

	// Group files living under a `<source>/` directory.
	const dirGroups = new Map<string, string[]>();
	const files: FileConfig[] = [];
	for (const path of candidates) {
		const segments = path.split("/");
		const dirIndex = segments.lastIndexOf(sourceLocale, segments.length - 2);
		const stem = (segments.at(-1) ?? "").replace(/\.jsonc?$/, "");
		if (dirIndex >= 0 && stem !== sourceLocale) {
			const dir = segments.slice(0, dirIndex + 1).join("/");
			dirGroups.set(dir, [...(dirGroups.get(dir) ?? []), path]);
		} else {
			files.push({ pattern: path });
		}
	}
	for (const [dir, paths] of dirGroups) {
		if (paths.length === 1) files.push({ pattern: paths[0] });
		else {
			const ext = paths.every((p) => p.endsWith(".jsonc")) ? "jsonc" : "json";
			files.push({ pattern: `${dir}/**/*.${ext}` });
		}
	}
	files.sort((a, b) => a.pattern.localeCompare(b.pattern));

	// Infer targets from siblings: messages/es.json, locales/es/, pages.es.json.
	const targets = new Set<string>();
	for (const file of files) {
		const probe = file.pattern.includes("*")
			? file.pattern.slice(0, file.pattern.indexOf("/**"))
			: file.pattern;
		const segments = probe.split("/");
		const name = segments.at(-1) ?? "";
		const parent = dirname(probe) === "." ? "" : dirname(probe);
		let siblings: string[] = [];
		try {
			siblings = readdirSync(join(root, parent));
		} catch {
			continue;
		}
		const stem = name.replace(/\.jsonc?$/, "");
		const ext = name.slice(stem.length);
		for (const sibling of siblings) {
			let locale: string | undefined;
			if (name === sourceLocale)
				locale = sibling; // directory layout
			else if (stem === sourceLocale && sibling.endsWith(ext)) {
				locale = sibling.slice(0, -ext.length || undefined);
			} else {
				const prefix = stem.slice(0, stem.length - sourceLocale.length);
				if (sibling.startsWith(prefix) && sibling.endsWith(ext)) {
					locale = sibling.slice(prefix.length, sibling.length - ext.length);
				}
			}
			if (locale && locale !== sourceLocale && LOCALE.test(locale)) {
				targets.add(locale);
			}
		}
	}
	return { files, targetLocales: [...targets].sort() };
}

export interface LingoImport {
	config: Omit<ProjectConfig, "engine"> & { engine?: ProjectConfig["engine"] };
	source: string;
	warnings: string[];
}

const slashToDot = (keys: unknown): string[] | undefined =>
	Array.isArray(keys)
		? keys.map((key) => String(key).replace(/\//g, "."))
		: undefined;

/**
 * Convert a Lingo.dev config: `.lingo/config.json` (CLI v1) or `i18n.json`
 * (legacy CLI v0). Only JSON/JSONC files carry over; others are reported.
 */
export function importLingo(root: string): LingoImport {
	const warnings: string[] = [];
	const v1 = join(root, ".lingo", "config.json");
	const v0 = join(root, "i18n.json");

	if (existsSync(v1)) {
		const raw = parseJsonc(readFileSync(v1, "utf8")).value as Record<
			string,
			unknown
		>;
		const files: FileConfig[] = [];
		for (const entry of (raw.files as Array<Record<string, unknown>>) ?? []) {
			const pattern = String(entry.pattern ?? "");
			if (
				!/\.jsonc?$/.test(pattern) &&
				entry.format !== "json" &&
				entry.format !== "jsonc"
			) {
				warnings.push(
					`Skipped "${pattern}": Rosetta v1 supports JSON/JSONC only.`,
				);
				continue;
			}
			files.push({
				pattern,
				...(entry.format
					? { format: entry.format as FileConfig["format"] }
					: {}),
				...(entry.lockedKeys
					? { lockedKeys: slashToDot(entry.lockedKeys) }
					: {}),
				...(entry.preservedKeys
					? { preservedKeys: slashToDot(entry.preservedKeys) }
					: {}),
				...(entry.ignoredKeys
					? { ignoredKeys: slashToDot(entry.ignoredKeys) }
					: {}),
			});
		}
		if (raw.engineId) {
			warnings.push(
				"Your Lingo.dev engine (brand voice, glossary, rules, model) lives on their platform — copy it into `engine` in .rosetta/config.json.",
			);
		}
		return {
			source: ".lingo/config.json",
			warnings,
			config: {
				sourceLocale: String(raw.sourceLocale ?? "en"),
				targetLocales: (raw.targetLocales as string[]) ?? [],
				files,
			},
		};
	}

	if (existsSync(v0)) {
		const raw = parseJsonc(readFileSync(v0, "utf8")).value as {
			locale?: { source?: string; targets?: string[] };
			buckets?: Record<string, Record<string, unknown>>;
			provider?: { model?: string; baseUrl?: string; prompt?: string };
		};
		const sourceLocale = raw.locale?.source ?? "en";
		const files: FileConfig[] = [];
		for (const [type, bucket] of Object.entries(raw.buckets ?? {})) {
			const include =
				(bucket.include as Array<string | { path: string }>) ?? [];
			if (type !== "json" && type !== "jsonc") {
				warnings.push(
					`Skipped "${type}" bucket: Rosetta v1 supports JSON/JSONC only.`,
				);
				continue;
			}
			for (const item of include) {
				const path = typeof item === "string" ? item : item.path;
				files.push({
					pattern: path.replaceAll("[locale]", sourceLocale),
					...(bucket.lockedKeys
						? { lockedKeys: slashToDot(bucket.lockedKeys) }
						: {}),
					...(bucket.preservedKeys
						? { preservedKeys: slashToDot(bucket.preservedKeys) }
						: {}),
					...(bucket.ignoredKeys
						? { ignoredKeys: slashToDot(bucket.ignoredKeys) }
						: {}),
				});
			}
		}
		return {
			source: "i18n.json",
			warnings,
			config: {
				sourceLocale,
				targetLocales: raw.locale?.targets ?? [],
				files,
				...(raw.provider?.model
					? {
							engine: {
								model: raw.provider.model,
								...(raw.provider.baseUrl
									? { baseURL: raw.provider.baseUrl }
									: {}),
								...(raw.provider.prompt
									? { rules: [raw.provider.prompt] }
									: {}),
							},
						}
					: {}),
			},
		};
	}

	throw new ConfigError(
		"No Lingo.dev config found (.lingo/config.json or i18n.json).",
	);
}

/** Assemble and validate a new config; throws ConfigError on problems. */
export function buildConfig(input: {
	sourceLocale: string;
	targetLocales: string[];
	files: FileConfig[];
	engine?: ProjectConfig["engine"];
}): ProjectConfig {
	if (input.files.length === 0) {
		throw new ConfigError(
			`No ${input.sourceLocale} locale files found. Pass --pattern <path> (e.g. --pattern messages/${input.sourceLocale}.json).`,
		);
	}
	if (input.targetLocales.length === 0) {
		throw new ConfigError(
			"No target locales found. Pass --target <locale> (repeatable).",
		);
	}
	const config: ProjectConfig = {
		$schema: "https://unpkg.com/rosetta-i18n@1/schema/config.json",
		sourceLocale: input.sourceLocale,
		targetLocales: input.targetLocales,
		files: input.files,
		engine: {
			model: DEFAULT_MODEL,
			brandVoice: { "*": "" },
			rules: [],
			...input.engine,
		},
	};
	return validateConfig(config).config;
}

/** Render the config file with a short header comment. */
export function renderConfig(config: ProjectConfig): string {
	const body = JSON.stringify(config, null, 2);
	return `// Rosetta config — https://github.com/ian/rosetta\n// Comments are allowed. Run \`rosetta push\` to translate, \`rosetta check\` in CI.\n${body}\n`;
}

export const projectName = (root: string) => basename(root);
