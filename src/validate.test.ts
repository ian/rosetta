import { describe, expect, it } from "vitest";
import { parseMessage, validateTranslation } from "./validate";

const rules = (source: string, target: unknown) =>
	validateTranslation(source, target).map((issue) => issue.rule);

describe("parseMessage", () => {
	it("collects simple args, typed args, cases, and tags", () => {
		const sig = parseMessage(
			"<b>{name}</b> has {count, plural, =0 {no items} one {# item} other {# items}} {when, date, short} {g, select, male {he} other {they}}<br/>",
		);
		expect(Object.fromEntries(sig.args)).toEqual({
			name: "simple",
			count: "plural",
			when: "date",
			g: "select",
		});
		expect([...(sig.pluralKeys.get("count") ?? [])]).toEqual([
			"=0",
			"one",
			"other",
		]);
		expect([...(sig.selectKeys.get("g") ?? [])]).toEqual(["male", "other"]);
		expect(Object.fromEntries(sig.tags)).toEqual({ b: 1, br: 1 });
	});

	it("handles nested plurals, offsets, and apostrophe quoting", () => {
		const sig = parseMessage(
			"{a, plural, offset:1 one {{b, select, x {X} other {Y}}} other {n}} Don't '{literal}' it''s",
		);
		expect(Object.fromEntries(sig.args)).toEqual({ a: "plural", b: "select" });
	});

	it("treats a lone < as text", () => {
		expect(parseMessage("a < b and 1<2").tags.size).toBe(0);
	});

	it("throws on unbalanced braces and mismatched tags", () => {
		expect(() => parseMessage("{name")).toThrow();
		expect(() => parseMessage("name}")).toThrow();
		expect(() => parseMessage("<b>bold</i>")).toThrow();
		expect(() => parseMessage("<b>bold")).toThrow();
	});
});

describe("validateTranslation", () => {
	it("accepts a faithful translation", () => {
		expect(
			validateTranslation(
				"Hi <strong>{email}</strong>, {count, plural, one {# doc} other {# docs}}",
				"Hola <strong>{email}</strong>, {count, plural, one {# doc} other {# docs}}",
			),
		).toEqual([]);
	});

	it("allows target-language plural categories", () => {
		expect(
			rules(
				"{n, plural, one {# day} other {# days}}",
				"{n, plural, zero {# ayam} one {# yawm} two {# yawmān} few {# ayyām} many {# yawman} other {# yawm}}",
			),
		).toEqual([]);
		expect(
			rules(
				"{n, plural, one {# day} other {# days}}",
				"{n, plural, other {#日}}",
			),
		).toEqual([]);
	});

	it("requires the plural other case", () => {
		expect(
			rules("{n, plural, one {#} other {#}}", "{n, plural, one {#}}"),
		).toEqual(["icu"]);
	});

	it("flags missing, renamed, and extra placeholders", () => {
		expect(rules("Hi {name}", "Hola")).toEqual(["placeholder"]);
		expect(rules("Hi {name}", "Hola {nombre}")).toEqual([
			"placeholder",
			"placeholder",
		]);
	});

	it("flags changed ICU types and select cases", () => {
		expect(rules("{n, plural, other {#}}", "{n, select, other {#}}")).toEqual([
			"icu",
		]);
		expect(
			rules(
				"{g, select, male {he} other {they}}",
				"{g, select, masc {él} other {ellos}}",
			),
		).toEqual(["icu"]);
	});

	it("flags dropped or renamed tags", () => {
		expect(rules("<terms>Terms</terms>", "Términos")).toEqual(["tags"]);
		expect(
			rules("<terms>Terms</terms>", "<términos>Términos</términos>"),
		).toEqual(["tags"]);
	});

	it("flags broken syntax in the translation", () => {
		expect(rules("Hi {name}", "Hola {name")).toEqual(["syntax"]);
	});

	it("flags empty and non-string values", () => {
		expect(rules("Hello", "")).toEqual(["type"]);
		expect(rules("Hello", 42)).toEqual(["type"]);
	});

	it("falls back to loose token matching for non-ICU sources", () => {
		expect(rules("Hello {{name}}", "Hola {{name}}")).toEqual([]);
		expect(rules("Hello {{name}}", "Hola")).toEqual(["placeholder"]);
	});
});
