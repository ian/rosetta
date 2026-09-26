export interface BrandVoice {
	/**
	 * Free-form briefing: tone, formality, audience, conventions. One text per
	 * target locale; `*` is the fallback for locales without their own text.
	 */
	variations: Record<string, string>;
}

/**
 * Exact term mappings per locale: `{ [locale]: { [sourceTerm]: rendering } }`.
 * Terms under `*` are kept verbatim in every locale (do-not-translate).
 */
export type Glossary = Record<string, Record<string, string>>;

export interface RosettaConfig {
	/** API key for the OpenAI-compatible endpoint. */
	apiKey: string;
	/** Model id (e.g. `z-ai/glm-5.3-flash` via OpenRouter). */
	model: string;
	/** OpenAI-compatible chat completions endpoint. */
	baseURL?: string;
	/** Brand voice: tone + conventions per locale. */
	brandVoice: BrandVoice;
	/** Linguistic rules appended to every prompt. */
	rules?: string[];
	/** Exact term mappings per locale — highest precedence. */
	glossary?: Glossary;
	/** Sampling temperature (default 0.3 for translation consistency). */
	temperature?: number;
	/** Max keys per LLM request (default 25). */
	batchSize?: number;
	/** Max requests in flight across all translate calls (default 4). */
	concurrency?: number;
	/** Retries per request and per failing key (default 2). */
	retries?: number;
	/** Per-request timeout in milliseconds (default 120000). */
	timeoutMs?: number;
	/**
	 * What `translate()` does when keys still fail after retries:
	 * `"throw"` (default) raises `RosettaValidationError`; `"skip"` logs and
	 * returns only the keys that succeeded (the 0.x behavior).
	 */
	onBatchError?: "throw" | "skip";
}

export interface TranslateDataOptions {
	source: string;
	target: string;
	/** Broad context: product surface, audience, purpose. */
	context?: string;
	/** Per-key hints that disambiguate short or overloaded text. */
	hints?: Record<string, string[]>;
	/** Per-key translator notes (e.g. from JSONC comments). */
	notes?: Record<string, string>;
}

export interface TranslateTextOptions {
	source: string;
	target: string;
	/** Broad context for this translation. */
	context?: string;
}

/** A single validation or request problem with a translated key. */
export interface TranslationIssue {
	key: string;
	rule:
		| "missing"
		| "type"
		| "placeholder"
		| "icu"
		| "tags"
		| "syntax"
		| "request"
		| "parse";
	message: string;
}

export interface TranslationUsage {
	requests: number;
	inputTokens: number;
	outputTokens: number;
}

export interface TranslateEntriesResult {
	/** Validated translations, keyed like the input. */
	translations: Record<string, string>;
	/** Keys that still failed after retries, with the last problem seen. */
	failures: TranslationIssue[];
	usage: TranslationUsage;
}

/** The surface the workflow needs from a translation engine (real or fake). */
export interface Translator {
	translateEntries(
		data: Record<string, string>,
		options: TranslateDataOptions,
	): Promise<TranslateEntriesResult>;
}
