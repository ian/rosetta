import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HELP,
	missingKeys,
	parseArgs,
	runCatalog,
	type TranslateClient,
} from "./cli";

function fakeClient(): TranslateClient {
	return {
		translate: vi.fn(async (data, options) =>
			Object.fromEntries(
				Object.entries(data).map(([key, value]) => [
					key,
					`[${options.target}]${String(value)}`,
				]),
			),
		),
	};
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "rosetta-cli-"));
}

describe("parseArgs", () => {
	it("returns HELP with no args or --help", () => {
		expect(parseArgs([])).toBe(HELP);
		expect(parseArgs(["--help"])).toBe(HELP);
	});

	it("parses targets and options", () => {
		const options = parseArgs([
			"translate-catalog",
			"messages/en.json",
			"--target",
			"es",
			"--target",
			"pt-BR",
			"--source",
			"en",
			"--merge",
			"--dry-run",
			"--batch-size",
			"10",
		]);
		expect(options).not.toBe(HELP);
		if (options === HELP) return;
		expect(options.targets).toEqual(["es", "pt-BR"]);
		expect(options.source).toBe("en");
		expect(options.merge).toBe(true);
		expect(options.dryRun).toBe(true);
		expect(options.batchSize).toBe(10);
		expect(options.input).toMatch(/messages\/en\.json$/);
	});

	it("defaults outDir to the input directory", () => {
		const options = parseArgs([
			"translate-catalog",
			"messages/en.json",
			"--target",
			"es",
		]);
		if (options === HELP) throw new Error("expected options");
		expect(options.outDir).toMatch(/messages$/);
	});

	it("rejects unknown commands, flags, and missing targets", () => {
		expect(() => parseArgs(["nope"])).toThrow(/Unknown command/);
		expect(() => parseArgs(["translate-catalog", "a.json", "--wat"])).toThrow(
			/Unknown flag/,
		);
		expect(() => parseArgs(["translate-catalog", "a.json"])).toThrow(
			/At least one --target/,
		);
		expect(() => parseArgs(["translate-catalog", "--target"])).toThrow(
			/Missing value/,
		);
	});
});

describe("missingKeys", () => {
	it("returns only keys absent from existing", () => {
		expect(missingKeys({ a: 1, b: 2, c: 3 }, { a: "x" })).toEqual({
			b: 2,
			c: 3,
		});
	});
});

describe("runCatalog", () => {
	const cleanup: string[] = [];

	afterEach(() => {
		cleanup.length = 0;
	});

	it("translates into each target and writes files", async () => {
		const dir = await tempDir();
		cleanup.push(dir);
		const input = join(dir, "en.json");
		await writeFile(input, JSON.stringify({ a: "Alpha", b: "Beta" }));

		const client = fakeClient();
		await runCatalog(
			{
				input,
				targets: ["es", "pt-BR"],
				source: "en",
				outDir: dir,
			},
			client,
		);

		await expect(readFile(join(dir, "es.json"), "utf8")).resolves.toContain(
			'"[es]Alpha"',
		);
		await expect(readFile(join(dir, "pt-BR.json"), "utf8")).resolves.toContain(
			'"[pt-BR]Beta"',
		);
		expect(client.translate).toHaveBeenCalledTimes(2);
	});

	it("merge only translates keys missing from the target file", async () => {
		const dir = await tempDir();
		const input = join(dir, "en.json");
		await writeFile(input, JSON.stringify({ a: "Alpha", b: "Beta" }));
		await writeFile(join(dir, "es.json"), JSON.stringify({ a: "[es]Alpha" }));

		const client = fakeClient();
		await runCatalog(
			{ input, targets: ["es"], source: "en", outDir: dir, merge: true },
			client,
		);

		expect(client.translate).toHaveBeenCalledWith(
			{ b: "Beta" },
			expect.objectContaining({ target: "es" }),
		);
		const written = JSON.parse(await readFile(join(dir, "es.json"), "utf8"));
		expect(written).toEqual({ a: "[es]Alpha", b: "[es]Beta" });
	});

	it("dry run does not call the client or write files", async () => {
		const dir = await tempDir();
		const input = join(dir, "en.json");
		await writeFile(input, JSON.stringify({ a: "Alpha" }));

		const client = fakeClient();
		await runCatalog(
			{ input, targets: ["es"], source: "en", outDir: dir, dryRun: true },
			client,
		);

		expect(client.translate).not.toHaveBeenCalled();
		await expect(readFile(join(dir, "es.json"), "utf8")).rejects.toThrow();
	});
});
