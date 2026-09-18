export interface BrandVoice {
	/**
	 * Free-form briefing: tone, formality, audience, conventions. One text per
	 * target locale; `*` is the fallback for locales without their own text.
	 */
	variations: Record<string, string>;
}

export type Glossary = Record<string, Record<string, string>>;

export interface RosettaConfig {
	/** API key for the OpenAI-compatible endpoint. */
	apiKey: string;
	/** Model id (e.g. `anthropic/claude-sonnet-4.5` via OpenRouter). */
	model: string;
	/** OpenAI-compatible chat completions endpoint. */
	baseURL?: string;
	/** Brand voice: tone + conventions per locale. */
	brandVoice: BrandVoice;
	/** Exact term mappings per locale — highest precedence. */
	glossary?: Glossary;
	/** Sampling temperature (default 0.3 for translation consistency). */
	temperature?: number;
	/** Keys per LLM request when translating large payloads. */
	batchSize?: number;
	/** Parallel batch requests in flight. */
	concurrency?: number;
	/** Retries per batch on failure. */
	retries?: number;
}

export interface TranslateDataOptions {
	source: string;
	target: string;
	/** Broad context: product surface, audience, purpose. */
	context?: string;
	/** Per-key hints that disambiguate short or overloaded text. */
	hints?: Record<string, string[]>;
}

export interface TranslateTextOptions {
	source: string;
	target: string;
	/** Broad context for this translation. */
	context?: string;
}
