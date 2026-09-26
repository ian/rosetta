import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { flatten, isTranslatable, rebuild, serialize } from "./entries";
import { createKeyMatcher, expandPattern, globToRegExp } from "./glob";
import { parseJsonc } from "./jsonc";
import { PathResolutionError, resolveTargetPath } from "./paths";

describe("parseJsonc", () => {
	it("parses JSON with comments and trailing commas", () => {
		const { value } = parseJsonc(`{
			// comment
			"a": 1, /* block */ "b": [1, 2,],
			"c": { "d": "x", },
		}`);
		expect(value).toEqual({ a: 1, b: [1, 2], c: { d: "x" } });
	});

	it("attaches comments above keys and same-line trailing comments as notes", () => {
		const { notes } = parseJsonc(`{
			// Top nav — keep it short
			"nav": {
				/* Button label */
				"save": "Save",
				"light": "Light", // the theme, not weight
				"plain": "Plain"
			}
		}`);
		expect(notes).toEqual({
			nav: "Top nav — keep it short",
			"nav.save": "Button label",
			"nav.light": "the theme, not weight",
		});
	});

	it("reports line and column on errors", () => {
		expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow(/line 3/);
	});

	it("handles escapes in strings", () => {
		expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}').value).toEqual({
			a: 'say "hi" // not a comment',
		});
	});
});

describe("globs and key matching", () => {
	it("matches path globs", () => {
		const re = globToRegExp("locales/en/**/*.json", "/");
		expect(re.test("locales/en/a.json")).toBe(true);
		expect(re.test("locales/en/x/y/a.json")).toBe(true);
		expect(re.test("locales/es/a.json")).toBe(false);
	});

	it("matches key globs, exact keys, and dotted prefixes", () => {
		const match = createKeyMatcher(["**.href", "Marketing.*", "auth"]);
		expect(match("sections.0.cta.href")).toBe(true);
		expect(match("href")).toBe(true);
		expect(match("Marketing.title")).toBe(true);
		expect(match("Marketing.hero.title")).toBe(true); // glob claims its subtree
		expect(match("auth")).toBe(true);
		expect(match("auth.login.title")).toBe(true);
		expect(match("authority")).toBe(false);
	});

	it("expands globs against the filesystem", () => {
		const root = mkdtempSync(join(tmpdir(), "rosetta-glob-"));
		for (const file of [
			"locales/en/a.json",
			"locales/en/sub/b.json",
			"locales/es/a.json",
			"node_modules/x/locales/en/c.json",
		]) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), "{}");
		}
		expect(expandPattern(root, "locales/en/**/*.json")).toEqual([
			"locales/en/a.json",
			"locales/en/sub/b.json",
		]);
		expect(expandPattern(root, "locales/en/a.json")).toEqual([
			"locales/en/a.json",
		]);
		expect(expandPattern(root, "missing/en.json")).toEqual([]);
	});
});

describe("resolveTargetPath", () => {
	it.each([
		["messages/en.json", "messages/es.json"],
		["content/en/app.json", "content/es/app.json"],
		["locales/en/sub/app.json", "locales/es/sub/app.json"],
		["lib/marketing-pages.en.json", "lib/marketing-pages.es.json"],
		["l10n/app_en.json", "l10n/app_es.json"],
		["l10n/app-en.json", "l10n/app-es.json"],
	])("%s → %s", (source, target) => {
		expect(resolveTargetPath(source, "en", "es")).toBe(target);
	});

	it("handles region locales", () => {
		expect(resolveTargetPath("i18n/en.json", "en", "zh-CN")).toBe(
			"i18n/zh-CN.json",
		);
	});

	it("refuses to guess", () => {
		expect(() => resolveTargetPath("i18n/strings.json", "en", "es")).toThrow(
			PathResolutionError,
		);
		expect(() => resolveTargetPath("i18n/open.json", "en", "es")).toThrow(
			PathResolutionError,
		);
	});
});

describe("entries", () => {
	it("flattens in document order, including arrays", () => {
		const leaves = flatten({ a: { b: "x", c: [{ d: "y" }, 2] }, e: null });
		expect([...leaves]).toEqual([
			["a.b", "x"],
			["a.c.0.d", "y"],
			["a.c.1", 2],
			["e", null],
		]);
	});

	it("rebuilds with source structure and omits undefined leaves", () => {
		const doc = rebuild(
			{ a: { b: "x", c: "y" }, list: ["p", "q"], empty: {} },
			(key, v) => (key === "a.c" || key === "list.0" ? undefined : `${v}!`),
		);
		expect(doc).toEqual({ a: { b: "x!" }, list: ["q!"], empty: {} });
		expect(serialize(doc)).toMatch(/\n$/);
	});

	it("detects non-translatable strings", () => {
		for (const value of [
			"",
			"  ",
			"https://jot.so/pricing",
			"hi@jot.so",
			"123e4567-e89b-12d3-a456-426614174000",
			"2026-09-26",
			"1,234.50",
			"{count}",
			"—",
			"$ 9",
		]) {
			expect(isTranslatable(value), value).toBe(false);
		}
		for (const value of [
			"Save",
			"{count} docs",
			"Go to https://jot.so",
			"日本語",
		]) {
			expect(isTranslatable(value), value).toBe(true);
		}
	});
});
