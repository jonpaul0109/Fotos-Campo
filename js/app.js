/* ======================================================================
   Fotos de Campo — PWA
   Reconstrucción de foto_campo.py (Termux) para navegador / Android.

   Estructura que se guarda en el dispositivo (dentro de Download/):
     Fotos_Campo/<tipo>/<codigo>/<codigo>_<NN>.<ext>

   Cada foto también queda copiada en IndexedDB para poder:
     - mostrar la galería dentro de la app,
     - calcular el siguiente número correlativo (como siguiente_numero()),
     - reintentar la descarga si el navegador la bloqueó.
   ====================================================================== */

const BASE_DIR = "Fotos_Campo";
const TIPOS = {
  Muestras_Roca: "Muestras de roca",
  Afloramientos: "Afloramientos",
};

/* ---------------------------- IndexedDB ---------------------------- */

const DB_NAME = "fotos_campo_db";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photos")) {
        const store = db.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_tipo", "tipo");
        store.createIndex("by_tipo_codigo", ["tipo", "codigo"]);
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "tipo" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

async function dbGetSetting(tipo) {
  const store = await tx("settings", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(tipo);
    req.onsuccess = () => resolve(req.result ? req.result.codigo : null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSetSetting(tipo, codigo) {
  const store = await tx("settings", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put({ tipo, codigo });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbAddPhoto(record) {
  const store = await tx("photos", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbUpdatePhoto(id, changes) {
  const store = await tx("photos", "readwrite");
  return new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve();
      Object.assign(rec, changes);
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function dbDeletePhoto(id) {
  const store = await tx("photos", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGetPhotosByTipoCodigo(tipo, codigo) {
  const store = await tx("photos", "readonly");
  return new Promise((resolve, reject) => {
    const idx = store.index("by_tipo_codigo");
    const req = idx.getAll([tipo, codigo]);
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.numero - b.numero));
    req.onerror = () => reject(req.error);
  });
}

async function dbGetPhotosByTipo(tipo) {
  const store = await tx("photos", "readonly");
  return new Promise((resolve, reject) => {
    const idx = store.index("by_tipo");
    const req = idx.getAll(tipo);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAllPhotos() {
  const store = await tx("photos", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------ Estado ------------------------------ */

const state = {
  tipo: null,
  codigo: null,
};

/* ------------------------------ Helpers ------------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function extFromFile(file) {
  const nameExt = (file.name || "").split(".").pop();
  if (nameExt && nameExt.length <= 5 && /^[a-zA-Z0-9]+$/.test(nameExt)) {
    return "." + nameExt.toLowerCase();
  }
  const map = { "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/heif": ".heif", "image/webp": ".webp" };
  return map[file.type] || ".jpg";
}

async function siguienteNumero(tipo, codigo) {
  const fotos = await dbGetPhotosByTipoCodigo(tipo, codigo);
  if (fotos.length === 0) return 1;
  return Math.max(...fotos.map((f) => f.numero)) + 1;
}

function showToast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

/** Dispara la descarga del navegador con una ruta anidada, para que Chrome
 *  en Android la ubique en Download/Fotos_Campo/<tipo>/<codigo>/archivo */
function descargarArchivo(blob, tipo, codigo, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${BASE_DIR}/${tipo}/${codigo}/${filename}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------ Vistas ------------------------------ */

const viewHome = document.getElementById("view-home");
const viewCategory = document.getElementById("view-category");

function showHome() {
  state.tipo = null;
  state.codigo = null;
  viewCategory.classList.add("hidden");
  viewHome.classList.remove("hidden");
  refreshHomeCounts();
}

async function refreshHomeCounts() {
  for (const tipo of Object.keys(TIPOS)) {
    const fotos = await dbGetPhotosByTipo(tipo);
    const codigos = new Set(fotos.map((f) => f.codigo));
    const el = document.getElementById(`count-${tipo}`);
    if (fotos.length === 0) {
      el.textContent = "— sin registros aún";
    } else {
      el.textContent = `${fotos.length} foto${fotos.length === 1 ? "" : "s"} · ${codigos.size} código${codigos.size === 1 ? "" : "s"}`;
    }
  }
}

async function openCategory(tipo) {
  state.tipo = tipo;
  viewHome.classList.add("hidden");
  viewCategory.classList.remove("hidden");
  viewCategory.dataset.tipo = tipo;
  document.getElementById("cat-title").textContent = TIPOS[tipo];

  const savedCodigo = await dbGetSetting(tipo);
  if (savedCodigo) {
    state.codigo = savedCodigo;
    renderCategory();
  } else {
    openCodeModal({ tipo, mode: "inicial" });
  }
}

async function renderCategory() {
  document.getElementById("code-value").textContent = state.codigo || "—";
  const fotos = state.codigo ? await dbGetPhotosByTipoCodigo(state.tipo, state.codigo) : [];

  document.getElementById("gallery-title").textContent = `Fotos de ${state.codigo || "—"}`;
  document.getElementById("gallery-count").textContent = fotos.length;

  const grid = document.getElementById("gallery-grid");
  const empty = document.getElementById("gallery-empty");
  grid.innerHTML = "";

  if (fotos.length === 0) {
    empty.classList.remove("hidden");
    grid.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.classList.remove("hidden");

  for (const foto of fotos) {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(foto.blob);
    img.alt = foto.filename;
    thumb.appendChild(img);

    const badge = document.createElement("span");
    badge.className = "thumb-badge";
    badge.textContent = pad2(foto.numero);
    thumb.appendChild(badge);

    if (!foto.downloaded) {
      const pending = document.createElement("span");
      pending.className = "thumb-pending";
      pending.textContent = "!";
      pending.title = "No se confirmó la descarga";
      thumb.appendChild(pending);
    }

    thumb.addEventListener("click", () => openLightbox(foto));
    grid.appendChild(thumb);
  }
}

/* ------------------------------ Modal de código ------------------------------ */

const modalCode = document.getElementById("modal-code");
const modalCodeInput = document.getElementById("modal-code-input");
const modalCodeError = document.getElementById("modal-code-error");
const modalCodeSuggestions = document.getElementById("modal-code-suggestions");
let modalCodeCtx = null;

async function openCodeModal(ctx) {
  modalCodeCtx = ctx;
  document.getElementById("modal-code-title").textContent =
    ctx.mode === "inicial" ? `Código para ${TIPOS[ctx.tipo]}` : "Cambiar código";
  modalCodeInput.value = "";
  modalCodeError.classList.add("hidden");

  const fotos = await dbGetPhotosByTipo(ctx.tipo);
  const codigos = [...new Set(fotos.map((f) => f.codigo))].slice(-8).reverse();
  modalCodeSuggestions.innerHTML = "";
  for (const c of codigos) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "code-suggestion";
    chip.textContent = c;
    chip.addEventListener("click", () => {
      modalCodeInput.value = c;
      modalCodeInput.focus();
    });
    modalCodeSuggestions.appendChild(chip);
  }

  modalCode.classList.remove("hidden");
  setTimeout(() => modalCodeInput.focus(), 50);
}

function closeCodeModal() {
  modalCode.classList.add("hidden");
  // Si estábamos pidiendo el código inicial y se cancela, volvemos al home.
  if (modalCodeCtx && modalCodeCtx.mode === "inicial" && !state.codigo) {
    showHome();
  }
  modalCodeCtx = null;
}

async function confirmCodeModal() {
  const value = modalCodeInput.value.trim();
  if (!value) {
    modalCodeError.classList.remove("hidden");
    return;
  }
  const ctx = modalCodeCtx;
  state.tipo = ctx.tipo;
  state.codigo = value;
  await dbSetSetting(ctx.tipo, value);
  modalCode.classList.add("hidden");
  modalCodeCtx = null;
  renderCategory();
}

document.getElementById("modal-code-cancel").addEventListener("click", closeCodeModal);
document.getElementById("modal-code-confirm").addEventListener("click", confirmCodeModal);
modalCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmCodeModal();
});

/* ------------------------------ Captura de foto ------------------------------ */

const cameraInput = document.getElementById("camera-input");

document.getElementById("btn-capture").addEventListener("click", () => {
  if (!state.codigo) {
    showToast("Primero define un código.");
    return;
  }
  cameraInput.value = "";
  cameraInput.click();
});

cameraInput.addEventListener("change", async () => {
  const file = cameraInput.files && cameraInput.files[0];
  if (!file) return;

  const tipo = state.tipo;
  const codigo = state.codigo;
  const numero = await siguienteNumero(tipo, codigo);
  const ext = extFromFile(file);
  const filename = `${codigo}_${pad2(numero)}${ext}`;

  const id = await dbAddPhoto({
    tipo,
    codigo,
    numero,
    filename,
    blob: file,
    mime: file.type || "image/jpeg",
    createdAt: Date.now(),
    downloaded: false,
  });

  try {
    descargarArchivo(file, tipo, codigo, filename);
    await dbUpdatePhoto(id, { downloaded: true });
    showToast(`✅ Foto guardada como ${filename}`);
  } catch (err) {
    showToast(`No se pudo guardar automáticamente. Usa "reintentar guardado".`);
  }

  renderCategory();
});

/* ------------------------------ Lightbox ------------------------------ */

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxFilename = document.getElementById("lightbox-filename");
let lightboxPhoto = null;

function openLightbox(foto) {
  lightboxPhoto = foto;
  lightboxImg.src = URL.createObjectURL(foto.blob);
  lightboxFilename.textContent = `${BASE_DIR}/${foto.tipo}/${foto.codigo}/${foto.filename}`;
  lightbox.classList.remove("hidden");
}

document.getElementById("lightbox-close").addEventListener("click", () => {
  lightbox.classList.add("hidden");
  lightboxPhoto = null;
});

document.getElementById("lightbox-resend").addEventListener("click", async () => {
  if (!lightboxPhoto) return;
  descargarArchivo(lightboxPhoto.blob, lightboxPhoto.tipo, lightboxPhoto.codigo, lightboxPhoto.filename);
  await dbUpdatePhoto(lightboxPhoto.id, { downloaded: true });
  showToast("↻ Descarga reintentada.");
  renderCategory();
});

document.getElementById("lightbox-delete").addEventListener("click", async () => {
  if (!lightboxPhoto) return;
  if (!confirm(`¿Eliminar ${lightboxPhoto.filename} del registro de la app?\n(El archivo ya descargado en el dispositivo no se borra.)`)) return;
  await dbDeletePhoto(lightboxPhoto.id);
  lightbox.classList.add("hidden");
  lightboxPhoto = null;
  renderCategory();
});

/* ------------------------------ Navegación ------------------------------ */

document.querySelectorAll(".cat-tag").forEach((btn) => {
  btn.addEventListener("click", () => openCategory(btn.dataset.tipo));
});

document.getElementById("btn-back").addEventListener("click", showHome);

document.getElementById("btn-change-code").addEventListener("click", () => {
  openCodeModal({ tipo: state.tipo, mode: "cambiar" });
});

/* ------------------------------ Reintentar todas ------------------------------ */

document.getElementById("btn-resend-all").addEventListener("click", async () => {
  const fotos = await dbGetAllPhotos();
  if (fotos.length === 0) {
    showToast("No hay fotos registradas todavía.");
    return;
  }
  showToast(`Reenviando ${fotos.length} foto(s)… si el navegador pregunta, permite las descargas múltiples.`, 4000);
  let i = 0;
  for (const foto of fotos) {
    descargarArchivo(foto.blob, foto.tipo, foto.codigo, foto.filename);
    await dbUpdatePhoto(foto.id, { downloaded: true });
    i++;
    await new Promise((r) => setTimeout(r, 350));
  }
  showToast(`✅ ${i} foto(s) reenviadas.`);
  refreshHomeCounts();
});

/* ------------------------------ Arranque ------------------------------ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

showHome();
