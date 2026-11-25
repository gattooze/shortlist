# Shortlist

A personal, visual bookmarking space: links, products, places, ideas, anything from across the internet, each saved as a card with its picture. Installable app (PWA) on Firebase.

- Share any link from Instagram or Chrome (Pixel) straight into the list. Mac Chrome uses a bookmarklet.
- Saving a link creates a card at once; the `preview` Cloud Function then fills in its title, description and picture, and keeps a copy of the picture in Storage so it never breaks when the original link expires.
- Cards with no picture show "Add picture": open the card to upload a photo, paste a screenshot, or paste an image link. "Fetch N missing pictures" in the header fills older saves.
- Sign in with Google; you stay signed in on the device. Access is a list of `members/<email>` docs in Firestore with a role (owner, editor, viewer).

## Files
- `index.html`: the whole UI. `fb.js`: sign-in, Firestore doc store, picture upload, preview call. `config.js`: Firebase web config (public by design).
- `functions/index.js`: the `preview` callable function (region asia-south1).
- `firestore.rules`, `storage.rules`: access rules. `firebase.json`: hosting, rules and functions config.
- `sheets/` (photo sprite sheets of saved Instagram posts) and seed data are private and kept out of this repo; they are deployed with hosting from the owner's machine.
- `manifest.webmanifest`, `sw.js`, `icons/`: install and share-target support.

## Deploy
`firebase deploy --project <shortlist project id>` from this folder (with `sheets/` present). Always pass `--project`.

## Switching backend later
Only `fb.js` talks to Firebase. `index.html` uses a small interface: `boot()` resolves `{ db, user, id }` or `null`; `db.collection(name).onSnapshot(cb)` and `.add(doc)`; `db.doc('coll/id').onSnapshot / set / update / delete`; plus `preview()`, `uploadImage()` and `SHEET_BASE`.
