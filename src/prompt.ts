import type { BrandVoice, Glossary, TranslateDataOptions } from "./config";

/**
 * Builds the system prompt for a translation request: brand voice, glossary
 * enforcement, locale conventions, and output-shape rules.
 */
export function buildSystemPrompt(options: {
	brandVoice: BrandVoice;
	glossary?: Glossary;
	source: string;
	target: string;
}): string {
	const { brandVoice, glossary, source, target } = options;

	const voice =
		brandVoice.variations[target] ?? brandVoice.variations["*"] ?? "";

	const parts = [voice];

	if (glossary) {
		const terms = glossary[target];
		if (terms && Object.keys(terms).length > 0) {
			parts.push(
				`Glossary (use these exact renderings):\n${Object.entries(terms)
					.map(([src, tgt]) => `- "${src}" -> ${tgt}`)
					.join("\n")}`,
			);
		}
	}

	parts.push(
		`Translate from ${source} to ${target}. Return ONLY the translated text — no explanations, no quotes around it.`,
	);

	return parts.filter(Boolean).join("\n\n");
}

/**
 * Builds the user prompt for a key-value payload translation.
 */
export function buildDataPrompt(
	data: Record<string, unknown>,
	options: TranslateDataOptions & { hints?: Record<string, string[]> },
): string {
	const lines = [
		`Translate the values of this JSON object from ${options.source} to ${options.target}. Keep every key exactly as provided — return a JSON object with identical keys and translated values. Preserve {placeholders} and ICU plural syntax (=1 {...} other {...}) intact, translating only the inner text. Output ONLY the JSON.`,
	];

	if (options.context) {
		lines.push(`Context: ${options.context}`);
	}

	if (options.hints) {
		const hints = Object.entries(options.hints)
			.map(([key, breadcrumb]) => `- ${key}: ${breadcrumb.join(" > ")}`)
			.join("\n");
		if (hints) {
			lines.push(`Key disambiguation:\n${hints}`);
		}
	}

	lines.push(JSON.stringify(data, null, 1));

	return lines.join("\n\n");
}
