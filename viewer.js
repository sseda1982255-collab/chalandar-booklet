// Flipbook presentation layer around an existing PDF.
//   PDF  ->  PDF.js (lazy, per-page, on demand)  ->  <canvas> per page  ->  StPageFlip
// The PDF file is only read; nothing is written back.
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const cfg = await fetch("config.json").then(r => r.json()).catch(() => ({}));
const params = new URLSearchParams(location.search);
const PDF_URL = params.get("pdf") || cfg.pdf;
const KEEP_RADIUS = 3;      // render current page +/- this many
const RELEASE_RADIUS = 6;   // free canvases beyond this distance
const MAX_DPR = 2;

const $ = id => document.getElementById(id);
const status = t => { $("status").textContent = t; };
$("title").textContent = cfg.title || "Booklet";
$("subtitle").textContent = cfg.subtitle || "";
document.title = cfg.title || "Booklet";

const pdf = await pdfjsLib.getDocument({ url: PDF_URL }).promise;
const N = pdf.numPages;
$("pageCount").textContent = N;
$("pageInput").max = N;

// page aspect from page 1 (all pages share the A3 landscape format)
const p1 = await pdf.getPage(1);
const vp1 = p1.getViewport({ scale: 1 });
const ASPECT = vp1.width / vp1.height;

const state = {
  book: null, current: 0, spread: null, userMode: null, pageW: 0, pageH: 0,
  pages: [],            // {el, canvas, renderedW, task}
  pdfPages: new Map(),  // index -> PDFPageProxy (kept only for nearby pages)
};
window.__flip = state;      // test hook

function layout() {
  const stage = $("stage").getBoundingClientRect();
  const W = stage.width - 120, H = stage.height - 40;     // room for edge buttons + ground shadow
  const single = Math.min(W / ASPECT, H);                  // page height when one page shown
  const spread = Math.min(W / (2 * ASPECT), H);            // page height for a two-page spread
  const autoSpread = window.innerWidth >= 900 && spread >= 0.6 * single;
  const useSpread = state.userMode === null ? autoSpread : state.userMode === "spread";
  const h = Math.floor(useSpread ? spread : single);
  return { spread: useSpread, pageH: h, pageW: Math.floor(h * ASPECT) };
}

function buildPages() {
  const wrap = $("bookwrap");
  wrap.innerHTML = "";
  const block = document.createElement("div");
  block.id = "book";
  wrap.appendChild(block);
  state.pages = [];
  for (let i = 0; i < N; i++) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.density = i === 0 || i === N - 1 ? "hard" : "soft";
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = String(i + 1).padStart(2, "0");
    const c = document.createElement("canvas");
    el.append(ph, c);
    block.appendChild(el);
    state.pages.push({ el, canvas: c, ph, renderedW: 0, task: null });
  }
  return block;
}

function init(startPage = 0) {
  const L = layout();
  if (state.book) { try { state.book.destroy(); } catch (e) { /* already gone */ } }
  // release all canvases - sizes change with layout
  state.pages.forEach(p => release(p));
  state.spread = L.spread; state.pageW = L.pageW; state.pageH = L.pageH;
  const block = buildPages();
  $("bookwrap").style.width = (L.spread ? 2 * L.pageW : L.pageW) + "px";
  $("bookwrap").style.height = L.pageH + "px";
  const book = new St.PageFlip(block, {
    width: L.pageW, height: L.pageH, size: "fixed",
    usePortrait: !L.spread, showCover: true, autoSize: false,
    drawShadow: true, maxShadowOpacity: 0.35, flippingTime: 900,
    mobileScrollSupport: false, swipeDistance: 30, showPageCorners: true,
    startPage, startZIndex: 0,
  });
  book.loadFromHTML(document.querySelectorAll("#book .page"));
  book.on("flip", e => { state.current = e.data; onPage(); });
  book.on("changeState", e => { state.flipState = e.data; if (e.data === "read") state.animEndAt = performance.now(); });
  state.book = book;
  state.current = book.getCurrentPageIndex();
  $("btnMode").classList.toggle("on", L.spread);
  onPage();
}

function onPage() {
  const i = state.current;
  const shown = state.spread && i > 0 ? [i, Math.min(i + 1, N - 1)] : [i];
  const label = shown.length > 1 && shown[1] !== shown[0] ? `${shown[0] + 1}–${shown[1] + 1}` : `${shown[0] + 1}`;
  $("pageInput").value = shown[0] + 1;
  status(`Page ${label} of ${N}`);
  schedule();
}

// ---------------- lazy rendering ----------------
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(async () => {
    pending = false;
    const i = state.current;
    const order = [0];
    for (let d = 1; d <= KEEP_RADIUS; d++) order.push(d, -d);
    for (const d of order) {
      const k = i + d;
      if (k >= 0 && k < N) await render(k);
    }
    state.pages.forEach((p, k) => { if (Math.abs(k - i) > RELEASE_RADIUS) release(p, k); });
  });
}

async function getPdfPage(k) {
  if (!state.pdfPages.has(k)) state.pdfPages.set(k, await pdf.getPage(k + 1));
  return state.pdfPages.get(k);
}

async function render(k) {
  const p = state.pages[k];
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const targetW = Math.round(state.pageW * dpr);
  if (p.renderedW >= targetW || p.task) return;
  const page = await getPdfPage(k);
  const vp = page.getViewport({ scale: targetW / page.getViewport({ scale: 1 }).width });
  const c = p.canvas;
  const tmp = document.createElement("canvas");     // render offscreen, swap when complete
  tmp.width = Math.round(vp.width); tmp.height = Math.round(vp.height);
  p.task = page.render({ canvasContext: tmp.getContext("2d", { alpha: false }), viewport: vp, canvas: tmp });
  try {
    await p.task.promise;
    c.width = tmp.width; c.height = tmp.height;
    c.getContext("2d").drawImage(tmp, 0, 0);
    p.renderedW = targetW;
    p.ph.style.display = "none";
    state.renders = (state.renders || 0) + 1;
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.error(e);
  } finally {
    p.task = null;
    tmp.width = tmp.height = 0;
  }
}

function release(p, k) {
  if (p.task) { p.task.cancel(); p.task = null; }
  if (p.renderedW) { p.canvas.width = p.canvas.height = 0; p.renderedW = 0; p.ph.style.display = ""; }
  if (k !== undefined && state.pdfPages.has(k)) { state.pdfPages.get(k).cleanup(); state.pdfPages.delete(k); }
}

// ---------------- controls ----------------
const next = () => state.book.flipNext("bottom");
const prev = () => state.book.flipPrev("bottom");
$("btnNext").onclick = next; $("edgeNext").onclick = next;
$("btnPrev").onclick = prev; $("edgePrev").onclick = prev;
$("pageInput").addEventListener("change", e => {
  const v = Math.max(1, Math.min(N, parseInt(e.target.value || "1", 10)));
  state.book.flip(v - 1);
});
$("btnMode").onclick = () => {
  state.userMode = state.spread ? "single" : "spread";
  init(state.current);
};
$("btnFull").onclick = toggleFull;
function toggleFull() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (!$("zoom").hidden) { if (e.key === "Escape") closeZoom(); return; }
  if (e.key === "ArrowRight") next();
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === "Home") { e.preventDefault(); state.book.flip(0); }
  else if (e.key === "End") { e.preventDefault(); state.book.flip(N - 1); }
  else if (e.key === "f" || e.key === "F") toggleFull();
  else if (e.key === "z" || e.key === "Z") openZoom();
});
// ---------------- mouse wheel -> page turn ----------------
// One physical wheel gesture = one page / spread turn, using the same
// flipNext/flipPrev animation as the buttons. Wheel input is ignored while a
// page is animating or being dragged, and until the wheel has been quiet for
// WHEEL_QUIET ms after the animation ends (absorbs notch bursts and
// touchpad inertia).
const WHEEL_THRESHOLD = 40, WHEEL_QUIET = 220;
const wheel = { acc: 0, lastAt: 0, locked: false };
state.wheelTurns = 0;
$("stage").addEventListener("wheel", e => {
  e.preventDefault();                                   // never scroll the page from inside the book
  if (!$("zoom").hidden || !state.book) return;
  const now = performance.now();
  const quietFor = now - wheel.lastAt;
  wheel.lastAt = now;
  const busy = state.flipState && state.flipState !== "read";   // flipping / user_fold / fold_corner
  if (wheel.locked) {
    if (busy || quietFor < WHEEL_QUIET || now - (state.animEndAt || 0) < WHEEL_QUIET) return;
    wheel.locked = false; wheel.acc = 0;
  }
  if (busy) return;
  const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  wheel.acc += d;
  if (Math.abs(wheel.acc) < WHEEL_THRESHOLD) return;
  const dir = wheel.acc > 0 ? 1 : -1;
  wheel.acc = 0; wheel.locked = true;
  const before = state.book.getCurrentPageIndex();
  if (dir > 0 && before < N - 1) next();
  else if (dir < 0 && before > 0) prev();
  state.wheelTurns++;
  $("stage").classList.add("wheeled");
}, { passive: false });

let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const L = layout();
    if (L.spread !== state.spread || Math.abs(L.pageH - state.pageH) > 4) init(state.current);
  }, 180);
});

// ---------------- zoom (high-res single page, pan + wheel/pinch) ----------------
const Z = { scale: 1, x: 0, y: 0, base: 1, page: 0 };
$("btnZoom").onclick = openZoom;
$("zoomClose").onclick = closeZoom;
$("zoomIn").onclick = () => zoomBy(1.4);
$("zoomOut").onclick = () => zoomBy(1 / 1.4);

async function openZoom() {
  Z.page = state.current;
  $("zoom").hidden = false;
  $("zoomLabel").textContent = `Page ${Z.page + 1} of ${N}`;
  const vp = $("zoomViewport").getBoundingClientRect();
  Z.base = Math.min(vp.width / ASPECT, vp.height) * ASPECT;   // fitted CSS width
  Z.scale = 1; zoomRes = 1.5;
  await renderZoom(1.5);
  center();
}
function closeZoom() {
  $("zoom").hidden = true;
  const c = $("zoomCanvas"); c.width = c.height = 0;
}
async function renderZoom(maxFactor) {
  const page = await getPdfPage(Z.page);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.min(Math.round(Z.base * maxFactor * dpr), 8000);
  const vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
  const c = $("zoomCanvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  c.style.width = Z.base + "px"; c.style.height = Z.base / ASPECT + "px";
  await page.render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, canvas: c }).promise;
}
// re-render sharper once the zoom level settles (capped; one render per settle)
let zoomT, zoomRes = 0;
function sharpen() {
  clearTimeout(zoomT);
  zoomT = setTimeout(async () => {
    const need = Math.min(Z.scale * 1.1, 3.2);
    if (need > zoomRes + 0.2) { zoomRes = need; await renderZoom(need); }
  }, 260);
}
function apply() { sharpen(); $("zoomCanvas").style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.scale})`; $("zoomPct").textContent = Math.round(Z.scale * 100) + "%"; }
function center() {
  const vp = $("zoomViewport").getBoundingClientRect();
  Z.x = (vp.width - Z.base * Z.scale) / 2; Z.y = (vp.height - Z.base / ASPECT * Z.scale) / 2; apply();
}
function zoomBy(f, cx, cy) {
  const vp = $("zoomViewport").getBoundingClientRect();
  cx = cx ?? vp.width / 2; cy = cy ?? vp.height / 2;
  const ns = Math.max(1, Math.min(4, Z.scale * f));
  Z.x = cx - (cx - Z.x) * ns / Z.scale; Z.y = cy - (cy - Z.y) * ns / Z.scale; Z.scale = ns;
  if (ns === 1) center(); else apply();
}
const zv = $("zoomViewport");
zv.addEventListener("wheel", e => { e.preventDefault(); const r = zv.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
const ptrs = new Map(); let pinch0 = 0;
zv.addEventListener("pointerdown", e => { zv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e); zv.classList.add("drag"); });
zv.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  const prevE = ptrs.get(e.pointerId); ptrs.set(e.pointerId, e);
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch0) { const r = zv.getBoundingClientRect(); zoomBy(d / pinch0, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top); }
    pinch0 = d; return;
  }
  Z.x += e.clientX - prevE.clientX; Z.y += e.clientY - prevE.clientY; apply();
});
const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = 0; if (!ptrs.size) zv.classList.remove("drag"); };
zv.addEventListener("pointerup", endPtr); zv.addEventListener("pointercancel", endPtr);

init(Math.max(0, Math.min(N - 1, (parseInt(params.get("page") || "1", 10) || 1) - 1)));
window.__ready = true;
