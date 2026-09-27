import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseModelJson,
	Rosetta,
	RosettaRequestError,
	RosettaValidationError,
} from "./rosetta";
import type { RosettaConfig } from "./types";

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

	it("throws RosettaValidationError when keys still fail", async () => {
		const fetchMock = echoUpper();
		fetchMock.mockRejectedValueOnce(new Error("network"));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 1,
			concurrency: 1,
			retries: 0,
		});
		const error = await rosetta
			.translate({ a: "a", b: "b" }, { source: "en", target: "es" })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RosettaValidationError);
		expect((error as RosettaValidationError).failures).toEqual([
			{ key: "a", rule: "request", message: "network" },
		]);
		expect((error as RosettaValidationError).partial).toEqual({ b: "B" });
	});

	it('skips failed keys with onBatchError: "skip"', async () => {
		const fetchMock = echoUpper();
		fetchMock.mockRejectedValueOnce(new Error("network"));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const rosetta = new Rosetta({
			...baseConfig,
			batchSize: 1,
			concurrency: 1,
			retries: 0,
			onBatchError: "skip",
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

describe("parseModelJson", () => {
	it("parses bare JSON, fenced JSON, and JSON wrapped in prose", () => {
		expect(parseModelJson('{"a":"b"}')).toEqual({ a: "b" });
		expect(parseModelJson('```json\n{"a":"b"}\n```')).toEqual({ a: "b" });
		expect(parseModelJson('Here you go:\n{"a":"b"}\nThanks')).toEqual({
			a: "b",
		});
	});

	it("rejects non-objects", () => {
		expect(() => parseModelJson("[1]")).toThrow();
		expect(() => parseModelJson("nope")).toThrow();
	});
});

describe("translateEntries hardening", () => {
	const quick = { ...baseConfig, concurrency: 1, retries: 1 };

	it("sends JSON mode and accepts fenced replies", async () => {
		const fetchMock = vi.fn(async () =>
			contentResponse('```json\n{"a":"Hola"}\n```'),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new Rosetta(quick).translateEntries(
			{ a: "Hello" },
			{ source: "en", target: "es" },
		);
		expect(result.translations).toEqual({ a: "Hola" });
		const body = JSON.parse(
			(fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.messages[0].content).toContain("Return ONLY a JSON object");
	});

	it("falls back when the provider rejects response_format", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("response_format is not supported", { status: 400 }),
			)
			.mockResolvedValue(contentResponse('{"a":"Hola"}'));
		vi.stubGlobal("fetch", fetchMock);

		const rosetta = new Rosetta(quick);
		const result = await rosetta.translateEntries(
			{ a: "Hello" },
			{ source: "en", target: "es" },
		);
		expect(result.translations).toEqual({ a: "Hola" });
		const second = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(second.response_format).toBeUndefined();
	});

	it("retries only keys that fail validation, in smaller batches", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(contentResponse('{"a":"Hola","b":"Adiós"}'))
			.mockResolvedValueOnce(contentResponse('{"b":"Adiós {name}"}'));
		vi.stubGlobal("fetch", fetchMock);

		const result = await new Rosetta(quick).translateEntries(
			{ a: "Hello", b: "Bye {name}" },
			{ source: "en", target: "es" },
		);
		expect(result.translations).toEqual({ a: "Hola", b: "Adiós {name}" });
		expect(result.failures).toEqual([]);
		const retry = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(retry.messages[1].content).not.toContain('"a"');
	});

	it("reports keys that stay invalid", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => contentResponse('{"b":"Adiós"}')),
		);
		const result = await new Rosetta(quick).translateEntries(
			{ b: "Bye {name}" },
			{ source: "en", target: "es" },
		);
		expect(result.failures).toEqual([
			{ key: "b", rule: "placeholder", message: "missing placeholder {name}" },
		]);
	});

	it("reports keys missing from the reply", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => contentResponse("{}")),
		);
		const result = await new Rosetta({ ...quick, retries: 0 }).translateEntries(
			{ a: "Hello" },
			{ source: "en", target: "es" },
		);
		expect(result.failures[0].rule).toBe("missing");
	});

	it("honors Retry-After on 429", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("slow down", {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
			)
			.mockResolvedValue(contentResponse('{"a":"Hola"}'));
		vi.stubGlobal("fetch", fetchMock);

		const pending = new Rosetta(quick).translateEntries(
			{ a: "Hello" },
			{ source: "en", target: "es" },
		);
		await vi.advanceTimersByTimeAsync(6_900);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(200);
		await expect(pending).resolves.toMatchObject({
			translations: { a: "Hola" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("aborts immediately on unrecoverable errors like 401", async () => {
		const fetchMock = vi.fn(
			async () => new Response("bad key", { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new Rosetta(quick).translateEntries(
				{ a: "Hello" },
				{ source: "en", target: "es" },
			),
		).rejects.toBeInstanceOf(RosettaRequestError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("times out hung requests", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						);
					}),
			),
		);
		const pending = new Rosetta({
			...quick,
			retries: 0,
			timeoutMs: 1000,
		}).translateEntries({ a: "Hello" }, { source: "en", target: "es" });
		await vi.advanceTimersByTimeAsync(1001);
		await expect(pending).resolves.toMatchObject({
			failures: [
				{ key: "a", rule: "request", message: "Rosetta: request timed out" },
			],
		});
	});

	it("accumulates token usage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"a":"Hola"}' } }],
							usage: { prompt_tokens: 12, completion_tokens: 3 },
						}),
					),
			),
		);
		const result = await new Rosetta(quick).translateEntries(
			{ a: "Hello" },
			{ source: "en", target: "es" },
		);
		expect(result.usage).toEqual({
			requests: 1,
			inputTokens: 12,
			outputTokens: 3,
		});
	});
});
