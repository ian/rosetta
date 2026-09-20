# Migrating an app to rosetta-i18n

A playbook for replacing an existing translation stack with `rosetta-i18n`.
Covers static UI catalogs, database/content translation, and on-demand server
translation — pick the mode(s) the app needs.

For a ready-to-run agent prompt that executes this spec, see
[`agent-prompt.md`](./agent-prompt.md).

## 1. Inventory (do this first)

Before changing anything, find:

- **Existing i18n runtime** — `next-intl`, `react-i18next`, `FormatJS`, custom.
  Rosetta does not replace the runtime; it feeds it.
- **Translation engine** — a vendor (`lingo.dev`, Phrase, Lokalise, Crowdin), an
  in-repo package, or hand-written copy. This is what Rosetta replaces.
- **What is translated**
  - static UI chrome / generated copy → catalogs
  - database or CMS content (blurbs, descriptions, product copy) → server content
  - dynamic user-facing copy rendered per request → on-demand server
  - email, metadata/SEO, push copy
- **Where translations live** — JSON catalogs in the repo, a DB table, a KV store,
  or a vendor dashboard.
- **Source locale** and **target locales**.
- **When translation runs** — build time, request time, or on mutation.

Record this as a short table; it determines the mode.

## 2. Choose integration mode(s)

| Mode | Use for | Entrypoint |
| --- | --- | --- |
| **A. Build-time catalogs** | Static UI strings in a JSON catalog | `rosetta-i18n translate-catalog` CLI |
| **B. Server content** | DB/CMS copy translated on mutation, stored + read at render | `Rosetta` class + your datastore |
| **C. On-demand server** | Per-request dynamic copy, RSC, route handlers | `rosetta-i18n/next` `cachedTranslate` |

An app often needs more than one. Static chrome → A; content records → B;
anything generated at request time → C.

## 3. Install & configure

```bash
pnpm add rosetta-i18n
# only if you call it from a module that must never be bundled client-side:
pnpm add server-only
```

Environment (server only — never expose to the client):

| Variable | Required | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — |
| `ROSETTA_MODEL` | no | `anthropic/claude-sonnet-4.5` |
| `ROSETTA_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `ROSETTA_BRAND_VOICE` | no | — |

Instantiate once in a server-only module:

```ts
// lib/rosetta.ts
import "server-only";
import { getRosetta } from "rosetta-i18n/next";

export const rosetta = getRosetta();
```

Apps that aren't Next.js (or don't want the optional `next` peer) use the core
class directly:

```ts
import { Rosetta } from "rosetta-i18n";

export const rosetta = new Rosetta({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.ROSETTA_MODEL ?? "anthropic/claude-sonnet-4.5",
  brandVoice: { variations: { "*": process.env.ROSETTA_BRAND_VOICE ?? "" } },
});
```

## 4. Mode A — build-time catalogs

Best for static UI strings. No LLM in the request path.

1. Identify the source catalog (usually `messages/en.json`).
2. Add a script:

   ```json
   {
     "scripts": {
       "i18n:translate": "rosetta-i18n translate-catalog messages/en.json --merge --target es --target pt-BR --context \"<app> UI catalog\""
     }
   }
   ```

3. Run it once and commit the generated `<target>.json` files.
4. Wire the runtime loader (e.g. next-intl):

   ```ts
   // i18n/request.ts
   export default getRequestConfig(async ({ locale }) => ({
     messages: (await import(`../messages/${locale}.json`)).default,
   }));
   ```

5. In CI, run with `--merge` and fail on a dirty diff (or commit it back) so new
   source keys are always translated and reviewed.
6. Review diffs. Add a glossary for recurring brand terms.

`--merge` only translates keys missing from the target file, so routine runs cost
one request per batch of new keys, not a full re-translation.

## 5. Mode B — database / CMS content

Best for content records (blurbs, descriptions, product copy). This is the
reference pattern used by BRG.

1. **Decide target locales** — mirror the app's SEO/locale list.
2. **Add storage** — a `Translation` table keyed `(entityId, field, locale)` with
   a unique index, or a KV namespace.
3. **Write a non-throwing wrapper** around `Rosetta`:

   ```ts
   export async function translateAndStore(
     entityId: string,
     fields: Record<string, string>,
   ): Promise<void> {
     if (!process.env.OPENROUTER_API_KEY) return; // graceful no-op
     const data = Object.fromEntries(
       Object.entries(fields).filter(([, v]) => v?.trim()),
     );
     if (Object.keys(data).length === 0) return;
     try {
       for (const target of TARGET_LOCALES) {
         const translated = await rosetta.translate(data, {
           source: "en",
           target,
           context: "<entity> listing",
         });
         // upsert only successfully translated keys
       }
     } catch (error) {
       console.error("[i18n] translation failed", error); // never rethrow
     }
   }
   ```

4. **Queue it off the request path** on mutations (`void translateAndStore(...)`),
   so user writes never block on the model.
5. **Fall back to the source locale at read time** when no row exists.
6. **Backfill** existing rows with a script ordered by traffic; start with cheap,
   high-traffic entities.
7. **Re-translate on edit** — hook the change-request / webhook path.
8. English/source copy is the source of truth; translations are derived.

## 6. Mode C — on-demand server translation

For copy that only exists at render time (RSC, route handlers, server actions):

```ts
import { cachedTranslate } from "rosetta-i18n/next";

const copy = await cachedTranslate(
  { hero: "Every awarded restaurant in the world" },
  { source: "en", target: locale, context: "home hero" },
  { revalidate: 60 * 60 * 24, tags: ["i18n"] },
);
```

The cache keys on source/target/payload, so repeated renders do not re-call the
model. Prefer Mode A when the strings are known at build time — it's cheaper and
has zero request-path latency.

## 7. Brand voice & glossary

- Provide one brand-voice briefing per locale; `*` is the fallback. State tone,
  formality, audience, and conventions (e.g. "always vous" for French).
- List proper nouns that must **not** be translated (brand, product, place,
  award names).
- Use the glossary for exact term mappings that override model judgment.
- Keep the source of truth in the repo (JSON), not a vendor dashboard.

## 8. Failure & fallback semantics

- `rosetta.translate(data)` is **non-throwing at the batch level**: failed
  batches are logged and skipped, and the result contains only successful keys.
  Callers must fall back to the source locale for missing keys.
- `rosetta.translateText(text)` **throws** on a non-OK response.
- Never let a translation failure break a user mutation or a page render.

## 9. Verification

- Unit: mock `fetch` and assert batching, retries, and partial-failure behavior
  for the app's wrapper.
- E2E (no API key needed): run the CLI against a local OpenAI-compatible mock and
  assert the output files, including `--merge` only sending new keys.
- Bundle check: grep the client build for the API key / `rosetta-i18n` imports to
  confirm it is server-only.
- `typecheck`, `lint`, `test`, `build` all green.

## 10. Rollout

- One PR per app, gated by env (`OPENROUTER_API_KEY` absent → no-op).
- Tune `batchSize` / `concurrency` / `retries` after measuring cost.
- Watch the fallback rate (missing-translation reads) after launch.
- Remove the old engine only once catalogs/content are verified.

## Reference implementation: BRG

- Wrapper: `apps/api/src/lib/translation.ts` (brand voice, glossary, 23 locales,
  `Translation` upsert, queued variant).
- Storage: `Translation` model in `packages/db/prisma/schema.prisma`.
- Integration test: `apps/api/src/lib/translation.test.ts` (mocked DB + LLM).
- Switch PR: `bestrestaurantsguide/brg#943` (workspace package → `rosetta-i18n`).

## Migration checklist

- [ ] Inventory recorded (runtime, engine, content types, storage, locales)
- [ ] Mode(s) chosen (A / B / C)
- [ ] `rosetta-i18n` installed; env configured; key is server-only
- [ ] Single server-only Rosetta instance (or `getRosetta()`)
- [ ] Brand voice per locale + do-not-translate list + glossary
- [ ] Translation wired at the right lifecycle point (build / mutation / render)
- [ ] Source-locale fallback verified
- [ ] Failure is non-blocking for user paths
- [ ] Unit + e2e tests added
- [ ] Client bundle contains no key and no `rosetta-i18n` import
- [ ] Backfill run (Mode B) ordered by traffic
- [ ] Old engine removed; unused deps pruned
