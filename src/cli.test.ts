import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIO, EXIT, parseCli, run, UsageError } from "./cli";
import { parseJsonc } from "./project/jsonc";
import type {
	TranslateDataOptions,
	TranslateEntriesResult,
	Translator,
} from "./types";

class FakeTranslator implements Translator {
	calls = 0;
	fail = new Set<string>();
	async translateEntries(
		data: Record<string, string>,
		options: TranslateDataOptions,
	): Promise<TranslateEntriesResult> {
		this.calls++;
		const translations: Record<string, string> = {};
		const failures: TranslateEntriesResult["failures"] = [];
		for (const [key, value] of Object.entries(data)) {
			if (this.fail.has(key))
				failures.push({ key, rule: "icu", message: "bad plural" });
			else translations[key] = `[${options.target}] ${value}`;
		}
		return {
			translations,
			failures,
			usage: { requests: 1, inputTokens: 100, outputTokens: 50 },
		};
	}
}

function sandbox(files: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "rosetta-cli-"));
	const write = (path: string, value: unknown) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(
			join(root, path),
			typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
		);
	};
	for (const [path, value] of Object.entries(files)) write(path, value);
	const translator = new FakeTranslator();
	const exec = async (argv: string[], io: Partial<CliIO> = {}) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await run(argv, {
			cwd: root,
			env: {},
			interactive: false,
			stdout: (t) => stdout.push(t),
			stderr: (t) => stderr.push(t),
			confirm: async () => true,
			translator,
			...io,
		});
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	};
	const read = (path: string) =>
		// biome-ignore lint/suspicious/noExplicitAny: loosely typed test fixture reads
		parseJsonc(readFileSync(join(root, path), "utf8")).value as any;
	return { root, write, read, exec, translator };
}

const CONFIG = {
	sourceLocale: "en",
	targetLocales: ["es", "ja"],
	files: [{ pattern: "messages/en.json" }],
	engine: { model: "test/model" },
};

describe("parseCli", () => {
	it("parses commands, positionals, repeatable and comma lists, and = values", () => {
		expect(
			parseCli([
				"push",
				"a.json",
				"--locale",
				"es,ja",
				"--locale=fr",
				"--key",
				"x",
				"-y",
				"--json",
			]),
		).toEqual({
			command: "push",
			positionals: ["a.json"],
			flags: { locale: ["es", "ja", "fr"], key: ["x"], yes: true, json: true },
		});
	});

	it("rejects unknown commands, unknown flags, and missing values", () => {
		expect(() => parseCli(["nope"])).toThrow(UsageError);
		expect(() => parseCli(["check", "--force"])).toThrow(
			/Unknown flag "--force" for `rosetta check`/,
		);
		expect(() => parseCli(["push", "--locale"])).toThrow(/Missing value/);
		expect(() => parseCli(["purge", "extra"])).toThrow(
			/doesn't take arguments/,
		);
	});
});

describe("rosetta CLI", () => {
	it("prints help and version", async () => {
		const s = sandbox();
		expect((await s.exec(["--help"])).stdout).toContain("rosetta <command>");
		expect((await s.exec(["push", "--help"])).stdout).toContain(
			"--key <pattern>",
		);
		expect((await s.exec(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
		expect((await s.exec([])).code).toBe(EXIT.usage);
	});

	it("exits 2 with a JSON error when there's no config", async () => {
		const s = sandbox();
		const result = await s.exec(["check", "--json"]);
		expect(result.code).toBe(EXIT.usage);
		expect(JSON.parse(result.stdout)).toMatchObject({
			command: "check",
			ok: false,
			error: { type: "ConfigError" },
		});
		expect((await s.exec(["check"])).stderr).toMatch(/Run `rosetta init`/);
	});

	describe("init", () => {
		it("detects source files and sibling locales", async () => {
			const s = sandbox({
				"package.json": { name: "x" },
				"apps/web/messages/en.json": { a: "A" },
				"apps/web/messages/es.json": { a: "A" },
				"apps/web/messages/pt-BR.json": { a: "A" },
				"apps/web/lib/pages.en.json": { b: "B" },
				"apps/web/lib/pages.fr.json": { b: "B" },
				"locales/en/common.json": { c: "C" },
				"locales/en/admin.json": { d: "D" },
				"locales/de/common.json": { c: "C" },
				"node_modules/pkg/en.json": { z: "Z" },
			});
			const result = await s.exec(["init"]);
			expect(result.code).toBe(EXIT.ok);
			const config = s.read(".rosetta/config.json");
			expect(config.files.map((f: { pattern: string }) => f.pattern)).toEqual([
				"apps/web/lib/pages.en.json",
				"apps/web/messages/en.json",
				"locales/en/**/*.json",
			]);
			expect(config.targetLocales).toEqual(["de", "es", "fr", "pt-BR"]);
			expect(config.engine.model).toBeTruthy();
			expect(
				readFileSync(join(s.root, ".rosetta/config.json"), "utf8"),
			).toMatch(/^\/\/ Rosetta config/);
			expect((await s.exec(["init"])).code).toBe(EXIT.usage); // never overwrites
		});

		it("accepts explicit --pattern/--target/--model and fails helpfully without targets", async () => {
			const s = sandbox({ "i18n/en.json": { a: "A" } });
			expect((await s.exec(["init"])).stderr).toMatch(/--target/);
			const ok = await s.exec([
				"init",
				"--pattern",
				"i18n/en.json",
				"--target",
				"es,ja",
				"--model",
				"m/x",
			]);
			expect(ok.code).toBe(EXIT.ok);
			expect(s.read(".rosetta/config.json")).toMatchObject({
				targetLocales: ["es", "ja"],
				files: [{ pattern: "i18n/en.json" }],
				engine: { model: "m/x" },
			});
		});

		it("imports a Lingo.dev v1 config", async () => {
			const s = sandbox({
				".lingo/config.json": {
					orgId: "org_1",
					engineId: "eng_1",
					sourceLocale: "en",
					targetLocales: ["de", "fr"],
					files: [
						{ pattern: "locales/en.json", lockedKeys: ["meta/version"] },
						{ pattern: "docs/en/**/*.md" },
					],
				},
				"locales/en.json": { a: "A" },
			});
			const result = await s.exec(["init", "--from-lingo"]);
			expect(result.code).toBe(EXIT.ok);
			expect(result.stderr).toMatch(/Skipped "docs\/en\/\*\*\/\*.md"/);
			expect(s.read(".rosetta/config.json")).toMatchObject({
				targetLocales: ["de", "fr"],
				files: [{ pattern: "locales/en.json", lockedKeys: ["meta.version"] }],
			});
		});

		it("imports a legacy Lingo.dev i18n.json", async () => {
			const s = sandbox({
				"i18n.json": {
					locale: { source: "en", targets: ["es"] },
					buckets: {
						json: {
							include: ["locales/[locale].json"],
							ignoredKeys: ["internal/*"],
						},
					},
					provider: { id: "openrouter", model: "openai/gpt-4o-mini" },
				},
			});
			expect((await s.exec(["init", "--from-lingo"])).code).toBe(EXIT.ok);
			expect(s.read(".rosetta/config.json")).toMatchObject({
				files: [{ pattern: "locales/en.json", ignoredKeys: ["internal.*"] }],
				engine: { model: "openai/gpt-4o-mini" },
			});
		});
	});

	describe("push / check / status", () => {
		const setup = () =>
			sandbox({
				".rosetta/config.json": CONFIG,
				"messages/en.json": {
					hello: "Hello",
					count: "{n, plural, one {# doc} other {# docs}}",
				},
			});

		it("push translates and check passes; human output lists locales", async () => {
			const s = setup();
			expect((await s.exec(["check"])).code).toBe(EXIT.stale);

			const pushed = await s.exec(["push"]);
			expect(pushed.code).toBe(EXIT.ok);
			expect(pushed.stdout).toMatch(/✓ es\s+messages\/es.json {2}2 translated/);
			expect(pushed.stdout).toMatch(
				/2 requests · 200 input \/ 100 output tokens/,
			);
			expect(s.read("messages/es.json")).toEqual({
				hello: "[es] Hello",
				count: "[es] {n, plural, one {# doc} other {# docs}}",
			});

			const checked = await s.exec(["check"]);
			expect(checked.code).toBe(EXIT.ok);
			expect(checked.stdout).toContain("All translations are up to date.");
		});

		it("push --json emits the spec'd result shape", async () => {
			const s = setup();
			const result = await s.exec(["push", "--json", "--locale", "es"]);
			const json = JSON.parse(result.stdout);
			expect(json).toMatchObject({
				command: "push",
				ok: true,
				locales: [
					{
						locale: "es",
						file: "messages/es.json",
						written: true,
						translated: 2,
						errors: [],
					},
				],
				usage: { requests: 1 },
			});
		});

		it("push exits 1 and reports keys when a locale fails", async () => {
			const s = setup();
			s.translator.fail.add("count");
			const result = await s.exec(["push"]);
			expect(result.code).toBe(EXIT.failed);
			expect(result.stdout).toMatch(/✗ es .*not written — 1 error:/);
			expect(result.stdout).toContain("count  icu: bad plural");
			expect(existsSync(join(s.root, "messages/es.json"))).toBe(false);
		});

		it("push --estimate doesn't translate", async () => {
			const s = setup();
			const result = await s.exec(["push", "--estimate"]);
			expect(result.code).toBe(EXIT.ok);
			expect(result.stdout).toMatch(/Estimate: 4 keys/);
			expect(s.translator.calls).toBe(0);
		});

		it("push --force needs confirmation unless --yes or CI", async () => {
			const s = setup();
			await s.exec(["push"]);
			expect((await s.exec(["push", "--force"])).code).toBe(EXIT.usage);
			expect(
				(await s.exec(["push", "--force"], { env: { CI: "true" } })).code,
			).toBe(EXIT.ok);
			expect((await s.exec(["push", "--force", "-y"])).code).toBe(EXIT.ok);
			const declined = await s.exec(["push", "--force"], {
				interactive: true,
				confirm: async () => false,
			});
			expect(declined.code).toBe(EXIT.failed);
		});

		it("push without an API key exits 2 with guidance", async () => {
			const s = setup();
			const result = await s.exec(["push"], { translator: undefined, env: {} });
			expect(result.code).toBe(EXIT.usage);
			expect(result.stderr).toMatch(/ROSETTA_API_KEY/);
		});

		it("check --json and status report stale keys after a source edit", async () => {
			const s = setup();
			await s.exec(["push"]);
			s.write("messages/en.json", {
				hello: "Hello there",
				count: "{n, plural, one {# doc} other {# docs}}",
				extra: "New",
			});

			const checked = await s.exec(["check", "--json"]);
			expect(checked.code).toBe(EXIT.stale);
			const es = JSON.parse(checked.stdout).locales.find(
				(l: { locale: string }) => l.locale === "es",
			);
			expect(es.stale).toEqual([
				{ key: "hello", reason: "changed" },
				{ key: "extra", reason: "missing" },
			]);

			const status = await s.exec(["status"]);
			expect(status.code).toBe(EXIT.ok);
			expect(status.stdout).toContain("messages/en.json");
			expect(status.stdout).toMatch(/es\s+2 to translate/);
			expect((await s.exec(["status", "--exit-code"])).code).toBe(EXIT.stale);

			const statusJson = JSON.parse(
				(await s.exec(["status", "--json"])).stdout,
			);
			expect(statusJson.locales[0]).toMatchObject({
				upToDate: false,
				counts: { translate: 2 },
				items: [
					{ key: "hello", action: "translate", reason: "changed" },
					{ key: "extra", action: "translate", reason: "missing" },
				],
			});
		});

		it("unknown locales are a usage error", async () => {
			const s = setup();
			expect((await s.exec(["push", "--locale", "xx"])).code).toBe(EXIT.usage);
		});
	});

	it("purge deletes a locale after confirmation", async () => {
		const s = sandbox({
			".rosetta/config.json": CONFIG,
			"messages/en.json": { a: "Apple" },
		});
		await s.exec(["push"]);
		expect((await s.exec(["purge", "--locale", "ja"])).code).toBe(EXIT.usage);
		const result = await s.exec(["purge", "--locale", "ja", "--yes"]);
		expect(result.code).toBe(EXIT.ok);
		expect(existsSync(join(s.root, "messages/ja.json"))).toBe(false);
		expect(existsSync(join(s.root, "messages/es.json"))).toBe(true);
	});

	it("pull is a friendly no-op", async () => {
		const s = sandbox();
		const result = await s.exec(["pull"]);
		expect(result.code).toBe(EXIT.ok);
		expect(result.stdout).toMatch(/Nothing to pull/);
	});

	it("translate-catalog still works with a deprecation warning", async () => {
		const s = sandbox({ "messages/en.json": { a: "A" } });
		const result = await s.exec([
			"translate-catalog",
			join(s.root, "messages/en.json"),
			"--target",
			"es",
			"--dry-run",
		]);
		expect(result.code).toBe(EXIT.ok);
		expect(result.stderr).toMatch(/deprecated/);
	});
});
