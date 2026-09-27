# Example: next-intl + Rosetta

A minimal next-intl app setup with Rosetta-managed catalogs.

```
.rosetta/
  config.json        # source/targets, files, engine (model, brand voice, rules, glossary)
  lock.json          # written by `rosetta push`: which English each translation came from
  glossary.json      # term mappings; "*" terms are never translated
  voice/default.md   # brand voice for every locale (ja has its own inline)
messages/
  en.json            # the only file you edit
  es.json, ja.json   # generated
i18n/request.ts      # next-intl loads the generated catalogs; no LLM at request time
workflows/i18n.yml   # CI: `check` on PRs, rolling translation PR after merges
```

Try it:

```bash
npx rosetta status                   # everything up to date
# edit messages/en.json: change "Create a note" to "New note", add a key
npx rosetta status                   # es/ja: 2 to translate
ROSETTA_API_KEY=sk-or-... npx rosetta push
npx rosetta check
```

Things this example shows:

- `lockedKeys: ["**.href"]` keeps URLs identical in every locale.
- ICU plurals: `ja` legitimately has only an `other` case; validation allows that.
- Rich text: `<terms>…</terms>` must survive translation, or the key is retried.
- Brand voice from a file (`voice/default.md`) plus an inline override for `ja`.
