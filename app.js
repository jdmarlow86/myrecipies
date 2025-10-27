/* ========= Utilities & Storage ========= */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const storage = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
};
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ========= State ========= */
let recipes = storage.get("recipes", []); // [{id,title,category,created,pdfUrl,previewHtml,searchText}]
let categories = storage.get("categories", ["General", "Desserts", "Meat", "Vegetarian", "Vegan", "Gluten-Free", "Breakfast", "Beverages", "Soups", "Salads"]);
let selectedIds = new Set();

const fileInput = $("#fileInput");
const dirInput = $("#dirInput");
const titleInput = $("#titleInput");
const categorySelect = $("#categorySelect");
const newCategoryInput = $("#newCategoryInput");
const addCategoryBtn = $("#addCategoryBtn");
const importBtn = $("#importBtn");

const filterCategory = $("#filterCategory");
const searchInput = $("#searchInput");
const cardsEl = $("#cards");
const emptyState = $("#emptyState");

const exportSelectedBtn = $("#exportSelectedBtn");
const deleteSelectedBtn = $("#deleteSelectedBtn");

const renderRoot = $("#renderRoot");

const viewDialog = $("#viewDialog");
const viewTitle = $("#viewTitle");
const viewFrame = $("#viewFrame");
const closeViewBtn = $("#closeViewBtn");

const editDialog = $("#editDialog");
const editTitle = $("#editTitle");
const editCategory = $("#editCategory");
const saveEditBtn = $("#saveEditBtn");
const cancelEditBtn = $("#cancelEditBtn");

const dropZone = $("#dropZone");
const progressBar = $("#progressBar");
const progressText = $("#progressText");

/* === NEW: Windows folder organization controls === */
const chooseLibraryBtn = $("#chooseLibraryBtn");
const libraryPath = $("#libraryPath");
const saveAllBtn = $("#saveAllBtn");
const saveSelectedBtn = $("#saveSelectedBtn");
const syncBar = $("#syncBar");
const syncText = $("#syncText");

let editingId = null;
let libraryRootHandle = null; // FileSystemDirectoryHandle (not persisted across sessions)

/* ========= Init ========= */
function initCategoryControls() {
    categorySelect.innerHTML = "";
    for (const c of categories) {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        categorySelect.appendChild(opt);
    }
    filterCategory.innerHTML = "";
    const all = document.createElement("option");
    all.value = "__all__"; all.textContent = "All";
    filterCategory.appendChild(all);
    for (const c of categories) {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        filterCategory.appendChild(opt);
    }
}
initCategoryControls();
render();

/* ========= Category add ========= */
addCategoryBtn.addEventListener("click", () => {
    const name = (newCategoryInput.value || "").trim();
    if (!name) return;
    if (!categories.includes(name)) {
        categories.push(name);
        storage.set("categories", categories);
        initCategoryControls();
        categorySelect.value = name;
    }
    newCategoryInput.value = "";
});

/* ========= Single/Bulk Import Triggers ========= */
importBtn.addEventListener("click", async () => {
    const files = gatherChosenFiles();
    if (!files.length) { alert("Choose files first (or use drag & drop)."); return; }
    await bulkImport(files);
});

fileInput.addEventListener("change", async (e) => {
    if (e.target.files?.length) await bulkImport([...e.target.files]);
});
dirInput.addEventListener("change", async (e) => {
    if (e.target.files?.length) await bulkImport([...e.target.files]);
});

/* ========= Drag & Drop ========= */
["dragenter", "dragover"].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add("dragover");
    });
});
["dragleave", "drop"].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove("dragover");
    });
});
dropZone.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    let files = [];
    if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === "function") {
        const entries = [...dt.items].map(i => i.webkitGetAsEntry()).filter(Boolean);
        files = await readAllEntries(entries);
    } else {
        files = [...(dt.files || [])];
    }
    if (!files.length) return;
    await bulkImport(files);
});

/* ========= Read folders recursively (webkitdirectory) ========= */
async function readAllEntries(entries) {
    const files = [];
    async function traverse(entry) {
        if (!entry) return;
        if (entry.isFile) {
            await new Promise((res) => entry.file((f) => { files.push(f); res(); }));
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            await new Promise((res) => {
                const readBatch = () => {
                    reader.readEntries(async (batch) => {
                        if (!batch.length) return res();
                        await Promise.all(batch.map(traverse));
                        readBatch();
                    });
                };
                readBatch();
            });
        }
    }
    await Promise.all(entries.map(traverse));
    return files;
}

/* ========= Bulk Import Engine ========= */
function gatherChosenFiles() {
    const a = fileInput.files ? [...fileInput.files] : [];
    const b = dirInput.files ? [...dirInput.files] : [];
    return [...a, ...b];
}

async function bulkImport(files) {
    const allowed = new Set(["txt", "md", "docx", "pdf", "png", "jpg", "jpeg", "gif", "webp"]);
    const toProcess = files.filter(f => {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        return allowed.has(ext);
    });

    if (!toProcess.length) {
        alert("No supported files found in your selection.");
        return;
    }

    const defaultTitle = (titleInput.value || "").trim();
    const category = categorySelect.value || "General";

    let done = 0, failed = 0;
    setProgress(0, toProcess.length, 0);

    const CONCURRENCY = 3;
    const queue = [...toProcess];
    const workers = new Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(() => worker());
    await Promise.all(workers);

    storage.set("recipes", recipes);
    render();
    resetPickers();

    const msg = `Imported ${done} file(s). ${failed ? failed + " failed." : "All succeeded."}`;
    progressText.textContent = msg;

    async function worker() {
        while (queue.length) {
            const file = queue.shift();
            try {
                const { pdfBlob, previewHtml, searchText } = await convertFileToPdfAndPreview(file);
                const pdfUrl = URL.createObjectURL(pdfBlob);
                const title = defaultTitle || file.name.replace(/\.[^.]+$/, "");
                const rec = {
                    id: uid(),
                    title, category,
                    created: Date.now(),
                    pdfUrl,
                    previewHtml,
                    searchText: (title + " " + searchText).toLowerCase()
                };
                recipes.unshift(rec);
                done++;
            } catch (err) {
                console.error("Import failed:", file.name, err);
                failed++;
            } finally {
                setProgress(done + failed, toProcess.length, failed);
            }
            await new Promise(r => setTimeout(r, 0));
        }
    }
}

function setProgress(current, total, failed = 0) {
    const pct = total ? Math.round((current / total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressText.textContent = total
        ? `Processing ${current}/${total}… ${failed ? `(${failed} failed)` : ""}`
        : "";
}
function resetPickers() {
    try { fileInput.value = ""; dirInput.value = ""; } catch { }
    setProgress(0, 0, 0);
}

/* ========= File Type Converters ========= */
async function convertFileToPdfAndPreview(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();

    if (ext === "pdf") {
        const blob = file.slice(0, file.size, "application/pdf");
        const previewHtml = `<p><strong>PDF:</strong> ${escapeHtml(file.name)} (kept as-is)</p>`;
        return { pdfBlob: blob, previewHtml, searchText: file.name };
    }

    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        const imgDataUrl = await fileToDataUrl(file);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: "pt", format: "letter" });
        const img = await loadImage(imgDataUrl);
        const pageW = 612 - 72 * 2, pageH = 792 - 72 * 2;
        const scale = Math.min(pageW / img.width, pageH / img.height);
        const w = img.width * scale, h = img.height * scale;
        doc.addImage(imgDataUrl, "PNG", (612 - w) / 2, (792 - h) / 2, w, h);
        const pdfBlob = doc.output("blob");
        const previewHtml = `<img src="${imgDataUrl}" alt="Recipe image" />`;
        return { pdfBlob, previewHtml, searchText: "[image]" };
    }

    if (ext === "docx") {
        const arrayBuf = await file.arrayBuffer();
        const result = await window.mammoth.convertToHtml({ arrayBuffer: arrayBuf });
        const html = sanitizeHtml(result.value || "<p>(empty)</p>");
        const pdfBlob = await htmlToPdfBlob(html, { title: file.name });
        const previewHtml = limitPreview(html);
        const textForSearch = htmlToText(html);
        return { pdfBlob, previewHtml, searchText: textForSearch };
    }

    if (ext === "md") {
        const text = await file.text();
        const html = sanitizeHtml(marked.parse(text));
        const pdfBlob = await htmlToPdfBlob(html, { title: file.name });
        const previewHtml = limitPreview(html);
        return { pdfBlob, previewHtml, searchText: text };
    }

    if (ext === "txt" || !ext) {
        const text = await file.text();
        const html = sanitizeHtml("<pre>" + escapeHtml(text) + "</pre>");
        const pdfBlob = await htmlToPdfBlob(html, { title: file.name });
        const previewHtml = limitPreview(html);
        return { pdfBlob, previewHtml, searchText: text };
    }

    // Fallback: try as text
    const text = await file.text().catch(() => "");
    const html = sanitizeHtml(text ? marked.parse(text) : `<p>Unsupported file type: .${ext}</p>`);
    const pdfBlob = await htmlToPdfBlob(html, { title: file.name });
    const previewHtml = limitPreview(html);
    return { pdfBlob, previewHtml, searchText: text || file.name };
}

/* ========= HTML -> PDF via html2canvas + jsPDF ========= */
async function htmlToPdfBlob(html, { title = "Recipe" } = {}) {
    renderRoot.innerHTML = `
    <article style="font-family: Georgia, serif; line-height: 1.35;">
      <h1 style="margin:0 0 8px 0; font-family: ui-serif, Georgia, serif;">${escapeHtml(title)}</h1>
      ${html}
    </article>
  `;
    const node = renderRoot;
    const canv = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter" }); // 612x792
    const pageWidth = 612, pageHeight = 792;
    const margin = 36;
    const availW = pageWidth - margin * 2;
    const scale = availW / canv.width;
    const imgW = canv.width * scale;

    let y = 0;
    const sliceHeightPx = Math.floor((pageHeight - margin * 2) / scale);
    while (y < canv.height) {
        const sliceH = Math.min(sliceHeightPx, canv.height - y);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canv.width;
        sliceCanvas.height = sliceH;
        const ctx = sliceCanvas.getContext("2d");
        ctx.drawImage(canv, 0, y, canv.width, sliceH, 0, 0, canv.width, sliceH);

        const sliceData = sliceCanvas.toDataURL("image/png");
        if (y > 0) pdf.addPage();
        const sliceHpt = sliceH * scale;
        pdf.addImage(sliceData, "PNG", margin, margin, imgW, sliceHpt);
        y += sliceH;
    }
    return pdf.output("blob");
}

/* ========= General helpers ========= */
function escapeHtml(s) {
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function sanitizeHtml(html) {
    return String(html).replaceAll("<script", "&lt;script");
}
function limitPreview(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    const pieces = [];
    let count = 0;
    for (const node of div.childNodes) {
        if (count >= 3) break;
        if (node.nodeType === 1) {
            if (/^H[1-3]$/.test(node.tagName) || node.tagName === "P") {
                pieces.push(node.outerHTML); count++;
            } else if (node.tagName === "IMG") {
                pieces.push(node.outerHTML); count++;
            }
        }
    }
    if (pieces.length === 0) pieces.push("<p>(no preview)</p>");
    return pieces.join("");
}
function htmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/\s+/g, " ").trim();
}
function fileToDataUrl(file) {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
    });
}
function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

/* ========= Render Cards ========= */
function render() {
    const term = (searchInput.value || "").toLowerCase();
    const cat = filterCategory.value || "__all__";

    const filtered = recipes.filter(r => {
        const okCat = (cat === "__all__" || r.category === cat);
        const okTerm = (!term || r.searchText.includes(term));
        return okCat && okTerm;
    });

    cardsEl.innerHTML = "";
    emptyState.style.display = filtered.length ? "none" : "block";

    for (const rec of filtered) {
        const tpl = document.importNode($("#cardTemplate").content, true);
        const card = tpl.querySelector(".card");
        const selectBox = tpl.querySelector(".select-box");
        const titleEl = tpl.querySelector(".title");
        const catEl = tpl.querySelector(".category");
        const dateEl = tpl.querySelector(".date");
        const previewEl = tpl.querySelector(".preview");

        titleEl.textContent = rec.title;
        catEl.textContent = rec.category;
        dateEl.textContent = new Date(rec.created).toLocaleString();
        previewEl.innerHTML = rec.previewHtml;

        if (selectedIds.has(rec.id)) {
            card.classList.add("selected");
            selectBox.checked = true;
            card.setAttribute("aria-pressed", "true");
        }

        function toggleSel() {
            if (selectedIds.has(rec.id)) {
                selectedIds.delete(rec.id);
                card.classList.remove("selected");
                card.setAttribute("aria-pressed", "false");
                selectBox.checked = false;
            } else {
                selectedIds.add(rec.id);
                card.classList.add("selected");
                card.setAttribute("aria-pressed", "true");
                selectBox.checked = true;
            }
        }
        card.addEventListener("click", (e) => {
            if (e.target.closest(".card-actions") || e.target.classList.contains("select-box")) return;
            toggleSel();
        });
        selectBox.addEventListener("change", toggleSel);

        tpl.querySelector(".viewBtn").addEventListener("click", () => {
            viewTitle.textContent = rec.title;
            viewFrame.src = rec.pdfUrl;
            viewDialog.showModal();
        });
        tpl.querySelector(".downloadBtn").addEventListener("click", () => {
            const a = document.createElement("a");
            a.href = rec.pdfUrl;
            a.download = safeFileName(rec.title) + ".pdf";
            a.click();
        });
        tpl.querySelector(".editBtn").addEventListener("click", () => {
            openEdit(rec.id);
        });
        tpl.querySelector(".deleteBtn").addEventListener("click", () => {
            if (!confirm(`Delete "${rec.title}"?`)) return;
            removeRecipe(rec.id);
        });

        cardsEl.appendChild(tpl);
    }

    // enable/disable save buttons based on FS access support + folder selected
    const fsSupported = "showDirectoryPicker" in window;
    chooseLibraryBtn.disabled = !fsSupported;
    const canSave = fsSupported && !!libraryRootHandle;
    saveAllBtn.disabled = !canSave;
    saveSelectedBtn.disabled = !canSave;
}
function safeFileName(s) {
    return s.replace(/[\/\\?%*:|"<>]/g, "-").slice(0, 120) || "recipe";
}
closeViewBtn.addEventListener("click", () => viewDialog.close());

/* ========= Edit ========= */
function openEdit(id) {
    editingId = id;
    const rec = recipes.find(r => r.id === id);
    if (!rec) return;
    editTitle.value = rec.title;

    editCategory.innerHTML = "";
    for (const c of categories) {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        if (c === rec.category) opt.selected = true;
        editCategory.appendChild(opt);
    }
    editDialog.showModal();
}
saveEditBtn.addEventListener("click", () => {
    const rec = recipes.find(r => r.id === editingId);
    if (!rec) { editDialog.close(); return; }
    rec.title = editTitle.value.trim() || rec.title;
    rec.category = editCategory.value || rec.category;
    rec.searchText = (rec.title + " " + rec.searchText).toLowerCase();
    storage.set("recipes", recipes);
    editDialog.close();
    render();
});
cancelEditBtn.addEventListener("click", () => editDialog.close());

/* ========= Filtering & Search ========= */
filterCategory.addEventListener("change", render);
searchInput.addEventListener("input", () => {
    clearTimeout(searchInput._t);
    searchInput._t = setTimeout(render, 150);
});

/* ========= Delete / Export Selected ========= */
deleteSelectedBtn.addEventListener("click", () => {
    if (selectedIds.size === 0) { alert("No recipes selected."); return; }
    if (!confirm(`Delete ${selectedIds.size} selected recipe(s)?`)) return;
    recipes = recipes.filter(r => !selectedIds.has(r.id));
    selectedIds.clear();
    storage.set("recipes", recipes);
    render();
});

exportSelectedBtn.addEventListener("click", async () => {
    if (selectedIds.size === 0) { alert("No recipes selected."); return; }
    const chosen = recipes.filter(r => selectedIds.has(r.id));
    const { jsPDF } = window.jspdf;
    const out = new jsPDF({ unit: "pt", format: "letter" });

    for (let i = 0; i < chosen.length; i++) {
        const title = chosen[i].title;
        const html = `
      <article style="font-family: Georgia, serif;">
        <h1 style="margin:0 0 8px 0;">${escapeHtml(title)}</h1>
        <p style="color:#333">Embedded original PDF is stored in your library.</p>
        <p style="color:#555">Created: ${new Date(chosen[i].created).toLocaleString()}</p>
      </article>
    `;
        renderRoot.innerHTML = html;
        const canv = await html2canvas(renderRoot, { scale: 2, backgroundColor: "#ffffff" });
        const imgData = canv.toDataURL("image/png");
        if (i > 0) out.addPage();
        out.addImage(imgData, "PNG", 36, 36, 612 - 72, (canv.height * (612 - 72)) / canv.width);
    }

    const blob = out.output("blob");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `MyRecipies_Selected_${Date.now()}.pdf`;
    a.click();
});

/* ========= Remove Recipe ========= */
function removeRecipe(id) {
    const idx = recipes.findIndex(r => r.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(recipes[idx].pdfUrl);
    recipes.splice(idx, 1);
    storage.set("recipes", recipes);
    render();
}

/* ========= NEW: Windows folder organization via File System Access ========= */
chooseLibraryBtn?.addEventListener("click", async () => {
    if (!("showDirectoryPicker" in window)) {
        alert("This feature needs a Chromium browser (Edge/Chrome).");
        return;
    }
    try {
        libraryRootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        // We cannot get a real path string; show the directory name instead.
        libraryPath.textContent = `Selected: ${libraryRootHandle.name}`;
        syncSetProgress(0, 0);
        render();
    } catch (e) {
        if (e?.name !== "AbortError") console.error(e);
    }
});

saveAllBtn?.addEventListener("click", async () => {
    if (!libraryRootHandle) return alert("Choose a library folder first.");
    await syncRecipesToDisk(recipes);
});

saveSelectedBtn?.addEventListener("click", async () => {
    if (!libraryRootHandle) return alert("Choose a library folder first.");
    const chosen = recipes.filter(r => selectedIds.has(r.id));
    if (!chosen.length) return alert("No recipes selected.");
    await syncRecipesToDisk(chosen);
});

async function syncRecipesToDisk(list) {
    syncSetProgress(0, list.length, 0);
    let done = 0, failed = 0;
    for (const rec of list) {
        try {
            await writeRecipePdf(rec);
            done++;
        } catch (err) {
            console.error("Write failed:", rec.title, err);
            failed++;
        } finally {
            syncSetProgress(done + failed, list.length, failed);
            await new Promise(r => setTimeout(r, 0));
        }
    }
    syncText.textContent = `Saved ${done}/${list.length}. ${failed ? failed + " failed." : "All done."}`;
}

function syncSetProgress(current, total, failed = 0) {
    const pct = total ? Math.round((current / total) * 100) : 0;
    syncBar.style.width = `${pct}%`;
    syncText.textContent = total
        ? `Saving ${current}/${total}… ${failed ? `(${failed} failed)` : ""}`
        : "";
}

async function writeRecipePdf(rec) {
    if (!libraryRootHandle) throw new Error("No library folder selected");
    // Create/resolve category directory
    const catDir = await libraryRootHandle.getDirectoryHandle(rec.category || "General", { create: true });
    // Create/overwrite file
    const base = safeFileName(rec.title || "recipe");
    const fileHandle = await catDir.getFileHandle(`${base}.pdf`, { create: true });
    const writable = await fileHandle.createWritable();

    // Fetch the blob from the object URL and write
    const blob = await fetch(rec.pdfUrl).then(r => r.blob());
    await writable.write(blob);
    await writable.close();
}
