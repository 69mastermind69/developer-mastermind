
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
    description: "Plan study sessions, organise deadlines and manage reminders."
  },
  focus: {
    title: "Focus Timer",
    icon: "◉",
    description: "A Pomodoro timer and study history are planned for a future update."
  },
  library: {
    title: "Photo & PDF Library",
    icon: "▧",
    description: "Photo storage, PDF tools and OCR are planned for a future update."
  },
  flashcards: {
    title: "Flashcards & Revision",
    icon: "▱",
    description: "Create revision cards and track learning progress in a future update."
  }
};

/* -------------------- Utilities -------------------- */

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return Date.now().toString(36) + Math.random().toString(36).slice(2);
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

  if (Number.isNaN(date.getTime())) return "Recently";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function showToast(message) {
  if (!elements.toast) {
    console.log(message);
    return;
  }

  elements.toast.textContent = message;
  elements.toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 3000);
}

function setSaveStatus(message, saved = false) {
  if (!elements.saveStatus) return;

  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle("saved", saved);
}

function normaliseNote(note) {
  return {
    ...note,
    id: String(note.id),
    title: typeof note.title === "string" && note.title.trim()
      ? note.title
      : "Untitled note",
    content: typeof note.content === "string" ? note.content : "",
    folder: typeof note.folder === "string" ? note.folder : "",
    tags: Array.isArray(note.tags)
      ? [...new Set(note.tags.map(String).map((tag) => tag.trim()).filter(Boolean))]
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
      reject(new Error("IndexedDB is not supported in this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Preserve the existing notes store and all stored data.
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
      showToast("Close other app tabs, then reload this page.");
    };
  });
}

function getStore(mode = "readonly") {
  if (!db) throw new Error("The local database is not ready.");

  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAllNotes() {
  return new Promise((resolve, reject) => {
    let request;

    try {
      request = getStore("readonly").getAll();
    } catch (error) {
      reject(error);
      return;
    }

    request.onsuccess = () => {
      resolve((request.result || []).map(normaliseNote));
    };

    request.onerror = () => reject(request.error);
  });
}

function getNote(id) {
  return new Promise((resolve, reject) => {
    let request;

    try {
      request = getStore("readonly").get(String(id));
    } catch (error) {
      reject(error);
      return;
    }

    request.onsuccess = () => {
      resolve(request.result ? normaliseNote(request.result) : null);
    };

    request.onerror = () => reject(request.error);
  });
}

function putNote(note) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(normaliseNote(note));
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(note);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function deleteNoteFromDatabase(id) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(String(id));
    } catch (error) {
      reject(error);
      return;
    }

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
    if (currentFilter === "trash") return Boolean(note.deletedAt);

    if (note.deletedAt) return false;

    if (currentFilter === "favorites" && !note.favorite) return false;

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

  const actions = note.deletedAt
    ? `
      <div class="dm-card-actions">
        <button type="button" data-note-action="restore"
          data-note-id="${escapeHTML(note.id)}">Restore</button>
        <button type="button" data-note-action="purge"
          data-note-id="${escapeHTML(note.id)}">Delete forever</button>
      </div>`
    : "";

  return `
    <article class="note-card"
      style="--note-accent:${color}"
      data-note-id="${escapeHTML(note.id)}"
      tabindex="0" role="button"
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
        <span class="note-open">${note.deletedAt ? "Manage →" : "Open →"}</span>
      </div>

      ${actions}
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
      </div>`;
  }

  if (currentFilter === "favorites") {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">★</div>
        <h3>No favorite notes yet</h3>
        <p>Open a note and add it to favorites.</p>
      </div>`;
  }

  if (hasSearch) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">⌕</div>
        <h3>No matching notes</h3>
        <p>Try another keyword in বাংলা or English.</p>
      </div>`;
  }

  return `
    <div class="empty-state">
      <div class="empty-state-icon">✦</div>
      <h3>Your first idea starts here</h3>
      <p>Create a note to save what you learn. Notes stay on this device.</p>
      <button type="button" class="primary-button" data-action="new-note">
        ＋ Create a note
      </button>
    </div>`;
}

/* -------------------- Dynamic styles and interface -------------------- */

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
    .dm-editor-field input {
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
    .dm-favorite-toggle { min-height:38px; cursor:pointer; }
    .dm-tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
    .dm-tag {
      display:inline-block; border-radius:6px; padding:4px 7px;
      color:var(--primary); background:var(--primary-soft);
      font-size:10px; overflow-wrap:anywhere;
    }
    .dm-folder-label { margin-top:9px; color:var(--muted); font-size:10px; }
    .dm-card-actions {
      display:flex; flex-wrap:wrap; gap:7px;
      margin-top:12px; position:relative; z-index:2;
    }
    .dm-card-actions button {
      padding:7px 9px; border:1px solid var(--border);
      border-radius:8px; background:var(--surface);
      color:var(--text); cursor:pointer; font-size:11px;
    }
    .dm-help { color:var(--muted); font-size:11px; line-height:1.7; }
    @media(max-width:520px) {
      .dm-editor-fields { grid-template-columns:1fr; }
      .dm-toolbar button, .dm-toolbar select { flex:1 1 auto; }
    }
  `;

  document.head.appendChild(style);
}

function setFilter(filter, folder = "") {
  currentFilter = filter;
  currentFolder = folder;

  const toolbar = $("#dmToolbar");

  toolbar?.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });

  const folderSelect = $("#dmFolderFilter");
  if (folderSelect) folderSelect.value = folder;

  if (elements.breadcrumb && currentView === "notes") {
    elements.breadcrumb.textContent =
      filter === "trash" ? "Trash" :
      filter === "favorites" ? "Favorites" :
      filter === "folder" ? folder :
      "My Notes";
  }

  renderNotes();
}

function setupDynamicInterface() {
  if (editorControlsReady) return;

  addInterfaceStyles();

  const toolbarHost = $("#notesToolbarHost");

  if (toolbarHost && !$("#dmToolbar")) {
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
      <button type="button" id="dmEmptyTrash">Empty trash</button>
      <input type="file" id="dmBackupFile"
        accept=".json,application/json" hidden>
    `;

    toolbarHost.appendChild(toolbar);

    toolbar.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        setFilter(button.dataset.filter);
      });
    });

    $("#dmFolderFilter")?.addEventListener("change", (event) => {
      const folder = event.target.value;
      setFilter(folder ? "folder" : "all", folder);
    });

    $("#dmNewFolder")?.addEventListener("click", createFolder);
    $("#dmExport")?.addEventListener("click", exportBackup);
    $("#dmEmptyTrash")?.addEventListener("click", emptyTrash);

    $("#dmImport")?.addEventListener("click", () => {
      $("#dmBackupFile")?.click();
    });

    $("#dmBackupFile")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];

      if (file) await importBackup(file);

      // Allow choosing the same file again.
      event.target.value = "";
    });
  }

  const editorPanel = elements.editor?.querySelector(".editor-panel");

  if (editorPanel && !$("#dmEditorFields")) {
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

    $("#dmNoteFolder")?.addEventListener("input", scheduleAutosave);
    $("#dmNoteTags")?.addEventListener("input", scheduleAutosave);

    $("#dmFavoriteToggle")?.addEventListener("click", toggleCurrentFavorite);
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

  const notes = await getAllNotes();
  const folders = getAllFolders(notes);

  if (select) {
    select.innerHTML = `
      <option value="">All folders</option>
      ${folders.map((folder) =>
        `<option value="${escapeHTML(folder)}">${escapeHTML(folder)}</option>`
      ).join("")}`;

    select.value = folders.includes(currentFolder) ? currentFolder : "";

    if (!select.value && currentFilter === "folder") {
      currentFilter = "all";
      currentFolder = "";
    }
  }

  if (suggestions) {
    suggestions.innerHTML = folders.map((folder) =>
      `<option value="${escapeHTML(folder)}"></option>`
    ).join("");
  }
}

async function createFolder() {
  const answer = window.prompt("Enter a folder name:");
  if (answer === null) return;

  const name = answer.trim();

  if (!name) {
    showToast("Folder name cannot be empty.");
    return;
  }

  if (name.length > 80) {
    showToast("Folder name is too long.");
    return;
  }

  const notes = await getAllNotes();

  if (getAllFolders(notes).some(
    (folder) => folder.toLocaleLowerCase() === name.toLocaleLowerCase()
  )) {
    showToast("That folder already exists.");
    return;
  }

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

  setFilter("folder", name);
  await renderNotes();
  showToast("Folder created. Create a note and select this folder.");
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
      .filter((note) => !note.isFolderPlaceholder || Boolean(note.deletedAt));

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

  const title = view === "notes"
    ? currentFilter === "trash" ? "Trash"
      : currentFilter === "favorites" ? "Favorites"
      : currentFilter === "folder" ? currentFolder
      : "My Notes"
    : view === "home" ? "Dashboard"
    : view === "editor" ? "Note Editor"
    : placeholderPages[view]?.title || "Dashboard";

  if (elements.breadcrumb) elements.breadcrumb.textContent = title;

  elements.sidebar?.classList.remove("open");

  if (view === "notes" || view === "home") renderNotes();

  if (placeholderPages[view]) {
    const page = placeholderPages[view];

    const placeholderTitle = $("#placeholderTitle");
    const placeholderIcon = $("#placeholderIcon");
    const placeholderDescription = $("#placeholderDescription");

    if (placeholderTitle) placeholderTitle.textContent = page.title;
    if (placeholderIcon) placeholderIcon.textContent = page.icon;
    if (placeholderDescription) {
      placeholderDescription.textContent = page.description;
    }
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* -------------------- Create and open notes -------------------- */

async function createNewNote() {
  clearTimeout(autosaveTimer);

  currentNoteId = null;

  if (elements.title) elements.title.value = "";
  if (elements.content) elements.content.value = "";
  if (elements.editorDate) elements.editorDate.textContent = "New note";

  if ($("#dmNoteFolder")) $("#dmNoteFolder").value = currentFolder || "";
  if ($("#dmNoteTags")) $("#dmNoteTags").value = "";

  updateFavoriteButton(false);
  setSaveStatus("Not saved yet");

  showView("editor");
  elements.title?.focus();
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

    clearTimeout(autosaveTimer);
    currentNoteId = note.id;

    if (elements.title) elements.title.value = note.title || "";
    if (elements.content) elements.content.value = note.content || "";

    if (elements.editorDate) {
      elements.editorDate.textContent = "Last edited " + formatDate(note.updatedAt);
    }

    if ($("#dmNoteFolder")) $("#dmNoteFolder").value = note.folder || "";
    if ($("#dmNoteTags")) $("#dmNoteTags").value = (note.tags || []).join(", ");

    updateFavoriteButton(note.favorite);
    setSaveStatus("Saved on this device", true);
    showView("editor");
  } catch (error) {
    console.error("Could not open note:", error);
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

function saveCurrentNote(showMessage = true) {
  // Queue saves so two rapid clicks/autosaves do not overwrite each other.
  const operation = async () => {
    const title = elements.title?.value.trim() || "";
    const content = elements.content?.value || "";
    const folder = ($("#dmNoteFolder")?.value || "").trim().slice(0, 80);
    const tags = parseTags($("#dmNoteTags")?.value || "");

    if (!title && !content.trim()) {
      if (currentNoteId) {
        const existing = await getNote(currentNoteId);

        if (existing) {
          existing.folder = folder;
          existing.tags = tags;
          existing.updatedAt = new Date().toISOString();
          await putNote(existing);
          await renderNotes();
        }
      }

      setSaveStatus("Nothing to save");
      return;
    }

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

      if (elements.editorDate) {
        elements.editorDate.textContent = "Last edited " + formatDate(now);
      }

      updateFavoriteButton(note.favorite);
      setSaveStatus("Saved on this device", true);

      await renderNotes();

      if (showMessage) showToast("Note saved on this device.");
    } catch (error) {
      console.error("Save failed:", error);
      setSaveStatus("Save failed");
      showToast("Could not save. Check available device storage.");
    }
  };

  saveQueue = saveQueue.then(operation, operation);
  return saveQueue;
}

async function toggleCurrentFavorite() {
  try {
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

    showToast(note.favorite
      ? "Added to favorites."
      : "Removed from favorites.");
  } catch (error) {
    console.error("Could not update favorite:", error);
    showToast("Could not update favorite.");
  }
}

/* -------------------- Trash, restore and permanent delete -------------------- */

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

    clearTimeout(autosaveTimer);
    currentNoteId = null;

    setFilter("all");
    showView("notes");

    await renderNotes();
    showToast("Note moved to Trash. You can restore it.");
  } catch (error) {
    console.error("Could not move note to Trash:", error);
    showToast("Could not move this note to Trash.");
  }
}

async function restoreNote(id) {
  try {
    const note = await getNote(id);

    if (!note || !note.deletedAt) {
      showToast("This note is not in Trash.");
      await renderNotes();
      return;
    }

    note.deletedAt = null;
    note.updatedAt = new Date().toISOString();

    await putNote(note);
    await renderNotes();

    showToast("Note restored successfully.");
  } catch (error) {
    console.error("Restore failed:", error);
    showToast("Could not restore the note.");
  }
}

async function permanentlyDeleteNote(id) {
  const confirmed = window.confirm(
    "Permanently delete this note? This cannot be undone."
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
    console.error("Permanent delete failed:", error);
    showToast("Could not permanently delete the note.");
  }
}

async function emptyTrash() {
  try {
    const notes = await getAllNotes();
    const deleted = notes.filter((note) => Boolean(note.deletedAt));

    if (!deleted.length) {
      showToast("Trash is already empty.");
      return;
    }

    const confirmed = window.confirm(
      `Permanently delete ${deleted.length} note(s) from Trash? This cannot be undone.`
    );

    if (!confirmed) return;

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      deleted.forEach((note) => store.delete(note.id));

      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await renderNotes();
    showToast("Trash emptied.");
  } catch (error) {
    console.error("Empty Trash failed:", error);
    showToast("Could not empty Trash.");
  }
}

/* -------------------- Backup export and restore/import -------------------- */

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
      { type: "application/json;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
      `developer-mastermind-backup-${new Date().toISOString().slice(0, 10)}.json`;

    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);

    showToast("Backup export started. Check your Downloads folder.");
  } catch (error) {
    console.error("Backup export failed:", error);
    showToast("Could not export backup. Please try again.");
  }
}

async function importBackup(file) {
  if (!file) return;

  try {
    if (file.size > 25 * 1024 * 1024) {
      showToast("Backup is too large. Maximum size is 25 MB.");
      return;
    }

    const text = await file.text();
    const parsed = JSON.parse(text);

    const incoming = Array.isArray(parsed) ? parsed : parsed?.notes;

    if (!Array.isArray(incoming)) {
      throw new Error("The file does not contain a notes array.");
    }

    if (incoming.length > 10000) {
      showToast("Backup contains too many notes.");
      return;
    }

    const validNotes = incoming.filter((note) =>
      note &&
      typeof note === "object" &&
      !Array.isArray(note) &&
      (typeof note.id === "string" || typeof note.id === "number") &&
      String(note.id).length > 0 &&
      (typeof note.content === "string" || note.content == null) &&
      (typeof note.title === "string" || note.title == null)
    );

    if (validNotes.length === 0 && incoming.length > 0) {
      showToast("No valid notes were found in this backup.");
      return;
    }

    const confirmed = window.confirm(
      `Import ${validNotes.length} note(s)? Notes with matching IDs will be updated. Other existing notes will be kept.`
    );

    if (!confirmed) return;

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      validNotes.forEach((rawNote) => {
        const note = normaliseNote({
          ...rawNote,
          id: String(rawNote.id)
        });

        store.put(note);
      });

      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await renderNotes();
    showToast(`Backup restored: ${validNotes.length} note(s) imported.`);
  } catch (error) {
    console.error("Backup restore failed:", error);
    showToast("Could not restore backup. Choose a valid MASTERMIND JSON file.");
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
    button.setAttribute("aria-label", "Current theme: " + theme + ". Change theme.");
  }
}

function setTheme(theme) {
  if (!["light", "dark", "system"].includes(theme)) theme = "system";

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
    else if (action === "purge") await permanentlyDeleteNote(id);

    return;
  }

  const createButton = event.target.closest('[data-action="new-note"]');

  if (createButton) {
    await createNewNote();
    return;
  }

  const card = event.target.closest("[data-note-id]");

  if (card) await openNote(card.dataset.noteId);
}

function setupNavigation() {
  document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
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

  $("#placeholderNotesButton")?.addEventListener("click", () => showView("notes"));

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
  });

  $("#installButton")?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast("Use your browser menu and choose Install app or Add to Home screen.");
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
    if ($("#offlineStatus")) $("#offlineStatus").textContent = "Limited";
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");

    if ($("#offlineStatus")) {
      $("#offlineStatus").textContent = navigator.onLine ? "Ready" : "Offline";
    }
  } catch (error) {
    console.error("Service worker registration failed:", error);
    if ($("#offlineStatus")) $("#offlineStatus").textContent = "Limited";
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
    showToast("Local database could not start. Check browser support and reload.");

    if ($("#offlineStatus")) $("#offlineStatus").textContent = "Check browser";
  }
}

document.addEventListener("DOMContentLoaded", init);
