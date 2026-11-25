/* Thin Supabase layer: login (email code), a Firestore-style doc store over one Postgres table, realtime. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON } from './config.js';

export const configured = !/YOUR-/.test(SUPABASE_URL + SUPABASE_ANON);
export const SHEET_BASE = SUPABASE_URL + '/storage/v1/object/public/sheets/';
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

const css = '#gate{position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:var(--bg);padding:20px}#gate form{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:26px;display:grid;gap:12px;box-shadow:var(--shadow)}#gate h1{font-family:var(--f-display);margin:0;font-size:28px}#gate p{margin:0;color:var(--muted);font-size:14px;line-height:1.45}#gate input{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}#gate button{font:inherit;font-weight:600;padding:12px;border-radius:12px;border:0;background:var(--accent);color:var(--accent-ink);cursor:pointer}#gate .err{color:#c0392b}';

function gate(build) {
  return new Promise(res => {
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const g = document.createElement('div'); g.id = 'gate'; document.body.append(g);
    build(g, () => { g.remove(); st.remove(); res(); });
  });
}
const h = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); e.append(...kids.filter(Boolean)); return e; };

async function login() {
  await gate((g, done) => {
    const msg = h('p', { textContent: 'Enter your email. We send a 6-digit code, or tap the link in the email.' });
    const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
    const code = h('input', { type: 'text', inputMode: 'numeric', placeholder: '6-digit code', autocomplete: 'one-time-code', hidden: true });
    const btn = h('button', { type: 'submit', textContent: 'Send code' });
    const f = h('form', null, h('h1', { textContent: 'Shortlist' }), msg, email, code, btn);
    let sent = false;
    f.onsubmit = async e => {
      e.preventDefault(); btn.disabled = true; msg.className = '';
      try {
        if (!sent) {
          const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
          if (error) throw error;
          sent = true; code.hidden = false; code.focus(); btn.textContent = 'Sign in'; msg.textContent = 'Check your email. Type the code here, or tap the link.';
        } else {
          const { error } = await sb.auth.verifyOtp({ email: email.value.trim(), token: code.value.trim(), type: 'email' });
          if (error) throw error; done();
        }
      } catch (err) { msg.className = 'err'; msg.textContent = err.message || 'Something went wrong.'; }
      btn.disabled = false;
    };
    g.append(f);
    sb.auth.onAuthStateChange((ev, s) => { if (s) done(); });
  });
}

async function notMember(email) {
  await gate(g => g.append(h('form', null, h('h1', { textContent: 'Not on the list' }), h('p', { textContent: (email || 'This account') + ' is signed in but has not been added to this Shortlist. Ask the owner to add you.' }), h('button', { type: 'button', textContent: 'Sign out', onclick: async () => { await sb.auth.signOut(); location.reload(); } }))));
}

/* doc store: coll/id -> data, mirrored in memory and kept live by one realtime channel per collection */
const caches = {}, listeners = {};
function watch(coll) {
  if (caches[coll]) return caches[coll];
  const c = caches[coll] = { map: new Map(), ready: null };
  listeners[coll] = new Set();
  const fire = () => listeners[coll].forEach(f => f());
  c.fire = fire;
  c.ready = (async () => {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('docs').select('id,data').eq('coll', coll).order('id').range(from, from + 999);
      if (error) throw error;
      data.forEach(r => c.map.set(r.id, r.data));
      if (data.length < 1000) break;
    }
  })();
  sb.channel('docs-' + coll).on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'coll=eq.' + coll }, p => {
    if (p.eventType === 'DELETE') c.map.delete(p.old.id); else c.map.set(p.new.id, p.new.data);
    fire();
  }).subscribe();
  return c;
}
const snapDocs = c => [...c.map].map(([id, d]) => ({ id, exists: true, data: () => d }));
function listen(coll, cb, onErr, pick) {
  const c = watch(coll);
  const f = () => cb(pick(c));
  listeners[coll].add(f);
  c.ready.then(f, e => onErr && onErr(e));
  return () => listeners[coll].delete(f);
}
async function write(coll, id, data) {
  const c = watch(coll); c.map.set(id, data); c.fire();
  const { error } = await sb.from('docs').upsert({ coll, id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
const splitPath = p => { const i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
export const db = configured && {
  collection: coll => ({
    onSnapshot: (cb, onErr) => listen(coll, cb, onErr, c => ({ docs: snapDocs(c) })),
    add: async d => { const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, '').slice(0, 14); await write(coll, id, d); return { id }; },
  }),
  doc: path => {
    const [coll, id] = splitPath(path);
    return {
      onSnapshot: (cb, onErr) => listen(coll, cb, onErr, c => ({ id, exists: c.map.has(id), data: () => c.map.get(id) })),
      set: async d => write(coll, id, d),
      update: async p => { await watch(coll).ready; return write(coll, id, Object.assign({}, watch(coll).map.get(id) || {}, p)); },
      delete: async () => { const c = watch(coll); c.map.delete(id); c.fire(); const { error } = await sb.from('docs').delete().eq('coll', coll).eq('id', id); if (error) throw error; },
    };
  },
};

export async function boot() {
  if (!configured) { document.body.prepend(h('p', { textContent: 'Shortlist is not connected yet: set SUPABASE_URL and SUPABASE_ANON in config.js.', style: 'padding:20px;color:#c0392b' })); return null; }
  let { data: { session } } = await sb.auth.getSession();
  if (!session) { await login(); ({ data: { session } } = await sb.auth.getSession()); }
  const { data: ok } = await sb.rpc('is_member');
  if (!ok) { await notMember(session && session.user.email); return null; }
  const user = { id: async () => session.user.id, can: async () => true, email: session.user.email, signOut: async () => { await sb.auth.signOut(); location.reload(); } };
  return { db, user, id: session.user.id };
}

/* previews: the `preview` Edge Function reads a link's title and image and copies the image into the `thumbs` bucket */
export async function preview(body) {
  const { data, error } = await sb.functions.invoke('preview', { body });
  if (error) throw error;
  return data || {};
}
/* a photo the person pasted or picked: shrink it in the browser, then store it in `thumbs` */
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
  const path = 'u/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.' + ext;
  const { error } = await sb.storage.from('thumbs').upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return sb.storage.from('thumbs').getPublicUrl(path).data.publicUrl;
}
