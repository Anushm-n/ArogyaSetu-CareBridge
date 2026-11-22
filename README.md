# ArogyaSetu / CareBridge — Full-Stack Healthcare & Emergency Ecosystem

The existing Node.js HTTP server and multilingual healthcare portal now use MySQL instead of JSON-file storage. The original `data/db.json` remains unchanged and is the source for the one-time/re-runnable import.

## Run locally with XAMPP on Windows

1. Install Node.js and XAMPP if they are not already installed.
2. Open the XAMPP Control Panel and start **MySQL**. Apache is not required because the Node.js server serves the application.
3. In phpMyAdmin (`http://localhost/phpmyadmin`), create a database named `arogyasetu_db` using `utf8mb4_unicode_ci`. Alternatively, import [`database/init.sql`](./database/init.sql) in phpMyAdmin; it creates the database and tables without dropping existing data. The migration command also creates the database/tables if needed.
4. In the project folder, copy `.env.example` to `.env`:
   ```powershell
   Copy-Item .env.example .env
   ```
   Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` to match XAMPP. The common local XAMPP defaults are `localhost`, `3306`, `root`, an empty password, and `arogyasetu_db`. Keep `.env` private.
5. Install the project dependencies:
   ```powershell
   npm install
   ```
6. Import the existing JSON records:
   ```powershell
   npm run migrate
   ```
   The importer hashes the JSON passwords with bcrypt, keeps user and record IDs and nested metadata, and skips existing IDs on reruns. It never writes to or deletes `data/db.json`.
7. Apply the additive authentication/reminder migration:
   ```powershell
   npm run migrate:runtime
   ```
   It creates the server-side session table and adds missing medicine reminder columns without dropping tables or records.
8. Start the application:
   ```powershell
   npm start
   ```
9. Open [http://localhost:3000/login.html](http://localhost:3000/login.html).

## Verify the import

In phpMyAdmin, select `arogyasetu_db` and open the **users**, **medicines**, **alerts**, **vitals**, and **sos** tables. Check the row counts and inspect the JSON `meta` and `extra_json` columns. Passwords are stored as bcrypt hashes in `users.password_hash`; API responses never include passwords or hashes.

The seven pre-seeded demo accounts retain their existing JSON credentials:

| Role | Email | Password |
| --- | --- | --- |
| Patient | `patient@arogyasetu.in` | `patient123` |
| Caretaker | `caretaker@arogyasetu.in` | `caretaker123` |
| Doctor | `doctor@arogyasetu.in` | `doctor123` |
| Nurse | `nurse@arogyasetu.in` | `nurse123` |
| Hospital | `hospital@arogyasetu.in` | `hospital123` |
| Admin | `admin@arogyasetu.in` | `admin123` |
| Volunteer | `volunteer@arogyasetu.in` | `volunteer123` |

If MySQL is not reachable, the server reports a connection error and does not fall back to JSON storage. Check that the MySQL service is running, that `.env` matches its settings, and that the `arogyasetu_db` schema has been initialized.

## Authentication and role access

Successful sign-in creates a random, server-validated session stored in MySQL. The browser receives only an HttpOnly session cookie; logout revokes the database session. Patient, caretaker and volunteer self-registration is available. Clinical and administrator roles must be provisioned by an authenticated administrator. The dashboard is served only to authenticated users, and APIs enforce role permissions.

## Medication reminders

Medicine reminders are checked while the patient dashboard is open. Use **Enable browser reminders & voice** to request browser notification permission and enable voice playback. The dashboard shows an in-page reminder even when browser notifications or speech are unavailable. Browser reminders do not run while the browser/application is completely closed.

## AI provider configuration

The source project previously contained only fixed browser-side sample replies; it did not include an AI backend or provider configuration. The new server endpoint accepts an OpenAI-compatible chat-completions endpoint. Configure `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` in the private `.env` file using your chosen provider's endpoint and credentials. The key stays on the server and is never sent to the browser. Until configured, the assistant reports that it is unavailable rather than generating a fake response. Browser microphone recognition and speech output depend on browser support and installed language voices.
