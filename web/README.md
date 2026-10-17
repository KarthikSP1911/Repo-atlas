# RepoAtlas landing page

A static Next.js site (`output: 'export'`): plain HTML, CSS and one SVG. No API routes, no server code, no environment variables, no cost. It is separate from the MCP server and is not part of what NitroCloud runs.

Everything it shows (numbers, example output, the graph picture) is generated from the shipped snapshot and `docs/eval/backtest.json`:

```bash
npm run landing:data        # from the repo root: writes web/data/example.json and web/public/screens/tour-stage-4.svg
npm test                    # tests/landing-data.test.ts fails if the page data goes stale
```

## Run and build locally

```bash
cd web
npm install
npm run dev                 # http://localhost:3100
npm run build               # static files in web/out/
```

## Deploy to Vercel (free Hobby plan)

1. Push the repository to GitHub.
2. In Vercel: **Add New, Project**, import the repo.
3. Set **Root Directory** to `web`. Framework preset: Next.js. Leave build and output settings at their defaults. No environment variables.
4. Deploy. Vercel gives a `*.vercel.app` URL to put in the submission and the LinkedIn post.

## Adding real screenshots

The page currently shows one image: the graph the widget draws, rendered from real `tour_next` data. To add screenshots of RepoAtlas running in Claude or ChatGPT, save them in `web/public/screens/` (crop out anything personal such as account names) and add an `<img>` to `app/page.tsx`.

## Before you edit the connect URL

`MCP_URL` in `app/page.tsx` is the NitroCloud endpoint. Update it if the deployment URL ever changes.

## Design notes

- **Scale.** On screens 1100px and wider the page is drawn at 80% (`zoom: 0.8` on `body` in `app/globals.css`), 90% from 640 to 1099px, and 100% on phones. If you also zoom out in the browser the page will look smaller than intended; reset the browser zoom to 100% (Ctrl+0).
- **Form controls.** Dropdowns use `components/Select.tsx` (a keyboard-accessible listbox) and checkboxes are styled pills, so nothing falls back to the browser's own widgets.
- **Validation.** `lib/schemas.ts` holds the zod schemas: what people type (repo links, stage, issue number, languages) is checked with plain-language messages before anything is sent, and the few server answers the page relies on are checked before use. `tests/web-schemas.test.ts` checks that the arguments built here pass the server's own tool schemas.
- **Tool guidance.** `lib/tool-specs.ts` is the plain-English description of each tool: what it does, what to enter, what comes back and how to read it.
