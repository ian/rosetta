"use client";

/**
 * React adapter: a server-resolved locale, provided to the client, with a
 * switcher that can't race.
 *
 * The server resolves the locale (see the Next/Astro adapters) and renders
 * `<LocaleProvider locale={locale}>`. The client only ever *reads* that locale
 * and, to switch, sets the cookie and navigates — it never guesses.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { type LocaleConfig, planSwitch } from "./locale/core";

export interface LocaleContextValue {
	config: LocaleConfig;
	/** The active locale, resolved on the server for this request. */
	locale: string;
	/** True while a switch is in flight. */
	pending: boolean;
	/** Switch locale: writes the cookie, then navigates. */
	switchTo: (locale: string) => void;
	/** Localized href for the current page in `locale`, or `null` if it has none. */
	hrefFor: (locale: string) => string | null;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export interface LocaleProviderProps {
	/** Plain data, safe to pass from a server component. */
	config: LocaleConfig;
	/** The locale resolved for this request. */
	locale: string;
	/**
	 * Navigate to the localized URL. Defaults to a full-page `location.assign`,
	 * which is the reliable choice: one request, URL and cookie in agreement.
	 */
	navigate?: (href: string) => void;
	/**
	 * Persist the choice server-side (the cookie is already written). Use for
	 * signed-in users. Because `switchTo` navigates immediately and does NOT
	 * wait for this to settle, `persist` must survive the page unloading: send
	 * the locale with `fetch(url, { keepalive: true })` or `navigator.sendBeacon`.
	 * Do not pass a server action — it is aborted when the page navigates, and a
	 * rejected save would otherwise surface as an unhandled rejection.
	 */
	persist?: (locale: string) => void | Promise<void>;
	children: ReactNode;
}

function defaultNavigate(href: string): void {
	window.location.assign(href);
}

function writeCookie(
	name: string,
	value: string,
	options: { path: string; maxAge: number },
): void {
	// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't available in Safari, so document.cookie is the portable choice.
	document.cookie = `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${
		options.maxAge
	}; SameSite=Lax`;
}

export function LocaleProvider({
	config,
	locale,
	navigate,
	persist,
	children,
}: LocaleProviderProps) {
	const [pendingLocale, setPendingLocale] = useState<string | null>(null);
	const pending = pendingLocale !== null;
	// Keyed to the target locale so it clears the moment the new locale lands: a
	// router-based `navigate` rerenders the provider with the new `locale`, while
	// the default `location.assign` unloads the page first and never needs it.
	if (pendingLocale !== null && pendingLocale === locale) {
		setPendingLocale(null);
	}

	const switchTo = useCallback(
		(next: string) => {
			if (next === locale || pending) return;
			const pathname =
				typeof window === "undefined" ? "/" : window.location.pathname;
			const plan = planSwitch(config, pathname, next);
			if (!plan) return; // current path has no localized variant
			setPendingLocale(next);
			writeCookie(plan.cookie.name, plan.cookie.value, plan.cookie.options);
			// Best-effort and never awaited: catches a synchronous throw AND a
			// rejected promise, so a failed save can't surface as an unhandled
			// rejection. Navigation must not wait on it (see the `persist` docs).
			if (persist) {
				Promise.resolve()
					.then(() => persist(next))
					.catch(() => {});
			}
			(navigate ?? defaultNavigate)(plan.href);
		},
		[config, locale, pending, navigate, persist],
	);

	const hrefFor = useCallback(
		(target: string): string | null => {
			const pathname =
				typeof window === "undefined" ? "/" : window.location.pathname;
			return planSwitch(config, pathname, target)?.href ?? null;
		},
		[config],
	);

	const value = useMemo<LocaleContextValue>(
		() => ({ config, locale, pending, switchTo, hrefFor }),
		[config, locale, pending, switchTo, hrefFor],
	);

	return (
		<LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
	);
}

export function useLocaleContext(): LocaleContextValue {
	const value = useContext(LocaleContext);
	if (!value) {
		throw new Error(
			"rosetta-i18n: no locale context — render <LocaleProvider> (or the framework provider) above this component.",
		);
	}
	return value;
}

export function useLocale(): string {
	return useLocaleContext().locale;
}

export function useLocales(): readonly string[] {
	return useLocaleContext().config.locales;
}

/** The switcher primitive: `switchTo(locale)` writes the cookie and navigates. */
export function useLocaleSwitch(): (locale: string) => void {
	return useLocaleContext().switchTo;
}

export interface LocaleSwitcherRenderProps {
	locales: readonly string[];
	locale: string;
	pending: boolean;
	switchTo: (locale: string) => void;
	/** Endonym for a locale (e.g. `"日本語"`), unless overridden by `labels`. */
	labelFor: (locale: string) => string;
}

export interface LocaleSwitcherProps {
	/** Render your own UI. Omit for a plain, unstyled `<select>`. */
	render?: (props: LocaleSwitcherRenderProps) => ReactNode;
	/** Display names per locale. Defaults to the locale's own name. */
	labels?: Record<string, string>;
}

function defaultLabel(locale: string): string {
	try {
		return (
			new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale
		);
	} catch {
		return locale;
	}
}

export function LocaleSwitcher({ render, labels }: LocaleSwitcherProps) {
	const { config, locale, pending, switchTo } = useLocaleContext();
	const labelFor = (value: string) => labels?.[value] ?? defaultLabel(value);
	const props: LocaleSwitcherRenderProps = {
		locales: config.locales,
		locale,
		pending,
		switchTo,
		labelFor,
	};
	if (render) return <>{render(props)}</>;
	return (
		<select
			aria-label="Language"
			value={locale}
			disabled={pending}
			onChange={(event) => switchTo(event.target.value)}
		>
			{config.locales.map((value) => (
				<option key={value} value={value}>
					{labelFor(value)}
				</option>
			))}
		</select>
	);
}
