# CivicAI - From citizen reports to smarter cities

Citizens send a photo. CivicAI identifies the problem, scores its severity, merges duplicate reports,
routes it to the right department, tracks it, predicts hotspots and checks whether the repair was real.

Data is stored in a **local MySQL database server** (`civicai` database). Photos are stored in the `uploads/` folder.

## Quick start

1. Install **Node.js** (current LTS, 20 or newer) from https://nodejs.org . Check with `node -v`.
2. Install **MySQL Server 8.x** (or MariaDB) and make sure it is running. See "Set up MySQL" below.
3. In this folder:

       npm install
       copy .env.example .env          (Windows)   |   cp .env.example .env   (Mac/Linux)

   Open `.env` and set `DB_USER`, `DB_PASSWORD` (and the other settings).
4. Start:

       npm run seed        # optional: adds demo data so the dashboard is not empty
       npm start

5. Open http://localhost:3000  -  Authority dashboard: http://localhost:3000/#/dashboard
   Default login: `admin` / `change-me-now` (change it in `.env`).

The tables are created automatically on first start. If the server cannot connect, it prints exactly what is wrong
(MySQL not running, wrong password, no access to the database).

## Set up MySQL

Install MySQL Community Server (https://dev.mysql.com/downloads/mysql/), or MariaDB, or XAMPP on Windows.
Then open the MySQL shell (`mysql -u root -p`) and run:

    CREATE DATABASE civicai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER 'civicai'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
    GRANT ALL PRIVILEGES ON civicai.* TO 'civicai'@'localhost';
    FLUSH PRIVILEGES;

Put the same user/password in `.env`. (Shortcut for a quick test: set `DB_USER=root` and your root password.
CivicAI will then create the database itself. Use a dedicated user for anything real.)

## Moving your existing SQLite data to MySQL (one time)

If your old `data/civicai.db` holds real reports you want to keep:

    npm run migrate:sqlite                       # reads data/civicai.db
    npm run migrate:sqlite -- path\to\old.db     # or another file

It copies landmarks, issues, reports and the timeline, keeping all IDs and tracking IDs. Your `uploads/` folder is
reused as is. This script needs Node 22.13+ (only because it reads the old SQLite file). If MySQL already has
demo data, run `npm run reset` first. If you only had demo data, skip this and just run `npm run seed`.

## Settings (.env)

| Setting | What it does |
|---|---|
| DB_HOST / DB_PORT | Where MySQL runs (default `localhost` / `3306`). |
| DB_USER / DB_PASSWORD / DB_NAME | MySQL login and database name. |
| ADMIN_USER / ADMIN_PASSWORD | Dashboard login. Change before showing anyone. |
| MAP_CENTER_LAT / MAP_CENTER_LNG | Where the maps open. Put your city here. |
| ANTHROPIC_API_KEY | Turns on real photo AI (detect the problem, judge danger, compare before/after). Leave empty for manual mode. |
| PORT | Default 3000. |

Restart the server (`Ctrl+C`, then `npm start`) after editing `.env`.

## Two AI modes

* **Vision mode** (API key set): the citizen only uploads a photo. Claude identifies the category, rates the hazard 1-5,
  and compares before/after photos to verify repairs. Get a key at https://console.anthropic.com
* **Manual mode** (no key): the citizen picks the problem type on the form. Severity scoring, location context,
  duplicate merging, routing, tracking and hotspots all still work.

## How each feature works

| Feature | Where | How |
|---|---|---|
| Auto-identify problem | `server/ai.js` | Claude vision, or manual category as fallback |
| Severity 0-100 with reason | `server/scoring.js` | photo hazard + road type + school/hospital nearby + report count + age |
| Smart location | `server/geo.js` + `landmarks` table | distance to roads, schools, hospitals, markets |
| Duplicate merge | `server/issues.js` | same type within 40 m, or within 100 m and photo hash 80% similar |
| Department routing | `server/config.js` | category -> department map |
| Tracking | `#/track` page | tracking ID + timeline |
| Hotspot prediction | `server/hotspots.js` | repeat reports, recency, reopened repairs, monsoon weighting |
| "Was it really fixed?" | `server/issues.js` -> `verifyFix` | before/after comparison, flags incomplete repairs |
| Authority dashboard | `public/js/app.js` | stats, top-5 priorities, map, filters, issue drawer |

## Make it yours

* **Real places for severity context:** the demo landmarks are fake. Add your real schools, hospitals, markets and main roads:

      curl -X POST http://localhost:3000/api/admin/landmarks -H "Authorization: Bearer <token>" \
        -H "Content-Type: application/json" \
        -d '{"name":"City Public School","type":"school","lat":33.69,"lng":73.05,"radius_m":300}'

  or edit the `landmarks` table with MySQL Workbench, HeidiSQL, DBeaver or phpMyAdmin.
* **Departments and categories:** edit `server/config.js`.
* **Wipe demo data:** `npm run reset` (clears issues, reports, events and landmarks, then re-adds the demo set).
* **Back up:**

      mysqldump -u civicai -p civicai > civicai-backup.sql

  and copy the `uploads/` folder.
* **Restore:** `mysql -u civicai -p civicai < civicai-backup.sql`

## Notes

* Maps use OpenStreetMap tiles, so the map background needs internet. Everything else is local.
* Browser location (GPS button) works on `localhost` and HTTPS. On a phone over plain HTTP, use the map tap instead.
* The hotspot predictor is a transparent statistical model. With enough history, replace it with a trained model.
* All dates are stored in UTC (`DATETIME(3)`), the frontend receives the same ISO strings as before.

## Project layout

    server/   index.js (API) | db.js (MySQL pool + schema) | ai.js | issues.js | scoring.js | geo.js
              hotspots.js | seed.js | migrate-from-sqlite.js | config.js
    public/   index.html | css/style.css | js/app.js      (unchanged by the MySQL move)
    uploads/  citizen photos
