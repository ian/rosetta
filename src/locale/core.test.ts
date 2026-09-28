import { describe, expect, it } from "vitest";
import {
	type LocaleConfig,
	localeFromPath,
	localizePath,
	parseCookie,
	planSwitch,
	resolveLocale,
	serializeLocaleCookie,
	stripLocale,
	switchHref,
} from "./core";

const config: LocaleConfig = {
	locales: ["en", "ja", "es"],
	defaultLocale: "en",
	localizedPaths: ["/", "/pricing"],
	localizedPathPrefixes: ["/blog/"],
};

describe("resolveLocale", () => {
	it("makes a locale-prefixed URL authoritative, and returns the canonical path", () => {
		expect(resolveLocale(config, { pathname: "/ja/pricing" })).toEqual({
			locale: "ja",
			path: "/pricing",
			source: "url",
		});
		expect(resolveLocale(config, { pathname: "/ja" })).toEqual({
			locale: "ja",
			path: "/",
			source: "url",
		});
	});

	it("falls back to the forced header, then the cookie, then the default", () => {
		expect(
			resolveLocale(config, { pathname: "/pricing", header: "es" }).source,
		).toBe("header");
		expect(
			resolveLocale(config, { pathname: "/pricing", cookie: "ja" }),
		).toEqual({ locale: "ja", path: "/pricing", source: "cookie" });
		expect(resolveLocale(config, { pathname: "/pricing" })).toEqual({
			locale: "en",
			path: "/pricing",
			source: "default",
		});
	});

	it("ignores an unknown header/cookie value", () => {
		expect(
			resolveLocale(config, {
				pathname: "/pricing",
				header: "xx",
				cookie: "ja",
			}).locale,
		).toBe("ja");
	});

	it("lets the URL beat a conflicting header and cookie", () => {
		expect(
			resolveLocale(config, {
				pathname: "/es/pricing",
				header: "ja",
				cookie: "ja",
			}).locale,
		).toBe("es");
	});
});

describe("paths", () => {
	it("extracts and strips the locale segment", () => {
		expect(localeFromPath(config, "/ja/pricing")).toBe("ja");
		expect(localeFromPath(config, "/pricing")).toBeNull();
		expect(stripLocale(config, "/ja/pricing")).toEqual({
			locale: "ja",
			path: "/pricing",
		});
		expect(stripLocale(config, "/ja")).toEqual({ locale: "ja", path: "/" });
		expect(stripLocale(config, "/pricing")).toEqual({
			locale: null,
			path: "/pricing",
		});
	});

	it("prefixes non-default locales and leaves the default bare", () => {
		expect(localizePath(config, "/pricing", "ja")).toBe("/ja/pricing");
		expect(localizePath(config, "/", "ja")).toBe("/ja");
		expect(localizePath(config, "/pricing", "en")).toBe("/pricing");
	});

	it("builds a switch href from any current URL", () => {
		expect(switchHref(config, "/ja/pricing", "es")).toBe("/es/pricing");
		expect(switchHref(config, "/ja", "en")).toBe("/");
		expect(switchHref(config, "/blog/x", "ja")).toBe("/ja/blog/x");
	});
});

describe("planSwitch", () => {
	it("returns the href and cookie for a localized path", () => {
		expect(planSwitch(config, "/ja/pricing", "es")).toEqual({
			href: "/es/pricing",
			cookie: {
				name: "locale",
				value: "es",
				options: { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" },
			},
		});
	});

	it("returns null when the path has no localized variant", () => {
		expect(planSwitch(config, "/privacy", "ja")).toBeNull();
	});

	it("honours a custom cookie name", () => {
		const custom: LocaleConfig = { ...config, cookieName: "lang" };
		expect(planSwitch(custom, "/pricing", "ja")?.cookie.name).toBe("lang");
	});
});

describe("cookies", () => {
	it("serializes a Set-Cookie value", () => {
		expect(serializeLocaleCookie(config, "ja")).toBe(
			"locale=ja; Path=/; Max-Age=31536000; SameSite=Lax",
		);
	});

	it("parses a cookie header", () => {
		expect(parseCookie("a=1; locale=ja; b=2", "locale")).toBe("ja");
		expect(parseCookie("a=1", "locale")).toBeNull();
		expect(parseCookie(undefined, "locale")).toBeNull();
	});
});
