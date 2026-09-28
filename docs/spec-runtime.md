# Rosetta runtime spec: React, Next.js, Astro

- **Status:** Draft, for discussion
- **Builds on:** [`spec-v1.md`](./spec-v1.md), which covers translation. This spec covers
  rendering and routing.
- **Package:** the same `rosetta-i18n`, with new entry points `rosetta-i18n/react`,
  `rosetta-i18n/next` and `rosetta-i18n/astro`

## 1. Summary

Rosetta v1 writes translated locale files. Rendering them, and all the plumbing
around locales, is still left to each project. That plumbing includes:

- a locale list copied into several places;
- middleware that detects the visitor's language and redirects `/pricing` to `/es/pricing`;
- a cookie that remembers the choice;
- a provider that loads the right messages;
- a locale switcher, and links that keep the current locale;
- `<html lang dir>`, `hreflang` alternates, and static params for every locale.

Every project rebuilds this, and it's the most tedious part of internationalization.

The runtime removes it. **`.rosetta/config.json` drives both translation and
routing.** Its `sourceLocale`, `targetLocales` and file layout already say which
locales exist and where their messages live. Add a locale to the config, run
`rosetta push`, and routing, the switcher, and SEO tags pick it up with no other
changes.

## 2. Goals and non-goals

### Goals

- **Minimal setup.** Next.js: about three small files. Astro: one integration line.
  React: one provider.
- **One source of truth** for locales: the Rosetta config.
- **Automatic locale handling.** Detect the locale (URL, then cookie, then
  `Accept-Language`, then the default), redirect, remember the choice, and switch.
- **Correct by default.** `<html lang>`, `dir="rtl"` for RTL locales, canonical and
  `hreflang` alternates, and no hydration mismatches.
- **Missing translations fall back to the source locale** instead of breaking.
  Shipping a new English key before its translations land is safe.
- **The same `t()` everywhere:** client components, server components, and `.astro`
  files.
- **Zero runtime dependencies.** Formatting uses the built-in `Intl` APIs. React,
  Next.js and Astro are optional peer dependencies.
- **Edge-safe.** Nothing on a request path imports `node:*`.

### Non-goals for the first release

- Frameworks other than React, Next.js (App Router), and Astro. That rules out
  Vue, Svelte, Solid, Remix-specific adapters, and the Next.js Pages Router.
- Domain- or subdomain-per-locale routing (e.g. `es.example.com`). Planned; the
  config leaves room for it.
- Translating on the client at runtime. The runtime renders pre-translated catalogs.
  Dynamic content still uses the server-only `cachedTranslate`.
- Localized URL slugs (`/es/precios`). Planned.
- A full ICU implementation. We support what `Intl` covers (§6); anything else is a
  validation error.

## 3. Packaging

| Entry point | Built on | Runs in | Provides |
|---|---|---|---|
| `rosetta-i18n/react` | internal core | browser, server | `RosettaProvider`, `useT`, `useLocale`, `<T>`, `<LocaleSwitcher>`, `detectBrowserLocale` |
| `rosetta-i18n/next` | `/react` + core | Node, edge, browser | `withRosetta`, `defineI18n` (middleware/proxy, layout, `getT`, `Link`, alternates, static params) |
| `rosetta-i18n/astro` | core | Node (build/SSR), browser (switcher) | the integration, `getT`, `<LocaleSwitcher>`, `<Alternates>`, `localePaths` |

- The **internal core** (`src/runtime/`) is not a public entry point. It holds
  message lookup and fallback, the ICU formatter, locale negotiation, and turning
  the config into a runtime locale list. It is about 300 lines of TypeScript with no
  dependencies. The ICU parser already exists in `src/validate.ts`; the core adds
  a formatter on top.
- **Optional peers:** `react >= 18`, `next >= 15`, `astro >= 5`.
- **Astro components** (`.astro` files) ship as source under
  `rosetta-i18n/astro/components/*`. Rollup doesn't bundle them.
- **Why not a preset over next-intl?** It would only cover Next.js and would tie us
  to next-intl's versions. Our own small runtime gives one `t()` across all three
  frameworks, and it reuses the ICU parser we already maintain.

## 4. Configuration

The runtime reads the existing config. An optional `routing` block adds routing
settings; everything in it has a default.

```jsonc
// .rosetta/config.json
{
  "sourceLocale": "en",
  "targetLocales": ["es", "ja", "ar"],
  "files": [{ "pattern": "messages/en.json" }],
  "routing": {
    "strategy": "prefix-except-default",  // or "prefix-always"
    "detect": ["cookie", "accept-language"],  // order after the URL prefix; [] disables detection
    "cookie": { "name": "locale", "maxAge": 31536000 },
    "localizedPaths": ["/", "/pricing", "/blog/**"]  // optional allowlist; default: every path
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `strategy` | `prefix-except-default` | `prefix-except-default`: the source locale is served at `/pricing` and the others at `/es/pricing`. `prefix-always`: every locale is prefixed, and `/` redirects. |
| `detect` | `["cookie", "accept-language"]` | How a visitor with no locale prefix is matched to a locale. |
| `cookie` | `{ name: "locale", maxAge: 1 year }` | Set whenever a locale is chosen explicitly (a prefixed URL, or the switcher). |
| `localizedPaths` | every path | Glob allowlist. Other paths stay source-only and never redirect (e.g. `/app/**`, `/api/**`). |

- **Derived values.** Each locale's display name comes from `Intl.DisplayNames`,
  shown in that locale's own language. Text direction comes from
  `Intl.Locale.prototype.textInfo` where available, with a fallback list
  (`ar`, `he`, `fa`, `ur`, `ps`, `sd`, `yi`, `dv`, `ug`, `ku`).
- **Getting the config to the runtime.** It's JSONC and read from disk, so the
  runtime never parses it at request time.
  - **Next.js:** `withRosetta()` reads it at build time and inlines a compact JSON
    manifest through `env` (`process.env.ROSETTA_I18N`). That works in both the edge
    and Node runtimes.
  - **Astro:** the integration reads it at build or startup time and passes the
    manifest to the virtual module `virtual:rosetta/manifest`.
  - **Plain React:** there's no config file at runtime. Pass `locales` to the
    provider, or generate a manifest with `rosetta manifest > src/i18n.json` (a new
    CLI command, §9).

## 5. Messages and fallback

- **Loading.** Messages load through a `load(locale)` function you supply, e.g.
  `(locale) => import(\`./messages/${locale}.json\`)`, so the bundler can split them
  into one chunk per locale. Projects with several files (namespaces) return a
  merged object, and helpers are provided.
- **Fallback chain:**
  1. the requested locale;
  2. its base language, if it's configured (e.g. `pt-BR` falls back to `pt`);
  3. the source locale;
  4. the key itself.

  Steps 3 and 4 log a warning in development.
- **Merging with the source locale.** The source locale's messages are always
  loaded and deep-merged underneath the target's. This is what makes "ship the
  English key now, translations follow" safe. It also means projects no longer need
  locale-parity tests to protect production, though `rosetta check` can still gate
  CI.
- **Performance.** Compiled messages are cached per locale and key, so each message
  is parsed once.

## 6. Formatting API

The same API is available everywhere: `useT()` in client components, `await getT()`
in server components, and `getT(Astro)` in `.astro` files.

```ts
const t = useT("Pricing");                 // namespace = key prefix (optional)

t("cta");                                  // "Start free"
t("trial", { days: 14 });                  // ICU: "{days, plural, one {# day} other {# days}} free"
t.rich("terms", { terms: (chunks) => <a href="/terms">{chunks}</a> });  // <terms>…</terms>
t.has("beta");                             // boolean
t.raw("list");                             // unformatted value (arrays, objects)
```

- **ICU support:**
  - simple `{arg}`;
  - `plural` and `selectordinal`, with `=N` cases and `offset:`, via `Intl.PluralRules`;
  - `select`, with `#` inside plural cases;
  - `number` (default, `percent`, `integer`, `::currency/USD` skeleton subset) via
    `Intl.NumberFormat`;
  - `date` and `time` (`short`, `medium`, `long`, `full`) via `Intl.DateTimeFormat`;
  - apostrophe quoting.

  Anything else is rejected by `rosetta check`, so it can't reach the runtime.
- **Rich text:** `t.rich` maps each tag to a function that returns a React node, or
  an HTML string in Astro. Tags without a handler render their inner text, and warn
  in development.
- **Deterministic output.** Formatting uses the request's locale and an explicit
  `timeZone` (config `routing.timeZone`, default `UTC`), so server and client
  render identical output.
- **Types.** An optional generated `rosetta.d.ts` (`rosetta types`, §9) gives key
  autocompletion and type-checks the values each message needs.

## 7. Locale negotiation

`negotiateLocale(request)` is pure and runs in middleware and Astro SSR:

1. **URL prefix.** `/es/...` means `es`. It's an exact match against the configured
   locales, case-insensitive (`/pt-br/` is accepted and redirected to `/pt-BR/`).
2. **Cookie**, if `detect` includes it and the value is a configured locale.
3. **`Accept-Language`**, if `detect` includes it. It's parsed with q-values, then
   matched in this order: exact match, then same language with a different region
   (`pt-PT` → `pt-BR`), then the base language.
4. **Otherwise**, the source locale.

Bots and crawlers (by user-agent) skip steps 2 and 3, so search engines always see
the URL's own locale.

## 8. Adapters

### 8.1 Next.js (App Router)

```ts
// next.config.ts
import { withRosetta } from "rosetta-i18n/next/plugin";
export default withRosetta({ /* your Next config */ });

// i18n.ts
import { defineI18n } from "rosetta-i18n/next";
export const i18n = defineI18n({
  load: (locale) => import(`./messages/${locale}.json`),
});

// proxy.ts (Next 16+) or middleware.ts (Next 15)
export { proxy, config } from "./i18n";   // also exported as `middleware`

// app/[locale]/layout.tsx
import { i18n } from "@/i18n";
export const generateStaticParams = i18n.generateStaticParams;
export default i18n.Layout;   // provider + <html lang dir> + default alternates metadata
```

**Middleware or proxy behavior** under `prefix-except-default`:

| Request | Result |
|---|---|
| `/es/pricing` | Rewrite to the `[locale]` route with `es`; set the cookie to `es` |
| `/pricing`, negotiated `es` | 307 redirect to `/es/pricing` |
| `/pricing`, negotiated `en` (source) | Internal rewrite to `/en/pricing` (the URL stays `/pricing`) |
| `/en/pricing` | 308 redirect to `/pricing` (the source locale is never prefixed) |
| `/_next/*`, `/api/*`, files with extensions, non-`localizedPaths` | Untouched |

Next.js 16 renamed `middleware.ts` to `proxy.ts`, and proxy runs on the Node.js
runtime by default. Next 15's `middleware.ts` runs on the edge by default. The same
handler is exported as both `proxy` and `middleware` and must stay edge-safe: no
`node:*` imports, and the manifest is inlined at build time.

Every localized request gets an `x-rosetta-locale` header. The default `config`
matcher excludes static assets. Users with their own middleware can compose
`i18n.handle(request)` into it.

**Server components:**

```tsx
import { i18n } from "@/i18n";
export default async function Page() {
  const t = await i18n.getT("Pricing");   // locale comes from x-rosetta-locale
  return <h1>{t("title")}</h1>;
}
export const generateMetadata = i18n.metadata(async (t) => ({ title: t("Pricing.meta.title") }));
```

**Client components:**

- `useT`, `useLocale` and `<T>` come from `rosetta-i18n/react`, and they work because
  `i18n.Layout` renders the provider.
- **Only the messages a client component needs are sent to the browser.**
  `i18n.Layout` takes an optional `clientNamespaces` list, and by default sends the
  whole catalog, since keeping it lean is opt-in in v1.

**Navigation:**

- `i18n.Link` wraps `next/link`: `href="/pricing"` becomes `/es/pricing` under the
  current locale. A `locale` prop switches locale.
- `i18n.redirect`, `i18n.usePathname` and `i18n.useRouter` all work on paths without
  the locale prefix.
- `<LocaleSwitcher>`: shows the current locale, lists the rest by display name, sets
  the cookie, and navigates to the same path in the new locale. It has no styles and
  can be replaced by a render prop.

**SEO:** `i18n.alternates("/pricing")` returns:

- the canonical URL;
- a `languages` map for every locale;
- an `x-default` entry pointing at the source-locale URL.

`i18n.Layout` adds these automatically for the current path. `i18n.sitemap(paths)`
expands a sitemap with an entry per locale.

### 8.2 React (any setup: Vite, custom SSR, …)

```tsx
import { RosettaProvider, useT } from "rosetta-i18n/react";
import manifest from "./i18n.json";   // from `rosetta manifest`

<RosettaProvider
  manifest={manifest}
  locale={locale}                                   // you own routing; or:
  detect                                            // pick from URL/cookie/navigator.languages
  load={(l) => import(`./messages/${l}.json`)}
>
  <App />
</RosettaProvider>
```

- The provider:
  - suspends while a locale loads;
  - keeps the previous locale on screen during a switch, so the page doesn't flash;
  - sets `document.documentElement.lang` and `dir`.
- `useLocale()` returns `{ locale, locales, setLocale }`. `setLocale` sets the cookie
  and loads the new catalog.
- Routing is out of scope. The provider works with any router, and a path-prefix
  helper (`localizePath`, `stripLocale`) is exported.

### 8.3 Astro

```js
// astro.config.mjs
import rosetta from "rosetta-i18n/astro";
export default defineConfig({ integrations: [rosetta()] });
```

- The integration calls `updateConfig` to set Astro's built-in i18n from the Rosetta
  config:
  - `locales`;
  - `defaultLocale` = `sourceLocale`;
  - `routing.prefixDefaultLocale` = (`strategy === "prefix-always"`).
- **Detection:**
  - **SSR** (`output: "server"` or on-demand pages): it injects middleware with the
    same negotiation and cookie behavior as Next.js.
  - **Static builds:** it can't redirect on the server. There's an optional,
    opt-in inline script that does a one-time client-side redirect from `/` using
    the cookie and `navigator.languages`.
- **Pages:**

  ```astro
  ---
  import { getT, localePaths } from "rosetta-i18n/astro";
  export const getStaticPaths = localePaths;         // one page per locale under src/pages/[...locale]/
  const t = await getT(Astro, "Home");
  ---
  <h1>{t("title")}</h1>
  <p set:html={t.rich("terms", { terms: (c) => `<a href="/terms">${c}</a>` })} />
  ```

- **Components:** `<LocaleSwitcher />` (plain `<a>` links and no JavaScript, or
  `client:load` for the cookie), `<Alternates />` (`hreflang` `<link>` tags), and
  `<HtmlAttrs />` for `lang` and `dir`.
- **Messages** are loaded through `import.meta.glob` over the config's `files`
  patterns, so no `load()` function is needed.
- **Proving ground:** rosetta.tools, translated into several languages with Rosetta
  itself.

## 9. CLI additions

| Command | What it does |
|---|---|
| `rosetta init --next` | Writes `i18n.ts`, `proxy.ts` (or `middleware.ts` for Next 15) and the `withRosetta` wrapper, and prints the one manual step: moving `app/*` into `app/[locale]/`. `--move-app` does that move with `git mv`. |
| `rosetta init --astro` | Adds the integration to `astro.config.*` and, with `--move-pages`, moves pages under `src/pages/[...locale]/`. |
| `rosetta manifest` | Prints the runtime manifest (locales, display names, directions, routing) for plain React apps. |
| `rosetta types` | Writes `rosetta.d.ts`, with message keys and argument types from the source catalog. |

## 10. Testing

- **Core:**
  - the formatter, tested against a table of ICU cases, with pinned output for every
    locale's plural rules;
  - the fallback chain;
  - negotiation, including q-values, region matching and bots.
- **React:** Testing Library tests for the provider, hooks, `<T>`, switching, and
  suspense.
- **Next.js:**
  - unit tests for every row in the middleware table (§8.1), with real `NextRequest`
    objects;
  - an `examples/next` app built and smoke-tested in CI with `next build`,
    `next start`, and `curl` for redirects, cookies, `lang`/`dir` and `hreflang`.
- **Astro:** an `examples/astro` static site plus an SSR build in CI, and the
  rosetta.tools site itself.
- **Hydration:** a test that renders on the server and hydrates on the client,
  asserting no mismatch warnings. This covers dates, numbers and plurals in `ar`,
  `ja` and `pt-BR`.

## 11. Phases

1. **Core and `/react`:** formatter, fallback, negotiation, provider, hooks, `<T>`,
   switcher, and `rosetta manifest`.
2. **`/next`:** `withRosetta`, `defineI18n`, middleware/proxy, layout, `getT`,
   navigation, SEO helpers, `examples/next`, and `rosetta init --next`. Then
   replace Jot's hand-written locale layer (`locales.ts`, the `x-jot-locale` header,
   the cookie, `LOCALIZED_PUBLIC_PATHS`) as the real-world test.
3. **`/astro`:** the integration, components, `examples/astro`,
   `rosetta init --astro`, and translating rosetta.tools.
4. **Types:** `rosetta types`, plus typed `t()` in all three adapters.

## 12. Decisions to confirm

1. **Own runtime, not a preset on top of next-intl.** Proposed: our own runtime, for
   one API across all three frameworks and no dependencies.
2. **Default strategy `prefix-except-default`** (the source locale has no prefix),
   matching Jot. Proposed: yes.
3. **Missing keys fall back to the source locale at runtime.** Proposed: yes. This is
   a behavior change for projects that currently rely on parity tests to catch
   missing keys, but `rosetta check` still does that in CI.
4. **The Next.js minimum is 15**, with the `proxy.ts` naming on 16+ and
   `middleware.ts` on 15. Proposed: yes; Next 14 isn't supported.
5. **Scaffolding writes files but doesn't move `app/` unless `--move-app` is passed.**
   Proposed: yes.
