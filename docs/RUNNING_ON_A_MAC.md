# Running AKB ERP on a Mac

This is for testing on one laptop. Nothing leaves the laptop: the database, the screens and the API all run locally.

## Option A: Docker Desktop

1. Install Docker Desktop for Mac (Apple chip or Intel, as shown on the download page) and start it once.
2. Get the code:
   ```sh
   git clone https://github.com/mohammadranaa/AKB-ERP.git
   cd AKB-ERP
   ```
3. Create the settings file and change the three passwords in it (letters and numbers only):
   ```sh
   cp .env.example .env
   open -e .env
   ```
4. Start everything:
   ```sh
   docker compose up -d --build
   ```
   The first build downloads PostgreSQL, Node and nginx and takes a few minutes.
5. Load demo data (optional, for trying the system):
   ```sh
   docker compose exec api node dist/src/cli/seed.js
   ```
6. Open http://localhost:8080 and sign in as `owner` / `Demo-Pass-2026`.

Everyday commands:

| What | Command |
|---|---|
| Stop | `docker compose stop` |
| Start again | `docker compose start` |
| See what the API is doing | `docker compose logs -f api` |
| Update after pulling new code | `git pull && docker compose up -d --build` (new migrations apply automatically) |
| Back up the database | `./tools/backup.sh` |
| Wipe everything and start fresh | `docker compose down -v` (deletes all data) |

## Option B: Homebrew, no Docker

1. Install Homebrew from https://brew.sh if it is not already installed.
2. Get the code (as above), then:
   ```sh
   ./tools/mac-setup.sh
   ```
   This installs PostgreSQL 17 and Node 22, creates `.env` with random passwords, builds the database and loads demo data. Use `./tools/mac-setup.sh --empty` for no demo data.
3. Start it whenever you want to use it:
   ```sh
   ./tools/start.sh
   ```
   It opens http://localhost:5173. Press Ctrl+C in that window to stop.

## Using it on a phone

The screens are built for phones too: a bottom bar with each role's main screens, a menu behind the ☰ button, lists shown as cards, and forms that slide up from the bottom. Use Chrome.

**Phones on the same Wi-Fi as the laptop (Homebrew option):**

1. Start with `./tools/start.sh --lan`. It prints an address such as `http://192.168.1.20:5173`.
2. Open that address in Chrome on the phone. The first time, macOS may ask whether to allow incoming connections; choose Allow.
3. In Chrome's menu, choose **Add to Home screen** to get an AKB ERP icon that opens full screen.

For the Docker option, set `WEB_BIND=0.0.0.0` in `.env` (see below) and open `http://<laptop address>:8080` on the phone.

**A demo copy that needs no laptop:** `node tools/build-demo.mjs` (with the system running on demo data) writes `dist-demo/akb-erp-demo.html`, a single file with made-up data that opens in any browser, including on a phone. Nothing in it can be saved. It refuses to build if the database has any non-demo users, so real data cannot end up in the file.

## Letting other computers in the office use it

By default only the laptop itself can open the system. To let other computers on the same Wi-Fi/network in (Docker option):

1. In `.env` set `WEB_BIND=0.0.0.0`, then `docker compose up -d`.
2. Find the laptop's address: System Settings → Wi-Fi → Details → IP address (for example 192.168.1.20).
3. Others open `http://192.168.1.20:8080`.

Do this only on the office network, and only with `REQUIRE_TOTP=true`. The connection is not encrypted (no HTTPS) until the system moves to its proper server.

## Using Claude Code on the laptop

The repository has a `CLAUDE.md` that tells Claude Code how to run, test and change the system. Open a terminal in the `AKB-ERP` folder and run `claude`; you can then ask it to start the system, run the tests or explain a screen.

## Running the tests

With either option running:

```sh
pnpm install
pnpm test
```

The tests use a separate `akb_test` database that is wiped on every run. Your real data is never touched.

## If something goes wrong

- **Port already in use (5432 or 8080):** another PostgreSQL or program is using it. For 5432 set `DB_PORT=5433` in `.env` (Docker option). Or stop the other program (`brew services stop postgresql@16`, for example).
- **"password authentication failed":** the passwords in `.env` were changed after the database was first created. Either put the old ones back, or wipe and start fresh (`docker compose down -v`, which deletes all data).
- **Sign-in says too many attempts:** wait 15 minutes, or ask an admin to use Users → Reset access.
- **Blank page:** run `docker compose logs api` and look at the last lines.
