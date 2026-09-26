import { describe, expect, it } from "vitest";
import { buildDataPrompt, buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
	const brandVoice = {
		variations: {
			"*": "Default voice.",
			es: "Voz en español.",
		},
	};

	it("uses the locale-specific brand voice when present", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			source: "en",
			target: "es",
		});
		expect(prompt).toContain("Voz en español.");
		expect(prompt).not.toContain("Default voice.");
	});

	it("falls back to the wildcard voice for unknown locales", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			source: "en",
			target: "de",
		});
		expect(prompt).toContain("Default voice.");
	});

	it("includes glossary terms for the target locale", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			glossary: { es: { "award-winning": "premiado" } },
			source: "en",
			target: "es",
		});
		expect(prompt).toContain("Glossary (use these exact renderings):");
		expect(prompt).toContain('- "award-winning" -> premiado');
	});

	it("omits the glossary block when the target has no terms", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			glossary: { es: { "award-winning": "premiado" } },
			source: "en",
			target: "fr",
		});
		expect(prompt).not.toContain("Glossary");
	});

	it("states the source and target and the output-shape rule", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			source: "en",
			target: "pt-BR",
		});
		expect(prompt).toContain("Translate from en to pt-BR.");
		expect(prompt).toContain("Return ONLY the translated text");
	});
});

describe("buildDataPrompt", () => {
	it("embeds the JSON payload and the key-preservation rule", () => {
		const prompt = buildDataPrompt(
			{ hero: "Every awarded restaurant" },
			{ source: "en", target: "es" },
		);
		expect(prompt).toContain("Keep every key exactly as provided");
		expect(prompt).toContain("Preserve {placeholders}");
		expect(prompt).toContain('"hero": "Every awarded restaurant"');
	});

	it("includes context when provided", () => {
		const prompt = buildDataPrompt(
			{ hero: "Hello" },
			{ source: "en", target: "es", context: "restaurant listing" },
		);
		expect(prompt).toContain("Context: restaurant listing");
	});

	it("formats per-key hints as breadcrumbs", () => {
		const prompt = buildDataPrompt(
			{ hero: "Hello" },
			{
				source: "en",
				target: "es",
				hints: { hero: ["home", "top banner"] },
			},
		);
		expect(prompt).toContain("Key disambiguation:");
		expect(prompt).toContain("- hero: home > top banner");
	});

	it("omits the disambiguation block when there are no hints", () => {
		const prompt = buildDataPrompt(
			{ hero: "Hello" },
			{ source: "en", target: "es" },
		);
		expect(prompt).not.toContain("Key disambiguation");
	});
});

describe("v1 prompt additions", () => {
	const brandVoice = { variations: { "*": "Voice." } };

	it("adds rules and do-not-translate glossary terms", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			rules: ["Use sentence case."],
			glossary: {
				"*": { Jot: "Jot", Quip: "Quip" },
				ja: { workspace: "ワークスペース" },
			},
			source: "en",
			target: "ja",
		});
		expect(prompt).toContain("Rules:\n- Use sentence case.");
		expect(prompt).toContain('- "workspace" -> ワークスペース');
		expect(prompt).toContain('keep them exactly as written: "Jot", "Quip"');
		expect(prompt.indexOf("Rules:")).toBeLessThan(prompt.indexOf("Glossary"));
	});

	it("uses JSON output instructions in json mode", () => {
		const prompt = buildSystemPrompt({
			brandVoice,
			source: "en",
			target: "ar",
			mode: "json",
		});
		expect(prompt).toContain("Return ONLY a JSON object");
		expect(prompt).toContain("plural categories that are correct for ar");
		expect(prompt).not.toContain("Return ONLY the translated text");
	});

	it("includes translator notes for keys in the batch only", () => {
		const prompt = buildDataPrompt(
			{ save: "Save" },
			{
				source: "en",
				target: "es",
				notes: { save: "Button label", other: "unused" },
			},
		);
		expect(prompt).toContain("Translator notes:\n- save: Button label");
		expect(prompt).not.toContain("unused");
		expect(prompt.trim().endsWith("}")).toBe(true);
	});
});
