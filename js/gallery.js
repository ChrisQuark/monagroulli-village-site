// Render gallery (web/renders/index.json) + lightbox. Section stays hidden when the list is empty.
// index.json items: "a.jpg" | {"file":"a.jpg","caption":"…","thumb":"…"} | {"src":"renders/a.jpg","thumb":"renders/a_thumb.jpg","caption":"…","w":2048,"h":1280}
// (the last form is what tools/make_gallery.py writes). Paths may or may not carry the "renders/" prefix.

const url = (p) => (/^(renders\/|https?:\/\/|\/)/.test(p) ? p : 'renders/' + p);

export async function initGallery() {
  const section = document.getElementById('gallery');
  const grid = document.getElementById('galleryGrid');
  let items = [];
  try {
    const r = await fetch('renders/index.json', { cache: 'no-cache' });
    if (r.ok) items = await r.json();
  } catch (_) { /* no gallery */ }
  items = (Array.isArray(items) ? items : [])
    .map((it) => (typeof it === 'string' ? { file: it, caption: '' } : it))
    .filter((it) => it && typeof (it.src || it.file) === 'string');
  if (!items.length) { section.hidden = true; return; }

  const full = (it) => url(it.src || it.file);
  const thumb = (it) => url(it.thumb || it.src || it.file);
  const alt = (it) => it.caption || (it.src || it.file).replace(/^.*\//, '');

  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lbImg');
  const cap = document.getElementById('lbCap');
  let cur = 0;
  const show = (i) => {
    cur = (i + items.length) % items.length;
    img.src = full(items[cur]);
    img.alt = alt(items[cur]);
    cap.textContent = items[cur].caption || '';
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  };
  const close = () => { lb.hidden = true; document.body.style.overflow = ''; };

  const frag = document.createDocumentFragment();
  items.forEach((it, i) => {
    const f = document.createElement('figure');
    const im = document.createElement('img');
    im.loading = 'lazy';
    im.decoding = 'async';
    im.src = thumb(it);
    im.alt = alt(it);
    if (Number.isFinite(it.w) && Number.isFinite(it.h) && it.w > 0 && it.h > 0) { im.width = it.w; im.height = it.h; }
    f.appendChild(im);
    if (it.caption) { const c = document.createElement('figcaption'); c.textContent = it.caption; f.appendChild(c); }
    f.addEventListener('click', () => show(i));
    frag.appendChild(f);
  });
  grid.appendChild(frag);
  section.hidden = false;

  lb.querySelector('.lb-close').addEventListener('click', close);
  lb.querySelector('.lb-prev').addEventListener('click', () => show(cur - 1));
  lb.querySelector('.lb-next').addEventListener('click', () => show(cur + 1));
  lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
  window.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  });
}
