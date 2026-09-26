import type { BrandVoice, Glossary, TranslateDataOptions } from "./types";

/**
 * Builds the system prompt for a translation request, in precedence order:
 * brand voice, rules, glossary, then the output-shape instructions.
 *
 * `mode: "text"` is for single strings (`translateText`); `mode: "json"` is
 * for key-value batches, where the reply must be a JSON object.
 */
export function buildSystemPrompt(options: {
	brandVoice: BrandVoice;
	glossary?: Glossary;
	rules?: string[];
	source: string;
	target: string;
	mode?: "text" | "json";
}): string {
	const {
		brandVoice,
		glossary,
		rules,
		source,
		target,
		mode = "text",
	} = options;

	const parts: string[] = [
		brandVoice.variations[target] ?? brandVoice.variations["*"] ?? "",
	];

	if (rules && rules.length > 0) {
		parts.push(`Rules:\n${rules.map((rule) => `- ${rule}`).join("\n")}`);
	}

	const terms = glossary?.[target];
	if (terms && Object.keys(terms).length > 0) {
		parts.push(
			`Glossary (use these exact renderings):\n${Object.entries(terms)
				.map(([src, tgt]) => `- "${src}" -> ${tgt}`)
				.join("\n")}`,
		);
	}
	const keep = glossary?.["*"];
	if (keep && Object.keys(keep).length > 0) {
		parts.push(
			`Never translate these terms; keep them exactly as written: ${Object.keys(
				keep,
			)
				.map((term) => `"${term}"`)
				.join(", ")}.`,
		);
	}

	parts.push(
		mode === "json"
			? `Translate from ${source} to ${target}. You will receive a JSON object. Return ONLY a JSON object with exactly the same keys and translated string values — no markdown, no code fences, no commentary. Keep {placeholders}, ICU syntax ({count, plural, one {...} other {...}}, select, #) and <tags>…</tags> intact, translating only the human-readable text. Use the plural categories that are correct for ${target}.`
			: `Translate from ${source} to ${target}. Return ONLY the translated text — no explanations, no quotes around it.`,
	);

	return parts.filter(Boolean).join("\n\n");
}

/**
 * Builds the user prompt for a key-value payload translation. The JSON
 * payload is always the last block.
 */
export function buildDataPrompt(
	data: Record<string, unknown>,
	options: TranslateDataOptions,
): string {
	const lines = [
		`Translate the values of this JSON object from ${options.source} to ${options.target}. Keep every key exactly as provided — return a JSON object with identical keys and translated values. Preserve {placeholders}, ICU plural/select syntax, and <tags> intact, translating only the inner text. Output ONLY the JSON.`,
	];

	if (options.context) {
		lines.push(`Context: ${options.context}`);
	}

	if (options.notes) {
		const notes = Object.entries(options.notes)
			.filter(([key, note]) => note && key in data)
			.map(([key, note]) => `- ${key}: ${note}`)
			.join("\n");
		if (notes) lines.push(`Translator notes:\n${notes}`);
	}

	if (options.hints) {
		const hints = Object.entries(options.hints)
			.filter(([key, breadcrumb]) => breadcrumb.length > 0 && key in data)
			.map(([key, breadcrumb]) => `- ${key}: ${breadcrumb.join(" > ")}`)
			.join("\n");
		if (hints) lines.push(`Key disambiguation:\n${hints}`);
	}

	lines.push(JSON.stringify(data, null, 1));

	return lines.join("\n\n");
}
