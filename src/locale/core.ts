/**
 * Runtime locale layer — framework-agnostic core.
 *
 * The translation engine answers "how do I translate these strings?". This
 * module answers "which locale is this request in, and how do I switch?" — the
 * routing + cookie model that the React, Next, and Astro adapters are thin
 * wrappers around.
 *
 * The config is deliberately plain data (no functions) so the exact same object
 * can cross the server → client boundary. Resolution is deterministic and
 * one-directional:
 *
 *   1. a locale-prefixed URL (`/ja/pricing`) is authoritative,
 *   2. then a forced header (`x-rosetta-locale`, set by middleware),
 *   3. then the persisted cookie,
 *   4. then the default locale.
 *
 * Switching sets the cookie *and* navigates to the localized URL, so the URL and
 * the cookie always agree. There is no client-side guessing, no
 * refresh-after-push race, and no way for a stale request to re-pin the locale.
 */

export const LOCALE_HEADER = "x-rosetta-locale";
export const DEFAULT_LOCALE_COOKIE = "locale";
export const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface LocaleConfig {
	/** Every locale, including the default. Order is the switcher order. */
	locales: readonly string[];
	/** The locale served without a URL prefix. */
	defaultLocale: string;
	/** Cookie that persists the choice. Default `"locale"`. */
	cookieName?: string;
	/** Cookie max-age in seconds. Default one year. */
	cookieMaxAgeSeconds?: number;
	/** Prefix the default locale too (`/en/...`). Default `false`. */
	prefixDefaultLocale?: boolean;
	/**
	 * Canonical (unprefixed) paths that have localized variants — exact matches.
	 * Omit both this and `localizedPathPrefixes` to localize every path.
	 */
	localizedPaths?: readonly string[];
	/** Canonical paths that have localized variants — prefix matches (e.g. `/blog/`). */
	localizedPathPrefixes?: readonly string[];
}

export type LocaleSource = "url" | "header" | "cookie" | "default";

export interface ResolvedLocale {
	locale: string;
	/** The canonical, unprefixed path for this request. */
	path: string;
	source: LocaleSource;
}

export interface LocaleCookieOptions {
	path: string;
	maxAge: number;
	sameSite: "lax";
}

export interface LocaleSwitchPlan {
	/** Localized URL to navigate to. */
	href: string;
	/** Cookie to persist the choice. */
	cookie: { name: string; value: string; options: LocaleCookieOptions };
}

export function localeCookieName(config: LocaleConfig): string {
	return config.cookieName ?? DEFAULT_LOCALE_COOKIE;
}

export function localeCookieOptions(config: LocaleConfig): LocaleCookieOptions {
	return {
		path: "/",
		maxAge: config.cookieMaxAgeSeconds ?? ONE_YEAR_SECONDS,
		sameSite: "lax",
	};
}

export function isLocale(
	config: LocaleConfig,
	value: unknown,
): value is string {
	return typeof value === "string" && config.locales.includes(value);
}

export function isLocalizedPath(
	config: LocaleConfig,
	pathname: string,
): boolean {
	const hasRules =
		(config.localizedPaths?.length ?? 0) > 0 ||
		(config.localizedPathPrefixes?.length ?? 0) > 0;
	if (!hasRules) return true;
	if (config.localizedPaths?.includes(pathname)) return true;
	return (
		config.localizedPathPrefixes?.some(
			(prefix) => pathname === prefix || pathname.startsWith(prefix),
		) ?? false
	);
}

/** The leading locale segment of a path, if it is one we know. */
export function localeFromPath(
	config: LocaleConfig,
	pathname: string,
): string | null {
	const segment = pathname.split("/")[1];
	return segment && isLocale(config, segment) ? segment : null;
}

/** Strip a leading locale segment, returning the canonical path. */
export function stripLocale(
	config: LocaleConfig,
	pathname: string,
): { locale: string | null; path: string } {
	const locale = localeFromPath(config, pathname);
	if (!locale) return { locale: null, path: pathname || "/" };
	const rest = pathname.slice(locale.length + 1);
	return { locale, path: rest || "/" };
}

/**
 * Prefix a canonical path for a locale. The default locale stays bare unless
 * `prefixDefaultLocale` is set.
 */
export function localizePath(
	config: LocaleConfig,
	pathname: string,
	locale: string,
): string {
	if (locale === config.defaultLocale && !config.prefixDefaultLocale) {
		return pathname;
	}
	return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}

/** The URL to navigate to when switching `pathname` to `locale`. */
export function switchHref(
	config: LocaleConfig,
	pathname: string,
	locale: string,
): string {
	const { path } = stripLocale(config, pathname);
	return localizePath(config, path, locale);
}

/**
 * Resolve the active locale for a request. Precedence: URL prefix → forced
 * header → cookie → default. `path` is always the canonical (unprefixed) path.
 */
export function resolveLocale(
	config: LocaleConfig,
	input: { pathname: string; header?: string | null; cookie?: string | null },
): ResolvedLocale {
	const fromPath = localeFromPath(config, input.pathname);
	if (fromPath) {
		return {
			locale: fromPath,
			path: stripLocale(config, input.pathname).path,
			source: "url",
		};
	}
	if (isLocale(config, input.header)) {
		return { locale: input.header, path: input.pathname, source: "header" };
	}
	if (isLocale(config, input.cookie)) {
		return { locale: input.cookie, path: input.pathname, source: "cookie" };
	}
	return {
		locale: config.defaultLocale,
		path: input.pathname,
		source: "default",
	};
}

/** The `Set-Cookie` value that persists `locale`. */
export function serializeLocaleCookie(
	config: LocaleConfig,
	locale: string,
): string {
	const options = localeCookieOptions(config);
	return `${localeCookieName(config)}=${encodeURIComponent(locale)}; Path=${
		options.path
	}; Max-Age=${options.maxAge}; SameSite=${capitalize(options.sameSite)}`;
}

/** Read a single cookie value from a `Cookie:` header. */
export function parseCookie(
	header: string | null | undefined,
	name: string,
): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

/**
 * Everything a client needs to switch locale: set `cookie`, navigate to `href`.
 * Returns `null` when the current path has no localized variant (legal pages,
 * API routes, …), so the switcher can no-op instead of linking to a 404.
 */
export function planSwitch(
	config: LocaleConfig,
	pathname: string,
	locale: string,
): LocaleSwitchPlan | null {
	const { path } = stripLocale(config, pathname);
	if (!isLocalizedPath(config, path)) return null;
	return {
		href: localizePath(config, path, locale),
		cookie: {
			name: localeCookieName(config),
			value: locale,
			options: localeCookieOptions(config),
		},
	};
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
