# few-chat

## ⛔ Privacy invariant — NEVER broadcast profile information

**Profile information (nickname, avatar, or any personal metadata) must NEVER be
broadcast to public relays, under any circumstances.** This is a hard,
non-negotiable product constraint that overrides convenience, feature requests,
and "it's just public data anyway" reasoning.

- **No public kind-0.** The app must not publish the user's kind-0 metadata (name,
  about, picture) to public relays. Profile data is exchanged *only* over encrypted,
  recipient-addressed channels.
- **Allowed channels are targeted and encrypted only:** MLS group application rumors
  (encrypted, sent only to group members) and NIP-59 gift-wrapped events (encrypted
  to a specific recipient's pubkey, sender hidden by an ephemeral key). A gift wrap is
  *not* a broadcast — it is an addressed private message that happens to transit a relay.
  The user's own **relay backup** (kind 30078, NIP-44 encrypted to the user's own key,
  owner-confirmed 2026-10-14) is likewise allowed: only its existence, size and timing are
  visible, never its contents.
- **Reading others' profiles** must likewise not require or induce any public
  broadcast of our own data.
- Before adding or changing any code that publishes, syncs, or fetches profile data,
  confirm it cannot leak profile metadata to an unaddressed audience.

## Multi-platform development

This project is developed across Linux x86_64 and macOS ARM (darwin-arm64). Native dependencies (rolldown, @next/swc) are platform-specific.

- Never assume `node_modules/` from a previous session has the right native binaries.
- The Makefile `node_modules` target stamps the current platform — switching platforms triggers a fresh `npm install`.
- When running build, test, or dev commands, always go through `make` so the platform check runs first.
- Do not run `npm install` and then `touch node_modules` without also writing the platform stamp.

## Static export and dynamic data

The app uses `output: 'export'` (fully static) and is hosted on Cloudflare Pages (`few.chat` / `few-chat.pages.dev`), deployed by direct upload via `make deploy` (`wrangler pages deploy app/out`). Dynamic path segments like `/groups/[id]` cause 404s on page reload because no HTML file exists at that path.

- Use **query parameters** (`/groups?id=xxx`) instead of path segments for client-side dynamic data.
- Keep all views for a route in a single page file (e.g. `pages/groups.tsx` renders both the list and detail views based on `router.query.id`).
- Do not create `[param].tsx` files unless `getStaticPaths` can enumerate all values at build time (like `topic/[slug].tsx` does).

## Translations

All user-facing UI text must be translated. The app supports English (`en`) and German (`de`).

- Translations are defined in `app/src/lib/i18n.ts`, separate from component code.
- Never hardcode user-visible strings in components. Use `useCopy()` from `@/src/context/LanguageContext` and reference the appropriate key.
- When adding new UI text, add both `en` and `de` entries to the `Copy` type and both language objects in `i18n.ts`.
- Dynamic strings use functions (e.g. `(count: number) => string`). Use the same pattern for new entries.

### Long-form content pages → markdown, not i18n

Short UI strings (labels, buttons, headings, page titles) stay in `i18n.ts`. **Long-form
prose pages** (info, imprint) instead live as one markdown file per language under
`app/src/content/` (e.g. `info.en.md`, `info.de.md`), rendered by the shared
`@/src/components/Markdown` component. This keeps editable prose out of TS string literals.

- Legal/structured facts are **not** duplicated into the markdown. `imprint.*.md` are
  [Mustache](https://github.com/janl/mustache.js) templates fed the single-sourced
  `IMPRINT` constant (`app/src/config/imprint.ts`); `{{#field}}…{{/field}}` sections drop
  empty fields (phone, VAT). The address is written once, never per-language.
- Only page chrome for these pages stays in `i18n.ts` (page `<title>`, the `<h1>`, the
  info page's collapse-toggle label).
- The `.md` files are imported as raw strings via the `asset/source` webpack rule in
  `next.config.mjs` (typed by `app/src/content.d.ts`).

## E2E tests

E2E tests (Playwright, under `app/tests/e2e/`) must drive publishes through the app, not via raw `WebSocket` to the strfry relay.

- When a test needs a peer to send a message, gift-wrap, group event, etc., boot a second `browser.newContext()`, sign in as that peer, and call the app's publish helper (`publishDirectMessage`, group send, …).
- Do not hand-sign a kind-1059 / kind-14 / kind-4 in the test process and `WebSocket.send` it to the relay. Such a test passes even when the app's signer, NDK config, retry/dedupe, or future protocol changes are broken — which defeats the point of an e2e test.
- Narrow exception: events the app cannot itself produce (e.g., a bare-plaintext kind-4 from a non-Few client). Treat as exceptional, prefer a fixture loader over inline WebSocket, and call it out in the spec header.

### E2E gate (do not ship on a subset)

The suite is physically split into two buckets by infrastructure need, **not** by importance:
the **non-relay** bucket (12 tests: profile, avatar, theming, settings, emoji, notifications, info page, imprint) runs on
`next dev` alone, and the **groups/relay** bucket (48 tests: `groups-*`, `dm-*`, including the
contact-pairing-code epic's 6 `dm-pairing-*.spec.ts` specs and the direct-contact-profile-exchange
epic's 4 `dm-profile-*.spec.ts` specs) needs Docker
(strfry relay + blossom mock) and a differently-configured server. There is no CI — the Makefile is
the only gate.

- **The definitive e2e gate is the full 60-test suite: `make test-e2e-all` (or `make test`, which adds unit tests).** A feature or bug is not e2e-verified until that passes end to end.
- `make test-e2e-fast`, `make test-e2e-groups`, `make test-e2e-image-sharing`, and any filtered `node scripts/run-e2e.mjs <pattern>` run a **subset**. They are dev-iteration aids. A green subset is **never** an e2e pass — `test-e2e-fast` prints a partial-run warning when run standalone for this reason.
- When the `/feature` or `/bug` workflow reaches its e2e step, the pass criterion is the full suite, not the tests that happen to touch the changed files.

## Documentation upkeep (behaviour & design docs)

Two living documents describe the product; both must stay current with the code.

- **`docs/behavior/`** — product-level behaviour specification, one document per
  topic plus a `README.md` index, maintained via the `/behavior-docs` skill.
  **Any feature or bug work that changes user-facing behaviour must update the
  affected topic document(s) in the same run** — either invoke
  `/behavior-docs <topic>` or edit the document following the skill's writing
  rules (`.claude/skills/behavior-docs/references/`), and keep the index in
  sync. If the change touches a topic not yet covered by a document, note that
  in the run's report/retro instead of authoring a new topic mid-feature.
- **`docs/design-rationales.md`** — standing UI design rules with their
  reasoning (no concrete example names, negative actions danger-outline,
  minimal info text, …). Consult it before UI work. When the user states a new
  design rule of general scope during development, append it there in the
  document's Rule/Why/How-to-apply shape.

## Project state
Project orientation lives in `BACKLOG.json`. On a fresh session — or when
resuming work after idle time — run `/base:orient` to get a 3-line
"you are here" plus ranked next moves. Do not inline backlog content
into this file.
