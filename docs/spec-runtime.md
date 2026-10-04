# Rosetta runtime spec: React, Next.js, Astro

- **Status:** Draft 2, for discussion
- **Builds on:** [`spec-v1.md`](./spec-v1.md), which covers translation. This spec covers
  rendering and routing.
- **Package:** the same `rosetta-i18n`, with new entry points under
  `rosetta-i18n/react`, `rosetta-i18n/next/*` and `rosetta-i18n/astro`

## 1. Summary

Rosetta v1 writes translated locale files. Rendering them, and all the plumbing
around locales, is still left to each project. That plumbing includes:

- a locale list copied into several places;
- routing that serves `/es/pricing` and detects the visitor's language;
- a provider that loads the right messages;
- a locale switcher, and links that keep the current locale;
- `<html lang dir>`, `hreflang` alternates, and static params for every locale.

The runtime removes it. **`.rosetta/config.json` drives both translation and
routing.** Add a locale to the config, run `rosetta push`, rebuild, and routing,
the switcher, and SEO tags pick it up with no other changes.

The runtime is designed **performance first, ergonomics second**. Where the
two conflict, the runtime picks the fast option and makes the slow option an
explicit opt-in. It never silently falls back to a slower rendering mode.

## 2. Performance invariants

These are requirements, not goals. Each has a CI check (§10).

1. **Every localized page can be prerendered.** No runtime API used in rendering
   reads `headers()`, `cookies()`, or anything else that opts a Next.js route
   into dynamic rendering. The locale always comes from the route (`[locale]`),
   never from the request.
2. **Server-rendered text sends no catalog to the browser.** A server component
   that calls `t()` sends only the resulting HTML. Messages reach the client only
   for namespaces you explicitly hand to a client provider (§5.3).
3. **No duplicate payloads.** Fallback to the source locale is resolved on the
   server, once per locale. The client never receives both a target catalog and
   the source catalog.
4. **Small client runtime.** Lookup plus the ICU formatter is tree-shakeable and
   budgeted at **≤ 3 kB min+gzip**. A page with no client-side `t()` ships
   **0 bytes** of formatter; `Link` and `useLocale` add only a context read.
5. **No routing function when you don't need one.** With detection off, routing
   is expressed as static `rewrites`/`redirects` in `next.config`, so no
   middleware or proxy runs. With detection on, the proxy imports only the
   manifest (budget **≤ 5 kB**), never catalogs, and does no work on prefixed
   URLs.
6. **At most one redirect per request.** Crawlers are never redirected. The
   proxy is stateless and keeps no record of past redirects, so the limit is per
   request: an unprefixed URL gets at most one redirect, straight to its final
   locale, never a chain. A visitor who arrives on an unprefixed URL again may be
   redirected again. In practice that's rare, because `Link` keeps them on
   prefixed URLs, and a locale chosen with the switcher wins through the cookie.
   Redirect responses are `Cache-Control: private` and
   `Vary: Cookie, Accept-Language`; page responses keep their normal caching.
7. **No `Set-Cookie` on page responses.** Only an explicit choice (the switcher)
   writes the locale cookie, and it does so on the client. Pages stay cacheable
   at the CDN.
8. **Fail loudly instead of going dynamic.** If the runtime can't find the locale
   statically (e.g. on a Next.js version without `next/root-params`, or in a
   Server Action), it throws a build-time or dev error that says which
   argument to pass. It never falls back to reading headers.

## 3. Goals and non-goals

### Goals

- **Minimal setup.** Next.js: `next.config`, one `i18n.ts`, and the root layout.
  Astro: one integration line. React: one provider.
- **One source of truth** for locales: the Rosetta config.
- **The same `t()` everywhere:** server components, client components, and
  `.astro` files.
- **Correct by default:** `<html lang>`, `dir="rtl"` for RTL locales, canonical
  and `hreflang` alternates.
- **Missing translations fall back to the source locale** instead of breaking.
- **Zero runtime dependencies.** Formatting uses the built-in `Intl` APIs. React,
  Next.js and Astro are optional peer dependencies.

### Non-goals for the first release

- Frameworks other than React, Next.js (App Router), and Astro.
- Domain- or subdomain-per-locale routing. Planned; the config leaves room.
- Localized URL slugs (`/es/precios`). Planned.
- Translating on the client at runtime. The runtime renders pre-translated
  catalogs; dynamic content still uses the server-only `cachedTranslate`.
- A full ICU implementation. We support what `Intl` covers (§6); `rosetta check`
  rejects the rest.

## 4. Packaging

| Entry point | Runs in | Provides |
|---|---|---|
| `rosetta-i18n/react` | browser, server | `RosettaProvider`, `useT`, `useLocale`, `LocaleSwitcher`, `localizePath`, `stripLocale` (`"use client"`) |
| `rosetta-i18n/next` | server only | `defineI18n` (`getT`, `getLocale`, `htmlAttrs`, `Provider`, `alternates`, `sitemap`, `generateStaticParams`), plus the existing `createRosetta` / `cachedTranslate` |
| `rosetta-i18n/next/client` | browser, server | `Link`, `usePathname`, `useRouter`, `LocaleSwitcher`, `LocaleSuggestion`, and re-exports of `useT` / `useLocale` (`"use client"`) |
| `rosetta-i18n/next/plugin` | Node (build) | `withRosetta` |
| `rosetta-i18n/next/proxy` | edge, Node | `proxy` (ready-made, re-exportable from `proxy.ts`/`middleware.ts`) and `rosettaProxy(request)` (for composing with your own middleware). Detection only; imports the manifest, nothing else |
| `rosetta-i18n/astro` | Node (build/SSR), browser | the integration, `getT`, `localePaths`, components |

- **Server/client split.** `rosetta-i18n/next` is server-only (it imports
  `server-only`), which lets it keep the existing `createRosetta` and
  `cachedTranslate` exports. Everything a client component can import lives in
  `/next/client` or `/react`. The rollup build must keep `"use client"`
  directives at the top of those output chunks, using a directive-preserving
  plugin or `preserveModules`.
- **Internal core** (`src/runtime/`, not public): message lookup and fallback,
  the ICU formatter, locale negotiation, and building the manifest. No
  dependencies. It needs an **AST-producing ICU parser**. Today's parser in
  `src/validate.ts` only returns a structural signature, so it gets refactored to
  build an AST, and `validate.ts` derives its signature from that AST. Validation
  and rendering then share one parser.
- **Peer dependencies:** `react >= 18`, `next >= 14` (unchanged, because
  `cachedTranslate` still supports 14), `astro >= 5`. The routing runtime needs
  `next >= 15` and checks for it at build time; automatic locale resolution
  needs `>= 16.3` (§8.1).
- **Astro components** ship as source under `rosetta-i18n/astro/components/*`.

## 5. Configuration and messages

### 5.1 Config

The runtime reads the existing config. An optional `routing` block, in which
every field has a default, adds routing settings. An optional `format` block
adds formatting settings.

```jsonc
// .rosetta/config.json
{
  "sourceLocale": "en",
  "targetLocales": ["es", "ja", "ar", "pt-BR"],
  "files": [{ "pattern": "messages/en.json" }],
  "routing": {
    "strategy": "prefix-except-default",   // or "prefix-always"
    "detect": "redirect",                  // "redirect" | "suggest" | "off"
    "cookie": "rosetta-locale",
    "localizedPaths": ["/", "/pricing", "/blog/**"]   // default: every path
  },
  "format": { "timeZone": "UTC" }
}
```

| Field | Default | Meaning |
|---|---|---|
| `routing.strategy` | `prefix-except-default` | `prefix-except-default`: the source locale is served at `/pricing`, others at `/es/pricing`. `prefix-always`: every locale is prefixed. |
| `routing.detect` | `redirect` | `redirect`: a small proxy sends first-time visitors to their language (§7). `suggest`: no server work; a client `<LocaleSuggestion>` banner offers the switch. `off`: no detection, no proxy. |
| `routing.cookie` | `rosetta-locale` | Name of the cookie the switcher writes. It's read only by the `redirect` proxy. |
| `routing.localizedPaths` | every path | Glob allowlist. Other paths stay source-only and are never rewritten or redirected. |
| `format.timeZone` | `UTC` | Time zone for `date`/`time` formatting. It's fixed so the server and client produce the same output. |

- **Schema compatibility.** `schema/config.json` has `additionalProperties: false`,
  so today's CLI rejects `routing` and `format`. Both are added to the schema in
  the release that ships the runtime, and the docs say to upgrade the CLI and the
  pinned GitHub Action together.
- **Locale codes.** Codes in the config are normalized to BCP 47 (`pt_BR` becomes
  `pt-BR`) for URLs, `lang`, `hreflang` and the manifest. File paths keep
  whatever form the files use; the mapping reuses `src/project/paths.ts`.
- **Derived values.** Display names come from `Intl.DisplayNames`, in each
  locale's own language. Direction comes from `Intl.Locale#textInfo` (or
  `getTextInfo()`), with a fallback list (`ar he fa ur ps sd yi dv ug ku`).
  Both are computed **at build time** and stored in the manifest.

### 5.2 The manifest

The runtime never parses JSONC at request time. A build step turns the config
into a compact **manifest**: locales, source locale, display names, directions,
routing settings, and the format settings.

- **Next.js:** `withRosetta()` builds it when Next loads its config and inlines
  it through `env.ROSETTA_I18N`. It's available on the server, on the edge, and
  in the browser, and it's a few hundred bytes. Changing `routing` requires
  restarting the dev server.
- **Astro:** the integration exposes it as `virtual:rosetta/manifest`.
- **Plain React:** `rosetta manifest > src/i18n.json`. `rosetta check` fails
  (exit `3`) if that file is stale, so it can't drift from the config.

### 5.3 Loading, fallback, and what reaches the client

- **Loading.** On the server, messages load through a `load(locale)` you supply
  (Next, React) or a generated virtual module (Astro). Multi-file configs
  (`locales/en/**/*.json`) map each file to a namespace from its path relative to
  the pattern's static prefix: `locales/en/auth/login.json` becomes
  `auth.login`. `rosetta init` generates the matching `load`.
- **Fallback chain:** requested locale, then its base language if configured
  (`pt-BR` → `pt`), then the source locale, then the key itself. Steps 3 and 4
  warn in development.
- **Resolved once, on the server.** For each locale, the server merges the
  catalogs in the order of the fallback chain (target, then base language if
  configured, then source) once, and caches the result in module scope. During
  `next build` that happens once per locale for the whole build.
- **Each message's plural rules come from the locale that supplied it;
  number and date formatting always use the requested locale.** A message that
  fell back to `pt` uses `pt` plural rules, and one that fell back to English
  uses English rules. An English `one`/`other` message therefore stays
  grammatical when shown to an Arabic visitor.
- **`ignoredKeys`** (omitted from target files) render in the source language.
  That's the intent of ignoring a key.
- **What the client gets.** Nothing, by default. A client component that needs
  `useT` must sit under a `Provider` that names its namespaces (§8.1). Each
  provider sends only those namespaces, already merged, as plain strings. It
  sends them once, as part of the RSC payload for the segment it's rendered in.
  In development, `useT` on a namespace that wasn't provided throws an error
  naming the namespace to add. In production it renders the key and logs once.
- **Recommended pattern.** Translate in server components and pass the resulting
  strings to client components as props. Use `useT` on the client only where the
  message changes with client state (a live count, a form error).

## 6. Formatting API

The same API is used everywhere: `await i18n.getT()` in server components,
`useT()` in client components, and `getT(Astro)` in `.astro` files.

```ts
const t = await i18n.getT("Pricing");     // namespace = key prefix (optional)

t("cta");                                  // "Start free"
t("trial", { days: 14 });                  // "{days, plural, one {# day} other {# days}} free"
t.rich("terms", { terms: (chunks) => <a href="/terms">{chunks}</a> });
t.has("beta");                             // boolean
t.raw("list");                             // unformatted value (arrays, objects)
```

- **ICU subset:** `{arg}`; `plural` and `selectordinal` with `=N` cases and
  `offset:` (`Intl.PluralRules`); `select`; `#`; `number` (default, `percent`,
  `integer`, and a `::currency/XXX` skeleton subset) via `Intl.NumberFormat`;
  `date` and `time` (`short`, `medium`, `long`, `full`) via
  `Intl.DateTimeFormat`; apostrophe quoting.
- **Enforced by `check`.** Today `check` only compares each target with its
  source, and it falls back to loose matching for non-ICU sources such as
  i18next `{{name}}`. The runtime adds a **source lint**: when a `routing` block
  is present, every source message must parse into the supported subset, or
  `check` fails with the key and the unsupported construct. Projects without
  `routing` keep today's behavior. If an invalid message reaches the runtime
  anyway, it renders the raw string and logs once. It never throws in
  production.
- **Fast paths.** A message with no `{`, `<` or `'` is returned as-is, with no
  parse. Other messages are compiled on first use and memoized per locale and
  key.
- **Rich text:** in React, `t.rich` maps each tag to a function that returns a
  node. In Astro it returns an HTML string, and **message text and arguments
  are HTML-escaped before the tag functions run**, since translations come
  from an LLM. Tags with no handler render their inner text and warn in
  development.
- **Deterministic output.** Formatting uses the route's locale and
  `format.timeZone`. Node's ICU data and the browser's can still differ in
  small ways (e.g. U+202F in times). That's one more reason to format on the
  server; the hydration test (§10) covers the client path.
- **Build-time freeze.** Statically rendered pages format dates at build time.
  Relative or "now"-based values belong in a client component, or in a
  revalidated or dynamic segment.

## 7. Locale negotiation

`negotiateLocale(input)` is a pure function over the URL, the cookie value and
the `Accept-Language` value. It runs in the Next proxy, in Astro SSR middleware,
and in `<LocaleSuggestion>` in the browser.

1. **URL prefix.** An exact, case-insensitive match against the configured
   locales. `/pt-br/…` redirects to `/pt-BR/…`.
2. **Cookie**, if it holds a configured locale.
3. **Language list** (`Accept-Language` on the server, `navigator.languages` in
   the browser), weighted by q-value and matched in this order: exact match, then
   same language with a different region (`pt-PT` → `pt-BR`), then base language.
4. Otherwise, the source locale.

Requests from bots (by user-agent) skip steps 2 and 3.

## 8. Adapters

### 8.1 Next.js (App Router)

**Locale resolution.** On Next.js **16.3+**, `next/root-params` lets any server
component read the `[locale]` root param. That includes nested components and
`generateMetadata`, and it works without `headers()`, so pages stay fully
static. It doesn't yet work in Route Handlers or Server Actions. There, and on
older Next.js versions, you pass the locale explicitly (the "explicit mode"
below). The runtime never reads a request header to find the locale.

`next/root-params` is a module Next generates for the app. So the import lives in
the user's `i18n.ts` rather than inside our package, and older versions of Next
simply leave it out:

```ts
// next.config.ts
import { withRosetta } from "rosetta-i18n/next/plugin";
export default withRosetta({ /* your Next config */ });

// i18n.ts — server-only
import { locale } from "next/root-params";          // Next 16.3+
import { defineI18n } from "rosetta-i18n/next";
export const i18n = defineI18n({
  locale,                                            // omit on Next 15–16.2
  load: (l) => import(`./messages/${l}.json`),
});
```

```tsx
// app/[locale]/layout.tsx — the root layout (no app/layout.tsx above it)
import { i18n } from "@/i18n";
export const generateStaticParams = i18n.generateStaticParams;

export default async function RootLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <html {...await i18n.htmlAttrs()}>              {/* lang + dir */}
      <body>
        <i18n.Provider messages={["Nav"]}>{children}</i18n.Provider>
      </body>
    </html>
  );
}
```

- The layout is yours. The runtime supplies attributes and a provider, and
  doesn't own `<html>`, fonts, or `<body>`.
- `i18n.Provider` is an async server component. It renders the client provider
  with the locale (always) and the listed namespaces (only those). A provider
  with no `messages` costs a context value and no catalog. Providers nest, and
  a nested provider adds namespaces for its subtree.
- `i18n.getLocale()` validates the param and calls `notFound()` for unknown
  locales. That works with Cache Components, where `dynamicParams = false`
  doesn't. Without Cache Components, `rosetta init --next` also emits
  `export const dynamicParams = false`.

**Pages and metadata:**

```tsx
// app/[locale]/pricing/page.tsx
import { i18n } from "@/i18n";
import { Calculator } from "./calculator";   // "use client", uses useT("Pricing.calc")

export default async function Page() {
  const t = await i18n.getT("Pricing");
  return (
    <>
      <h1>{t("title")}</h1>
      <i18n.Provider messages={["Pricing.calc"]}><Calculator /></i18n.Provider>
    </>
  );
}

export async function generateMetadata() {
  const t = await i18n.getT("Pricing");
  return { title: t("meta.title"), alternates: await i18n.alternates("/pricing") };
}
```

- **Alternates are per page**, because layouts in Next don't know the current
  path. Dynamic routes build the path from params, e.g.
  ``i18n.alternates(`/blog/${slug}`)``.
- **`i18n.sitemap(entries)`** adds `alternates.languages` to each entry of a
  `sitemap.ts`. Google accepts `hreflang` in the sitemap, so this is the
  recommended default: one build-time file instead of tags on every page.

**Explicit mode** (Server Actions, Route Handlers, `"use cache"` functions, and
Next 15–16.2): every server API accepts `{ locale }`:

```ts
const t = await i18n.getT({ locale, namespace: "ContactForm" });
```

In explicit mode, calling a server API without `locale` throws an error that
says "pass `{ locale }` or upgrade to Next 16.3". Client code gets the locale
from `useLocale()` and binds it into the action.

**Routing, with no middleware by default.** `withRosetta` adds static
`rewrites` and `redirects`, merged with any you already have:

| Request | Handled by | Result |
|---|---|---|
| `/es/pricing` | the `[locale]` route | served statically |
| `/pricing` | `beforeFiles` rewrite | served from `/en/pricing`; the URL stays `/pricing` |
| `/en/pricing` | `redirects` | 308 to `/pricing` (the source locale is never prefixed) |
| `/pt-br/pricing` | `redirects` | 308 to `/pt-BR/pricing` |
| `/_next/*`, `/api/*`, files, non-`localizedPaths` | — | untouched |

Under `prefix-always`, the unprefixed-path redirect depends on detection,
because Next.js runs `redirects` from `next.config` *before* the proxy (order:
`headers`, `redirects`, proxy, `beforeFiles` rewrites, routes). A static
redirect would therefore fire before the proxy could negotiate.

- **Detection off or `suggest`:** `withRosetta` emits a static 307 from each
  unprefixed localized path to the source locale (`/pricing` → `/en/pricing`).
- **Detection `redirect`:** `withRosetta` emits **no** unprefixed-path redirect.
  The proxy handles both decisions: it sends a 307 to the negotiated locale,
  which may be the source locale.

The prefixed-path redirects in the table (`/en/…` and case fixes) don't overlap
with the proxy, which ignores prefixed paths, so they stay static in both cases.

**Detection (`detect: "redirect"`)** adds a proxy that only decides whether to
redirect:

```ts
// proxy.ts (Next 16+) or middleware.ts (Next 15)
export { proxy } from "rosetta-i18n/next/proxy";
export const config = { matcher: ["/((?!api|_next|.*\\..*).*)"] };  // must be a literal here
```

- It returns immediately for prefixed paths and non-localized paths, and for
  bots.
- For an unprefixed path, it negotiates (§7). Under `prefix-except-default`,
  if the result is the source locale it passes the request through to the
  static rewrite. Otherwise (and always under `prefix-always`), it sends a 307
  to the prefixed URL with `Cache-Control: private` and
  `Vary: Cookie, Accept-Language`.
- It never sets cookies and never touches catalogs. Users with their own
  middleware call `rosettaProxy(request)` and use the returned response or
  `null`.
- The matcher is generic on purpose, so adding a locale doesn't require editing
  it.

**`detect: "suggest"`** skips the proxy entirely. `<LocaleSuggestion />` from
`/next/client` runs after hydration. If `navigator.languages` negotiates to a
different locale and no cookie is set, it shows a dismissible link to the same
page in that locale. It adds no server work and no redirect, and it doesn't
affect LCP.

**Navigation (`/next/client`):** `Link` localizes `href` using the locale from
context (`href="/pricing"` becomes `/es/pricing`), and a `locale` prop switches
locale. `usePathname` and `useRouter` work on paths without the prefix.
`LocaleSwitcher` is unstyled and supports a render prop. It sets the cookie on
the client, then navigates.

### 8.2 React (Vite, custom SSR, …)

```tsx
import { RosettaProvider } from "rosetta-i18n/react";
import manifest from "./i18n.json";   // from `rosetta manifest`

<RosettaProvider
  manifest={manifest}
  locale={locale}                                   // you own routing, or:
  detect                                            // URL prefix → cookie → navigator.languages
  load={(l) => import(`./messages/${l}.json`)}      // one chunk per locale
  initialMessages={ssrMessages}                     // optional: skip the first fetch
>
  <App />
</RosettaProvider>
```

- The first locale's catalog should load in parallel with the app, not after
  it. The provider exports `preloadLocale(locale)` so an entry point can start
  the import before React renders.
- When the locale changes, the provider keeps the previous locale on screen
  until the new catalog is ready (via `useTransition`, not a Suspense fallback),
  then updates `document.documentElement.lang` and `dir`.
- `useLocale()` returns `{ locale, locales, setLocale }`. Routing is out of
  scope; `localizePath` and `stripLocale` are exported.

### 8.3 Astro

```js
// astro.config.mjs
import rosetta from "rosetta-i18n/astro";
export default defineConfig({ integrations: [rosetta()] });
```

- The integration sets Astro's `i18n` config (`locales`, `defaultLocale`)
  with `routing: "manual"`, so Astro supplies `Astro.currentLocale` and its URL
  helpers and Rosetta owns routing. That avoids running two routing layers.
  Astro allows no other routing options (such as `prefixDefaultLocale`) with
  `routing: "manual"`, so the integration sets none. Rosetta applies the
  default-locale prefix strategy (`routing.strategy`) itself, through
  `localePaths` and its own middleware.
- **Pages** use one `src/pages/[...locale]/` tree. `localePaths` returns an
  undefined `locale` param for the source locale and the prefix for the others:

  ```astro
  ---
  import { getT, localePaths } from "rosetta-i18n/astro";
  export const getStaticPaths = localePaths;
  const t = await getT(Astro, "Home");
  ---
  <h1>{t("title")}</h1>
  <p set:html={t.rich("terms", { terms: (c) => `<a href="/terms">${c}</a>` })} />
  ```

- **Messages** come from a generated virtual module containing one
  `import.meta.glob` call per config pattern. Vite requires literal glob
  patterns, so the patterns are written into generated code rather than read at
  runtime.
- **Detection:** in SSR, `detect: "redirect"` injects middleware that behaves the
  same way as the Next proxy. For static builds, `redirect` isn't possible, so the
  integration falls back to `suggest` and warns at build time. There's no
  client-side redirect script, because redirecting after the page loads costs
  more than it saves.
- **Components:** `<LocaleSwitcher />` (plain links, no JavaScript),
  `<LocaleSuggestion />` (a small island), `<Alternates />`, and `<HtmlAttrs />`.
- **Proving ground:** rosetta.tools, translated with Rosetta itself.

## 9. CLI additions

| Command | What it does | Exit codes |
|---|---|---|
| `rosetta init --next` | Writes `i18n.ts` (with `next/root-params` on 16.3+), wraps `next.config`, and on `detect: "redirect"` writes `proxy.ts` or `middleware.ts`. Prints the manual move of `app/*` into `app/[locale]/`; `--move-app` does the move with `git mv`, and moves non-localized routes into a `(unlocalized)` group with its own root layout. | `0`, `2` |
| `rosetta init --astro` | Adds the integration; `--move-pages` moves pages under `src/pages/[...locale]/`. | `0`, `2` |
| `rosetta manifest` | Prints the runtime manifest for plain React apps. | `0`, `2` |
| `rosetta types` | Writes `rosetta.d.ts`, with message keys and argument types from the source catalog. | `0`, `2` |
| `rosetta check` (extended) | Adds the source lint (§6) and the stale-manifest check (§5.2). | unchanged: `0`, `2`, `3` |

## 10. Testing

- **Core:** a table of ICU cases, with pinned output for every locale's plural
  rules; the fallback chain, including fallback plural rules; negotiation,
  including q-values, region matching and bots.
- **React:** Testing Library tests for the provider, hooks, switching without
  a flash, and `preloadLocale`.
- **Next.js:** `examples/next` is built in CI on the minimum supported Next.js
  (explicit mode) and on the latest (root-params mode). CI asserts:
  - **every localized route is prerendered** for every locale, checked by
    reading `.next/prerender-manifest.json`. A route that turns dynamic fails
    the build (invariant 1);
  - **a page with no client provider has no message strings in its RSC payload**
    (invariant 2);
  - the client runtime and proxy bundle sizes stay within budget, using
    `size-limit` (invariants 4 and 5);
  - after `next start`, `curl` checks each row of the routing table, and checks
    that the proxy never redirects a bot, that redirects carry `Vary`, and that
    page responses have no `Set-Cookie` (invariants 6 and 7).
- **Astro:** `examples/astro` built as static and as SSR, plus the
  rosetta.tools site. CI checks that the HTML output escapes a rich-text
  message containing `<script>`.
- **Hydration:** render on the server and hydrate on the client, asserting no
  mismatch warnings for dates, numbers and plurals in `ar`, `ja` and `pt-BR`.

## 11. Phases

1. **Core and `/react`:** the AST parser refactor, the formatter, fallback,
   negotiation, the provider and hooks, and `rosetta manifest`, plus the source
   lint in `check`.
2. **`/next`:** the plugin (manifest, rewrites, redirects), `defineI18n` with
   root-params and explicit modes, `Provider`, navigation, SEO helpers, the proxy,
   `LocaleSuggestion`, `examples/next` with the CI checks in §10, and
   `rosetta init --next`. Then replace Jot's hand-written locale layer as the
   real-world test.
3. **`/astro`:** the integration, components, `examples/astro`,
   `rosetta init --astro`, and translating rosetta.tools.
4. **Types:** `rosetta types` and typed `t()` in all three adapters. Possibly
   also build-time extraction of the namespaces client components use, so
   `Provider messages` can be generated.

## 12. Decisions to confirm

1. **Own runtime, not a preset on next-intl.** Proposed: yes.
2. **`prefix-except-default` by default.** Proposed: yes.
3. **Missing keys fall back to the source locale, resolved on the server.**
   Proposed: yes.
4. **Next.js support:** the routing runtime needs Next 15+. Automatic locale
   resolution needs 16.3+ (`next/root-params`). Next 15–16.2 get explicit mode
   rather than a header-based fallback. Proposed: yes. The alternative, a
   `setRequestLocale`-style store based on React `cache()`, works on 15, but it
   has to be called in every layout and page, and next-intl has already moved
   off it.
5. **Default detection: `redirect` or `suggest`.** `redirect` gives the right
   language on first paint, at the cost of a proxy invocation on every
   unprefixed request and one 307 per new visitor. `suggest` costs no server
   work but shows the source language first. Proposed: `redirect`, with
   `suggest` one config line away.
6. **Client messages are opt-in per namespace**; nothing is sent by default.
   Proposed: yes. It's the one place where ergonomics give way to performance, and
   the dev error makes it quick to fix.
7. **Scaffolding doesn't move `app/` unless `--move-app` is passed.** Proposed: yes.

## 13. Open questions

- Can `next/root-params` be called inside `"use cache"` functions, and is the
  root param then part of the cache key? Until that's confirmed, the docs say to
  pass `{ locale }` explicitly inside `"use cache"`. The locale belongs in the
  cache key either way.
- Does `Astro.currentLocale` resolve correctly with `routing: "manual"` and a
  `[...locale]` tree? This needs to be confirmed in Phase 3.
- Which Next 16.x releases before 16.3 support `experimental.rootParams`
  reliably enough for `rosetta init` to enable it automatically?
