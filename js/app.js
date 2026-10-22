/* ======================================================================
   Fotos de Campo — PWA
   Reconstrucción de foto_campo.py (Termux) para navegador / Android.

   Cada foto se guarda primero en IndexedDB (galería, numeración correlativa
   igual a siguiente_numero()). La organización real en carpetas del
   dispositivo ocurre al exportar: se genera un .zip con la estructura
     Fotos_Campo/<Categoría>/<código>/<código>_<NN>.<ext>
   que el usuario descomprime con su explorador de archivos. Esto es más
   confiable que intentar que el navegador cree subcarpetas al descargar
   cada foto por separado.
   ====================================================================== */

const BASE_DIR = "Fotos_Campo";
const TIPOS = {
  Muestras_Roca: "Muestras de roca",
  Afloramientos: "Afloramientos",
};
// Nombres de carpeta dentro del zip (legibles, con may/min consistente)
const TIPO_FOLDER = {
  Muestras_Roca: "Muestras de Roca",
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

/** Marca como exportados los ids dados (se llama tras generar un .zip con éxito) */
async function dbMarkExported(ids) {
  const idSet = new Set(ids);
  const store = await tx("photos", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if (idSet.has(cursor.value.id)) {
        const rec = cursor.value;
        rec.exported = true;
        cursor.update(rec);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** true si hay al menos una foto y TODAS están marcadas como exportadas */
async function dbTodoExportado() {
  const fotos = await dbGetAllPhotos();
  if (fotos.length === 0) return false;
  return fotos.every((f) => f.exported === true);
}

/** Borra toda la base local (fotos y configuración de códigos) */
async function dbClearAll() {
  const db = await openDB();
  await Promise.all(
    ["photos", "settings"].map(
      (name) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(name, "readwrite").objectStore(name).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );
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

/* ------------------------------ Vistas ------------------------------ */

const viewHome = document.getElementById("view-home");
const viewCategory = document.getElementById("view-category");

function showHome() {
  state.tipo = null;
  state.codigo = null;
  viewCategory.classList.add("hidden");
  viewHome.classList.remove("hidden");
  refreshHomeCounts();
  refreshClearButtonState();
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

  await dbAddPhoto({
    tipo,
    codigo,
    numero,
    filename,
    blob: file,
    mime: file.type || "image/jpeg",
    createdAt: Date.now(),
    exported: false,
  });

  showToast(`📸 Guardada como ${filename}. No olvides exportar para copiarla a tu almacenamiento.`);
  renderCategory();
  refreshHomeCounts();
  refreshClearButtonState();
});

/* ------------------------------ Lightbox ------------------------------ */

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxFilename = document.getElementById("lightbox-filename");
let lightboxPhoto = null;

function openLightbox(foto) {
  lightboxPhoto = foto;
  lightboxImg.src = URL.createObjectURL(foto.blob);
  lightboxFilename.textContent = `${BASE_DIR}/${TIPO_FOLDER[foto.tipo] || foto.tipo}/${foto.codigo}/${foto.filename}`;
  lightbox.classList.remove("hidden");
}

document.getElementById("lightbox-close").addEventListener("click", () => {
  lightbox.classList.add("hidden");
  lightboxPhoto = null;
});

document.getElementById("lightbox-download").addEventListener("click", () => {
  if (!lightboxPhoto) return;
  const url = URL.createObjectURL(lightboxPhoto.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = lightboxPhoto.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast(`⬇ ${lightboxPhoto.filename} descargada (archivo suelto).`);
});

document.getElementById("lightbox-delete").addEventListener("click", async () => {
  if (!lightboxPhoto) return;
  if (!confirm(`¿Eliminar ${lightboxPhoto.filename} del registro de la app?\n(El archivo ya descargado en el dispositivo no se borra.)`)) return;
  await dbDeletePhoto(lightboxPhoto.id);
  lightbox.classList.add("hidden");
  lightboxPhoto = null;
  renderCategory();
  refreshClearButtonState();
});

/* ------------------------------ Navegación ------------------------------ */

document.querySelectorAll(".cat-tag").forEach((btn) => {
  btn.addEventListener("click", () => openCategory(btn.dataset.tipo));
});

document.getElementById("btn-back").addEventListener("click", showHome);

document.getElementById("btn-change-code").addEventListener("click", () => {
  openCodeModal({ tipo: state.tipo, mode: "cambiar" });
});

/* ------------------------------ Exportar a .zip ------------------------------ */

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Arma un zip con la estructura Fotos_Campo/<Categoría>/<código>/<código_NN.ext>
 *  a partir de una lista de registros de foto, y dispara su descarga. */
async function exportarZip(fotos, nombreZip) {
  if (!fotos.length) {
    showToast("No hay fotos para exportar.");
    return;
  }
  if (typeof JSZip === "undefined") {
    showToast("No se pudo cargar el compresor (revisa tu conexión) e inténtalo de nuevo.");
    return;
  }
  showToast(`Generando ${nombreZip}… (${fotos.length} foto${fotos.length === 1 ? "" : "s"})`, 5000);

  const zip = new JSZip();
  const root = zip.folder(BASE_DIR);
  for (const foto of fotos) {
    const carpetaTipo = root.folder(TIPO_FOLDER[foto.tipo] || foto.tipo);
    const carpetaCodigo = carpetaTipo.folder(foto.codigo);
    carpetaCodigo.file(foto.filename, foto.blob);
  }

  try {
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreZip;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    await dbMarkExported(fotos.map((f) => f.id));
    showToast(`✅ ${nombreZip} descargado. Descomprímelo con tu explorador de archivos.`, 4500);
    refreshClearButtonState();
  } catch (err) {
    showToast("No se pudo generar el zip. Intenta con menos fotos a la vez.");
  }
}

document.getElementById("btn-export-all").addEventListener("click", async () => {
  const fotos = await dbGetAllPhotos();
  exportarZip(fotos, `${BASE_DIR}_${timestamp()}.zip`);
});

document.getElementById("btn-export-codigo").addEventListener("click", async () => {
  if (!state.tipo || !state.codigo) return;
  const fotos = await dbGetPhotosByTipoCodigo(state.tipo, state.codigo);
  exportarZip(fotos, `${BASE_DIR}_${state.codigo}_${timestamp()}.zip`);
});

/* ------------------------------ Eliminar todos los datos ------------------------------ */

const btnClearAll = document.getElementById("btn-clear-all");
const clearAllHint = document.getElementById("clear-all-hint");

/** Habilita el botón solo si hay fotos y todas ya fueron exportadas al menos una vez. */
async function refreshClearButtonState() {
  const fotos = await dbGetAllPhotos();
  const todoExportado = fotos.length > 0 && fotos.every((f) => f.exported === true);

  btnClearAll.disabled = !todoExportado;

  if (fotos.length === 0) {
    clearAllHint.textContent = "Aún no hay fotos registradas.";
  } else if (todoExportado) {
    clearAllHint.textContent = `Las ${fotos.length} foto${fotos.length === 1 ? "" : "s"} guardadas ya están exportadas. Puedes borrar los datos de la app con confianza.`;
  } else {
    const pendientes = fotos.filter((f) => !f.exported).length;
    clearAllHint.textContent = `Faltan ${pendientes} foto${pendientes === 1 ? "" : "s"} por exportar. Usa "Exportar todo" para habilitar este botón.`;
  }
}

btnClearAll.addEventListener("click", async () => {
  if (btnClearAll.disabled) return;
  const ok = confirm(
    "¿Eliminar TODAS las fotos y códigos guardados en esta app?\n\nYa las exportaste a .zip, pero esta acción no se puede deshacer dentro de la app. Los archivos que ya descargaste no se tocan."
  );
  if (!ok) return;

  await dbClearAll();
  state.tipo = null;
  state.codigo = null;
  showToast("🗑 Datos eliminados de la app.");
  showHome();
});

/* ------------------------------ Vista: Códigos registrados ------------------------------ */

const viewCodes = document.getElementById("view-codes");

async function dbGetCodigosConDatos(tipo) {
  const fotos = await dbGetPhotosByTipo(tipo);
  const map = new Map();
  for (const f of fotos) {
    if (!map.has(f.codigo)) map.set(f.codigo, { codigo: f.codigo, count: 0, lastCreated: 0, firstBlob: null });
    const entry = map.get(f.codigo);
    entry.count += 1;
    if (f.createdAt > entry.lastCreated) entry.lastCreated = f.createdAt;
    if (!entry.firstBlob || f.numero === 1) entry.firstBlob = f.blob;
  }
  return [...map.values()].sort((a, b) => b.lastCreated - a.lastCreated);
}

async function renderCodesView() {
  const container = document.getElementById("codes-list-container");
  container.innerHTML = "";

  for (const tipo of Object.keys(TIPOS)) {
    const section = document.createElement("section");
    section.className = `codes-section codes-section--${tipo === "Muestras_Roca" ? "rock" : "outcrop"}`;

    const title = document.createElement("div");
    title.className = "codes-section-title";
    title.innerHTML = `<span class="dot"></span> ${TIPOS[tipo]}`;
    section.appendChild(title);

    const codigos = await dbGetCodigosConDatos(tipo);

    if (codigos.length === 0) {
      const empty = document.createElement("p");
      empty.className = "codes-empty";
      empty.textContent = "Todavía no hay códigos con fotos.";
      section.appendChild(empty);
    } else {
      for (const entry of codigos) {
        const row = document.createElement("button");
        row.className = "code-row-item";
        row.type = "button";

        const img = document.createElement("img");
        img.className = "code-row-thumb";
        if (entry.firstBlob) img.src = URL.createObjectURL(entry.firstBlob);
        row.appendChild(img);

        const text = document.createElement("span");
        text.className = "code-row-text";
        text.innerHTML = `
          <span class="code-row-name">${entry.codigo}</span>
          <span class="code-row-count">${entry.count} foto${entry.count === 1 ? "" : "s"}</span>
        `;
        row.appendChild(text);

        row.addEventListener("click", async () => {
          state.tipo = tipo;
          state.codigo = entry.codigo;
          await dbSetSetting(tipo, entry.codigo);
          viewCodes.classList.add("hidden");
          viewCategory.classList.remove("hidden");
          viewCategory.dataset.tipo = tipo;
          document.getElementById("cat-title").textContent = TIPOS[tipo];
          renderCategory();
        });

        section.appendChild(row);
      }
    }

    container.appendChild(section);
  }
}

document.getElementById("btn-view-codes").addEventListener("click", () => {
  viewHome.classList.add("hidden");
  viewCodes.classList.remove("hidden");
  renderCodesView();
});

document.getElementById("btn-codes-back").addEventListener("click", () => {
  viewCodes.classList.add("hidden");
  showHome();
});

/* ------------------------------ Arranque ------------------------------ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

showHome();
