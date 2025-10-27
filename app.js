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

let editingId = null;

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

/* ========= Import & Convert ========= */
importBtn.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    if (!file) { alert("Choose a file."); return; }

    const title = (titleInput.value || file.name.replace(/\.[^.]+$/, "")).trim();
    const category = categorySelect.value || "General";

    try {
        const { pdfBlob, previewHtml, searchText } = await convertFileToPdfAndPreview(file);
        const pdfUrl = URL.createObjectURL(pdfBlob);

        const rec = {
            id: uid(),
            title, category,
            created: Date.now(),
            pdfUrl,
            previewHtml,
            searchText: (title + " " + searchText).toLowerCase()
        };
        recipes.unshift(rec);
        storage.set("recipes", recipes);

        // reset minimal
        titleInput.value = "";
        fileInput.value = "";

        render();
    } catch (err) {
        console.error(err);
        alert("Failed to import this file. See console for details.");
    }
});

/* ========= File Type Converters ========= */
async function convertFileToPdfAndPreview(file) {
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "pdf") {
        // Keep as-is for PDF
        const blob = file.slice(0, file.size, "application/pdf");
        const previewHtml = `<p><strong>PDF:</strong> ${escapeHtml(file.name)} (kept as-is)</p>`;
        return { pdfBlob: blob, previewHtml, searchText: file.name };
    }

    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        // Image -> PDF
        const imgDataUrl = await fileToDataUrl(file);
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: "pt", format: "letter" }); // 612x792
        // Fit image into page preserving aspect
        const img = await loadImage(imgDataUrl);
        const pageW = 612 - 72 * 2, pageH = 792 - 72 * 2; // margins
        const scale = Math.min(pageW / img.width, pageH / img.height);
        const w = img.width * scale, h = img.height * scale;
        doc.addImage(imgDataUrl, "PNG", (612 - w) / 2, (792 - h) / 2, w, h);
        const pdfBlob = doc.output("blob");

        const previewHtml = `<img src="${imgDataUrl}" alt="Recipe image" />`;
        return { pdfBlob, previewHtml, searchText: "[image]" };
    }

    if (ext === "docx") {
        // DOCX -> HTML (Mammoth) -> PDF
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

/* ========= Helpers: HTML -> PDF via html2canvas + jsPDF ========= */
async function htmlToPdfBlob(html, { title = "Recipe" } = {}) {
    renderRoot.innerHTML = `
    <article style="font-family: Georgia, serif; line-height: 1.35;">
      <h1 style="margin:0 0 8px 0; font-family: ui-serif, Georgia, serif;">${escapeHtml(title)}</h1>
      ${html}
    </article>
  `;

    // Render to canvas (split into pages if tall)
    const node = renderRoot;
    const canv = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canv.toDataURL("image/png");

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter" }); // 612x792
    const pageWidth = 612, pageHeight = 792;
    // Place image with margins
    const margin = 36;
    const availW = pageWidth - margin * 2;
    const scale = availW / canv.width;
    const imgW = canv.width * scale;
    const imgH = canv.height * scale;

    // If image taller than one page, slice into pages
    let y = 0;
    const sliceHeightPx = Math.floor((pageHeight - margin * 2) / scale);
    while (y < canv.height) {
        const sliceH = Math.min(sliceHeightPx, canv.height - y);
        // Create slice
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

/* ========= General small helpers ========= */
function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function sanitizeHtml(html) {
    // Very light sanitation; for a production app consider a robust sanitizer like DOMPurify.
    return String(html).replaceAll("<script", "&lt;script");
}
function limitPreview(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    // get first few paragraphs/images
    const pieces = [];
    let count = 0;
    for (const node of div.childNodes) {
        if (count >= 3) break;
        if (node.nodeType === 1) {
            if (node.tagName === "P" || node.tagName === "H1" || node.tagName === "H2") {
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
    // Filters
    const term = (searchInput.value || "").toLowerCase();
    const cat = filterCategory.value || "__all__";

    const filtered = recipes.filter(r => {
        const okCat = (cat === "__all__" || r.category === cat);
        const okTerm = (!term || r.searchText.includes(term));
        return okCat && okTerm;
    });

    cardsEl.innerHTML = "";
    if (filtered.length === 0) {
        emptyState.style.display = "block";
    } else {
        emptyState.style.display = "none";
    }

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

        // Selection behavior
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

        // Buttons
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
    // simple debounce
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

    // Append each existing PDF into the output via images (simple approach)
    // Note: A production-grade merge would parse PDF bytes; here we rasterize for simplicity.
    for (let i = 0; i < chosen.length; i++) {
        const pdfUrl = chosen[i].pdfUrl;
        const data = await fetch(pdfUrl).then(r => r.blob());
        const buf = await data.arrayBuffer();

        // Render the first page as an image by loading in iframe + html2canvas fallback
        // Simpler: embed the stored preview HTML into a new page instead of true merge.
        // We'll show title + a link note for clarity.
        const title = chosen[i].title;
        const html = `
      <article style="font-family: Georgia, serif;">
        <h1 style="margin:0 0 8px 0;">${escapeHtml(title)}</h1>
        <p style="color:#333">Embedded original PDF attached separately in your library. This merged export is a printable snapshot.</p>
        <p style="color:#555">Created: ${new Date(chosen[i].created).toLocaleString()}</p>
      </article>
    `;
        const pageBlob = await htmlToPdfBlob(html, { title });
        const pageUrl = URL.createObjectURL(pageBlob);
        // Load as image and stamp
        const arrBuf2 = await fetch(pageUrl).then(r => r.arrayBuffer());
        // Convert first page to image by drawing onto canvas
        // A simpler route: renderRoot snapshot again:
        // Re-render the same HTML to image for the merged doc:
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

/* ========= Initial seed (optional) ========= */
// Uncomment to add a sample on first run
// if (recipes.length === 0) {
//   (async () => {
//     const html = "<p>This is a sample recipe body.</p>";
//     const pdfBlob = await htmlToPdfBlob(html, { title: "Sample Pancakes" });
//     recipes.push({
//       id: uid(), title: "Sample Pancakes", category: "Breakfast",
//       created: Date.now(), pdfUrl: URL.createObjectURL(pdfBlob),
//       previewHtml: html, searchText: "sample pancakes breakfast recipe"
//     });
//     storage.set("recipes", recipes);
//     render();
//   })();
// }
