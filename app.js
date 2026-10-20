
"use strict";

/* =========================================================
   DEVELOPER MASTERMIND
   Notes • Folders • Tags • Favorites • Trash • Backup
   ========================================================= */

const DB_NAME = "developer_mastermind_db";
const DB_VERSION = 2;
const STORE_NAME = "notes";

let db = null;
let currentNoteId = null;
let currentView = "home";
let deferredInstallPrompt = null;
let toastTimer = null;
let autosaveTimer = null;
let currentFilter = "all";
let currentFolder = "";
let editorControlsReady = false;
let isSaving = false;
let saveQueue = Promise.resolve();

const $ = (selector) => document.querySelector(selector);

const elements = {
  dashboard: $("#dashboardView"),
  notes: $("#notesView"),
  editor: $("#editorView"),
  placeholder: $("#placeholderView"),
  breadcrumb: $("#breadcrumbCurrent"),
  notesGrid: $("#notesGrid"),
  allNotesGrid: $("#allNotesGrid"),
  totalNotes: $("#totalNotes"),
  search: $("#searchInput"),
  notesSearch: $("#notesSearchInput"),
  title: $("#noteTitle"),
  content: $("#noteContent"),
  saveStatus: $("#saveStatus"),
  editorDate: $("#editorDate"),
  toast: $("#toast"),
  sidebar: $("#sidebar")
};

const placeholderPages = {
  planner: {
    title: "Study Planner",
    icon: "◷",
    description:
      "Plan study sessions, organise deadlines and manage reminders."
  },
  focus: {
    title: "Focus Timer",
    icon: "◉",
    description:
      "A Pomodoro timer and study history are planned for a future update."
  },
  library: {
    title: "Photo & PDF Library",
    icon: "▧",
    description:
      "Photo storage, PDF tools and OCR are planned for a future update."
  },
  flashcards: {
    title: "Flashcards & Revision",
    icon: "▱",
    description:
      "Create revision cards and track learning progress in a future update."
  }
};

/* -------------------- Utilities -------------------- */

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return Date.now().toString(36) +
    Math.random().toString(36).slice(2);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "Just now";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function showToast(message) {
  if (!elements.toast) return;

  elements.toast.textContent = message;
  elements.toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2800);
}

function setSaveStatus(message, saved = false) {
  if (!elements.saveStatus) return;

  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle("saved", saved);
}

function normaliseNote(note) {
  // Add new properties without removing old note content.
  return {
    ...note,
    title: note.title || "Untitled note",
    content: note.content || "",
    folder: typeof note.folder === "string" ? note.folder : "",
    tags: Array.isArray(note.tags)
      ? [...new Set(note.tags.map(String).filter(Boolean))]
      : [],
    favorite: note.favorite === true,
    deletedAt: note.deletedAt || null,
    createdAt: note.createdAt || new Date().toISOString(),
    updatedAt: note.updatedAt || new Date().toISOString()
  };
}

/* -------------------- IndexedDB -------------------- */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Keep the existing object store and all existing notes.
      // Never delete or recreate the notes store during an upgrade.
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id"
        });

        store.createIndex("updatedAt", "updatedAt", {
          unique: false
        });
      }
    };

    request.onsuccess = () => {
      db = request.result;

      db.onversionchange = () => db.close();

      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      console.warn("Database upgrade is blocked by another open tab.");
    };
  });
}

function getStore(mode = "readonly") {
  if (!db) {
    throw new Error("The local database is not ready.");
  }

  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAllNotes() {
  return new Promise((resolve, reject) => {
    const request = getStore().getAll();

    request.onsuccess = () => {
      resolve((request.result || []).map(normaliseNote));
    };

    request.onerror = () => reject(request.error);
  });
}

function getNote(id) {
  return new Promise((resolve, reject) => {
    const request = getStore().get(id);

    request.onsuccess = () => {
      resolve(request.result ? normaliseNote(request.result) : null);
    };

    request.onerror = () => reject(request.error);
  });
}

function putNote(note) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");

    transaction.objectStore(STORE_NAME).put(normaliseNote(note));

    transaction.oncomplete = () => resolve(note);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function deleteNoteFromDatabase(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");

    transaction.objectStore(STORE_NAME).delete(id);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/* -------------------- Search and filters -------------------- */

function getAllFolders(notes) {
  return [...new Set(
    notes
      .filter((note) => !note.deletedAt)
      .map((note) => note.folder)
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function parseTags(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 30)
  )];
}

function noteMatchesSearch(note, term) {
  if (!term) return true;

  const searchable = [
    note.title,
    note.content,
    note.folder,
    ...(note.tags || [])
  ].join(" ").toLocaleLowerCase();

  return searchable.includes(term.toLocaleLowerCase());
}

function getVisibleNotes(notes, term = "") {
  let result = notes.filter((note) => {
    if (currentFilter === "trash") {
      return Boolean(note.deletedAt);
    }

    if (note.deletedAt) return false;

    if (currentFilter === "favorites" && !note.favorite) {
      return false;
    }

    if (currentFilter === "folder" && note.folder !== currentFolder) {
      return false;
    }

    return true;
  });

  if (term.trim()) {
    result = result.filter((note) =>
      noteMatchesSearch(note, term.trim())
    );
  }

  return result.sort((a, b) => {
    const dateA = new Date(a.updatedAt).getTime() || 0;
    const dateB = new Date(b.updatedAt).getTime() || 0;

    return dateB - dateA;
  });
}

/* -------------------- Note cards -------------------- */

function noteCardHTML(note) {
  const title = escapeHTML(note.title);
  const content = escapeHTML(note.content || "No content yet.");
  const date = escapeHTML(formatDate(note.updatedAt));
  const folder = escapeHTML(note.folder || "Unfiled");
  const tags = (note.tags || [])
    .map((tag) => `<span class="dm-tag">${escapeHTML(tag)}</span>`)
    .join("");

  const colors = ["#8a7cff", "#4c9ce8", "#27b68a", "#e9a34f"];
  const color = colors[
    (String(note.id).charCodeAt(0) || 0) % colors.length
  ];

  const trashActions = note.deletedAt
    ? `
      <div class="dm-card-actions">
        <button type="button" data-note-action="restore"
          data-note-id="${escapeHTML(note.id)}">Restore</button>
        <button type="button" data-note-action="purge"
          data-note-id="${escapeHTML(note.id)}">Delete forever</button>
      </div>
    `
    : "";

  return `
    <article class="note-card"
      style="--note-accent:${color}"
      data-note-id="${escapeHTML(note.id)}"
      tabindex="0"
      role="button"
      aria-label="Open note: ${title}">

      <div class="note-card-top">
        <span class="note-type">
          ${note.favorite ? "★ FAVORITE" : "PERSONAL NOTE"}
        </span>
        <span class="note-date">${date}</span>
      </div>

      <div class="note-title">${title}</div>
      <div class="note-preview">${content}</div>

      <div class="dm-folder-label">📁 ${folder}</div>
      ${tags ? `<div class="dm-tags">${tags}</div>` : ""}

      <div class="note-card-bottom">
        <span>${note.deletedAt ? "In trash" : "Stored locally"}</span>
        <span class="note-open">
          ${note.deletedAt ? "Manage →" : "Open →"}
        </span>
      </div>

      ${trashActions}
    </article>
  `;
}

function emptyStateHTML(hasSearch = false) {
  if (currentFilter === "trash") {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">♲</div>
        <h3>Your trash is empty</h3>
        <p>Deleted notes will appear here so you can restore them.</p>
      </div>
    `;
  }

  if (hasSearch) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">⌕</div>
        <h3>No matching notes</h3>
        <p>Try another keyword in বাংলা or English.</p>
      </div>
    `;
  }

  return `
    <div class="empty-state">
      <div class="empty-state-icon">✦</div>
      <h3>Your first idea starts here</h3>
      <p>Create a note to save what you learn. Notes stay on this device.</p>
      <button class="primary-button" data-action="new-note">
        ＋ Create a note
      </button>
    </div>
  `;
}

/* -------------------- Dynamic interface -------------------- */

function addInterfaceStyles() {
  if ($("#dmExtraStyles")) return;

  const style = document.createElement("style");
  style.id = "dmExtraStyles";

  style.textContent = `
    .dm-toolbar {
      display:flex; flex-wrap:wrap; align-items:center;
      gap:9px; margin:14px 0 18px;
    }
    .dm-toolbar button, .dm-toolbar select,
    .dm-toolbar input, .dm-editor-field input {
      min-height:38px; max-width:100%; padding:8px 11px;
      color:var(--text); background:var(--surface);
      border:1px solid var(--border); border-radius:10px;
      font:inherit;
    }
    .dm-toolbar button { cursor:pointer; font-weight:700; }
    .dm-toolbar button.active {
      color:var(--primary); background:var(--primary-soft);
      border-color:var(--primary);
    }
    .dm-toolbar .dm-spacer { flex:1; }
    .dm-editor-fields {
      display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
      gap:15px; margin-top:20px;
    }
    .dm-editor-field { display:flex; flex-direction:column; gap:8px; }
    .dm-editor-field label {
      font-size:11px; color:var(--muted); font-weight:800;
    }
    .dm-editor-field input { width:100%; }
    .dm-favorite-toggle { min-height:38px; }
    .dm-tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
    .dm-tag {
      display:inline-block; border-radius:6px; padding:4px 7px;
      color:var(--primary); background:var(--primary-soft);
      font-size:10px; overflow-wrap:anywhere;
    }
    .dm-folder-label {
      margin-top:9px; color:var(--muted); font-size:10px;
    }
    .dm-card-actions {
      display:flex; flex-wrap:wrap; gap:7px;
      margin-top:12px; position:relative; z-index:2;
    }
    .dm-card-actions button {
      padding:7px 9px; border:1px solid var(--border);
      border-radius:8px; background:var(--surface);
      color:var(--text); cursor:pointer; font-size:11px;
    }
    .dm-help {
      color:var(--muted); font-size:11px; line-height:1.7;
    }
    @media(max-width:520px) {
      .dm-editor-fields { grid-template-columns:1fr; }
      .dm-toolbar button, .dm-toolbar select { flex:1 1 auto; }
    }
  `;

  document.head.appendChild(style);
}

function setupDynamicInterface() {
  if (editorControlsReady) return;

  addInterfaceStyles();

  const notesSearchWrap = elements.notesSearch?.closest(".notes-page-search");

  if (notesSearchWrap) {
    const toolbar = document.createElement("div");
    toolbar.className = "dm-toolbar";
    toolbar.id = "dmToolbar";

    toolbar.innerHTML = `
      <button type="button" data-filter="all" class="active">All notes</button>
      <button type="button" data-filter="favorites">★ Favorites</button>
      <button type="button" data-filter="trash">♲ Trash</button>
      <select id="dmFolderFilter" aria-label="Filter by folder">
        <option value="">All folders</option>
      </select>
      <button type="button" id="dmNewFolder">＋ Folder</button>
      <span class="dm-spacer"></span>
      <button type="button" id="dmExport">Export backup</button>
      <button type="button" id="dmImport">Restore backup</button>
      <input type="file" id="dmBackupFile"
        accept=".json,application/json" hidden>
    `;

    notesSearchWrap.insertAdjacentElement("afterend", toolbar);

    toolbar.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        currentFilter = button.dataset.filter;
        currentFolder = "";

        toolbar.querySelectorAll("[data-filter]").forEach((item) => {
          item.classList.toggle("active", item === button);
        });

        $("#dmFolderFilter").value = "";
        renderNotes();
      });
    });

    $("#dmFolderFilter").addEventListener("change", (event) => {
      currentFolder = event.target.value;
      currentFilter = currentFolder ? "folder" : "all";

      toolbar.querySelectorAll("[data-filter]").forEach((item) => {
        item.classList.toggle("active", item.dataset.filter === currentFilter);
      });

      renderNotes();
    });

    $("#dmNewFolder").addEventListener("click", createFolder);
    $("#dmExport").addEventListener("click", exportBackup);
    $("#dmImport").addEventListener("click", () => $("#dmBackupFile").click());

    $("#dmBackupFile").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];

      if (file) await importBackup(file);

      event.target.value = "";
    });
  }

  const editorPanel = elements.editor?.querySelector(".editor-panel");

  if (editorPanel) {
    const fields = document.createElement("div");
    fields.className = "dm-editor-fields";
    fields.id = "dmEditorFields";

    fields.innerHTML = `
      <div class="dm-editor-field">
        <label for="dmNoteFolder">FOLDER</label>
        <input id="dmNoteFolder" type="text" maxlength="80"
          list="dmFolderSuggestions" placeholder="e.g. Biology">
        <datalist id="dmFolderSuggestions"></datalist>
      </div>

      <div class="dm-editor-field">
        <label for="dmNoteTags">TAGS</label>
        <input id="dmNoteTags" type="text" maxlength="500"
          placeholder="exam, biology, chapter 1">
      </div>

      <div class="dm-editor-field">
        <label>FAVORITE</label>
        <button type="button" id="dmFavoriteToggle"
          class="secondary-button dm-favorite-toggle">
          ☆ Add to favorites
        </button>
      </div>

      <div class="dm-editor-field">
        <label>NOTE MANAGEMENT</label>
        <p class="dm-help">
          Use folders to organise notes and commas to separate tags.
          Changes are saved with the note.
        </p>
      </div>
    `;

    editorPanel.appendChild(fields);

    $("#dmNoteFolder").addEventListener("input", scheduleAutosave);
    $("#dmNoteTags").addEventListener("input", scheduleAutosave);

    $("#dmFavoriteToggle").addEventListener("click", async () => {
      if (!currentNoteId) {
        await saveCurrentNote(false);

        if (!currentNoteId) {
          showToast("Write a title or some content first.");
          return;
        }
      }

      const note = await getNote(currentNoteId);
      if (!note) return;

      note.favorite = !note.favorite;
      note.updatedAt = new Date().toISOString();

      await putNote(note);
      updateFavoriteButton(note.favorite);
      await renderNotes();

      showToast(note.favorite ? "Added to favorites." : "Removed from favorites.");
    });
  }

  editorControlsReady = true;
}

function updateFavoriteButton(favorite) {
  const button = $("#dmFavoriteToggle");
  if (!button) return;

  button.textContent = favorite
    ? "★ Remove from favorites"
    : "☆ Add to favorites";

  button.classList.toggle("active", favorite);
}

async function refreshFolderOptions() {
  const select = $("#dmFolderFilter");
  const suggestions = $("#dmFolderSuggestions");

  if (!select) return;

  const notes = await getAllNotes();
  const folders = getAllFolders(notes);

  select.innerHTML = `
    <option value="">All folders</option>
    ${folders.map((folder) =>
      `<option value="${escapeHTML(folder)}">${escapeHTML(folder)}</option>`
    ).join("")}
  `;

  select.value = folders.includes(currentFolder) ? currentFolder : "";
  if (!select.value && currentFilter === "folder") {
    currentFilter = "all";
    currentFolder = "";
  }

  if (suggestions) {
    suggestions.innerHTML = folders.map((folder) =>
      `<option value="${escapeHTML(folder)}"></option>`
    ).join("");
  }
}

async function createFolder() {
  const folder = window.prompt("Enter a folder name:");

  if (folder === null) return;

  const name = folder.trim();

  if (!name) {
    showToast("Folder name cannot be empty.");
    return;
  }

  if (name.length > 80) {
    showToast("Folder name is too long.");
    return;
  }

  const notes = await getAllNotes();
  const exists = getAllFolders(notes).some(
    (item) => item.toLocaleLowerCase() === name.toLocaleLowerCase()
  );

  if (exists) {
    showToast("That folder already exists.");
    return;
  }

  // Folder names are derived from notes, so save an empty note
  // in the requested folder to create the folder itself.
  const now = new Date().toISOString();

  await putNote({
    id: makeId(),
    title: name,
    content: "",
    folder: name,
    tags: [],
    favorite: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    isFolderPlaceholder: true
  });

  currentFilter = "folder";
  currentFolder = name;

  await refreshFolderOptions();
  await renderNotes();

  showToast("Folder created. Open the note to add content.");
}

/* -------------------- Render notes -------------------- */

async function renderNotes() {
  if (!db) return;

  try {
    const notes = await getAllNotes();

    const activeNotes = notes.filter((note) => !note.deletedAt);
    const dashboardNotes = activeNotes
      .filter((note) => !note.isFolderPlaceholder)
      .sort((a, b) =>
        (new Date(b.updatedAt).getTime() || 0) -
        (new Date(a.updatedAt).getTime() || 0)
      );

    if (elements.totalNotes) {
      elements.totalNotes.textContent = String(dashboardNotes.length);
    }

    const dashboardTerm = elements.search?.value.trim() || "";
    const dashboardResults = dashboardNotes
      .filter((note) => noteMatchesSearch(note, dashboardTerm))
      .slice(0, 6);

    if (elements.notesGrid) {
      elements.notesGrid.innerHTML = dashboardResults.length
        ? dashboardResults.map(noteCardHTML).join("")
        : emptyStateHTML(Boolean(dashboardTerm));
    }

    const notesTerm = elements.notesSearch?.value.trim() || "";
    const results = getVisibleNotes(notes, notesTerm)
      .filter((note) => !note.isFolderPlaceholder || note.deletedAt);

    if (elements.allNotesGrid) {
      elements.allNotesGrid.innerHTML = results.length
        ? results.map(noteCardHTML).join("")
        : emptyStateHTML(Boolean(notesTerm));
    }

    await refreshFolderOptions();
  } catch (error) {
    console.error("Could not load notes:", error);
    showToast("Could not load notes. Please reload the app.");
  }
}

/* -------------------- Views -------------------- */

function showView(view) {
  currentView = view;

  elements.dashboard?.classList.toggle("hidden", view !== "home");
  elements.notes?.classList.toggle("hidden", view !== "notes");
  elements.editor?.classList.toggle("hidden", view !== "editor");

  elements.placeholder?.classList.toggle(
    "hidden",
    !Object.prototype.hasOwnProperty.call(placeholderPages, view)
  );

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const titles = {
    home: "Dashboard",
    notes: currentFilter === "trash"
      ? "Trash"
      : currentFilter === "favorites"
        ? "Favorites"
        : "My Notes",
    editor: "Note Editor"
  };

  if (elements.breadcrumb) {
    elements.breadcrumb.textContent =
      titles[view] || placeholderPages[view]?.title || "Dashboard";
  }

  elements.sidebar?.classList.remove("open");

  if (view === "notes" || view === "home") {
    renderNotes();
  }

  if (placeholderPages[view]) {
    const page = placeholderPages[view];

    $("#placeholderTitle").textContent = page.title;
    $("#placeholderIcon").textContent = page.icon;
    $("#placeholderDescription").textContent = page.description;
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* -------------------- Create and open notes -------------------- */

async function createNewNote() {
  currentNoteId = null;

  elements.title.value = "";
  elements.content.value = "";
  elements.editorDate.textContent = "New note";

  if ($("#dmNoteFolder")) $("#dmNoteFolder").value = currentFolder || "";
  if ($("#dmNoteTags")) $("#dmNoteTags").value = "";

  updateFavoriteButton(false);
  setSaveStatus("Not saved yet");

  showView("editor");
  elements.title.focus();
}

async function openNote(id) {
  try {
    const note = await getNote(id);

    if (!note) {
      showToast("This note could not be found.");
      await renderNotes();
      return;
    }

    if (note.deletedAt) {
      showToast("Restore this note before editing it.");
      return;
    }

    currentNoteId = note.id;
    elements.title.value = note.title || "";
    elements.content.value = note.content || "";
    elements.editorDate.textContent =
      "Last edited " + formatDate(note.updatedAt);

    if ($("#dmNoteFolder")) $("#dmNoteFolder").value = note.folder || "";
    if ($("#dmNoteTags")) $("#dmNoteTags").value = (note.tags || []).join(", ");

    updateFavoriteButton(note.favorite);
    setSaveStatus("Saved on this device", true);

    showView("editor");
  } catch (error) {
    console.error(error);
    showToast("Could not open this note.");
  }
}

/* -------------------- Save and autosave -------------------- */

function scheduleAutosave() {
  setSaveStatus("Unsaved changes");

  clearTimeout(autosaveTimer);

  autosaveTimer = setTimeout(() => {
    saveCurrentNote(false);
  }, 700);
}

async function saveCurrentNote(showMessage = true) {
  if (isSaving) {
    saveQueue = saveQueue.then(() => saveCurrentNote(showMessage));
    return saveQueue;
  }

  const title = elements.title.value.trim();
  const content = elements.content.value;

  const folder = ($("#dmNoteFolder")?.value || "").trim().slice(0, 80);
  const tags = parseTags($("#dmNoteTags")?.value || "");

  if (!title && !content.trim()) {
    if (currentNoteId) {
      const existing = await getNote(currentNoteId);

      if (existing) {
        existing.folder = folder;
        existing.tags = tags;
        await putNote(existing);
      }
    }

    setSaveStatus("Nothing to save");
    return;
  }

  isSaving = true;
  setSaveStatus("Saving…");

  try {
    const original = currentNoteId
      ? await getNote(currentNoteId)
      : null;

    const now = new Date().toISOString();

    const note = normaliseNote({
      ...(original || {}),
      id: currentNoteId || makeId(),
      title: title || "Untitled note",
      content,
      folder,
      tags,
      favorite: original?.favorite === true,
      deletedAt: null,
      createdAt: original?.createdAt || now,
      updatedAt: now
    });

    await putNote(note);

    currentNoteId = note.id;
    elements.editorDate.textContent = "Last edited " + formatDate(now);
    updateFavoriteButton(note.favorite);
    setSaveStatus("Saved on this device", true);

    await renderNotes();

    if (showMessage) showToast("Note saved on this device.");
  } catch (error) {
    console.error("Save failed:", error);
    setSaveStatus("Save failed");
    showToast("Could not save. Check available device storage.");
  } finally {
    isSaving = false;
  }
}

/* -------------------- Trash and restore -------------------- */

async function deleteCurrentNote() {
  if (!currentNoteId) {
    showView("notes");
    return;
  }

  const confirmed = window.confirm(
    "Move this note to Trash? You can restore it later."
  );

  if (!confirmed) return;

  try {
    const note = await getNote(currentNoteId);

    if (!note) {
      showToast("This note could not be found.");
      return;
    }

    note.deletedAt = new Date().toISOString();
    note.updatedAt = new Date().toISOString();

    await putNote(note);

    currentNoteId = null;
    currentFilter = "all";

    await renderNotes();
    showView("notes");

    showToast("Note moved to Trash. You can restore it.");
  } catch (error) {
    console.error(error);
    showToast("Could not move this note to Trash.");
  }
}

async function restoreNote(id) {
  try {
    const note = await getNote(id);

    if (!note) {
      showToast("Note not found.");
      return;
    }

    note.deletedAt = null;
    note.updatedAt = new Date().toISOString();

    await putNote(note);
    await renderNotes();

    showToast("Note restored.");
  } catch (error) {
    console.error(error);
    showToast("Could not restore the note.");
  }
}

async function permanentlyDeleteNote(id) {
  const confirmed = window.confirm(
    "Permanently delete this note? This cannot be undone. Export a backup first if needed."
  );

  if (!confirmed) return;

  try {
    const note = await getNote(id);

    if (!note || !note.deletedAt) {
      showToast("Only notes in Trash can be permanently deleted here.");
      return;
    }

    await deleteNoteFromDatabase(id);
    await renderNotes();

    showToast("Note permanently deleted.");
  } catch (error) {
    console.error(error);
    showToast("Could not permanently delete the note.");
  }
}

async function emptyTrash() {
  const notes = await getAllNotes();
  const deleted = notes.filter((note) => note.deletedAt);

  if (!deleted.length) {
    showToast("Trash is already empty.");
    return;
  }

  const confirmed = window.confirm(
    `Permanently delete ${deleted.length} note(s) from Trash? This cannot be undone.`
  );

  if (!confirmed) return;

  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    deleted.forEach((note) => store.delete(note.id));

    transaction.oncomplete = async () => {
      await renderNotes();
      showToast("Trash emptied.");
    };

    transaction.onerror = () => {
      showToast("Could not empty Trash.");
    };
  } catch (error) {
    console.error(error);
    showToast("Could not empty Trash.");
  }
}

/* -------------------- Backup and restore -------------------- */

async function exportBackup() {
  try {
    const notes = await getAllNotes();

    const backup = {
      app: "Developer MASTERMIND",
      version: 1,
      exportedAt: new Date().toISOString(),
      notes
    };

    const blob = new Blob(
      [JSON.stringify(backup, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `developer-mastermind-backup-${new Date()
      .toISOString().slice(0, 10)}.json`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast("Backup exported. Keep the file somewhere safe.");
  } catch (error) {
    console.error(error);
    showToast("Could not export the backup.");
  }
}

async function importBackup(file) {
  try {
    if (file.size > 25 * 1024 * 1024) {
      showToast("Backup is too large (maximum 25 MB).");
      return;
    }

    const text = await file.text();
    const parsed = JSON.parse(text);

    const incoming = Array.isArray(parsed)
      ? parsed
      : parsed?.notes;

    if (!Array.isArray(incoming)) {
      throw new Error("Invalid backup format.");
    }

    if (incoming.length > 10000) {
      showToast("Backup contains too many notes.");
      return;
    }

    const validNotes = incoming.filter((note) =>
      note &&
      typeof note === "object" &&
      typeof note.id === "string" &&
      note.id.length > 0 &&
      typeof note.content === "string" &&
      (typeof note.title === "string" || note.title == null)
    );

    if (!validNotes.length && incoming.length) {
      showToast("No valid notes were found in this backup.");
      return;
    }

    const confirmed = window.confirm(
      `Import ${validNotes.length} note(s)? Existing notes with the same ID will be updated. Other notes will be kept.`
    );

    if (!confirmed) return;

    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    validNotes.forEach((rawNote) => {
      const note = normaliseNote(rawNote);
      store.put(note);
    });

    transaction.oncomplete = async () => {
      await renderNotes();
      showToast(`Backup restored: ${validNotes.length} note(s) imported.`);
    };

    transaction.onerror = () => {
      showToast("Could not restore the backup.");
    };
  } catch (error) {
    console.error("Backup import failed:", error);
    showToast("Invalid backup file. Choose a MASTERMIND JSON backup.");
  }
}

/* -------------------- Theme -------------------- */

function applyTheme(theme) {
  const prefersDark = window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const effectiveTheme = theme === "system"
    ? (prefersDark ? "dark" : "light")
    : theme;

  document.documentElement.dataset.theme = effectiveTheme;

  const button = $("#themeButton");

  if (button) {
    button.textContent = effectiveTheme === "dark" ? "☼" : "◐";
    button.title = "Current theme: " + theme + ". Click to change.";
    button.setAttribute(
      "aria-label",
      "Current theme: " + theme + ". Change theme."
    );
  }
}

function setTheme(theme) {
  if (!["light", "dark", "system"].includes(theme)) {
    theme = "system";
  }

  try {
    localStorage.setItem("dm_theme", theme);
  } catch (error) {
    console.warn("Theme preference could not be saved.", error);
  }

  applyTheme(theme);
}

function cycleTheme() {
  let current = "system";

  try {
    current = localStorage.getItem("dm_theme") || "system";
  } catch (error) {
    console.warn(error);
  }

  const next = {
    system: "light",
    light: "dark",
    dark: "system"
  }[current] || "system";

  setTheme(next);
  showToast("Theme: " + next);
}

function setupTheme() {
  let savedTheme = "system";

  try {
    savedTheme = localStorage.getItem("dm_theme") || "system";
  } catch (error) {
    console.warn(error);
  }

  applyTheme(savedTheme);

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener?.("change", () => {
        let theme = "system";

        try {
          theme = localStorage.getItem("dm_theme") || "system";
        } catch (error) {
          console.warn(error);
        }

        if (theme === "system") applyTheme("system");
      });
  }
}

/* -------------------- Event delegation -------------------- */

async function handleGridClick(event) {
  const actionButton = event.target.closest("[data-note-action]");

  if (actionButton) {
    event.stopPropagation();

    const id = actionButton.dataset.noteId;
    const action = actionButton.dataset.noteAction;

    if (action === "restore") await restoreNote(id);
    if (action === "purge") await permanentlyDeleteNote(id);

    return;
  }

  const createButton = event.target.closest('[data-action="new-note"]');

  if (createButton) {
    await createNewNote();
    return;
  }

  const card = event.target.closest("[data-note-id]");

  if (card) {
    await openNote(card.dataset.noteId);
  }
}

function setupNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
    });
  });

  $("#newNoteButton")?.addEventListener("click", createNewNote);
  $("#heroNoteButton")?.addEventListener("click", createNewNote);
  $("#notesNewButton")?.addEventListener("click", createNewNote);

  $("#viewAllNotes")?.addEventListener("click", () => showView("notes"));
  $("#backToNotes")?.addEventListener("click", () => showView("notes"));

  $("#saveNoteButton")?.addEventListener("click", () => {
    saveCurrentNote(true);
  });

  $("#deleteNoteButton")?.addEventListener("click", deleteCurrentNote);
  $("#themeButton")?.addEventListener("click", cycleTheme);

  $("#placeholderNotesButton")?.addEventListener("click", () => {
    showView("notes");
  });

  $("#menuButton")?.addEventListener("click", () => {
    elements.sidebar?.classList.toggle("open");
  });

  elements.search?.addEventListener("input", renderNotes);
  elements.notesSearch?.addEventListener("input", renderNotes);

  elements.notesGrid?.addEventListener("click", handleGridClick);
  elements.allNotesGrid?.addEventListener("click", handleGridClick);

  for (const grid of [elements.notesGrid, elements.allNotesGrid]) {
    grid?.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target.matches("[data-note-id]")
      ) {
        event.preventDefault();
        openNote(event.target.dataset.noteId);
      }
    });
  }

  elements.title?.addEventListener("input", scheduleAutosave);
  elements.content?.addEventListener("input", scheduleAutosave);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;

    const button = $("#installButton");
    if (button) button.title = "Install app";
  });

  $("#installButton")?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast(
        "Use your browser menu and choose Install app or Add to Home screen."
      );
      return;
    }

    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch (error) {
      console.warn("Install prompt was not completed.", error);
    }

    deferredInstallPrompt = null;
  });
}

/* -------------------- Service worker and connection -------------------- */

async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    if ($("#offlineStatus")) {
      $("#offlineStatus").textContent = "Limited";
    }
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");

    if ($("#offlineStatus")) {
      $("#offlineStatus").textContent = navigator.onLine
        ? "Ready"
        : "Offline";
    }
  } catch (error) {
    console.error("Service worker registration failed:", error);

    if ($("#offlineStatus")) {
      $("#offlineStatus").textContent = "Limited";
    }
  }
}

function updateConnectionStatus() {
  const online = navigator.onLine;

  if ($("#connectionText")) {
    $("#connectionText").textContent = online
      ? "Local workspace"
      : "Offline mode";
  }

  if ($("#offlineStatus")) {
    $("#offlineStatus").textContent = online ? "Ready" : "Offline";
  }
}

/* -------------------- Start app -------------------- */

async function init() {
  setupTheme();
  setupDynamicInterface();
  setupNavigation();
  updateConnectionStatus();

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  try {
    await openDatabase();

    await renderNotes();
    await setupServiceWorker();
  } catch (error) {
    console.error("App startup failed:", error);

    showToast(
      "Local database could not start. Check browser support and reload."
    );

    if ($("#offlineStatus")) {
      $("#offlineStatus").textContent = "Check browser";
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
