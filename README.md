# claude-build-day-

A TypeScript starter wired to the Claude API using an **Anthropic Console** API key.

## Connect your Console account

1. Sign in at [console.anthropic.com](https://console.anthropic.com) and create a key:
   **Settings → API keys → Create key**. Make sure the workspace you pick has credit
   or billing set up.
2. Copy the key into a local `.env`:

   ```bash
   cp .env.example .env
   # then paste the key into .env
   ```

   `.env` is gitignored — the key never enters source or git history.
3. Install and verify the connection:

   ```bash
   npm install
   npm run check-auth
   ```

   `check-auth` lists the models your key can reach and makes one small billed
   request (a few hundred tokens, well under a cent). If the key is wrong you get a
   plain "authentication failed" message rather than a raw stack trace.

Prefer not to use a file? `export ANTHROPIC_API_KEY=sk-ant-...` works too — the SDK
reads it from the environment either way, and nothing here hardcodes a key.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check-auth` | Confirms the key works and lists available models |
| `npm run hello -- "question"` | One request, one response — the smallest useful shape |
| `npm run stream -- "prompt"` | Streams tokens with adaptive thinking, for chat UIs and long outputs |
| `npm run tools -- "prompt"` | Tool use via the SDK tool runner (weather + currency demo tools) |
| `npm run typecheck` | `tsc --noEmit` |

Each script takes an optional prompt after `--`; without one it uses a built-in example.

## Layout

```
src/client.ts            shared Anthropic client, default model, error messages
src/check-auth.ts        connection check
src/examples/hello.ts    single request
src/examples/stream.ts   streaming + adaptive thinking
src/examples/tools.ts    tool runner with two Zod-typed tools
```

## Notes

- Default model is `claude-opus-5` (`MODEL` in `src/client.ts`). Change it in one place.
- Thinking is on by default on Opus 5. `stream.ts` sets `display: "summarized"` so you
  see reasoning as it happens instead of a long pause.
- Streaming is the right default for anything with a large `max_tokens` — it avoids
  HTTP request timeouts.
- Billing, usage, and rate limits all live in the Console under your key's workspace.

## Warmer (`warmer/`)

A mobile web app that shows good, *fast* food nearby as a heat field on a real street
map. Zero dependencies, no build step — one HTML file and one Node script.

```bash
cd warmer
node server.mjs        # → http://localhost:3000  (Node 20+)
```

The first run asks for your Google Places key and Anthropic key, one at a time, and
saves them to `warmer/.env` (gitignored). After that it just starts. The server reads
`.env` itself and prefers it over the shell, so a key exported for another tool can't
leak in. If the Anthropic key is organization-level, startup asks once for the workspace ID
to bill (Console → Settings → Workspaces → open one; pasting the page URL works) and saves it.

Demo it in Chrome's device toolbar at 390×844. Denied/absent geolocation falls back to
Rothschild Blvd, Tel Aviv. Keys stay on the server: the browser only ever talks to
`/api/places` (Google Places New, cached 5 min) and `/api/foodie` (Claude Haiku 4.5).
