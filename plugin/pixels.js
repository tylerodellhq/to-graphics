// TO Graphics: looks at a rendered preview frame (PNG) so the panel can tell a real frame from
// Premiere's red "Media Offline" frame (shown while a template is still loading), and pick the
// busiest of a few frames. Uses fflate (lib/) to unpack the PNG.

(function () {
  const fflate = window.fflate || require("./lib/fflate.js");

  function decode(buf) {
    const a = new Uint8Array(buf);
    if (a.length < 33 || a[0] !== 0x89 || a[1] !== 0x50) return null;
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
    const parts = [];
    let p = 8;
    while (p + 8 <= a.length) {
      const len = dv.getUint32(p), t = String.fromCharCode(a[p + 4], a[p + 5], a[p + 6], a[p + 7]);
      const d = a.subarray(p + 8, p + 8 + len);
      if (t === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = d[8]; type = d[9]; interlace = d[12]; }
      else if (t === "IDAT") parts.push(d);
      else if (t === "IEND") break;
      p += 12 + len;
    }
    if (depth !== 8 || interlace || !(type === 2 || type === 6) || !w || !h) return null;
    let total = 0; for (const x of parts) total += x.length;
    const z = new Uint8Array(total); let o = 0; for (const x of parts) { z.set(x, o); o += x.length; }
    const raw = fflate.unzlibSync(z);
    const bpp = type === 6 ? 4 : 3, stride = w * bpp;
    const px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const v = raw[src + x];
        const left = x >= bpp ? px[dst + x - bpp] : 0;
        const up = y ? px[dst - stride + x] : 0;
        const ul = y && x >= bpp ? px[dst - stride + x - bpp] : 0;
        let r;
        if (f === 0) r = v;
        else if (f === 1) r = v + left;
        else if (f === 2) r = v + up;
        else if (f === 3) r = v + ((left + up) >> 1);
        else { const pp = left + up - ul, pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - ul); r = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
        px[dst + x] = r & 255;
      }
    }
    return { w, h, bpp, px };
  }

  // { offline, blank, score } or null if the PNG can't be read.
  function analyse(buf) {
    let img = null;
    try { img = decode(buf); } catch (e) { return null; }
    if (!img) return null;
    const { w, h, bpp, px } = img;
    let red = 0, n = 0, edges = 0, lit = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * bpp;
        const al = bpp === 4 ? px[i + 3] / 255 : 1;
        const r = px[i] * al, g = px[i + 1] * al, b = px[i + 2] * al;
        n++;
        if (r > 110 && r > g * 1.8 && r > b * 1.8) red++;
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        if (l > 24) lit++;
        if (x + 2 < w) {
          const j = i + 2 * bpp, al2 = bpp === 4 ? px[j + 3] / 255 : 1;
          edges += Math.abs(l - (0.3 * px[j] + 0.59 * px[j + 1] + 0.11 * px[j + 2]) * al2);
        }
      }
    }
    return { offline: red / n > 0.3, blank: lit / n < 0.003, score: edges / n + 40 * (lit / n) };
  }

  window.TOPixels = { analyse };
})();
