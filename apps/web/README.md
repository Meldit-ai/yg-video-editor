# web

Vite 8 + React 19 + Tailwind CSS v4 + shadcn/ui frontend for YG Video Editor.

## Commands

Run from the repo root (via turbo) or from `apps/web`:

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Vite dev server (port 8701, `strictPort`) |
| `pnpm build` | Type-check (`tsc -b`) and build to `dist/` |
| `pnpm preview` | Preview the production build (from `apps/web` only — no root/turbo task) |
| `pnpm check-types` | Type-check only (`tsc -b`, all projects have `noEmit`) |

## API proxy

The dev server proxies `/api/*` to `http://localhost:8700` (see `server.proxy` in
`vite.config.ts`), so the frontend can call the backend without CORS setup.
Start the API app alongside `pnpm dev` for the health check on the landing page
to report "API connected".

## Adding shadcn/ui components

`components.json` is already configured (new-york style, neutral base color,
CSS variables, lucide icons). Add components from `apps/web`:

```sh
pnpm dlx shadcn@latest add <component>
```

Components land in `src/components/ui`, use the `@/*` alias, and share the
`cn()` helper from `src/lib/utils.ts`.
