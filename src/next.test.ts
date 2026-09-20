import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
	unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { Rosetta } from "./index";
import { cachedTranslate, createRosetta, getRosetta } from "./next";

function jsonResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
	});
}

beforeEach(() => {
	process.env.OPENROUTER_API_KEY = "sk-test";
	delete process.env.ROSETTA_MODEL;
	delete process.env.ROSETTA_BASE_URL;
	delete process.env.ROSETTA_BRAND_VOICE;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createRosetta", () => {
	it("throws without an API key", () => {
		delete process.env.OPENROUTER_API_KEY;
		expect(() => createRosetta()).toThrow(/OPENROUTER_API_KEY/);
	});

	it("reads model, baseURL, and brand voice from env", () => {
		process.env.ROSETTA_MODEL = "openai/gpt-5";
		process.env.ROSETTA_BASE_URL = "https://api.example.com/v1";
		process.env.ROSETTA_BRAND_VOICE = "Editorial.";
		const rosetta = createRosetta();
		expect(rosetta).toBeInstanceOf(Rosetta);
	});

	it("prefers overrides over env", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse('{"a":"[x]A"}'));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = createRosetta({
			model: "override/model",
			baseURL: "https://override.example/v1",
		});
		await rosetta.translate({ a: "A" }, { source: "en", target: "es" });

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://override.example/v1/chat/completions");
	});
});

describe("getRosetta", () => {
	it("memoizes a single instance", () => {
		const first = getRosetta();
		const second = getRosetta();
		expect(first).toBe(second);
	});
});

describe("cachedTranslate", () => {
	it("translates through the cached wrapper", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse('{"a":"[es]A"}')),
		);

		const result = await cachedTranslate(
			{ a: "A" },
			{ source: "en", target: "es" },
		);
		expect(result).toEqual({ a: "[es]A" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
