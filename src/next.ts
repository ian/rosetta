import { unstable_cache } from "next/cache";
import { Rosetta } from "./rosetta";
import type { RosettaConfig, TranslateDataOptions } from "./types";

export type { RosettaConfig, TranslateDataOptions } from "./types";

/**
 * Build a server-side Rosetta instance. Config comes from `overrides` first,
 * then the environment:
 *
 * - `OPENROUTER_API_KEY` — required
 * - `ROSETTA_MODEL` — default `anthropic/claude-sonnet-4.5`
 * - `ROSETTA_BASE_URL` — any OpenAI-compatible endpoint
 * - `ROSETTA_BRAND_VOICE` — default `*` brand voice briefing
 *
 * Import this only from server code — add `import "server-only"` at the top of
 * the module that calls it.
 */
export function createRosetta(overrides: Partial<RosettaConfig> = {}): Rosetta {
	const apiKey = overrides.apiKey ?? process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error("rosetta-i18n: set OPENROUTER_API_KEY or pass apiKey.");
	}

	return new Rosetta({
		apiKey,
		model:
			overrides.model ??
			process.env.ROSETTA_MODEL ??
			"anthropic/claude-sonnet-4.5",
		baseURL: overrides.baseURL ?? process.env.ROSETTA_BASE_URL,
		brandVoice: overrides.brandVoice ?? {
			variations: {
				"*": process.env.ROSETTA_BRAND_VOICE ?? "",
			},
		},
		glossary: overrides.glossary,
		temperature: overrides.temperature,
		batchSize: overrides.batchSize,
		concurrency: overrides.concurrency,
		retries: overrides.retries,
	});
}

let instance: Rosetta | undefined;

/** Memoized `createRosetta()` for the current server process. */
export function getRosetta(): Rosetta {
	if (!instance) {
		instance = createRosetta();
	}
	return instance;
}

export interface CacheOptions {
	/** Seconds to cache for, or `false` to cache indefinitely. */
	revalidate?: number | false;
	/** Cache tags for on-demand revalidation. */
	tags?: string[];
}

/**
 * Translate a payload behind Next's data cache, keyed on the source/target and
 * payload. Repeated renders reuse the cached result instead of re-calling the
 * model.
 */
export function cachedTranslate(
	data: Record<string, unknown>,
	options: TranslateDataOptions,
	cache: CacheOptions = {},
): Promise<Record<string, unknown>> {
	const run = unstable_cache(
		() => getRosetta().translate(data, options),
		[
			"rosetta",
			options.source,
			options.target,
			options.context ?? "",
			JSON.stringify(data),
		],
		{
			revalidate: cache.revalidate ?? 60 * 60 * 24,
			tags: cache.tags,
		},
	);
	return run();
}
