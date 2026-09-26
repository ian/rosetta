import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Rosetta } from "../rosetta";
import type { TranslationIssue, TranslationUsage, Translator } from "../types";
import {
	ConfigError,
	type FileConfig,
	type Project,
	resolveEngine,
} from "./config";
import { flatten, type Leaf, rebuild, serialize } from "./entries";
import { expandPattern, globToRegExp, isGlob } from "./glob";
import { JsoncError, parseJsonc } from "./jsonc";
import { type Lockfile, readLock, writeFileAtomic, writeLock } from "./lock";
import { resolveTargetPath } from "./paths";
import {
	type LocalePlan,
	nextLockEntries,
	notesFor,
	type PlanItem,
	planLocale,
} from "./plan";

export interface RunOptions {
	/** Only source files matching these paths/globs. */
	patterns?: string[];
	/** Only these target locales. */
	locales?: string[];
	/** `--key`: retranslate matching keys even if unchanged. */
	keys?: string[];
	/** `--force`: retranslate everything in scope. */
	force?: boolean;
}

/** One (source file, target locale) unit of work. */
export interface Job extends LocalePlan {
	sourceFile: string;
	targetFile: string;
	locale: string;
	fileConfig: FileConfig;
	/** Parsed source document (structure template). */
	sourceDoc: unknown;
	sourceNotes: Record<string, string>;
	targetExists: boolean;
	/** Raw target file text, for no-op detection. */
	targetText?: string;
	/** Set when the target file exists but can't be parsed. */
	error?: string;
}

export interface ProjectPlan {
	jobs: Job[];
	lock: Lockfile;
	/** True when the run covers every file and locale (enables lock pruning). */
	complete: boolean;
}

export interface LocaleCounts {
	translated: number;
	adopted: number;
	copied: number;
	removed: number;
	kept: number;
}

export interface LocaleResult extends LocaleCounts {
	locale: string;
	sourceFile: string;
	file: string;
	/** Whether the target file's contents changed on disk. */
	written: boolean;
	ok: boolean;
	errors: TranslationIssue[];
}

export interface EstimateResult {
	locale: string;
	sourceFile: string;
	file: string;
	keys: number;
	sourceChars: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
}

export interface PushResult {
	command: "push";
	ok: boolean;
	estimate?: EstimateResult[];
	locales: LocaleResult[];
	usage: TranslationUsage;
}

export interface StaleEntry {
	key: string;
	reason: "missing" | "changed" | "invalid" | "untracked" | "copy" | "extra";
	message?: string;
}

export interface CheckLocaleResult {
	locale: string;
	sourceFile: string;
	file: string;
	ok: boolean;
	stale: StaleEntry[];
	error?: string;
}

export interface CheckResult {
	command: "check";
	ok: boolean;
	locales: CheckLocaleResult[];
}

function readDoc(
	root: string,
	path: string,
): { doc: unknown; notes: Record<string, string>; text: string } {
	const text = readFileSync(join(root, path), "utf8");
	const { value, notes } = parseJsonc(text);
	return { doc: value, notes, text };
}

function matchesAny(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) =>
		isGlob(pattern) ? globToRegExp(pattern, "/").test(path) : path === pattern,
	);
}

/** Resolve jobs for every configured source file × target locale. */
export function plan(project: Project, options: RunOptions = {}): ProjectPlan {
	const { config, root } = project;
	const lock = readLock(project.lockPath);

	const unknownLocales = (options.locales ?? []).filter(
		(locale) => !config.targetLocales.includes(locale),
	);
	if (unknownLocales.length > 0) {
		throw new ConfigError(
			`Unknown locale(s): ${unknownLocales.join(", ")}. targetLocales is ${config.targetLocales.join(", ")}.`,
		);
	}
	const locales =
		options.locales && options.locales.length > 0
			? config.targetLocales.filter((l) => options.locales?.includes(l))
			: config.targetLocales;

	const jobs: Job[] = [];
	const seen = new Set<string>();
	for (const fileConfig of config.files) {
		const sources = expandPattern(root, fileConfig.pattern);
		if (sources.length === 0) {
			if (isGlob(fileConfig.pattern)) continue;
			throw new ConfigError(`Source file not found: ${fileConfig.pattern}`);
		}
		for (const sourceFile of sources) {
			if (seen.has(sourceFile)) continue;
			seen.add(sourceFile);
			if (
				options.patterns &&
				options.patterns.length > 0 &&
				!matchesAny(sourceFile, options.patterns)
			) {
				continue;
			}

			let source: ReturnType<typeof readDoc>;
			try {
				source = readDoc(root, sourceFile);
			} catch (error) {
				if (error instanceof JsoncError) {
					throw new ConfigError(`${sourceFile}: ${error.message}`);
				}
				throw error;
			}
			const sourceLeaves = flatten(source.doc);

			for (const locale of locales) {
				const targetFile = resolveTargetPath(
					sourceFile,
					config.sourceLocale,
					locale,
				);
				const targetPath = join(root, targetFile);
				let targetLeaves: Map<string, Leaf> | undefined;
				let targetText: string | undefined;
				let error: string | undefined;
				const targetExists = existsSync(targetPath);
				if (targetExists) {
					try {
						const target = readDoc(root, targetFile);
						targetText = target.text;
						targetLeaves = flatten(target.doc);
					} catch (e) {
						error = `${targetFile} can't be parsed: ${(e as Error).message}. Fix it or run \`rosetta purge --locale ${locale}\`.`;
					}
				}

				const { items, removed } = error
					? { items: [], removed: [] }
					: planLocale({
							source: sourceLeaves,
							target: targetLeaves,
							lock: lock.files[sourceFile]?.[locale],
							controls: fileConfig,
							scope: { keys: options.keys, force: options.force },
						});

				jobs.push({
					sourceFile,
					targetFile,
					locale,
					fileConfig,
					sourceDoc: source.doc,
					sourceNotes: source.notes,
					targetExists,
					targetText,
					items,
					removed,
					error,
				});
			}
		}
	}

	const complete =
		!(options.patterns && options.patterns.length > 0) &&
		!(options.locales && options.locales.length > 0);
	return { jobs, lock, complete };
}

function counts(items: PlanItem[], removed: string[]): LocaleCounts {
	const c: LocaleCounts = {
		translated: 0,
		adopted: 0,
		copied: 0,
		removed: removed.length,
		kept: 0,
	};
	for (const item of items) {
		if (item.action === "translate") c.translated++;
		else if (item.action === "adopt") c.adopted++;
		else if (item.action === "copy") c.copied++;
		else if (item.action === "keep") c.kept++;
	}
	return c;
}

/** Render a job's target document from its plan and fresh translations. */
function render(job: Job, translations: Record<string, string>): string {
	const byKey = new Map(job.items.map((item) => [item.key, item]));
	const doc = rebuild(job.sourceDoc, (key, sourceValue) => {
		const item = byKey.get(key);
		if (!item || item.action === "omit") return undefined;
		if (item.action === "copy") return sourceValue;
		if (item.action === "translate") return translations[key];
		return item.target;
	});
	return serialize(doc);
}

/** Drop lock entries for source files/locales no longer configured. */
function pruneLock(plan: ProjectPlan, project: Project): boolean {
	if (!plan.complete) return false;
	let changed = false;
	const sources = new Set(plan.jobs.map((job) => job.sourceFile));
	for (const file of Object.keys(plan.lock.files)) {
		if (!sources.has(file)) {
			delete plan.lock.files[file];
			changed = true;
			continue;
		}
		for (const locale of Object.keys(plan.lock.files[file])) {
			if (!project.config.targetLocales.includes(locale)) {
				delete plan.lock.files[file][locale];
				changed = true;
			}
		}
	}
	return changed;
}

export interface PushOptions extends RunOptions {
	/** Plan + estimate only; no model calls, no writes. */
	estimate?: boolean;
	/** Inject a translator (tests, custom engines). Defaults to `Rosetta`. */
	translator?: Translator;
	/** Environment for engine/key resolution (defaults to `process.env`). */
	env?: Record<string, string | undefined>;
	/** Called as each locale finishes. */
	onLocale?: (result: LocaleResult) => void;
}

/**
 * Translate what changed and write target files + lock entries. A locale is
 * written only if every key it needs translated succeeded; otherwise its file
 * and lock entries are left untouched and its errors are reported.
 */
export async function push(
	project: Project,
	options: PushOptions = {},
): Promise<PushResult> {
	const projectPlan = plan(project, options);
	const { jobs, lock } = projectPlan;
	const usage: TranslationUsage = {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
	};

	if (options.estimate) {
		const estimate = jobs.map((job): EstimateResult => {
			const pending = job.items.filter((item) => item.action === "translate");
			const sourceChars = pending.reduce(
				(sum, item) => sum + String(item.source).length + item.key.length,
				0,
			);
			const batches = Math.ceil(
				pending.length / (project.config.engine?.batchSize ?? 25),
			);
			const estimatedInputTokens = Math.ceil(sourceChars / 4) + batches * 400;
			return {
				locale: job.locale,
				sourceFile: job.sourceFile,
				file: job.targetFile,
				keys: pending.length,
				sourceChars,
				estimatedInputTokens,
				estimatedOutputTokens: Math.ceil((sourceChars / 4) * 1.3),
			};
		});
		return {
			command: "push",
			ok: jobs.every((job) => !job.error),
			estimate,
			locales: jobs.map((job) => ({
				locale: job.locale,
				sourceFile: job.sourceFile,
				file: job.targetFile,
				written: false,
				ok: !job.error,
				errors: job.error
					? [{ key: "", rule: "parse", message: job.error }]
					: [],
				...counts(job.items, job.removed),
			})),
			usage,
		};
	}

	const needsModel = jobs.some((job) =>
		job.items.some((item) => item.action === "translate"),
	);
	let translator = options.translator;
	if (needsModel && !translator) {
		const engine = resolveEngine(project, options.env);
		if (!engine.apiKey) {
			throw new ConfigError(
				`No API key: set ${engine.apiKeyEnv}${engine.apiKeyEnv === "OPENROUTER_API_KEY" ? "" : " (or OPENROUTER_API_KEY)"}.`,
			);
		}
		translator = new Rosetta({ ...engine, apiKey: engine.apiKey });
	}

	const persist = (job: Job, text: string | undefined) => {
		if (text !== undefined)
			writeFileAtomic(join(project.root, job.targetFile), text);
		lock.files[job.sourceFile] ??= {};
		lock.files[job.sourceFile][job.locale] = nextLockEntries(job.items);
		writeLock(project.lockPath, lock);
	};

	const results = await Promise.all(
		jobs.map(async (job): Promise<LocaleResult> => {
			const base = {
				locale: job.locale,
				sourceFile: job.sourceFile,
				file: job.targetFile,
				...counts(job.items, job.removed),
			};
			if (job.error) {
				const result = {
					...base,
					written: false,
					ok: false,
					errors: [{ key: "", rule: "parse" as const, message: job.error }],
				};
				options.onLocale?.(result);
				return result;
			}

			const pending = job.items.filter((item) => item.action === "translate");
			let translations: Record<string, string> = {};
			if (pending.length > 0 && translator) {
				const data = Object.fromEntries(
					pending.map((item) => [item.key, item.source as string]),
				);
				const response = await translator.translateEntries(data, {
					source: project.config.sourceLocale,
					target: job.locale,
					context: job.fileConfig.context,
					notes: notesFor(Object.keys(data), job.sourceNotes),
				});
				usage.requests += response.usage.requests;
				usage.inputTokens += response.usage.inputTokens;
				usage.outputTokens += response.usage.outputTokens;
				if (response.failures.length > 0) {
					const result = {
						...base,
						written: false,
						ok: false,
						errors: response.failures,
					};
					options.onLocale?.(result);
					return result;
				}
				translations = response.translations;
			}

			const text = render(job, translations);
			const changed = text !== job.targetText;
			persist(job, changed ? text : undefined);
			const result = { ...base, written: changed, ok: true, errors: [] };
			options.onLocale?.(result);
			return result;
		}),
	);

	if (pruneLock(projectPlan, project)) writeLock(project.lockPath, lock);

	return {
		command: "push",
		ok: results.every((result) => result.ok),
		locales: results,
		usage,
	};
}

/**
 * Verify every target is up to date without calling a model: lock hashes
 * match, no missing/empty/extra keys, every value passes validation.
 */
export function check(
	project: Project,
	options: Omit<RunOptions, "keys" | "force"> = {},
): CheckResult {
	const { jobs } = plan(project, options);
	const locales = jobs.map((job): CheckLocaleResult => {
		const base = {
			locale: job.locale,
			sourceFile: job.sourceFile,
			file: job.targetFile,
		};
		if (job.error) return { ...base, ok: false, stale: [], error: job.error };

		const stale: StaleEntry[] = [];
		for (const item of job.items) {
			if (item.action === "translate") {
				stale.push({
					key: item.key,
					reason:
						item.reason === "invalid"
							? "invalid"
							: item.reason === "changed"
								? "changed"
								: "missing",
					message: item.issues?.map((issue) => issue.message).join("; "),
				});
			} else if (item.action === "adopt") {
				stale.push({ key: item.key, reason: "untracked" });
			} else if (item.action === "copy" && item.target !== item.source) {
				stale.push({ key: item.key, reason: "copy" });
			}
		}
		for (const key of job.removed) stale.push({ key, reason: "extra" });
		if (
			!job.targetExists &&
			stale.length === 0 &&
			job.items.some((i) => i.action !== "omit")
		) {
			stale.push({
				key: "",
				reason: "missing",
				message: "target file does not exist",
			});
		}
		return { ...base, ok: stale.length === 0, stale };
	});
	return { command: "check", ok: locales.every((l) => l.ok), locales };
}

/** Delete a locale's target files and lock entries. */
export function purge(project: Project, locale: string): { deleted: string[] } {
	const { jobs, lock } = plan(project, { locales: [locale] });
	const deleted: string[] = [];
	for (const job of jobs) {
		const path = join(project.root, job.targetFile);
		if (existsSync(path)) {
			rmSync(path);
			deleted.push(job.targetFile);
		}
	}
	for (const locales of Object.values(lock.files)) delete locales[locale];
	writeLock(project.lockPath, lock);
	return { deleted };
}
