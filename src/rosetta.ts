import { buildDataPrompt, buildSystemPrompt } from "./prompt";
import type {
	RosettaConfig,
	TranslateDataOptions,
	TranslateEntriesResult,
	TranslateTextOptions,
	TranslationIssue,
	TranslationUsage,
	Translator,
} from "./types";
import { validateTranslation } from "./validate";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatCompletion {
	choices?: Array<{ message?: { content?: string } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Thrown by `translate()` when keys still fail after retries. */
export class RosettaValidationError extends Error {
	constructor(
		readonly failures: TranslationIssue[],
		readonly partial: Record<string, string>,
	) {
		const sample = failures
			.slice(0, 5)
			.map((f) => `${f.key} (${f.rule}: ${f.message})`)
			.join("; ");
		super(
			`Rosetta: ${failures.length} key(s) failed: ${sample}${failures.length > 5 ? "; …" : ""}`,
		);
		this.name = "RosettaValidationError";
	}
}

/** A request that can't succeed by retrying (auth, bad model, 4xx). */
export class RosettaRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RosettaRequestError";
	}
}

/** Approximate character budget of source text per request. */
const MAX_BATCH_CHARS = 8000;

class Limiter {
	private active = 0;
	private queue: Array<() => void> = [];

	constructor(private readonly size: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.size) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Extract a JSON object from a model reply: tolerates markdown code fences
 * and leading/trailing prose around a single object.
 */
export function parseModelJson(content: string): Record<string, unknown> {
	let text = content.trim();
	const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(text);
	if (fenced) text = fenced[1].trim();
	if (!text.startsWith("{")) {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start !== -1 && end > start) text = text.slice(start, end + 1);
	}
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("model reply is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Split keys into batches bounded by key count and source characters. */
function toBatches(
	keys: string[],
	data: Record<string, string>,
	batchSize: number,
): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let chars = 0;
	for (const key of keys) {
		const size = key.length + (data[key]?.length ?? 0);
		if (
			current.length > 0 &&
			(current.length >= batchSize || chars + size > MAX_BATCH_CHARS)
		) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(key);
		chars += size;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * Rosetta — self-hosted AI translation engine.
 *
 * Translates key-value content across locales through any OpenAI-compatible
 * LLM, with brand voice, rules, and glossary applied on every call. Every
 * translated value is validated (placeholders, ICU, tags); invalid or missing
 * keys are retried on their own before being reported.
 */
export class Rosetta implements Translator {
	private config: RosettaConfig;
	private limiter: Limiter;
	private jsonMode = true;

	constructor(config: RosettaConfig) {
		if (!config.apiKey) throw new Error("Rosetta: apiKey is required");
		if (!config.model) throw new Error("Rosetta: model is required");
		this.config = config;
		this.limiter = new Limiter(Math.max(1, config.concurrency ?? 4));
	}

	/** Translate a single text string. */
	async translateText(
		text: string,
		options: TranslateTextOptions,
	): Promise<string> {
		const system = buildSystemPrompt({
			brandVoice: this.config.brandVoice,
			glossary: this.config.glossary,
			rules: this.config.rules,
			source: options.source,
			target: options.target,
		});

		const res = await this.limiter.run(() =>
			this.chat(
				[
					{ role: "system", content: system },
					{
						role: "user",
						content: options.context
							? `${text}\n\nContext: ${options.context}`
							: text,
					},
				],
				false,
			),
		);

		if (!res.ok) {
			throw new Error(`Rosetta: ${res.status} ${await res.text()}`);
		}
		const json = (await res.json()) as ChatCompletion;
		return (json.choices?.[0]?.message?.content ?? "").trim();
	}

	/**
	 * Translate a key-value payload. Throws `RosettaValidationError` if any key
	 * still fails after retries, unless `onBatchError: "skip"` is configured —
	 * then failures are logged and only successful keys are returned.
	 *
	 * Non-string values are passed through unchanged.
	 */
	async translate(
		data: Record<string, unknown>,
		options: TranslateDataOptions,
	): Promise<Record<string, unknown>> {
		const strings: Record<string, string> = {};
		const passthrough: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (typeof value === "string") strings[key] = value;
			else passthrough[key] = value;
		}

		const result = await this.translateEntries(strings, options);
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(data)) {
			if (key in passthrough) output[key] = passthrough[key];
			else if (key in result.translations) {
				output[key] = result.translations[key];
			}
		}

		if (result.failures.length > 0) {
			if (this.config.onBatchError === "skip") {
				console.error(
					`[rosetta] ${result.failures.length} key(s) failed and were skipped:`,
					result.failures
						.slice(0, 5)
						.map((f) => f.key)
						.join(", "),
				);
			} else {
				throw new RosettaValidationError(result.failures, result.translations);
			}
		}
		return output;
	}

	/**
	 * Translate string entries, validating every value. Never throws for
	 * per-key problems — they're returned in `failures`. Throws
	 * `RosettaRequestError` for unrecoverable request errors (e.g. 401).
	 */
	async translateEntries(
		data: Record<string, string>,
		options: TranslateDataOptions,
	): Promise<TranslateEntriesResult> {
		const retries = this.config.retries ?? 2;
		const usage: TranslationUsage = {
			requests: 0,
			inputTokens: 0,
			outputTokens: 0,
		};
		const translations: Record<string, string> = {};
		const lastIssue = new Map<string, TranslationIssue>();

		let pending = Object.keys(data);
		let batchSize = Math.max(1, this.config.batchSize ?? 25);

		for (let round = 0; round <= retries && pending.length > 0; round++) {
			const batches = toBatches(pending, data, batchSize);
			const failed: string[] = [];

			await Promise.all(
				batches.map(async (keys) => {
					const batch = Object.fromEntries(keys.map((k) => [k, data[k]]));
					let reply: Record<string, unknown>;
					try {
						reply = await this.requestBatch(batch, options, usage);
					} catch (error) {
						if (error instanceof RosettaRequestError) throw error;
						const message =
							error instanceof Error ? error.message : String(error);
						const rule = error instanceof SyntaxError ? "parse" : "request";
						for (const key of keys) {
							lastIssue.set(key, { key, rule, message: message.slice(0, 200) });
							failed.push(key);
						}
						return;
					}

					for (const key of keys) {
						if (!(key in reply)) {
							lastIssue.set(key, {
								key,
								rule: "missing",
								message: "key missing from model reply",
							});
							failed.push(key);
							continue;
						}
						const issues = validateTranslation(data[key], reply[key]);
						if (issues.length > 0) {
							lastIssue.set(key, { key, ...issues[0] });
							failed.push(key);
							continue;
						}
						translations[key] = reply[key] as string;
						lastIssue.delete(key);
					}
				}),
			);

			pending = failed;
			batchSize = Math.max(1, Math.ceil(batchSize / 2));
		}

		const failures = pending.map(
			(key) =>
				lastIssue.get(key) ?? {
					key,
					rule: "request" as const,
					message: "failed",
				},
		);
		return { translations, failures, usage };
	}

	/** One batch request, with transport-level retries and JSON-mode fallback. */
	private async requestBatch(
		batch: Record<string, string>,
		options: TranslateDataOptions,
		usage: TranslationUsage,
	): Promise<Record<string, unknown>> {
		const retries = this.config.retries ?? 2;
		const system = buildSystemPrompt({
			brandVoice: this.config.brandVoice,
			glossary: this.config.glossary,
			rules: this.config.rules,
			source: options.source,
			target: options.target,
			mode: "json",
		});
		const user = buildDataPrompt(batch, {
			...options,
			hints: options.hints
				? Object.fromEntries(
						Object.keys(batch).map((key) => [key, options.hints?.[key] ?? []]),
					)
				: undefined,
		});
		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			{ role: "user", content: user },
		];

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			let res: Response;
			try {
				res = await this.limiter.run(() => this.chat(messages, this.jsonMode));
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < retries) await sleep(this.backoff(attempt));
				continue;
			}
			usage.requests++;

			if (res.ok) {
				const json = (await res.json()) as ChatCompletion;
				usage.inputTokens += json.usage?.prompt_tokens ?? 0;
				usage.outputTokens += json.usage?.completion_tokens ?? 0;
				return parseModelJson(json.choices?.[0]?.message?.content ?? "");
			}

			const body = await res.text();
			if (
				this.jsonMode &&
				(res.status === 400 || res.status === 422) &&
				/response_format|json_object|json mode|json_schema/i.test(body)
			) {
				// Provider doesn't support JSON mode: drop it for the rest of the run.
				this.jsonMode = false;
				attempt--;
				continue;
			}
			if (res.status === 429 || res.status >= 500) {
				lastError = new Error(`Rosetta: ${res.status} ${body.slice(0, 200)}`);
				if (attempt < retries) {
					await sleep(
						retryAfterMs(res.headers.get("retry-after")) ??
							this.backoff(attempt),
					);
				}
				continue;
			}
			throw new RosettaRequestError(
				res.status,
				`Rosetta: ${res.status} ${body.slice(0, 300)}`,
			);
		}
		throw lastError ?? new Error("Rosetta: request failed");
	}

	private backoff(attempt: number): number {
		return (
			Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250)
		);
	}

	private async chat(
		messages: ChatMessage[],
		jsonMode: boolean,
	): Promise<Response> {
		const baseURL = this.config.baseURL ?? "https://openrouter.ai/api/v1";
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("Rosetta: request timed out")),
			this.config.timeoutMs ?? 120_000,
		);
		try {
			return await fetch(`${baseURL}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.config.model,
					temperature: this.config.temperature ?? 0.3,
					messages,
					...(jsonMode ? { response_format: { type: "json_object" } } : {}),
				}),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	}
}
