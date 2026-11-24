'use strict';
/* Helpers shared by the booking page, the ticket page and the staff screens. */

const TYPE_INFO = {
  team: { label: 'Full team', hint: 'A whole room for your team' },
  group: { label: 'Small group or solo', hint: 'Matched with other players' },
  private: { label: 'Private room', hint: 'Room to yourselves' },
};

const CONTACT_LABEL = { messenger: 'Messenger', facebook: 'Facebook', instagram: 'Instagram', phone: 'Phone', other: 'Contact' };

function lockIcon(filled) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', filled ? 'lock is-on' : 'lock');
  const shackle = document.createElementNS(NS, 'path');
  shackle.setAttribute('d', 'M5.2 7.2V5.1a2.8 2.8 0 0 1 5.6 0v2.1');
  shackle.setAttribute('fill', 'none');
  shackle.setAttribute('stroke', 'currentColor');
  shackle.setAttribute('stroke-width', '1.6');
  const body = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: 3, y: 7, width: 10, height: 8, rx: 2 })) body.setAttribute(k, v);
  body.setAttribute('fill', filled ? 'currentColor' : 'none');
  body.setAttribute('stroke', 'currentColor');
  body.setAttribute('stroke-width', '1.6');
  svg.append(shackle, body);
  return svg;
}

/** Difficulty as 1–3 filled padlocks. */
function locks(n) {
  return h('span', { class: 'locks', role: 'img', 'aria-label': `Difficulty ${n} of 3`, title: `Difficulty ${n} of 3` }, [1, 2, 3].map((i) => lockIcon(i <= n)));
}

/** A shared contact, linked only when it's a safe link. */
function contactNode(c) {
  let value;
  const v = String(c.value || '');
  if (/^https:\/\/\S+$/i.test(v)) {
    value = h('a', { href: v, target: '_blank', rel: 'noopener noreferrer nofollow', text: v.replace(/^https:\/\/(www\.)?/i, '') });
  } else if (c.kind === 'phone' && /^[0-9+()\-\s]{7,30}$/.test(v)) {
    value = h('a', { href: `tel:${v.replace(/[^0-9+]/g, '')}`, text: v });
  } else if (c.kind === 'instagram' && /^@?[A-Za-z0-9._]{1,30}$/.test(v)) {
    value = h('a', { href: `https://instagram.com/${v.replace(/^@/, '')}`, target: '_blank', rel: 'noopener noreferrer nofollow', text: `@${v.replace(/^@/, '')}` });
  } else {
    value = h('span', { text: v });
  }
  return h('span', { class: 'contact' }, h('span', { class: 'contact-kind', text: CONTACT_LABEL[c.kind] || 'Contact' }), value);
}

/* --------------------------------------------------------- receipt picker */

/** Wires a .drop upload box. Images are resized so uploads stay quick on mobile data. */
function attachReceiptPicker(drop, onError) {
  const input = drop.querySelector('input[type="file"]');
  const st = { value: null };

  function render() {
    const r = st.value;
    drop.querySelector('.drop-empty').hidden = !!r;
    drop.querySelector('.drop-filled').hidden = !r;
    drop.classList.toggle('is-filled', !!r);
    if (!r) return;
    drop.querySelector('[data-thumb]').replaceChildren(r.isPdf ? h('span', { class: 'pdf-badge', text: 'PDF' }) : h('img', { src: r.preview, alt: 'Receipt preview' }));
    drop.querySelector('[data-name]').textContent = r.name;
    drop.querySelector('[data-size]').textContent = fileSize(r.size);
  }

  async function take(file) {
    onError('');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
    try {
      if (isPdf) {
        if (file.size > 8 * 1024 * 1024) throw new Error('That PDF is over 8 MB. Upload a smaller file or a screenshot instead.');
        st.value = { name: file.name, data: await blobToBase64(file), size: file.size, isPdf: true };
      } else if (isImage) {
        const blob = await shrinkImage(file, 1800);
        st.value = { name: file.name, data: await blobToBase64(blob), size: blob.size, preview: URL.createObjectURL(blob), isPdf: false };
      } else {
        throw new Error('Upload a JPG, PNG or WebP screenshot, or a PDF.');
      }
    } catch (err) {
      st.value = null;
      onError(err.message);
    }
    render();
  }

  input.addEventListener('change', () => { if (input.files[0]) take(input.files[0]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]);
  });
  return { get value() { return st.value; }, reset() { st.value = null; render(); } };
}

async function shrinkImage(file, maxSide) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0, w, hgt);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('encode failed');
    return blob;
  } catch {
    throw new Error("That image couldn't be opened. Upload a JPG or PNG screenshot instead.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error("That file couldn't be read. Try again."));
    reader.readAsDataURL(blob);
  });
}

/** Empty space where a room's photo goes, until one is uploaded in Settings. */
function roomPlaceholder() {
  return h('div', { class: 'room-ph', 'aria-hidden': 'true' });
}
