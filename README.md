# Shortlist

A shared list of things to buy, eat, visit and gift. Installable app (PWA) on Supabase.

- Share any link from Instagram or Chrome (Pixel) straight into the list. Mac Chrome uses a bookmarklet.
- Sign in with an email code. Only emails in the `members` table can read or write.
- Instagram posts show as photos in the grid and as the real embedded post in the detail sheet.
- Code is public. Data (docs table) and photos live in Supabase behind login.

## Files
- `tokyo.js`: the Tokyo trip view (static content, no personal data). Opens from the Tokyo button in the header, and stands alone, no login, at `tokyo.html`.
- `index.html`: the whole UI. `supa.js`: login, doc store, realtime. `config.js`: project URL and public anon key.
- `sql/schema.sql`: tables, row-level security, realtime, photo bucket.
- Import data (`docs.csv`) and photo sheets are private and kept out of this repo: `~/shortlist-seed/`.
- `manifest.webmanifest`, `sw.js`, `icons/`: install and share-target support.

## Setup (once)
1. supabase.com, New project (name it shortlist). Auth > Providers > Email: keep enabled. Auth > URL Configuration: Site URL = `https://gattooze.github.io/shortlist/`.
2. SQL Editor: paste `sql/schema.sql`, run. Then run the `insert into public.members ...` line with real emails.
3. Table Editor > `docs` > Insert > Import data from CSV: `docs.csv`.
4. Storage > `sheets` bucket > upload every file in the `sheets/` folder.
5. Project Settings > API: copy Project URL and the anon public key into `config.js`, commit.
6. GitHub repo Settings > Pages > Deploy from branch `main`, root. App is at `https://gattooze.github.io/shortlist/`.
7. On the Pixel open that URL in Chrome, Install app. Share from Instagram now offers Shortlist.

## Pictures on every card (previews)
Saving a link creates the card at once, then the `preview` Edge Function (`supabase/functions/preview/`) reads the page's title and preview image and copies the image into the public `thumbs` bucket, so pictures keep working after the original link expires. Cards with no picture show "Add picture": open the card to upload a photo, paste a screenshot, or paste an image link. "Fetch N missing pictures" in the header fills older saves.

Setup (once):
1. SQL Editor: run `sql/002_thumbs.sql` (adds the `thumbs` bucket and an upload policy; changes nothing existing).
2. On your Mac, in this repo: `npx supabase login`, then `npx supabase functions deploy preview --project-ref YOUR-PROJECT-REF`. The function reads the project URL and keys from Supabase itself; no secrets go in the repo.

## Switching backend later
Only `supa.js` talks to Supabase. `index.html` uses a small interface and nothing else:
- `boot()` resolves `{ db, user, id }` (shows the login screen itself), or `null` if not signed in or not allowed.
- `db.collection(name).onSnapshot(cb)` and `.add(doc)`; `db.doc('coll/id').onSnapshot / set / update / delete`. `cb` gets `{ docs: [{ id, data() }] }` for collections and `{ id, exists, data() }` for single docs.
- `SHEET_BASE`: URL prefix where the photo sheets (`sNN.jpg`) are served.
To move to Firebase, Cloudflare D1 or anything else, rewrite `supa.js` to the same shape, change `SHEET_BASE`, and re-import `docs.csv` (columns `coll,id,data` where `data` is JSON). `sql/schema.sql` is the only Supabase-specific schema.
