/**
 * Astro adapter.
 *
 * Astro's middleware runs on every request, so it's the natural place to
 * resolve the locale, force it onto `Astro.locals.locale`, rewrite
 * locale-prefixed URLs to their canonical path, and persist the cookie.
 *
 * ```ts
 * // src/middleware.ts
 * import { defineMiddleware } from "astro:middleware";
 * import { createAstroLocaleMiddleware } from "rosetta-i18n/astro";
 * import { localeConfig } from "../i18n/config";
 *
 * export const onRequest = createAstroLocaleMiddleware(localeConfig);
 * ```
 *
 * For a client switch, render the React `<LocaleSwitcher>` as an island and
 * wrap it in `<LocaleProvider locale={Astro.locals.locale} config={localeConfig}>`.
 * Types are structural, so this module never depends on `astro`.
 */

import {
	isLocale,
	LOCALE_HEADER,
	type LocaleConfig,
	localeCookieName,
	parseCookie,
	resolveLocale,
	serializeLocaleCookie,
} from "./core";

export interface AstroLocaleContext {
	request: Request;
	locals: Record<string, unknown>;
	/** Astro's `context.rewrite()`. */
	rewrite: (url: string | URL) => Promise<Response>;
}

export type AstroMiddlewareNext = (rewrite?: URL) => Promise<Response>;

export function createAstroLocaleMiddleware(config: LocaleConfig) {
	return async function onRequest(
		context: AstroLocaleContext,
		next: AstroMiddlewareNext,
	): Promise<Response> {
		const url = new URL(context.request.url);
		const resolved = resolveLocale(config, {
			pathname: url.pathname,
			header: context.request.headers.get(LOCALE_HEADER),
			cookie: parseCookie(
				context.request.headers.get("cookie"),
				localeCookieName(config),
			),
		});

		context.locals.locale = resolved.locale;

		if (resolved.source === "url") {
			const target = new URL(url);
			target.pathname = resolved.path;
			const response = await context.rewrite(target);
			response.headers.set(LOCALE_HEADER, resolved.locale);
			response.headers.append(
				"Set-Cookie",
				serializeLocaleCookie(config, resolved.locale),
			);
			return response;
		}

		const response = await next();
		// Persist only when the URL can't decide it (bare path) and the cookie
		// disagrees — never on a rewrite, where the URL is authoritative.
		if (resolved.source === "cookie" || resolved.source === "default") {
			response.headers.append(
				"Set-Cookie",
				serializeLocaleCookie(config, resolved.locale),
			);
		}
		return response;
	};
}

/** Read the locale the middleware stored on `Astro.locals`. */
export function getAstroLocale(
	context: { locals: Record<string, unknown> },
	config: LocaleConfig,
): string {
	const locale = context.locals.locale;
	return isLocale(config, locale) ? locale : config.defaultLocale;
}
