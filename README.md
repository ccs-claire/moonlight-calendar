# Moonlight Calendar

A shared shift calendar for moonlighting care teams. Admins manage users and team schedules, review requests, and offer unbooked shifts to a non-admin team member. Doctors and admin doctors can publish shared Reliever posts with no doctor-calendar assignment; one doctor request closes each post while an admin reviews it. Doctors, nurses, and staff see only their own schedule and records. Clock-in and clock-out photos and optional supporting documents stay tied to the booking.

The Cloudflare app uses **D1** for accounts, schedules, bookings, and attendance, and **R2** for evidence files. The Worker serves the browser app and API from one address. Times are displayed in **Asia/Manila**; rates are in **Philippine pesos per hour**.

## Run with your Cloudflare account

Requires Node.js 22.13 or newer and a Cloudflare account with D1 and R2 enabled. This repository does not contain your database ID, bucket name, bot token, or setup secrets.

```bash
cd /Users/clairereyes/cler-workspace/moonlight-calendar
npm install
npx wrangler login
cp wrangler.jsonc.example wrangler.jsonc
```

Create resources if you do not already have them:

```bash
npx wrangler d1 create moonlight-calendar
npx wrangler r2 bucket create moonlight-evidence
```

Edit `wrangler.jsonc`: enter your existing or newly created D1 **database name and UUID** and R2 **bucket name**. Keep the binding names `DB`, `EVIDENCE`, and `ASSETS`. The file is ignored by Git so each environment can use its own resources.

Apply the schema to your Cloudflare D1 database:

```bash
npx wrangler d1 migrations apply DB --remote
```

For local preview, create an ignored `.dev.vars` file containing `ADMIN_SETUP_KEY` (a long random value) and `TOKEN_ENCRYPTION_KEY` (a base64 encoded 32-byte value). For example, generate the file locally with:

```bash
printf 'ADMIN_SETUP_KEY=%s\nTOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -base64 32)" > .dev.vars
```

Then migrate the local D1 preview and run the Worker:

```bash
npx wrangler d1 migrations apply DB --local
npm start
```

Open the address Wrangler prints (usually `http://localhost:8787`). The local preview uses a local D1 database and R2 emulation, separate from your Cloudflare production data. To preview against your remote resources, use Wrangler's remote development mode only when you intend to work with live data.

To publish from your own GitHub checkout after reviewing the app and resources:

```bash
npm run deploy:cloudflare
```

Wrangler prints the deployed Worker URL. This repository has not been deployed or connected to your Cloudflare account.

Before opening the deployed app, set the two production Worker secrets. Choose a separate, long random `ADMIN_SETUP_KEY` that the first admin will enter on the setup screen. `TOKEN_ENCRYPTION_KEY` must be a base64 encoded 32-byte key. Save both securely, especially the encryption key: changing it later prevents the app from reading the saved Telegram bot token.

```bash
npx wrangler secret put ADMIN_SETUP_KEY
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Now open the Worker URL, enter the `ADMIN_SETUP_KEY`, and create the first admin account.

## Pages and permissions

- **Dashboard:** admins see team wide requests, booked shifts, and time records. Doctors, nurses, and staff see only their own bookings and hours.
- **Team Scorecard:** admin only and separate from User Management. Shows active and inactive admins, doctors, nurses, and staff with booked shifts and hours, completed shifts and actual worked hours, scheduled pay estimates, worked pay estimates, pending requests, and missing time or rates. Deleted accounts with shifts in the selected period remain visible under neutral names so historical payroll can still be reviewed. Filter by **This month**, **Last month**, **Last 3 months**, or a custom date range. The period follows the scheduled shift date in Philippine Time. Last month and Last 3 months cover complete prior calendar months. Open a team member to review each shift, rate, time entry, and evidence links. Pay figures are estimates before payroll adjustments; review missing information before processing payroll.
- **User Management:** admin only and **separate from Team Scorecard**. Creates and manages admin, doctor, nurse, and staff accounts. Admins can reset passwords or deactivate access. An inactive account shows **Activate** and **Delete**. Delete removes sign-in access and identifying profile details, and hides the account from management lists. Past bookings and evidence remain linked to a neutral “Deleted user” record. Resolve any pending request or current/future approved shift before deleting an account; an admin cannot delete their own account. Deleted users cannot be reactivated, but their former email can be used for a new account.
- **Find reliever posts:** doctors and admin doctors can publish shared Reliever posts with date, time, location, hourly rate, and one or more required skill questions. Each question accepts a Yes or No answer or written details. Posters can also require a photo, a supporting PDF/image, or both. Applicants must answer every question and attach each required file before requesting the post; answers and private file links appear in booking details, and the admin Telegram alert lists which files were received. Posts have no doctor calendar. The first request closes the post to other doctors while an admin reviews it. Nurses and staff do not see the doctor-only post list. A requested post stays closed even if the request is later declined or cancelled; publish a new post if it is available again. Previously published unrequested availability is copied into the shared post list during migration when it has a rate and no overlapping pending or approved booking.
- **My Calendar:** each team member can review their own calendar and booked shifts. Select a date to open that day's shift modal, then edit eligible personal shifts or add one for that date. The month view keeps the “All shifts this month” list below the calendar. To offer a shift directly, an admin selects one non-admin doctor, nurse, or staff member; that person's calendar is the offer calendar. The member must accept before the shift becomes booked. The app blocks overlapping confirmed bookings and duplicate pending offers for that member. Other users see each approved shift's day, time, location, hourly rate, scheduled amount, and an actual-time amount once completed without seeing private team details.
- **Requests & offers:** admins approve or decline requests made from posted open times. A team member accepts or declines a direct offer from an admin. Admins can withdraw offers; a user can cancel their own request or booking before a time record exists. Cancelled bookings stay in history and release the time. Overlapping approved bookings are blocked.
- **Time & evidence:** the assigned team member clocks in on the approved shift date with a JPG, PNG, or WebP photo, then clocks out with another. A PDF or image can be attached at either step. For an approved shift without a time record, **Add time & evidence** on My schedule or Time & evidence lets the member enter actual start/end times in Philippine Time, upload a required photo, and optionally add an end photo, PDF/image document, and note. The entry is linked to that booking; only the assigned member and admins can view its evidence. Pending requests and future shifts cannot have actual hours yet; the page now explains when entry becomes available. A shift can have one time record, and future worked time is rejected.

The hourly rate and location are copied onto each request or direct assignment. Editing an open time's rate affects future requests; existing bookings keep their original rate and location. The booking details show the scheduled amount as an estimate, not a payroll payment.
On the calendar, admins can also use **Set rate** or **Edit rate** on an existing booking. This is useful for older bookings that were created before hourly rates were required.
Completed hours use the actual time entry, whether it came from live clock actions or an entered record. Entered records are labeled so admins can distinguish them from live clock entries.

Admins can open `/team-scorecard` and `/user-management` directly or use the sidebar. These pages require an admin sign-in. The former `/doctor-management` route remains as a link to Team Scorecard. For Cloudflare, apply the new D1 migration before deploying. If managing D1 manually, open the database in Cloudflare Dashboard → **Console** and run the two `ALTER TABLE` statements from `migrations/0009_reliever_upload_requirements.sql`. If you still see an older interface from the local SQLite server, stop that process with Ctrl-C, run `npm run start:local`, and refresh the browser; startup adds the new account-role, rate, and shared-post structures to the existing local database.

## Telegram alerts

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Send `/start` to the new bot, or add it to an admin group and send a message there.
3. In the admin **Telegram alerts** page, save the token, find a recent chat, and save its chat ID.
4. Click **Send test**. New booking requests will notify that chat. Approval remains in the app.

The bot token is encrypted in D1 using `TOKEN_ENCRYPTION_KEY` and is not returned by the API. Telegram message delivery failure does not discard a booking request.

## Checks and troubleshooting

```bash
npm test
node --check worker.js
node --check public/app.js
```

If the app shows a D1 binding or table error, check `wrangler.jsonc` and apply migrations to the correct D1 database. If evidence upload fails, check the R2 bucket binding. If first-admin setup fails, confirm `ADMIN_SETUP_KEY` is set for the same Worker environment and enter it exactly on the setup screen. If Telegram fails, check the token, start a conversation with the bot, select the right chat ID, and send a test.

The original local SQLite server remains available for isolated testing with `npm run start:local`; it stores data in `data/` and is not the Cloudflare deployment. Do not put patient information in notes or uploads. Back up D1, R2 evidence, and your encryption key together according to your organization’s policy.
