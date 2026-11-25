// preview: given a link, return its title, description and preview picture, with the picture copied into
// Storage so cards never depend on hotlinks (Instagram and many shops expire or block them).
// call({ url }) -> { title, description, site, image, sourceImage }
// call({ imageUrl }) -> { image }   (keep a copy of an image link the person pasted)
// Only members with an owner or editor role (members/<email> in Firestore) may call it.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';

initializeApp();
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MAX_HTML = 1_500_000, MAX_IMG = 10_000_000, TIMEOUT = 9000;

// refuse private and local addresses so the function cannot be pointed at internal services
export function publicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]') return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (h.startsWith('[')) return null; // no raw IPv6 literals
  return u;
}

async function get(url, ua, accept, referer) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9', ...(referer ? { Referer: referer } : {}) } });
  } finally { clearTimeout(t); }
}

async function readCapped(r, cap) {
  const len = Number(r.headers.get('content-length') || 0);
  if (len > cap) return null;
  const reader = r.body?.getReader();
  if (!reader) return null;
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { reader.cancel(); break; }
    parts.push(value);
  }
  const out = new Uint8Array(Math.min(n, cap)); let o = 0;
  for (const p of parts) { out.set(p.subarray(0, out.length - o), o); o += p.length; if (o >= out.length) break; }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
  return ENT[e.toLowerCase()] ?? m;
}).replace(/\s+/g, ' ').trim();

export function parseMeta(html, base) {
  const head = html.slice(0, 600_000);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
    const k = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (k && attrs.content && !(k in meta)) meta[k] = decode(attrs.content);
  }
  const linkImg = /<link\b[^>]*rel=["']?image_src["']?[^>]*href=["']([^"']+)["']/i.exec(head)?.[1];
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const abs = u => { if (!u) return undefined; try { return new URL(decode(u), base).href; } catch { return undefined; } };
  return {
    title: meta['og:title'] || meta['twitter:title'] || (titleTag ? decode(titleTag) : undefined),
    description: meta['og:description'] || meta['twitter:description'] || meta['description'],
    site: meta['og:site_name'],
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta['image'] || linkImg),
  };
}

export async function fetchMeta(target) {
  let best = {};
  const isIg = /(^|\.)instagram\.com$/.test(target.hostname);
  // Instagram and many shops only serve preview tags to link-preview bots; try a browser first elsewhere
  for (const ua of isIg ? [BOT_UA, BROWSER_UA] : [BROWSER_UA, BOT_UA]) {
    try {
      const r = await get(target.href, ua, 'text/html,application/xhtml+xml');
      if (!r.ok || !/html|xml/i.test(r.headers.get('content-type') || '')) { await r.body?.cancel(); continue; }
      const buf = await readCapped(r, MAX_HTML);
      if (!buf) continue;
      const m = parseMeta(new TextDecoder().decode(buf), r.url || target.href);
      best = { title: best.title || m.title, description: best.description || m.description, site: best.site || m.site, image: best.image || m.image };
      if (best.image && best.title) break;
    } catch { /* try the next agent */ }
  }
  // Instagram fallback: the public embed page usually carries the post image even when the post page does not
  const ig = isIg && /\/(p|reel|tv)\/([\w-]+)/.exec(target.pathname);
  if (ig && !best.image) {
    try {
      const r = await get(`https://www.instagram.com/${ig[1]}/${ig[2]}/embed/captioned/`, BROWSER_UA, 'text/html');
      const html = r.ok ? new TextDecoder().decode((await readCapped(r, MAX_HTML)) || new Uint8Array()) : '';
      const src = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html)?.[1] || /<img[^>]+class="[^"]*EmbeddedMediaImage[^"]*"[^>]+src="([^"]+)"/.exec(html)?.[1];
      if (src) best.image = decode(src);
      const cap = /class="Caption"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
      if (cap && !best.description) best.description = decode(cap.replace(/<[^>]+>/g, ' ')).slice(0, 400);
    } catch { /* keep what we have */ }
  }
  if (!best.site) best.site = target.hostname.replace(/^www\./, '');
  return best;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

async function storeImage(src, referer) {
  const u = publicHttpUrl(src);
  if (!u) return null;
  const r = await get(u.href, BROWSER_UA, 'image/avif,image/webp,image/*;q=0.8', referer);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!r.ok || !EXT[type]) { await r.body?.cancel(); return null; }
  const bytes = await readCapped(r, MAX_IMG + 1);
  if (!bytes || bytes.length > MAX_IMG || bytes.length < 200) return null;
  const d = new Date(), token = randomUUID();
  const path = `thumbs/p/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXT[type]}`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(Buffer.from(bytes), { contentType: type, resumable: false, metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } } });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function canEdit(auth) {
  const email = auth && auth.token && auth.token.email && auth.token.email.toLowerCase();
  if (!email || auth.token.email_verified !== true) return false;
  const m = await getFirestore().doc(`members/${email}`).get();
  return m.exists && ['owner', 'editor'].includes(m.data().role);
}

export const preview = onCall({ region: 'asia-south1', memory: '256MiB', timeoutSeconds: 30, maxInstances: 3 }, async req => {
  if (!(await canEdit(req.auth))) throw new HttpsError('permission-denied', 'Not allowed');
  const body = req.data || {};
  if (body.imageUrl) {
    const image = await storeImage(body.imageUrl).catch(() => null);
    if (!image) throw new HttpsError('failed-precondition', 'Could not fetch that image');
    return { image };
  }
  const target = publicHttpUrl(body.url || '');
  if (!target) throw new HttpsError('invalid-argument', 'Not a public web address');
  const m = await fetchMeta(target);
  const image = m.image ? await storeImage(m.image, target.href).catch(() => null) : null;
  return { title: (m.title || '').slice(0, 300) || null, description: (m.description || '').slice(0, 600) || null, site: m.site || null, image, sourceImage: m.image || null };
});
