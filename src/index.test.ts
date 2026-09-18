import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosettaConfig } from "./config";
import { Rosetta } from "./index";

const baseConfig: RosettaConfig = {
	apiKey: "test-key",
	model: "test/model",
	brandVoice: { variations: { "*": "Voice." } },
};

function contentResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Replies with the request payload, values upper-cased. */
function echoUpper(): ReturnType<typeof vi.fn> {
	return vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		const segments = (body.messages[1].content as string).split("\n\n");
		const payload = JSON.parse(segments[segments.length - 1]);
		const translated = Object.fromEntries(
			Object.entries(payload).map(([key, value]) => [
				key,
				String(value).toUpperCase(),
			]),
		);
		return contentResponse(JSON.stringify(translated));
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("constructor", () => {
	it("throws without an apiKey", () => {
		expect(() => new Rosetta({ ...baseConfig, apiKey: "" })).toThrow(
			/apiKey is required/,
		);
	});

	it("throws without a model", () => {
		expect(() => new Rosetta({ ...baseConfig, model: "" })).toThrow(
			/model is required/,
		);
	});
});

describe("translateText", () => {
	it("returns trimmed content and sends model + temperature", async () => {
		const fetchMock = vi.fn().mockResolvedValue(contentResponse("  Hola  "));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta(baseConfig);
		const result = await rosetta.translateText("Hello", {
			source: "en",
			target: "es",
		});

		expect(result).toBe("Hola");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe("test/model");
		expect(body.temperature).toBe(0.3);
		expect(body.messages).toHaveLength(2);
	});

	it("appends context to the user message", async () => {
		const fetchMock = vi.fn().mockResolvedValue(contentResponse("Hola"));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta(baseConfig);
		await rosetta.translateText("Hello", {
			source: "en",
			target: "es",
			context: "hero banner",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.messages[1].content).toBe("Hello\n\nContext: hero banner");
	});

	it("throws on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(contentResponse("rate limited", 429)),
		);

		const rosetta = new Rosetta(baseConfig);
		await expect(
			rosetta.translateText("Hello", { source: "en", target: "es" }),
		).rejects.toThrow(/429/);
	});
});

describe("translate", () => {
	it("batches keys by batchSize and merges the results", async () => {
		const fetchMock = echoUpper();
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 2,
			concurrency: 1,
			retries: 0,
		});
		const result = await rosetta.translate(
			{ a: "a", b: "b", c: "c", d: "d", e: "e" },
			{ source: "en", target: "es" },
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result).toEqual({ a: "A", b: "B", c: "C", d: "D", e: "E" });
	});

	it("skips a failed batch and keeps the successful keys", async () => {
		const fetchMock = echoUpper();
		fetchMock.mockRejectedValueOnce(new Error("network"));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 1,
			concurrency: 1,
			retries: 0,
		});
		const result = await rosetta.translate(
			{ a: "a", b: "b" },
			{ source: "en", target: "es" },
		);

		expect(result).toEqual({ b: "B" });
	});

	it("retries a transient failure before succeeding", async () => {
		vi.useFakeTimers();
		const fetchMock = echoUpper();
		fetchMock.mockRejectedValueOnce(new Error("transient"));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 25,
			concurrency: 1,
			retries: 1,
		});
		const pending = rosetta.translate(
			{ a: "a" },
			{ source: "en", target: "es" },
		);
		await vi.runAllTimersAsync();

		await expect(pending).resolves.toEqual({ a: "A" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sends context and only the batch's hints", async () => {
		const fetchMock = echoUpper();
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 1,
			concurrency: 1,
			retries: 0,
		});
		await rosetta.translate(
			{ a: "a" },
			{
				source: "en",
				target: "es",
				context: "restaurant blurb",
				hints: { a: ["restaurant", "header"], z: ["unused"] },
			},
		);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		const user = body.messages[1].content as string;
		expect(user).toContain("Context: restaurant blurb");
		expect(user).toContain("- a: restaurant > header");
		expect(user).not.toContain("unused");
	});

	it("supports a custom baseURL", async () => {
		const fetchMock = echoUpper();
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			baseURL: "https://api.example.com/v1",
			batchSize: 25,
			concurrency: 1,
			retries: 0,
		});
		await rosetta.translate({ a: "a" }, { source: "en", target: "es" });

		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.example.com/v1/chat/completions");
	});
});
