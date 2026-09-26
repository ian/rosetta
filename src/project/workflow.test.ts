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
import type {
	TranslateDataOptions,
	TranslateEntriesResult,
	Translator,
} from "../types";
import { ConfigError, loadConfig } from "./config";
import { check, purge, push } from "./workflow";

/** Fake engine: "[es] Hello", records every call, can fail chosen keys. */
class FakeTranslator implements Translator {
	calls: Array<{
		data: Record<string, string>;
		options: TranslateDataOptions;
	}> = [];
	failKeys = new Set<string>();

	async translateEntries(
		data: Record<string, string>,
		options: TranslateDataOptions,
	): Promise<TranslateEntriesResult> {
		this.calls.push({ data, options });
		const translations: Record<string, string> = {};
		const failures: TranslateEntriesResult["failures"] = [];
		for (const [key, value] of Object.entries(data)) {
			if (this.failKeys.has(key))
				failures.push({ key, rule: "placeholder", message: "boom" });
			else translations[key] = `[${options.target}] ${value}`;
		}
		return {
			translations,
			failures,
			usage: { requests: 1, inputTokens: 10, outputTokens: 10 },
		};
	}

	keys(): string[] {
		return this.calls.flatMap((call) =>
			Object.keys(call.data).map((k) => `${call.options.target}:${k}`),
		);
	}
}

function project(
	files: Record<string, unknown>,
	config: Record<string, unknown> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "rosetta-wf-"));
	const write = (path: string, value: unknown) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(
			join(root, path),
			typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
		);
	};
	write(".rosetta/config.json", {
		sourceLocale: "en",
		targetLocales: ["es", "ja"],
		files: [{ pattern: "messages/en.json" }],
		engine: { model: "test/model" },
		...config,
	});
	for (const [path, value] of Object.entries(files)) write(path, value);
	const read = (path: string) =>
		JSON.parse(readFileSync(join(root, path), "utf8"));
	return {
		root,
		write,
		read,
		load: () => loadConfig({ cwd: join(root, "messages") }),
	};
}

describe("push", () => {
	it("translates a new project, writes targets + lock, then is a no-op", async () => {
		const p = project({
			"messages/en.json": {
				Auth: { title: "Sign in", url: "https://x.io" },
				count: 3,
			},
		});
		const t = new FakeTranslator();

		const first = await push(p.load(), { translator: t });
		expect(first.ok).toBe(true);
		expect(t.keys().sort()).toEqual(["es:Auth.title", "ja:Auth.title"]);
		expect(p.read("messages/es.json")).toEqual({
			Auth: { title: "[es] Sign in", url: "https://x.io" },
			count: 3,
		});
		expect(
			p.read(".rosetta/lock.json").files["messages/en.json"].es,
		).toHaveProperty(["Auth.title"]);
		expect(first.locales.map((l) => l.written)).toEqual([true, true]);

		const second = await push(p.load(), { translator: t });
		expect(t.calls).toHaveLength(2);
		expect(second.locales.every((l) => !l.written && l.ok)).toBe(true);
		expect(check(p.load()).ok).toBe(true);
	});

	it("retranslates edited source strings and prunes removed keys", async () => {
		const p = project({ "messages/en.json": { a: "Hello", b: "Bye" } });
		const t = new FakeTranslator();
		await push(p.load(), { translator: t });

		p.write("messages/en.json", { a: "Hello there", c: "New" });
		expect(check(p.load()).ok).toBe(false);
		t.calls = [];
		await push(p.load(), { translator: t, locales: ["es"] });

		expect(t.keys().sort()).toEqual(["es:a", "es:c"]);
		expect(p.read("messages/es.json")).toEqual({
			a: "[es] Hello there",
			c: "[es] New",
		});
		expect(
			Object.keys(p.read(".rosetta/lock.json").files["messages/en.json"].es),
		).toEqual(["a", "c"]);
	});

	it("adopts existing translations for free, keeping hand edits", async () => {
		const p = project({
			"messages/en.json": { a: "Hello", b: "World" },
			"messages/es.json": { a: "¡Hola!", b: "Mundo", stale: "x" },
			"messages/ja.json": { a: "こんにちは", b: "世界" },
		});
		const t = new FakeTranslator();
		expect(check(p.load()).locales[0].stale.map((s) => s.reason)).toEqual([
			"untracked",
			"untracked",
			"extra",
		]);

		const result = await push(p.load(), { translator: t });
		expect(t.calls).toHaveLength(0);
		expect(result.locales[0]).toMatchObject({
			adopted: 2,
			removed: 1,
			written: true,
		});
		expect(p.read("messages/es.json")).toEqual({ a: "¡Hola!", b: "Mundo" });
		expect(check(p.load()).ok).toBe(true);
	});

	it("does not need an API key when nothing needs translating", async () => {
		const p = project({
			"messages/en.json": { a: "Hello" },
			"messages/es.json": { a: "Hola" },
			"messages/ja.json": { a: "こんにちは" },
		});
		const result = await push(p.load(), { env: {} });
		expect(result.ok).toBe(true);
	});

	it("throws a ConfigError without an API key when translation is needed", async () => {
		const p = project({ "messages/en.json": { a: "Hello" } });
		await expect(push(p.load(), { env: {} })).rejects.toThrow(ConfigError);
		await expect(push(p.load(), { env: {} })).rejects.toThrow(
			/ROSETTA_API_KEY/,
		);
	});

	it("never writes a locale with failures, and leaves its lock untouched", async () => {
		const p = project({ "messages/en.json": { a: "Hello", b: "Bye" } });
		const t = new FakeTranslator();
		t.failKeys.add("b");

		const result = await push(p.load(), { translator: t });
		expect(result.ok).toBe(false);
		expect(result.locales[0]).toMatchObject({ ok: false, written: false });
		expect(result.locales[0].errors[0]).toMatchObject({
			key: "b",
			rule: "placeholder",
		});
		expect(existsSync(join(p.root, "messages/es.json"))).toBe(false);
		expect(existsSync(join(p.root, ".rosetta/lock.json"))).toBe(false);
	});

	it("--key retranslates only named keys; --force retranslates all", async () => {
		const p = project({
			"messages/en.json": {
				auth: { login: "Log in", logout: "Log out" },
				x: "X ray",
			},
		});
		const t = new FakeTranslator();
		await push(p.load(), { translator: t });

		t.calls = [];
		await push(p.load(), {
			translator: t,
			keys: ["auth.login"],
			locales: ["es"],
		});
		expect(t.keys()).toEqual(["es:auth.login"]);

		t.calls = [];
		await push(p.load(), { translator: t, force: true, locales: ["ja"] });
		expect(t.keys().sort()).toEqual([
			"ja:auth.login",
			"ja:auth.logout",
			"ja:x",
		]);
	});

	it("applies key controls, context, and JSONC translator notes", async () => {
		const p = project(
			{
				"messages/en.jsonc": `{
					// Top navigation
					"nav": {
						"save": "Save", // button
						"brand": "Jot Pro"
					},
					"debug": "Debug only"
				}`,
			},
			{
				targetLocales: ["es"],
				files: [
					{
						pattern: "messages/en.jsonc",
						context: "Web app",
						lockedKeys: ["nav.brand"],
						ignoredKeys: ["debug"],
					},
				],
			},
		);
		const t = new FakeTranslator();
		await push(p.load(), { translator: t });

		expect(t.calls[0].data).toEqual({ "nav.save": "Save" });
		expect(t.calls[0].options.context).toBe("Web app");
		expect(t.calls[0].options.notes).toEqual({
			"nav.save": "button / Top navigation",
		});
		expect(p.read("messages/es.jsonc")).toEqual({
			nav: { save: "[es] Save", brand: "Jot Pro" },
		});
	});

	it("expands globs and mirrors directories", async () => {
		const p = project(
			{
				"locales/en/common.json": { a: "A thing" },
				"locales/en/sub/extra.json": { b: "B thing" },
			},
			{ targetLocales: ["es"], files: [{ pattern: "locales/en/**/*.json" }] },
		);
		await push(p.load(), { translator: new FakeTranslator() });
		expect(p.read("locales/es/common.json")).toEqual({ a: "[es] A thing" });
		expect(p.read("locales/es/sub/extra.json")).toEqual({ b: "[es] B thing" });
	});

	it("estimates without calling the model or writing", async () => {
		const p = project({ "messages/en.json": { a: "Hello", b: "World" } });
		const t = new FakeTranslator();
		const result = await push(p.load(), { translator: t, estimate: true });
		expect(t.calls).toHaveLength(0);
		expect(result.estimate?.[0]).toMatchObject({ locale: "es", keys: 2 });
		expect(existsSync(join(p.root, "messages/es.json"))).toBe(false);
	});

	it("prunes lock entries for locales removed from the config", async () => {
		const p = project({ "messages/en.json": { a: "Hello" } });
		await push(p.load(), { translator: new FakeTranslator() });
		p.write(".rosetta/config.json", {
			sourceLocale: "en",
			targetLocales: ["es"],
			files: [{ pattern: "messages/en.json" }],
			engine: { model: "m" },
		});
		await push(p.load(), { translator: new FakeTranslator() });
		expect(
			Object.keys(p.read(".rosetta/lock.json").files["messages/en.json"]),
		).toEqual(["es"]);
	});
});

describe("check", () => {
	it("reports changed, invalid, and copy drift", async () => {
		const p = project({
			"messages/en.json": { a: "Hi {name}", b: "Bye", v: "https://x.io" },
		});
		await push(p.load(), { translator: new FakeTranslator() });

		p.write("messages/es.json", {
			a: "Hola",
			b: "[es] Bye",
			v: "https://old.io",
		});
		p.write("messages/en.json", {
			a: "Hi {name}",
			b: "Goodbye",
			v: "https://x.io",
		});
		const es = check(p.load()).locales.find((l) => l.locale === "es");
		expect(es?.stale.map((s) => `${s.key}:${s.reason}`)).toEqual([
			"a:invalid",
			"b:changed",
			"v:copy",
		]);
	});
});

describe("purge", () => {
	it("deletes a locale's files and lock entries", async () => {
		const p = project({ "messages/en.json": { a: "Hello" } });
		await push(p.load(), { translator: new FakeTranslator() });
		expect(purge(p.load(), "ja").deleted).toEqual(["messages/ja.json"]);
		expect(
			Object.keys(p.read(".rosetta/lock.json").files["messages/en.json"]),
		).toEqual(["es"]);
	});
});

describe("loadConfig", () => {
	it("walks up to .rosetta/config.json and validates it", () => {
		const p = project({ "messages/en.json": {} });
		expect(p.load().root).toBe(p.root);

		p.write(
			".rosetta/config.json",
			`{
			// comments are fine
			"sourceLocale": "en",
			"targetLocales": ["en", "bad locale"],
			"files": [{ "pattern": "i18n/strings.json", "nope": 1 }],
			"engineId": "eng_123",
		}`,
		);
		let message = "";
		try {
			p.load();
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("targetLocales[0] must not equal sourceLocale");
		expect(message).toContain('targetLocales[1] "bad locale"');
		expect(message).toContain('files[0]: unknown field "nope"');
		expect(message).toContain("files[0].pattern: Can't derive target paths");
	});

	it("warns on Lingo.dev-only fields", () => {
		const p = project(
			{ "messages/en.json": {} },
			{ engineId: "eng_1", orgId: "org_1" },
		);
		expect(p.load().warnings).toHaveLength(2);
	});
});
