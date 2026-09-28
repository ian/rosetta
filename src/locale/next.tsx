/**
 * Next.js adapter (App Router).
 *
 * Three pieces, each doing one thing:
 *
 * 1. `createLocaleMiddleware(config)` — route locale from the URL, force it
 *    onto the request as `x-rosetta-locale`, and (only when the URL is
 *    authoritative) persist it in the cookie.
 * 2. `<RosettaProvider config>` — a server component that reads the locale and
 *    provides it to the client. Wrap your tree in it.
 * 3. `createSetLocaleAction(config)` — a server action for signed-in users who
 *    want the choice stored on their account.
 *
 * The client `<LocaleSwitcher>` (from `rosetta-i18n/react`) sets the cookie and
 * hard-navigates, so the URL and cookie always agree — no refresh races.
 */

import { cookies, headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { ReactNode } from "react";
// Self-import so the client boundary is preserved: the browser gets
// `rosetta-i18n/react` (which carries "use client"), not an inlined copy.
import { LocaleProvider } from "rosetta-i18n/react";
import {
	isLocale,
	LOCALE_HEADER,
	type LocaleConfig,
	localeCookieName,
	localeCookieOptions,
	resolveLocale,
} from "./core";

/** The active locale for the current server render (reads the forced header, then the cookie). */
export async function getServerLocale(config: LocaleConfig): Promise<string> {
	const headerStore = await headers();
	const fromHeader = headerStore.get(LOCALE_HEADER);
	if (isLocale(config, fromHeader)) return fromHeader;
	const cookieStore = await cookies();
	const fromCookie = cookieStore.get(localeCookieName(config))?.value ?? null;
	return isLocale(config, fromCookie) ? fromCookie : config.defaultLocale;
}

/** Server component: resolves the locale and provides it to the client tree. */
export async function RosettaProvider({
	config,
	children,
}: {
	config: LocaleConfig;
	children: ReactNode;
}) {
	const locale = await getServerLocale(config);
	return (
		<LocaleProvider config={config} locale={locale}>
			{children}
		</LocaleProvider>
	);
}

/**
 * Middleware: resolve the locale for every request, force it onto the request
 * (`x-rosetta-locale`) so server components don't re-derive it, rewrite
 * locale-prefixed URLs to their canonical path, and persist the cookie only
 * when the URL is authoritative.
 *
 * ```ts
 * // middleware.ts
 * import { createLocaleMiddleware } from "rosetta-i18n/next";
 * export const middleware = createLocaleMiddleware(config);
 * export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
 * ```
 */
export function createLocaleMiddleware(config: LocaleConfig) {
	return function localeMiddleware(request: NextRequest): NextResponse {
		const cookieName = localeCookieName(config);
		const resolved = resolveLocale(config, {
			pathname: request.nextUrl.pathname,
			header: request.headers.get(LOCALE_HEADER),
			cookie: request.cookies.get(cookieName)?.value ?? null,
		});

		const requestHeaders = new Headers(request.headers);
		requestHeaders.set(LOCALE_HEADER, resolved.locale);

		let response: NextResponse;
		if (resolved.source === "url") {
			const url = request.nextUrl.clone();
			url.pathname = resolved.path;
			response = NextResponse.rewrite(url, {
				request: { headers: requestHeaders },
			});
		} else {
			response = NextResponse.next({ request: { headers: requestHeaders } });
		}

		// Persist only when the URL decides the locale (a locale-prefixed visit),
		// so a transient request to a bare path can't re-pin or clobber the choice.
		if (resolved.source === "url") {
			response.cookies.set(
				cookieName,
				resolved.locale,
				localeCookieOptions(config),
			);
		}

		return response;
	};
}

/**
 * Server action factory for persisting the choice on the account. Use with the
 * client provider's `persist` (for signed-in members).
 *
 * ```ts
 * // app/locale-actions.ts
 * "use server";
 * export const persistLocale = createSetLocaleAction(config, {
 *   persist: (locale) => updateUserProfile(userId, { locale }),
 * });
 * ```
 */
export function createSetLocaleAction(
	config: LocaleConfig,
	options: { persist?: (locale: string) => void | Promise<void> } = {},
) {
	return async function setLocale(locale: string): Promise<string> {
		const next = isLocale(config, locale) ? locale : config.defaultLocale;
		const cookieStore = await cookies();
		cookieStore.set(
			localeCookieName(config),
			next,
			localeCookieOptions(config),
		);
		await options.persist?.(next);
		return next;
	};
}

export {
	LOCALE_HEADER,
	type LocaleConfig,
	localeCookieName,
	localeCookieOptions,
	resolveLocale,
} from "./core";
