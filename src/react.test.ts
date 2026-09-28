// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocaleConfig } from "./locale/core";
import { LocaleProvider, useLocaleSwitch } from "./react";

type Persist = (locale: string) => void | Promise<void>;

// React 19 reads this to decide whether `act` is expected.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const config: LocaleConfig = {
	locales: ["en", "ja", "es"],
	defaultLocale: "en",
	localizedPaths: ["/", "/pricing"],
	localizedPathPrefixes: ["/blog/"],
};

// The provider hands `switchTo` out through context; this child records it so
// tests can call it directly.
let switchTo: ((locale: string) => void) | null = null;

function CaptureSwitch() {
	switchTo = useLocaleSwitch();
	return null;
}

interface Mounted {
	container: HTMLDivElement;
	navigate: ReturnType<typeof vi.fn>;
	rerender: (props: { locale: string; persist?: Persist }) => void;
	unmount: () => void;
}

const mounted: Mounted[] = [];

function mount(locale: string, persist?: Persist): Mounted {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const navigate = vi.fn();

	const render = (props: { locale: string; persist?: Persist }) => {
		act(() =>
			root.render(
				createElement(LocaleProvider, {
					config,
					locale: props.locale,
					navigate,
					persist: props.persist,
					// biome-ignore lint/correctness/noChildrenProp: React 19's overloads require `children` in props here.
					children: createElement(CaptureSwitch),
				}),
			),
		);
	};

	render({ locale, persist });
	const entry: Mounted = {
		container,
		navigate,
		rerender: (props) => render(props),
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
	mounted.push(entry);
	return entry;
}

function setPathname(pathname: string) {
	window.history.pushState({}, "", pathname);
}

function cookieValue(): string {
	return document.cookie;
}

beforeEach(() => {
	// biome-ignore lint/suspicious/noDocumentCookie: clearing state between tests; document.cookie is the portable choice.
	document.cookie = "locale=; Max-Age=0; Path=/";
	setPathname("/pricing");
	switchTo = null;
});

afterEach(() => {
	while (mounted.length > 0) mounted.pop()?.unmount();
});

describe("LocaleProvider switchTo", () => {
	it("writes the cookie and navigates to the localized URL", () => {
		const m = mount("en");
		act(() => switchTo?.("ja"));

		expect(cookieValue()).toContain("locale=ja");
		expect(m.navigate).toHaveBeenCalledWith("/ja/pricing");
	});

	it("does not navigate when the path has no localized variant", () => {
		setPathname("/legal");
		const m = mount("en");
		act(() => switchTo?.("ja"));
		expect(m.navigate).not.toHaveBeenCalled();
	});

	it("does not navigate when the target is the current locale", () => {
		const m = mount("en");
		act(() => switchTo?.("en"));
		expect(m.navigate).not.toHaveBeenCalled();
	});

	it("still navigates when persist throws synchronously", () => {
		const m = mount("en", () => {
			throw new Error("boom");
		});
		act(() => switchTo?.("ja"));
		expect(m.navigate).toHaveBeenCalledWith("/ja/pricing");
	});

	it("still navigates and reports no unhandled rejection when persist rejects", async () => {
		const onUnhandled = vi.fn();
		window.addEventListener("unhandledrejection", onUnhandled);

		const m = mount("en", () => Promise.reject(new Error("save failed")));
		act(() => switchTo?.("ja"));

		expect(m.navigate).toHaveBeenCalledWith("/ja/pricing");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(onUnhandled).not.toHaveBeenCalled();

		window.removeEventListener("unhandledrejection", onUnhandled);
	});

	it("resets pending when the locale changes, so a second switch works", () => {
		const m = mount("en");
		act(() => switchTo?.("ja"));
		expect(m.navigate).toHaveBeenCalledWith("/ja/pricing");

		// Simulate the router landing on the new locale without remounting.
		m.rerender({ locale: "ja" });

		act(() => switchTo?.("es"));
		expect(m.navigate).toHaveBeenCalledWith("/es/pricing");
		expect(m.navigate).toHaveBeenCalledTimes(2);
	});
});
