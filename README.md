# Moonlight Calendar

A shared shift calendar for a moonlighting care team. Admins manage users, schedules, requests, and payroll review. Doctors, nurses, and staff see their own records. The app supports shift requests, shared Reliever posts, clock-in/out photos, documents, and Telegram alerts. Times use **Asia/Manila** and rates use **Philippine pesos per hour**.

## Hosting layout

- **Supabase** stores all app data in Postgres and private evidence files in Storage. The login/session API runs as the `moonlight` Supabase Edge Function.
- **Cloudflare Workers** serves the static website and forwards `/api/*` to that Edge Function. It does not use D1 or R2.

## Set up Supabase

Create or open your Supabase project. You can apply the database schema without using a terminal:

1. In the Supabase Dashboard, open **SQL Editor** and start a new query.
2. Paste and run the full contents of [`supabase/migrations/20261115000000_moonlight_schema.sql`](supabase/migrations/20261115000000_moonlight_schema.sql).
3. Open **Storage** and create a bucket named `moonlight-evidence`. Keep it **private**. Set the maximum file size to at least **8 MB** and allowed MIME types to `image/jpeg`, `image/png`, `image/webp`, and `application/pdf`.

Then set Edge Function secrets in **Project Settings → Edge Functions → Secrets** (labels can vary slightly in the dashboard):

- `MOONLIGHT_SUPABASE_SECRET_KEY`: create/copy a Supabase `sb_secret_...` key from **Project Settings → API Keys**. Keep it only in Edge Function secrets; it grants backend access.
- `ADMIN_SETUP_KEY`: a long random value that the first admin enters once to create the initial account.
- `TOKEN_ENCRYPTION_KEY`: a base64 encoded 32-byte key. Keep it safe and stable; changing it makes the saved Telegram bot token unreadable.
- `MOONLIGHT_STORAGE_BUCKET`: optional; leave unset for `moonlight-evidence`, or set it to the exact name of your private bucket.

Supabase provides `SUPABASE_URL` to Edge Functions automatically. New Supabase secret names cannot use the reserved `SUPABASE_` prefix, so the app uses the `MOONLIGHT_` names above. The secret key must never be added to GitHub, Cloudflare browser assets, or a Cloudflare public variable.

Use the new `sb_publishable_...` and `sb_secret_...` key formats only. Supabase is deprecating the legacy `anon` and `service_role` API keys by the end of 2026; this app does not need either legacy key. See [Supabase's API key migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).

## Deploy the Supabase API from GitHub

Cloudflare's GitHub connection deploys the website Worker; it does not deploy the Supabase Edge Function. Connect the same GitHub repository separately in Supabase:

1. In Supabase, open **Project Settings → Integrations → GitHub Integration** and authorize Supabase for the `ccs-claire/moonlight-calendar` repository.
2. Set **Working directory** to `.` because the `supabase/` folder is at the repository root.
3. Enable **Deploy to production** and select the `master` production branch, then save the integration.
4. Push the repository changes, including `supabase/functions/moonlight/index.ts` and `supabase/config.toml`, to `master`. Supabase will deploy the function declared in the config when it processes that commit. If the integration was already connected before these files were pushed, make a new commit touching a file in `supabase/` to trigger deployment.

The function is named `moonlight`; its endpoint is:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/moonlight
```

The repository config turns Supabase's built-in JWT verification off for this function because the app uses its own signed-in session cookie. Its API routes still check the user's session and role; the Cloudflare Worker passes the publishable key to reach the function gateway. Keep the Edge Function secrets configured in Supabase; GitHub deploys the code, not those secret values.

## Deploy the website on Cloudflare

The repository includes `wrangler.jsonc`; do not replace it with the old D1/R2 example. In Cloudflare, connect the GitHub repository to a **Worker** and use:

- Root directory: `/`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`

In the Worker settings, add these runtime variables (not secrets):

- `SUPABASE_FUNCTION_URL`: the function URL above.
- `SUPABASE_PUBLISHABLE_KEY`: the `sb_publishable_...` key from Supabase **Project Settings → API Keys**. This key is safe to expose; the Worker uses it only to pass the Supabase API gateway.

Save and deploy. For local development against the deployed Supabase project, create `.dev.vars` in the repository (it is ignored by Git):

```dotenv
SUPABASE_FUNCTION_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/moonlight
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

Then run:

```bash
npm install
npm run dev:cloudflare
```

Open the localhost address Wrangler prints. This local UI uses the configured Supabase project, so changes you make there affect that project. To redeploy the website manually, run `npm run deploy:cloudflare` after setting the two Worker variables in Cloudflare.

## First sign-in and app pages

Open the deployed site, enter `ADMIN_SETUP_KEY`, and create the first admin account. Admins can add admin, doctor, nurse, and staff accounts through **User Management**.

- **Dashboard:** admins see team requests and time records; other team members see their own.
- **My Calendar / Team Calendar:** view and maintain shifts. The calendar supports day, week, month, and list views. Multiple shifts for a day are grouped in the monthly list.
- **Requests & offers:** review shift requests and direct offers. Team members accept or decline admin offers.
- **Find reliever posts:** doctors can share a post with required skill questions and required photo/document uploads. A request closes the post while an admin reviews it.
- **Time & evidence:** record actual hours and attach clock photos and supporting files to an approved shift.
- **Team Scorecard:** admin-only reporting for booked/completed hours, pay estimates, and missing records, with this-month, last-month, last-three-months, and custom date periods.
- **User Management:** admin-only account roles, activation, and deletion controls.

Set up Telegram alerts from the in-app **Telegram alerts** page: create a bot with [@BotFather](https://t.me/BotFather), start a conversation with it, enter the token and chat ID, then send a test. The bot token is stored in Supabase Postgres encrypted with `TOKEN_ENCRYPTION_KEY`.

## Data migration note

This setup creates the Supabase schema and deploys the Supabase-backed app. It does **not** copy existing records or evidence from a previous D1, local SQLite, or R2 installation. Keep the old resources intact until any needed data transfer has been separately planned and verified.

## Troubleshooting

- **Cloudflare says it failed while fetching the repository:** this happens before build settings run. Check that the Cloudflare GitHub App can access the repository and that the selected owner/repository still exists. Wrangler settings cannot fix repository access.
- **“Supabase API connection is not configured”:** set both Worker variables and redeploy.
- **Database RPC/table error:** run the complete SQL migration in the correct Supabase project's SQL Editor.
- **Evidence upload fails:** confirm the bucket name matches `MOONLIGHT_STORAGE_BUCKET`, the bucket is private, and its size/MIME limits allow these files. Photos can be up to 6 MB; documents up to 8 MB.
- **First admin setup fails:** confirm the Edge Function secret `ADMIN_SETUP_KEY` matches what you enter on the setup page.
- **Telegram token cannot be read:** restore the original `TOKEN_ENCRYPTION_KEY` value.
