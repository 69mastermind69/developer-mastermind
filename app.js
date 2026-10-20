
/* =========================================
   DEVELOPER MASTERMIND
   File: app.js
   Notes + Planner + Focus + Library + Flashcards
========================================= */

"use strict";

/* ---------- Configuration ---------- */

const DB_NAME = "developer_mastermind_db";
const DB_VERSION = 2;
const NOTES_STORE = "notes";

const FILE_DB_NAME = "dm_library_files_v1";
const FILE_DB_VERSION = 1;
const FILE_STORE = "files";

const STORAGE_KEYS = {
  planner: "dm_planner_tasks_v1",
  focus: "dm_focus_history_v1",
  flashcards: "dm_flashcards_v1",
  theme: "dm_theme"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let notesDB;
let filesDB;

let currentNoteId = null;
let showingTrash = false;
let showingFavorites = false;

let focusModeMinutes = 25;
let focusRemainingSeconds = 25 * 60;
let focusEndTime = null;
let focusInterval = null;
let focusRunning = false;
let focusSessionStartedAt = null;
let focusWasPaused = false;

/* ---------- Helpers ---------- */

function makeId() {
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function readJSON(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    console.error(`Could not read ${key}:`, error);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Could not save ${key}:`, error);
    showToast("Storage is full or unavailable. Export your data and free up space.", "error");
    return false;
  }
}

function showToast(message, type = "success") {
  const container = $("#toastContainer");

  if (!container) {
    console.log(message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => toast.remove(), 4000);
}

function formatDate(value) {
  if (!value) return "No date";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "No date";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatDateTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString();
}

function safeFilename(value) {
  return String(value || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 120);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = safeFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

/* ---------- IndexedDB: Notes ---------- */

function openNotesDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported by this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      // Create the Notes store only if it does not exist.
      // Existing Notes data and the version 2 schema are preserved.
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      notesDB = request.result;

      notesDB.onversionchange = () => {
        notesDB.close();
        showToast("Database updated in another tab. Reload this page.", "error");
      };

      resolve(notesDB);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      console.warn("Notes database opening is blocked by another tab.");
    };
  });
}

function notesTransaction(mode, callback) {
  return new Promise((resolve, reject) => {
    if (!notesDB) {
      reject(new Error("Notes database is not ready."));
      return;
    }

    let result;

    let transaction;

    try {
      transaction = notesDB.transaction(NOTES_STORE, mode);
      const store = transaction.objectStore(NOTES_STORE);

      callback(store, value => {
        result = value;
      });
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(
      transaction.error || new Error("Notes transaction was aborted.")
    );
  });
}

function getAllNotes() {
  return notesTransaction("readonly", (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result || []);
  });
}

function getNote(id) {
  return notesTransaction("readonly", (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => setResult(request.result || null);
  });
}

function saveNoteRecord(note) {
  return notesTransaction("readwrite", store => {
    store.put(note);
  });
}

function deleteNoteRecord(id) {
  return notesTransaction("readwrite", store => {
    store.delete(id);
  });
}

/* ---------- IndexedDB: Library files ---------- */

function openFilesDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_DB_NAME, FILE_DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      filesDB = request.result;
      resolve(filesDB);
    };

    request.onerror = () => reject(request.error);
  });
}

function filesTransaction(mode, callback) {
  return new Promise((resolve, reject) => {
    if (!filesDB) {
      reject(new Error("Library database is not ready."));
      return;
    }

    let result;
    let transaction;

    try {
      transaction = filesDB.transaction(FILE_STORE, mode);
      callback(transaction.objectStore(FILE_STORE), value => {
        result = value;
      });
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(
      transaction.error || new Error("File transaction was aborted.")
    );
  });
}

function getAllLibraryFiles() {
  return filesTransaction("readonly", (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result || []);
  });
}

function saveLibraryFile(fileRecord) {
  return filesTransaction("readwrite", store => {
    store.put(fileRecord);
  });
}

function deleteLibraryFile(id) {
  return filesTransaction("readwrite", store => {
    store.delete(id);
  });
}

/* ---------- Theme ---------- */

function setupTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const theme = savedTheme === "light" ? "light" : "dark";

  document.documentElement.dataset.theme = theme;

  const button = $("#themeToggle");

  if (button) {
    button.addEventListener("click", () => {
      const nextTheme =
        document.documentElement.dataset.theme === "light" ? "dark" : "light";

      document.documentElement.dataset.theme = nextTheme;
      localStorage.setItem(STORAGE_KEYS.theme, nextTheme);

      showToast(`${nextTheme === "light" ? "Light" : "Dark"} theme enabled.`);
    });
  }
}

/* ---------- Navigation ---------- */

const VIEW_TITLES = {
  home: "Dashboard",
  notes: "My Notes",
  planner: "Study Planner",
  focus: "Focus Timer",
  library: "Photo & PDF Library",
  flashcards: "Flashcards & Revision"
};

function showView(viewName) {
  const viewIds = {
    home: "homeView",
    notes: "notesView",
    editor: "editorView",
    planner: "plannerView",
    focus: "focusView",
    library: "libraryView",
    flashcards: "flashcardsView",
    placeholder: "placeholderView"
  };

  const targetId = viewIds[viewName];

  if (!targetId || !document.getElementById(targetId)) {
    showToast("This section is not available.", "error");
    return;
  }

  Object.values(viewIds).forEach(id => {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  });

  document.getElementById(targetId).hidden = false;

  $$(".nav-item[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });

  const breadcrumb = $("#breadcrumb");

  if (breadcrumb) {
    breadcrumb.textContent =
      viewName === "editor"
        ? (currentNoteId ? "Edit Note" : "Create Note")
        : (VIEW_TITLES[viewName] || "Developer Mastermind");
  }

  $("#sidebar")?.classList.remove("open");

  if (viewName === "notes") renderNotes();
  if (viewName === "planner") renderPlanner();
  if (viewName === "focus") renderFocusHistory();
  if (viewName === "library") renderLibrary();
  if (viewName === "flashcards") renderFlashcards();
}

function setupNavigation() {
  $$("[data-view]").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  $("#menuToggle")?.addEventListener("click", () => {
    $("#sidebar")?.classList.toggle("open");
  });

  document.addEventListener("click", event => {
    const sidebar = $("#sidebar");
    const menuButton = $("#menuToggle");

    if (
      window.innerWidth <= 760 &&
      sidebar?.classList.contains("open") &&
      !sidebar.contains(event.target) &&
      !menuButton?.contains(event.target)
    ) {
      sidebar.classList.remove("open");
    }
  });

  $("#newNoteButton")?.addEventListener("click", () => openNoteEditor());
  $("#notesNewButton")?.addEventListener("click", () => openNoteEditor());

  $("#backToNotes")?.addEventListener("click", () => showView("notes"));
}

/* ---------- Notes ---------- */

function normalizeNote(note = {}) {
  const now = new Date().toISOString();

  return {
    id: note.id || makeId(),
    title: String(note.title || "Untitled Note"),
    content: String(note.content || ""),
    folder: String(note.folder || "General"),
    tags: Array.isArray(note.tags)
      ? note.tags.map(String)
      : String(note.tags || "")
          .split(",")
          .map(tag => tag.trim())
          .filter(Boolean),
    favorite: Boolean(note.favorite),
    deletedAt: note.deletedAt || null,
    createdAt: note.createdAt || now,
    updatedAt: note.updatedAt || now
  };
}

function openNoteEditor(note = null) {
  currentNoteId = note?.id || null;

  $("#editorHeading").textContent = note ? "Edit Note" : "Create Note";
  $("#noteTitle").value = note?.title || "";
  $("#noteContent").value = note?.content || "";
  $("#noteFolder").value = note?.folder || "General";
  $("#noteTags").value = Array.isArray(note?.tags)
    ? note.tags.join(", ")
    : (note?.tags || "");
  $("#noteFavorite").checked = Boolean(note?.favorite);

  const deleteButton = $("#deleteNoteButton");

  if (deleteButton) {
    deleteButton.hidden = !note;
    deleteButton.textContent = note?.deletedAt ? "Delete Permanently" : "Move to Trash";
  }

  showView("editor");
}

async function handleNoteSave(event) {
  event.preventDefault();

  const title = $("#noteTitle").value.trim();
  const content = $("#noteContent").value.trim();

  if (!title && !content) {
    showToast("Enter a title or some note content first.", "error");
    return;
  }

  try {
    const previous = currentNoteId ? await getNote(currentNoteId) : null;
    const now = new Date().toISOString();

    const note = normalizeNote({
      ...previous,
      id: currentNoteId || makeId(),
      title: title || "Untitled Note",
      content,
      folder: $("#noteFolder").value || "General",
      tags: $("#noteTags").value.split(",").map(tag => tag.trim()).filter(Boolean),
      favorite: $("#noteFavorite").checked,
      deletedAt: previous?.deletedAt || null,
      createdAt: previous?.createdAt || now,
      updatedAt: now
    });

    await saveNoteRecord(note);

    currentNoteId = note.id;
    showToast("Note saved successfully.");
    showView("notes");
  } catch (error) {
    console.error(error);
    showToast("Could not save the note.", "error");
  }
}

async function handleNoteDelete() {
  if (!currentNoteId) return;

  try {
    const note = await getNote(currentNoteId);
    if (!note) return;

    if (note.deletedAt) {
      if (!confirm("Permanently delete this note? This cannot be undone.")) return;

      await deleteNoteRecord(note.id);
      showToast("Note permanently deleted.");
    } else {
      note.deletedAt = new Date().toISOString();
      note.updatedAt = new Date().toISOString();

      await saveNoteRecord(note);
      showToast("Note moved to Trash.");
    }

    currentNoteId = null;
    showView("notes");
  } catch (error) {
    console.error(error);
    showToast("Could not delete this note.", "error");
  }
}

async function toggleFavorite(id) {
  try {
    const note = await getNote(id);
    if (!note) return;

    note.favorite = !note.favorite;
    note.updatedAt = new Date().toISOString();

    await saveNoteRecord(note);
    await renderNotes();
  } catch (error) {
    console.error(error);
    showToast("Could not update favorite.", "error");
  }
}

async function restoreNote(id) {
  try {
    const note = await getNote(id);
    if (!note) return;

    note.deletedAt = null;
    note.updatedAt = new Date().toISOString();

    await saveNoteRecord(note);
    showToast("Note restored.");
    await renderNotes();
  } catch (error) {
    console.error(error);
    showToast("Could not restore the note.", "error");
  }
}

async function renderNotes() {
  const grid = $("#notesGrid");
  if (!grid || !notesDB) return;

  try {
    const allNotes = await getAllNotes();
    const search = ($("#noteSearch")?.value || "").trim().toLowerCase();
    const folder = $("#folderFilter")?.value || "all";
    const sort = $("#noteSort")?.value || "updated";

    let filtered = allNotes.filter(note => {
      const inTrash = Boolean(note.deletedAt);

      if (showingTrash !== inTrash) return false;
      if (!showingTrash && showingFavorites && !note.favorite) return false;
      if (folder !== "all" && note.folder !== folder) return false;

      const text = [
        note.title,
        note.content,
        note.folder,
        ...(Array.isArray(note.tags) ? note.tags : [])
      ].join(" ").toLowerCase();

      return !search || text.includes(search);
    });

    filtered.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "created") return new Date(b.createdAt) - new Date(a.createdAt);
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    grid.innerHTML = filtered.map(note => {
      const tags = (Array.isArray(note.tags) ? note.tags : [])
        .map(tag => `<span class="note-tag">${escapeHTML(tag)}</span>`)
        .join("");

      const actions = showingTrash
        ? `
          <button type="button" data-action="restore" data-id="${escapeHTML(note.id)}">Restore</button>
          <button type="button" data-action="purge" data-id="${escapeHTML(note.id)}">Delete permanently</button>
        `
        : `
          <button type="button" data-action="edit" data-id="${escapeHTML(note.id)}">Edit</button>
          <button type="button" data-action="favorite" data-id="${escapeHTML(note.id)}">${note.favorite ? "★ Favorite" : "☆ Favorite"}</button>
          <button type="button" data-action="trash" data-id="${escapeHTML(note.id)}">Trash</button>
        `;

      return `
        <article class="note-card">
          <h3>${escapeHTML(note.title)}</h3>
          <div class="note-card-content">${escapeHTML(note.content).replace(/\n/g, "<br>")}</div>
          <div class="note-meta">
            <span>${escapeHTML(note.folder)}</span>
            <span>${escapeHTML(formatDate(note.updatedAt))}</span>
            ${tags}
          </div>
          <div class="note-card-actions">${actions}</div>
        </article>
      `;
    }).join("");

    $("#notesEmpty").hidden = filtered.length > 0;

    const favoritesButton = $("#favoritesFilter");
    const trashButton = $("#trashFilter");

    if (favoritesButton) {
      favoritesButton.textContent = showingFavorites ? "Show All Notes" : "☆ Favorites";
      favoritesButton.classList.toggle("active", showingFavorites);
    }

    if (trashButton) {
      trashButton.textContent = showingTrash ? "← Back to Notes" : "Trash";
      trashButton.classList.toggle("active", showingTrash);
    }
  } catch (error) {
    console.error(error);
    showToast("Could not load notes.", "error");
  }
}

function setupNotes() {
  $("#noteForm")?.addEventListener("submit", handleNoteSave);
  $("#deleteNoteButton")?.addEventListener("click", handleNoteDelete);

  ["noteSearch", "folderFilter", "noteSort"].forEach(id => {
    $(`#${id}`)?.addEventListener("input", renderNotes);
    $(`#${id}`)?.addEventListener("change", renderNotes);
  });

  $("#favoritesFilter")?.addEventListener("click", () => {
    showingFavorites = !showingFavorites;
    showingTrash = false;
    renderNotes();
  });

  $("#trashFilter")?.addEventListener("click", () => {
    showingTrash = !showingTrash;
    showingFavorites = false;
    renderNotes();
  });

  $("#notesGrid")?.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const { action, id } = button.dataset;

    try {
      if (action === "edit") {
        const note = await getNote(id);
        if (note) openNoteEditor(note);
      }

      if (action === "favorite") await toggleFavorite(id);
      if (action === "restore") await restoreNote(id);

      if (action === "trash") {
        const note = await getNote(id);
        if (!note) return;

        note.deletedAt = new Date().toISOString();
        note.updatedAt = new Date().toISOString();

        await saveNoteRecord(note);
        showToast("Note moved to Trash.");
        await renderNotes();
      }

      if (action === "purge") {
        if (!confirm("Permanently delete this note?")) return;

        await deleteNoteRecord(id);
        showToast("Note permanently deleted.");
        await renderNotes();
      }
    } catch (error) {
      console.error(error);
      showToast("Could not complete that action.", "error");
    }
  });
}

/* ---------- Study Planner ---------- */

function getPlannerTasks() {
  return readJSON(STORAGE_KEYS.planner, []);
}

function savePlannerTasks(tasks) {
  return writeJSON(STORAGE_KEYS.planner, tasks);
}

function renderPlanner() {
  const list = $("#plannerTaskList");
  if (!list) return;

  const tasks = getPlannerTasks();
  const filter = $("#plannerFilter")?.value || "all";

  const completed = tasks.filter(task => task.completed).length;

  $("#plannerTotal").textContent = String(tasks.length);
  $("#plannerCompleted").textContent = String(completed);
  $("#plannerPending").textContent = String(tasks.length - completed);

  const filtered = tasks
    .filter(task => {
      if (filter === "pending") return !task.completed;
      if (filter === "completed") 
