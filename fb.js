/* Thin Firebase layer: Google sign-in, Firestore doc store, picture storage and the preview function.
   index.html only uses what this file exports, so the backend can be swapped by rewriting this one file. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, browserLocalPersistence, setPersistence } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { FIREBASE_CONFIG } from './config.js';

export const configured = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !/YOUR-/.test(FIREBASE_CONFIG.apiKey));
const app = configured ? initializeApp(FIREBASE_CONFIG) : null;
const auth = app && getAuth(app);
/* local cache: the app opens instantly and works offline, then syncs */
const fs = app && initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const store = app && getStorage(app);
/* sprite sheets of saved Instagram posts are served next to the app */
export const SHEET_BASE = new URL('sheets/', location.href).href;

const css = '#gate{position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:var(--bg);padding:20px}#gate form{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:26px;display:grid;gap:12px;box-shadow:var(--shadow)}#gate h1{font-family:var(--f-display);margin:0;font-size:28px}#gate p{margin:0;color:var(--muted);font-size:14px;line-height:1.45}#gate button{font:inherit;font-weight:600;padding:12px;border-radius:12px;border:0;background:var(--accent);color:var(--accent-ink);cursor:pointer}#gate .err{color:#c0392b}';
const h = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); e.append(...kids.filter(Boolean)); return e; };
function gate(build) {
  return new Promise(res => {
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const g = document.createElement('div'); g.id = 'gate'; document.body.append(g);
    build(g, () => { g.remove(); st.remove(); res(); });
  });
}
const currentUser = () => new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });

async function login() {
  await gate((g, done) => {
    const msg = h('p', { textContent: 'Sign in with Google. You stay signed in on this device.' });
    const btn = h('button', { type: 'submit', textContent: 'Continue with Google' });
    const f = h('form', null, h('h1', { textContent: 'Shortlist' }), msg, btn);
    f.onsubmit = async e => {
      e.preventDefault(); btn.disabled = true; msg.className = '';
      try {
        await setPersistence(auth, browserLocalPersistence);
        const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
        /* installed app (standalone) or ?signin=redirect: use a full-page redirect; otherwise a popup, falling back to redirect */
        const redirect = matchMedia('(display-mode: standalone)').matches || new URLSearchParams(location.search).get('signin') === 'redirect';
        if (redirect) { await signInWithRedirect(auth, p); return; }
        try { await signInWithPopup(auth, p); } catch (err) { if (/popup/.test(err.code || '')) { await signInWithRedirect(auth, p); return; } throw err; }
        done();
      } catch (err) { msg.className = 'err'; msg.textContent = err.message || 'Something went wrong.'; btn.disabled = false; }
    };
    g.append(f);
    onAuthStateChanged(auth, u => { if (u) done(); });
  });
}
async function notMember(email) {
  await gate(g => g.append(h('form', null, h('h1', { textContent: 'Not on the list' }), h('p', { textContent: (email || 'This account') + ' is signed in but has not been added to this Shortlist. Ask the owner to add you.' }), h('button', { type: 'button', textContent: 'Sign out', onclick: async () => { await signOut(auth); location.reload(); } }))));
}

const wrapSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
export const db = configured && {
  collection: name => ({
    onSnapshot: (cb, onErr) => onSnapshot(collection(fs, name), s => cb({ docs: s.docs.map(d => ({ id: d.id, exists: true, data: () => d.data() })) }), onErr),
    add: async d => { const r = await addDoc(collection(fs, name), d); return { id: r.id }; },
  }),
  doc: path => {
    const r = doc(fs, path);
    return {
      onSnapshot: (cb, onErr) => onSnapshot(r, s => cb(wrapSnap(s)), onErr),
      set: (d, opts) => setDoc(r, d, opts || {}),
      update: p => updateDoc(r, p),
      delete: () => deleteDoc(r),
    };
  },
};

/* ask the server for a link's title and picture: write a job, and the `preview` function (a Firestore trigger)
   fills the target doc in and deletes the job. Results arrive through the normal live listeners.
   job: { target: 'items/<id>' | 'ov/<id>', url } or { target, imageUrl }; fresh: true lets it replace a placeholder title */
export async function preview(job) {
  await addDoc(collection(fs, 'jobs'), Object.assign({ by: auth.currentUser && auth.currentUser.uid, at: new Date().toISOString() }, job));
}
/* a photo the person pasted or picked: shrink it in the browser, then store it */
export async function uploadImage(file) {
  let blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86)) || file;
  } catch (e) { /* formats the browser cannot decode go up as they are */ }
  const ext = blob.type === 'image/jpeg' ? 'jpg' : (blob.type.split('/')[1] || 'jpg');
  const r = ref(store, 'thumbs/u/' + crypto.randomUUID() + '.' + ext);
  await uploadBytes(r, blob, { contentType: blob.type || 'image/jpeg', cacheControl: 'public,max-age=31536000' });
  return getDownloadURL(r);
}

export async function boot() {
  if (!configured) { document.body.prepend(h('p', { textContent: 'Shortlist is not connected yet: set FIREBASE_CONFIG in config.js.', style: 'padding:20px;color:#c0392b' })); return null; }
  let u = await currentUser();
  if (!u) { await login(); u = auth.currentUser; }
  /* membership: owner is set in the rules; others get a members/<email> doc */
  try { await getDoc(doc(fs, 'members', u.email.toLowerCase())); }
  catch (e) { await notMember(u.email); return null; }
  const user = { email: u.email, signOut: async () => { await signOut(auth); location.reload(); } };
  return { db, user, id: u.uid };
}
