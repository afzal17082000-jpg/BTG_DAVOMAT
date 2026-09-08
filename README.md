# BTG Davomat

Telegram Mini App + Bot for employee attendance and salary tracking at **BTG**.

Employees check in/out from a phone through a Telegram Mini App. The server verifies
their GPS position against the factory geofence, calculates regular/overtime hours
and daily pay, and stores everything in PostgreSQL. Admins get a company-wide
dashboard and can export Excel reports from either the Mini App or the bot.

## 1. Project structure

```
btg-davomat/
├── schema.sql                    # PostgreSQL schema (run once to init the DB)
├── server.js                     # Express API + serves the Mini App (public/) + bot in webhook mode
├── bot.js                        # Telegraf bot entry point for long-polling mode
├── package.json
├── .env.example                  # copy to .env and fill in
├── public/
│   └── index.html                # the Mini App (single-file HTML/CSS/JS)
└── src/
    ├── config.js                 # reads & validates env vars
    ├── db.js                     # shared pg Pool
    ├── bot/
    │   └── telegramBot.js         # all bot commands, as a reusable factory (createBot())
    ├── utils/
    │   ├── geo.js                 # Haversine distance + geofence validation
    │   ├── salary.js              # regular/overtime hours + pay calculation
    │   └── departments.js         # enum <-> Uzbek label mapping
    ├── middleware/
    │   └── telegramAuth.js        # verifies Telegram initData (HMAC)
    ├── services/
    │   ├── attendanceService.js   # check-in/out + reporting logic (shared by API & bot)
    │   └── excelExport.js         # .xlsx report builder (exceljs)
    └── routes/
        └── api.js                 # all /api/* endpoints
```

**Two delivery modes for the bot, controlled by `BOT_MODE` in `.env`:**
- `BOT_MODE=polling` (default) — `bot.js` runs as its **own separate process**,
  continuously long-polling Telegram for updates. Needs a machine that's always on
  (a VPS, or your computer during development). Run `server.js` and `bot.js` independently
  (e.g. two systemd services, or two Docker containers).
- `BOT_MODE=webhook` — the bot is mounted **inside `server.js`** itself (no second
  process); Telegram pushes updates via HTTPS POST instead. `bot.js` becomes a no-op
  in this mode. This is the setup to use on free-tier hosts that spin down when idle —
  see **§3 Deploying on free hosting** below.

Either way, both entry points import the exact same command logic from
`src/bot/telegramBot.js`, so behavior never diverges between modes.

## 2. Setup

### 2.1 Prerequisites
- Node.js 18+
- PostgreSQL 13+
- A public HTTPS URL to host `public/index.html` behind (Telegram requires HTTPS
  for Mini Apps — use a real domain in production, or `ngrok`/Cloudflare Tunnel while developing).

### 2.2 Install
```bash
npm install
cp .env.example .env
# edit .env: DATABASE_URL, WEBAPP_URL, ADMIN_TELEGRAM_IDS, COMPANY_LAT/LNG, etc.
```

### 2.3 Initialize the database
```bash
createdb btg_davomat
npm run db:init
# or directly: psql "$DATABASE_URL" -f schema.sql
```

Uncomment and edit the seed `INSERT` statements at the bottom of `schema.sql` to add
your first employees, **or** add them later via the bot's `/add_employee` command
(admin-only — see below).

### 2.4 Register the bot's Mini App button with BotFather
1. Message `@BotFather` → `/mybots` → select **BTG Davomat** → **Bot Settings** → **Menu Button**.
2. Set the menu button URL to your `WEBAPP_URL` (must be HTTPS).
   This makes the Mini App reachable from the chat's menu button, in addition to
   the inline "📍 Davomatni belgilash" button sent by `/start`.

### 2.5 Run
With `BOT_MODE=polling` (default), run both:
```bash
npm run start:server   # API + Mini App static hosting, on $PORT
npm run start:bot      # Telegram bot (long polling)
```
Both must be running for the system to work end to end.

With `BOT_MODE=webhook`, just run the one process — `npm start` (or `npm run start:server`) —
`bot.js` will print a notice and exit if you run it by mistake in this mode. See §3 for the
full webhook deployment walkthrough.

## 3. Deploying on free hosting

This is the recommended zero-cost setup, verified as current in 2026. Two pieces:

| Piece | Recommended free service | Why |
|---|---|---|
| App (API + Mini App + Bot) | **[Render](https://render.com)** — Free Web Service | No credit card required. Free forever, not a trial. Serves HTTPS automatically. |
| Database | **[Neon](https://neon.tech)** — Free Postgres | A genuinely *permanent* free tier (not an expiring trial): 0.5 GB storage, 100 compute-hours/month, no card. |

**Avoid Render's own free Postgres for this project** — it auto-deletes your database
30 days after creation. Neon's free tier has no such expiry.

### 3.1 Why webhook mode matters here
Render's free web service spins down after 15 minutes with no incoming request, and
wakes up again (in ~30-60s) on the next one. A `bot.js` running separately with
long-polling would just go quiet every time the service sleeps — Render's free plan
doesn't include a free "background worker" service type to keep something like that
running continuously. The fix already built into this project: run in **webhook
mode** (`BOT_MODE=webhook`), so the bot is mounted right inside `server.js`. Then
there's only one process, and Telegram's own update-delivery retries are what
"wake" the sleeping service back up — no extra keep-alive trick needed.

*(If you'd rather keep the two-process, long-polling setup — e.g. because you're
deploying to a VPS that never sleeps — just leave `BOT_MODE=polling`, run
`bot.js` as its own process, and skip the webhook-specific steps below.)*

### 3.2 Steps
1. **Create the database on Neon.** Sign up at neon.tech (no card), create a project,
   and copy the connection string it gives you — that's your `DATABASE_URL`.
2. **Initialize the schema.** From your machine, with `DATABASE_URL` pointed at Neon:
   `psql "$DATABASE_URL" -f schema.sql`.
3. **Push this project to a GitHub repo** (Render deploys from Git).
4. **Create a free Web Service on Render**, connect the repo, set:
   - Build command: `npm install`
   - Start command: `npm start`
5. **Set environment variables** on Render (Environment tab) — copy everything from
   `.env.example`, with these specifics:
   - `DATABASE_URL` → your Neon connection string
   - `WEBAPP_URL` → your Render service's URL, e.g. `https://btg-davomat.onrender.com`
   - `BOT_MODE` → `webhook`
   - `TELEGRAM_WEBHOOK_SECRET` → a random string (generate with
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)
   - `ADMIN_TELEGRAM_IDS`, `COMPANY_LAT`, `COMPANY_LNG`, etc. → your real values
6. **Deploy.** On boot, `server.js` automatically registers the webhook with
   Telegram — check the logs for `[server] Telegram webhook mounted at ...`.
7. **Set the Mini App menu button** in BotFather to the same `WEBAPP_URL` (see §2.4 above).
8. **Test it**: `/start` the bot. The first message after idle time may take
   30-60 seconds to answer (cold start) — that's expected and one-time per sleep cycle.

### 3.3 Living with the free tier's limits
- **Cold starts**: the first check-in/out attempt after 15 minutes of inactivity
  will feel slow (~30-60s). Employees using it right at the start of their shift
  will mostly avoid this since traffic clusters around 08:30 and 18:00.
- **750 free instance-hours/month** on Render — a single service running 24/7 for a
  31-day month uses ~744 hours, so it fits, but leave no second free service running
  in the same workspace or you'll exceed it.
- **Neon's 0.5 GB storage** comfortably holds years of attendance rows for a
  factory this size (each row is tiny); you'll likely never hit it. If you ever do,
  Neon's paid tier starts at a few dollars a month rather than requiring a full
  re-platform.
- Keep an eye on both dashboards early on — free tiers are generous but not infinite,
  and it's better to notice a limit approaching than to get surprised by a suspension.

## 4. Onboarding employees & admins

- **Admins**: put their numeric Telegram user IDs in `ADMIN_TELEGRAM_IDS` in `.env`
  (comma-separated), then restart the process(es) — both `server.js` and `bot.js` if
  running in polling mode, or just `server.js` in webhook mode. Get a user's numeric ID by
  having them `/start` the bot once (unregistered users are shown their own ID),
  or via `@userinfobot`.
- **Employees**: an admin runs, in the bot chat:
  ```
  /add_employee 123456789 "Aliyev Vali" SOTUV 25000
  ```
  Department codes: `SOTUV`, `MARKETOLOG`, `LAZER`, `PAYVANDLASH`, `YIGUV`, `KRASKA_SEPISH`.
  The employee can then `/start` the bot and open the Mini App.

## 5. Bot commands

| Command | Who | Description |
|---|---|---|
| `/start` | everyone | Greeting + opens the Mini App |
| `/dashboard` | registered employees | This month's personal stats, in chat |
| `/export_excel [YYYY-MM]` | registered employees | Sends an .xlsx report (own data; admins get everyone's) |
| `/admin_dashboard [YYYY-MM]` | admins | Company-wide summary by department |
| `/add_employee <id> "<F.I.O.>" <DEPT> <rate>` | admins | Add/update a staff member |
| `/list_employees` | admins | List all active staff |
| `/help` | everyone | Command list |

## 6. Business rules implemented

- **Work day**: 08:30–18:00, Sunday is the rest day (not enforced as a hard block —
  the Mini App works any day since factories occasionally need Sunday shifts; the
  pay formula itself is day-agnostic and always correct for whatever day is worked).
- **Late check-in** (after 08:30): the Mini App *cannot* complete check-in without a
  `late_reason` — the API returns `409 late_reason_required` until one is supplied,
  and the Mini App shows a mandatory modal in response to that error, never lets the
  reason be skipped. Time before the actual check-in is never paid, whether the
  employee is late or arrived early.
- **Overtime check-out** (after 18:00): mirrors the late-checkin flow with
  `overtime_reason_required`. Hours after 18:00 are paid at `hourly_rate × overtime_multiplier`
  (default 1.5×); hours up to 18:00 are paid at the normal rate, capped at 18:00 even
  if checkout happens later.
- **GPS geofencing**: every check-in/out is validated **server-side** (never trust
  the client) against `COMPANY_LAT`/`COMPANY_LNG`/`GEOFENCE_RADIUS_M` using the
  Haversine formula. Requests with poor GPS accuracy (`> MAX_GPS_ACCURACY_M`) are
  rejected outright, since an imprecise fix makes the distance check meaningless
  regardless of spoofing.

### GPS anti-spoofing — what's implemented and its limits
Web browsers do not expose a fully reliable "this location is mocked" flag, so no
consumer-facing web app (including this one) can guarantee spoofed-GPS immunity.
What this project does to reduce risk in practice:
1. **Prefers Telegram's native `LocationManager`** (Bot API 8.0+) over the raw
   browser `navigator.geolocation` API when available — it runs inside the
   Telegram client's own sandbox, which is harder to spoof from an arbitrary
   installed fake-GPS app than a normal browser tab.
2. **Rejects low-accuracy fixes** server-side, closing off the common case where
   spoofing apps report degraded or suspiciously perfect accuracy values.
3. **All distance math happens on the server**, using the coordinates and accuracy
   the device reports — the client never gets to just say "I'm in range."
4. For stricter guarantees, pair this with an organizational policy (e.g. requiring
   the Mini App to be opened only on company Wi-Fi, or cross-checking against
   Telegram's own `LocationManager` availability, which excludes rooted/emulated
   environments Telegram itself blocks).

## 7. Database

See `schema.sql`. Key points:
- `attendance` has a `UNIQUE (employee_id, date)` constraint — one row per employee
  per day, upserted by check-in/out. This makes the check-in endpoint idempotent
  against double-submits.
- `employees.is_active` allows disabling a former employee without losing their
  historical attendance/salary records (used instead of hard deletes).

## 8. Security notes

- Every `/api/*` route (except `/api/health`) requires a valid Telegram `initData`
  string, verified server-side via HMAC-SHA256 against `BOT_TOKEN`, per Telegram's
  official Mini App algorithm. A request is rejected if the signature doesn't
  match, or if it's older than 24 hours (replay-attack mitigation).
- Never commit your real `.env` — `BOT_TOKEN` must stay secret. Rotate it via
  `@BotFather` → `/revoke` if it's ever exposed.
- The Excel export and dashboard endpoints scope data to `req.employee` unless
  `req.isAdmin` is true — a regular employee can never fetch another employee's
  records through the API.

## 9. Extending

- **Payroll periods / advances**: add a `payroll_periods` table and a "paid" flag
  on `attendance` if you need to mark salary as disbursed.
- **Push reminders**: use `bot.telegram.sendMessage` on a cron job (e.g. `node-cron`)
  to nudge employees who haven't checked in by 08:35, or haven't checked out by 18:05.
- **Multi-location geofencing**: generalize `config.geofence` into a list of sites
  and pick the nearest one in `validateGeofence`.
