# Fortuna Skin — Creator Partnership Application Platform

A production-ready creator partnership application system for **Fortuna Skin**:
a public multi-step applicant wizard and a private admin dashboard. Built with plain HTML, CSS and
ES modules plus Supabase (Postgres, Auth, Storage, Edge Functions). No frontend
framework, no build step.

- **Public site**: welcome page, 5-step application wizard (details → channels →
  product screenshots → terms consent → review/submit), confirmation page, privacy page.
- **Admin dashboard** (`/admin/`): overview stats, searchable/filterable
  application list with bulk actions, full application detail (products, images,
  notes, history, print), versioned Terms & Conditions management, form builder,
  branding/settings, team list, audit log. The official logo lives at
`public/furtunaskin.jpg` and is used across every page.
- **Applicants never create accounts.** Drafts are stored on the applicant's own
  device (sessionStorage + localStorage + IndexedDB for image blobs).
  Server-side submission is idempotent and rate-limited.

## Stack & constraints

| Layer | Choice |
| --- | --- |
| Frontend | HTML5, CSS3, vanilla JS ES modules (pinned CDN deps only) |
| Database | Supabase Postgres with row-level security + transactional RPCs |
| Auth | Supabase Auth (admins only) |
| Files | Supabase Storage (private buckets + signed URLs / signed uploads) |
| Server | Supabase Edge Functions (Deno; plain JS, no TypeScript) |
| Hosting | Vercel static (or any static host) |

Pinned browser dependencies (loaded from jsDelivr):

- `@supabase/supabase-js@2.118.0` (UMD bundle)
- `pdfjs-dist@4.10.38` — loaded **lazily** by the Terms viewer only, with a
  native-iframe fallback when the CDN or fetch fails

PDF generation uses the browser's own print pipeline (`.print-sheet` print CSS +
`window.print()`); no PDF library is bundled.

## Repository layout

```
index.html  apply.html  confirmation.html  privacy.html
admin/                  # private dashboard pages (login, applications, terms, …)
css/                    # tokens, base, components, welcome, wizard, admin
js/
  config.js  supabase.js
  utils/                # dom, format, validate, countries, toast, idb, draft
  public/               # api, branding, welcome, wizard, step-fields,
                        # product-grid, terms-viewer, review, confirmation
  admin/                # api, auth, shell, login, dashboard, applications,
                        # application-detail, settings, form-fields, terms,
                        # team, audit
supabase/
  migrations/           # schema, functions, RLS, storage, seed (ordered)
  functions/            # edge functions (submit-application, prepare-upload,
                        # terms-current, draft-file-url, admin-notify, cleanup-temp)
  tests/                # local Postgres shim + 47-assertion suite (run.sh)
scripts/                # generate-env.js, serve.js, check-js.js
vercel.json             # security headers + /admin rewrites
```

## Local development

```bash
npm run env      # generate env.js from .env (or placeholders)
npm run serve    # static server on http://localhost:3000  (PORT=4173 npm run serve)
npm run check    # syntax-check every JS module
npm run test:db  # apply migrations to a scratch DB and run the SQL suite
```

`npm run test:db` expects a scratch Postgres via `PGHOST/PGPORT/PGUSER`
(e.g. `PGHOST=/tmp/opencode/pg PGPORT=5433 PGUSER=hamilton npm run test:db`).
It drops and recreates the database named by `DB` (default `partnershipy_test`).
The suite in `supabase/tests/test.sql` mimics Supabase's `auth`/`storage`
prerequisites with `supabase/tests/shim.sql` and asserts schema, RPC behaviour
and RLS policies (47 checks, all passing against local Postgres 18).

## Supabase setup

1. Create a Supabase project.
2. Apply migrations in order (`supabase/migrations/`), e.g. with the CLI:
   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```
3. Create the first admin:
   - Authentication → Users → invite the admin's email.
   - Insert into `public.admin_profiles` (roles: `owner`, `admin`, `reviewer`;
     an active row is what `is_admin()` and the dashboard check):
     ```sql
     insert into public.admin_profiles (id, full_name, email, role, is_active)
     values ('<auth.users.id>', 'Admin Name', 'admin@example.com', 'owner', true);
     ```
4. Upload the first Terms & Conditions PDF from the admin dashboard
   (Terms page) and publish it — applicants cannot submit until a version is
   published (`terms_unavailable` otherwise).
5. Configure storage: buckets `product-uploads`, `terms-docs`,
   `application-docs` (private) and `branding` (public) are created by the
   storage migration; nothing to do manually.

### Edge functions

All functions live in `supabase/functions/<name>/index.js` (plain JavaScript).
Each function's entry point is declared in `supabase/config.toml`
(`entrypoint = "functions/<name>/index.js"`), and shared code in
`supabase/functions/_shared/` is uploaded with each function. Deploy from the
project root — `--use-api` bundles server-side (works without Docker):

```bash
for fn in submit-application prepare-upload terms-current draft-file-url admin-notify cleanup-temp; do
  supabase functions deploy "$fn" --project-ref <project-ref> --use-api
done
```

**Deploying via the Dashboard (single-file):** the Dashboard code editor only
sees one file, so a raw `index.js` fails bundling with
`Module not found ".../_shared/http.js"`. Paste the generated self-contained
bundle instead — `dist/functions/<name>.js` (all `_shared` code inlined,
`npm:` imports kept). Regenerate after editing sources with:

```bash
npm run bundle
```

Then in the Dashboard: Edge Functions → *name* → replace the contents with
`dist/functions/<name>.js` → Deploy.

Secrets (Dashboard: Edge Functions → Secrets; CLI: `supabase secrets set ...`).
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform automatically — do not set them (the CLI rejects
`SUPABASE_`-prefixed names):

```bash
# Required for the cleanup-temp scheduler (caller sends x-cleanup-secret):
supabase secrets set CLEANUP_SECRET=<random value> --project-ref <project-ref>

# Optional email notifications (skipped until EMAIL_PROVIDER is set:
# resend → EMAIL_API_KEY + EMAIL_FROM; webhook → EMAIL_WEBHOOK_URL):
supabase secrets set EMAIL_PROVIDER=resend EMAIL_API_KEY=<key> EMAIL_FROM=<from> --project-ref <project-ref>
```

`submit-application` is the **only** write path for applicant data. It
rate-limits by IP and email, verifies staged temp files, sniffs image magic
bytes server-side, moves files into `applications/<id>/products/`, then calls
the transactional `finalize_application()` RPC (service-role only). Client
calls never touch applicant tables directly — RLS blocks anon writes entirely.

Scheduled cleanup: create a pg_cron/edge schedule for `cleanup-temp` to delete
stale `temp/` uploads older than 24 hours.

## Environment files

`.env` (server-side, never committed):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
APP_ORIGIN=https://your-domain.example
```

`npm run env` writes `env.js` — the only browser-visible configuration
(public URL + anon key). Service-role keys never reach the browser.

## Vercel deployment

1. Import the repo; no build command, output directory = repo root.
2. Set env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ORIGIN` in the
   project settings (used by `npm run env` in a build step, or commit a
   generated `env.js` for fully static hosting).
3. `vercel.json` adds security headers (nosniff, frame-deny, referrer policy)
   and rewrites `/admin` → `/admin/index.html`.
4. Same-origin Supabase proxy: `vercel.json` rewrites `/api/supabase/*` → the
   project URL, and `js/supabase.js` probes it at boot (falling back to the
   direct project URL when the rewrite is absent). This keeps REST/auth/functions
   requests off `*.supabase.co` in the browser, so extension or network blocks
   and gateway CORS issues cannot break the app. `scripts/serve.js` mirrors the
   same route locally. Override the path with `SUPABASE_PROXY_PATH` (set it to
   an empty string to disable).

## Security model (summary)

- Admins sign in with Supabase Auth; every `/admin/*` page (except login) runs
  a session guard (`js/admin/auth.js`) that checks an active `admin_profiles`
  row.
- All privileged writes go through `security definer` RPCs that re-check
  `is_admin()`; every mutation is written to `admin_audit_logs`.
- Terms PDFs and product files live in private buckets; the public Terms
  endpoint mints short-lived signed URLs; product drafts upload via signed
  upload URLs scoped to `temp/<token>/`.
- Consent is server-verified: the submission must match the currently
  published terms document id/version (and sha256 when present); the evidence
  (version, sha, timestamp) is stored on the application row.
- Rate limits are enforced in the database (`bump_rate_limit`) so they hold
  across function instances.

## Testing checklist before launch

- [ ] `npm run check` and `npm run test:db` pass.
- [ ] A terms version is published; the public viewer opens it; consent
      checkbox stays disabled until the document is opened.
- [ ] End-to-end submission with 1–2 product screenshots produces a
      `CPA-######` reference and confirmation email.
- [ ] Refresh mid-application restores the draft; "discard" clears it.
- [ ] Pause switch on the public site shows the closure notice and blocks the
      wizard.
- [ ] Admin: status changes write history + audit rows; bulk actions work;
      product images render via signed URLs; print/PDF works.
