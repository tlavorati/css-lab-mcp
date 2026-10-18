# Contributing

Thanks for helping. Bug reports with a minimal HTML reproduction are the most useful thing you can
send.

## Setup

```bash
npm install
npx playwright install chromium   # or: npm run build && node dist/cli.js install-browser
npm run build
npm test
```

Tests run against real Chromium with the fixtures in `test/fixtures/`. If Chromium is missing, the
browser tests are skipped with a message, so install it before sending a PR.

## Adding a new bug pattern

1. Add a minimal fixture to `test/fixtures/` (plain HTML/CSS, generic names).
2. Add a test that asserts the verdict, the responsible rule and the suggested fix.
3. Detection logic that runs in the page lives in `src/page-script.ts` (plain JS string, no
   bundler helpers). Verdicts, explanations and fixes live in `src/diagnose.ts`.

## Guidelines

- Keep fixes minimal and local. Never suggest a global `z-index: 9999`.
- Every claim in an explanation should be backed by something measured in the browser.
- Run `npm run typecheck` and `npm test` before opening a PR. Use clear commit messages.
