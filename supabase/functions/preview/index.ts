// preview: given a link, return its title, description and preview image, with the image copied into
// the `thumbs` Storage bucket so cards never depend on hotlinks (Instagram and many shops expire or block them).
// POST { url } -> { title, description, site, image, sourceImage }
// POST { imageUrl } -> { image }   (store an image the user pasted as a link)
// Only signed-in members who can edit may call it (checked with the caller's own token against can_edit()).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MAX_HTML = 1_500_000, MAX_IMG = 10_000_000, TIMEOUT = 9000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// refuse private and local addresses so the function cannot be pointed at internal services
function publicHttpUrl(raw: string): URL | null {
  let u: URL;
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

async function get(url: string, ua: string, accept: string, referer?: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9', ...(referer ? { Referer: referer } : {}) } });
  } finally { clearTimeout(t); }
}

async function readCapped(r: Response, cap: number): Promise<Uint8Array | null> {
  const len = Number(r.headers.get('content-length') || 0);
  if (len > cap) return null;
  const reader = r.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = []; let n = 0;
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

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
  return ENT[e.toLowerCase()] ?? m;
}).replace(/\s+/g, ' ').trim();

function parseMeta(html: string, base: string) {
  const head = html.slice(0, 600_000);
  const meta: Record<string, string> = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
    const k = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (k && attrs.content && !(k in meta)) meta[k] = decode(attrs.content);
  }
  const linkImg = /<link\b[^>]*rel=["']?image_src["']?[^>]*href=["']([^"']+)["']/i.exec(head)?.[1];
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const abs = (u?: string) => { if (!u) return undefined; try { return new URL(decode(u), base).href; } catch { return undefined; } };
  return {
    title: meta['og:title'] || meta['twitter:title'] || (titleTag ? decode(titleTag) : undefined),
    description: meta['og:description'] || meta['twitter:description'] || meta['description'],
    site: meta['og:site_name'],
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta['image'] || linkImg),
  };
}

async function fetchMeta(target: URL) {
  let best: ReturnType<typeof parseMeta> = { title: undefined, description: undefined, site: undefined, image: undefined };
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

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

async function storeImage(admin: ReturnType<typeof createClient>, src: string, referer?: string): Promise<string | null> {
  const u = publicHttpUrl(src);
  if (!u) return null;
  const r = await get(u.href, BROWSER_UA, 'image/avif,image/webp,image/*;q=0.8', referer);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!r.ok || !EXT[type]) { await r.body?.cancel(); return null; }
  const bytes = await readCapped(r, MAX_IMG + 1);
  if (!bytes || bytes.length > MAX_IMG || bytes.length < 200) return null;
  const d = new Date();
  const path = `p/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${EXT[type]}`;
  const { error } = await admin.storage.from('thumbs').upload(path, bytes, { contentType: type, cacheControl: '31536000', upsert: false });
  if (error) return null;
  return admin.storage.from('thumbs').getPublicUrl(path).data.publicUrl;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const SB = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!, SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const asCaller = createClient(SB, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
  const { data: ok } = await asCaller.rpc('can_edit');
  if (!ok) return json({ error: 'Not allowed' }, 403);
  const admin = createClient(SB, SERVICE);

  let body: { url?: string; imageUrl?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad body' }, 400); }

  if (body.imageUrl) {
    const image = await storeImage(admin, body.imageUrl).catch(() => null);
    return image ? json({ image }) : json({ error: 'Could not fetch that image' }, 422);
  }
  const target = publicHttpUrl(body.url || '');
  if (!target) return json({ error: 'Not a public web address' }, 400);
  const m = await fetchMeta(target);
  const image = m.image ? await storeImage(admin, m.image, target.href).catch(() => null) : null;
  return json({ title: m.title?.slice(0, 300), description: m.description?.slice(0, 600), site: m.site, image, sourceImage: m.image || null });
});
