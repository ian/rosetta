import type {
	RosettaConfig,
	TranslateDataOptions,
	TranslateTextOptions,
} from "./config";
import { buildDataPrompt, buildSystemPrompt } from "./prompt";

export type {
	RosettaConfig,
	TranslateDataOptions,
	TranslateTextOptions,
} from "./config";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * Rosetta — self-hosted AI translation engine.
 *
 * Translates key-value content across locales through any OpenAI-compatible
 * LLM, with brand voice, glossary, and per-locale rules applied on every
 * call. Works with OpenRouter, direct Anthropic/OpenAI, or any
 * OpenAI-compatible endpoint.
 *
 * Non-throwing at the batch level: failed batches are logged and skipped, so
 * partial translations degrade gracefully to the source locale.
 */
export class Rosetta {
	private config: RosettaConfig;

	constructor(config: RosettaConfig) {
		if (!config.apiKey) throw new Error("Rosetta: apiKey is required");
		if (!config.model) throw new Error("Rosetta: model is required");
		this.config = config;
	}

	/** Translate a single text string. */
	async translateText(
		text: string,
		options: TranslateTextOptions,
	): Promise<string> {
		const system = buildSystemPrompt({
			brandVoice: this.config.brandVoice,
			glossary: this.config.glossary,
			source: options.source,
			target: options.target,
		});

		const res = await this.chat([
			{ role: "system", content: system },
			{
				role: "user",
				content: options.context
					? `${text}\n\nContext: ${options.context}`
					: text,
			},
		]);

		if (!res.ok) {
			throw new Error(`Rosetta: ${res.status} ${await res.text()}`);
		}
		const json = (await res.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		return json.choices[0].message.content.trim();
	}

	/**
	 * Translate a key-value payload, batched with concurrency. Failed batches
	 * are logged and skipped — the returned object carries only successfully
	 * translated keys, letting the caller fall back to the source locale for
	 * the rest.
	 */
	async translate(
		data: Record<string, unknown>,
		options: TranslateDataOptions,
	): Promise<Record<string, unknown>> {
		const batchSize = this.config.batchSize ?? 25;
		const concurrency = this.config.concurrency ?? 4;
		const keys = Object.keys(data);
		const output: Record<string, unknown> = {};

		for (let i = 0; i < keys.length; i += batchSize * concurrency) {
			const chunk = keys.slice(i, i + batchSize * concurrency);
			const batches = Array.from(
				{ length: Math.ceil(chunk.length / batchSize) },
				(_, b) => {
					const batchKeys = chunk.slice(b * batchSize, (b + 1) * batchSize);
					const batch = Object.fromEntries(batchKeys.map((k) => [k, data[k]]));
					return { batch, batchKeys };
				},
			);

			const results = await Promise.allSettled(
				batches.map(({ batch, batchKeys }) =>
					this.translateBatch(batch, options, batchKeys),
				),
			);

			for (let b = 0; b < results.length; b++) {
				const result = results[b];
				if (result.status !== "fulfilled") {
					console.error(
						`[rosetta] batch failed (${batches[b].batchKeys.length} keys):`,
						result.reason?.message?.slice(0, 120),
					);
					continue;
				}
				Object.assign(output, result.value);
			}
		}

		return output;
	}

	private async translateBatch(
		batch: Record<string, unknown>,
		options: TranslateDataOptions,
		batchKeys: string[],
	): Promise<Record<string, unknown>> {
		const retries = this.config.retries ?? 2;
		const system = buildSystemPrompt({
			brandVoice: this.config.brandVoice,
			glossary: this.config.glossary,
			source: options.source,
			target: options.target,
		});

		const user = buildDataPrompt(batch, {
			...options,
			hints: options.hints
				? Object.fromEntries(
						batchKeys.map((key) => [key, options.hints?.[key] ?? []]),
					)
				: undefined,
		});

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await this.chat([
					{ role: "system", content: system },
					{ role: "user", content: user },
				]);
				if (!res.ok) {
					throw new Error(`Rosetta: ${res.status} ${await res.text()}`);
				}
				const json = (await res.json()) as {
					choices: Array<{ message: { content: string } }>;
				};
				return JSON.parse(json.choices[0].message.content);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < retries) {
					await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
				}
			}
		}
		throw lastError ?? new Error("Rosetta: batch failed");
	}

	private async chat(messages: ChatMessage[]): Promise<Response> {
		const baseURL = this.config.baseURL ?? "https://openrouter.ai/api/v1";
		return fetch(`${baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.config.model,
				temperature: this.config.temperature ?? 0.3,
				messages,
			}),
		});
	}
}
