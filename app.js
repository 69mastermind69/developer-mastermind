"use strict";

/* =========================================================
   DEVELOPER MASTERMIND
   Notes, Planner, Focus Timer, Library, Flashcards, Backup
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const DB_NAME = "developer_mastermind_db";
const DB_VERSION = 2;
const NOTES_STORE = "notes";

const FILE_DB_NAME = "dm_library_files_v1";
const FILE_DB_VERSION = 1;
const FILES_STORE = "files";

const KEYS = {
  planner: "dm_planner_tasks_v1",
  focus: "dm_focus_history_v1",
  flashcards: "dm_flashcards_v1",
  theme: "dm_theme"
};

const state = {
  notesDB: null,
  filesDB: null,
  notes: [],
  planner: [],
  focusHistory: [],
  flashcards: [],
  currentNoteId: null,
  noteView: "all",
  currentView: "home",
  focusMinutes: 25,
  focusRemaining: 25 * 60,
  focusEndAt: null,
  focusInterval: null,
  focusRunning: false,
  focusStartedAt: null,
  focusTaskName: "",
  libraryURLs: new Map(),
  editingFlashcardId: null
};

const uid = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return "dm-" + Date.now().toString(36) +
    "-" + Math.random().toString(36).slice(2, 11);
};

function readJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.error("Could not read stored data:", key, error);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error("Could not save data:", key, error);
    showToast(
      "Storage is full or unavailable. Export a backup and try again.",
      "error"
    );
    return false;
  }
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

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleString();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(message, type = "") {
  const container = $("#toastContainer");
  if (!container) {
    console.log(message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => toast.remove(), 4000);
}

function confirmAction(message) {
  return window.confirm(message);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function saveJSONDownload(data, filename) {
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json"
    }),
    filename
  );
}

/* =========================================================
   THEME
   ========================================================= */

function setupTheme() {
  const saved = localStorage.getItem(KEYS.theme);
  applyTheme(saved === "light" ? "light" : "dark");

  $("#themeToggle")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    const next = current === "light" ? "dark" : "light";
    applyTheme(next);
    showToast(`${next === "light" ? "Light" : "Dark"} theme enabled.`);
  });
}

function applyTheme(theme) {
  const validTheme = theme === "light" ? "light" : "dark";

  document.documentElement.dataset.theme = validTheme;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = validTheme === "light" ? "#f3f6fc" : "#101827";
  }

  try {
    localStorage.setItem(KEYS.theme, validTheme);
  } catch (error) {
    console.warn("Theme preference could not be saved.", error);
  }
}

/* =========================================================
   NAVIGATION
   ========================================================= */

const VIEW_NAMES = {
  home: "Dashboard",
  notes: "My Notes",
  editor: "Note Editor",
  planner: "Study Planner",
  focus: "Focus Timer",
  library: "Photo & PDF",
  flashcards: "Flashcards",
  placeholder: "Coming Soon"
};

function navigate(view) {
  const target = $(`#${view}View`);
  if (!target) return;

  $$(".view").forEach(section => {
    section.hidden = section !== target;
  });

  state.currentView = view;

  $$("[data-view]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.view === view &&
      button.classList.contains("nav-item")
    );
  });

  const breadcrumb = $("#breadcrumb");
  if (breadcrumb) {
    breadcrumb.textContent = VIEW_NAMES[view] || "Dashboard";
  }

  $("#sidebar")?.classList.remove("open");

  if (view === "notes") renderNotes();
  if (view === "planner") renderPlanner();
  if (view === "focus") renderFocusHistory();
  if (view === "library") renderLibrary();
  if (view === "flashcards") renderFlashcards();
}

function setupNavigation() {
  $$("[data-view]").forEach(button => {
    button.addEventListener("click", () => navigate(button.dataset.view));
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

  $("#backToNotes")?.addEventListener("click", () => navigate("notes"));
}

/* =========================================================
   INDEXEDDB HELPERS
   ========================================================= */

function openDatabase(name, version, storeName) {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported by this browser."));
      return;
    }

    let request;

    try {
      request = indexedDB.open(name, version);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        reject(new Error(`The "${storeName}" store is missing.`));
        return;
      }

      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(
      request.error || new Error("Could not open database.")
    );

    request.onblocked = () => {
      showToast("Close other tabs of this app and try again.", "error");
    };
  });
}

function storeRequest(db, storeName, mode, action) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      action(store, resolve, reject);
      transaction.onerror = () => reject(
        transaction.error || new Error("Database transaction failed.")
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Database transaction aborted.")
      );
    } catch (error) {
      reject(error);
    }
  });
}

function dbGetAll(db, storeName) {
  return storeRequest(db, storeName, "readonly", (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(db, storeName, record) {
  return storeRequest(db, storeName, "readwrite", (store, resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbDelete(db, storeName, id) {
  return storeRequest(db, storeName, "readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function dbGet(db, storeName, id) {
  return storeRequest(db, storeName, "readonly", (store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* =========================================================
   NOTES
   ========================================================= */

function normalizeNote(note) {
  const now = new Date().toISOString();

  return {
    ...note,
    id: note.id || uid(),
    title: String(note.title || "Untitled Note"),
    content: String(note.content || ""),
    folder: String(note.folder || "General"),
    tags: Array.isArray(note.tags) ? note.tags : [],
    favorite: Boolean(note.favorite),
    createdAt: note.createdAt || now,
    updatedAt: note.updatedAt || now,
    deletedAt: note.deletedAt || null
  };
}

async function loadNotes() {
  if (!state.notesDB) return;

  try {
    state.notes = (await dbGetAll(state.notesDB, NOTES_STORE))
      .map(normalizeNote);
    renderNotes();
  } catch (error) {
    console.error(error);
    showToast("Could not load notes. Exported backups may help.", "error");
  }
}

async function saveNoteRecord(note) {
  const normalized = normalizeNote(note);
  await dbPut(state.notesDB, NOTES_STORE, normalized);

  const index = state.notes.findIndex(item => item.id === normalized.id);
  if (index >= 0) {
    state.notes[index] = normalized;
  } else {
    state.notes.push(normalized);
  }

  return normalized;
}

function getVisibleNotes() {
  const search = ($("#noteSearch")?.value || "").trim().toLowerCase();
  const folder = $("#folderFilter")?.value || "all";
  const sort = $("#noteSort")?.value || "updated";

  let notes = state.notes.filter(note => {
    if (state.noteView === "trash") {
      if (!note.deletedAt) return false;
    } else {
      if (note.deletedAt) return false;
      if (state.noteView === "favorites" && !note.favorite) return false;
    }

    if (folder !== "all" && note.folder !== folder) return false;

    const text = [
      note.title,
      note.content,
      note.folder,
      ...(note.tags || [])
    ].join(" ").toLowerCase();

    return !search || text.includes(search);
  });

  notes.sort((a, b) => {
    if (sort === "title") {
      return a.title.localeCompare(b.title);
    }

    const field = sort === "created" ? "createdAt" : "updatedAt";
    return String(b[field] || "").localeCompare(String(a[field] || ""));
  });

  return notes;
}

function renderNotes() {
  const grid = $("#notesGrid");
  const empty = $("#notesEmpty");
  if (!grid || !empty) return;

  const notes = getVisibleNotes();

  grid.innerHTML = notes.map(note => {
    const tags = (note.tags || []).map(tag =>
      `<span class="tag">${escapeHTML(tag)}</span>`
    ).join("");

    const favoriteButton = note.favorite
      ? "★ Unfavorite"
      : "☆ Favorite";

    const actions = note.deletedAt
      ? `
        <button type="button" data-note-action="restore"
          data-id="${escapeHTML(note.id)}">Restore</button>
        <button type="button" data-note-action="delete"
          data-id="${escapeHTML(note.id)}">Delete forever</button>
      `
      : `
        <button type="button" data-note-action="edit"
          data-id="${escapeHTML(note.id)}">Edit</button>
        <button type="button" data-note-action="favorite"
          data-id="${escapeHTML(note.id)}">${favoriteButton}</button>
        <button type="button" data-note-action="trash"
          data-id="${escapeHTML(note.id)}">Trash</button>
      `;

    return `
      <article class="note-card">
        <h3>${escapeHTML(note.title)}</h3>
        <div class="note-card-content">${escapeHTML(note.content)}</div>
        <div class="note-meta">
          <span class="tag">${escapeHTML(note.folder)}</span>
          ${tags}
        </div>
        <p class="muted small-text">
          Updated: ${escapeHTML(formatDate(note.updatedAt))}
        </p>
        <div class="note-card-actions">${actions}</div>
      </article>
    `;
  }).join("");

  empty.hidden = notes.length > 0;

  if (notes.length === 0) {
    empty.textContent = state.noteView === "trash"
      ? "Trash is empty."
      : state.noteView === "favorites"
        ? "No favorite notes yet."
        : "No notes to display. Create your first note.";
  }

  $("#favoritesFilter")?.classList.toggle(
    "active",
    state.noteView === "favorites"
  );

  $("#trashFilter")?.classList.toggle(
    "active",
    state.noteView === "trash"
  );
}

function openNoteEditor(noteId = null) {
  const note = noteId
    ? state.notes.find(item => item.id === noteId)
    : null;

  state.currentNoteId = note?.id || null;

  $("#editorHeading").textContent = note ? "Edit Note" : "Create Note";
  $("#noteTitle").value = note?.title || "";
  $("#noteContent").value = note?.content || "";
  $("#noteFolder").value = note?.folder || "General";
  $("#noteTags").value = (note?.tags || []).join(", ");
  $("#noteFavorite").checked = Boolean(note?.favorite);

  const deleteButton = $("#deleteNoteButton");
  if (deleteButton) {
    deleteButton.hidden = !note;
    deleteButton.textContent = note?.deletedAt
      ? "Restore Note"
      : "Move to Trash";
  }

  navigate("editor");
  $("#noteTitle")?.focus();
}

function setupNotes() {
  $("#noteForm")?.addEventListener("submit", async event => {
    event.preventDefault();

    if (!state.notesDB) {
      showToast("Notes database is unavailable.", "error");
      return;
    }

    const title = $("#noteTitle").value.trim() || "Untitled Note";
    const existing = state.notes.find(
      note => note.id === state.currentNoteId
    );

    const now = new Date().toISOString();

    const note = {
      ...(existing || {}),
      id: existing?.id || uid(),
      title,
      content: $("#noteContent").value,
      folder: $("#noteFolder").value || "General",
      tags: $("#noteTags").value.split(",")
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 30),
      favorite: $("#noteFavorite").checked,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deletedAt: existing?.deletedAt || null
    };

    try {
      await saveNoteRecord(note);
      showToast("Note saved.", "success");
      navigate("notes");
      renderNotes();
    } catch (error) {
      console.error(error);
      showToast("Could not save note.", "error");
    }
  });

  $("#notesGrid")?.addEventListener("click", async event => {
    const button = event.target.closest("[data-note-action]");
    if (!button) return;

    const { noteAction, id } = button.dataset;
    const note = state.notes.find(item => item.id === id);
    if (!note) return;

    try {
      if (noteAction === "edit") {
        openNoteEditor(id);
        return;
      }

      if (noteAction === "favorite") {
        await saveNoteRecord({
          ...note,
          favorite: !note.favorite,
          updatedAt: new Date().toISOString()
        });
        renderNotes();
        return;
      }

      if (noteAction === "trash") {
        if (!confirmAction("Move this note to Trash?")) return;
        await saveNoteRecord({
          ...note,
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        showToast("Note moved to Trash.");
        renderNotes();
        return;
      }

      if (noteAction === "restore") {
        await saveNoteRecord({
          ...note,
          deletedAt: null,
          updatedAt: new Date().toISOString()
        });
        showToast("Note restored.", "success");
        renderNotes();
        return;
      }

      if (noteAction === "delete") {
        if (!confirmAction("Permanently delete this note? This cannot be undone.")) {
          return;
        }
        await dbDelete(state.notesDB, NOTES_STORE, id);
        state.notes = state.notes.filter(item => item.id !== id);
        showToast("Note permanently deleted.");
        renderNotes();
      }
    } catch (error) {
      console.error(error);
      showToast("Could not update the note.", "error");
    }
  });

  $("#deleteNoteButton")?.addEventListener("click", async () => {
    const note = state.notes.find(item => item.id === state.currentNoteId);
    if (!note) return;

    try {
      if (note.deletedAt) {
        await saveNoteRecord({
          ...note,
          deletedAt: null,
          updatedAt: new Date().toISOString()
        });
        showToast("Note restored.", "success");
      } else {
        if (!confirmAction("Move this note to Trash?")) return;
        await saveNoteRecord({
          ...note,
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        showToast("Note moved to Trash.");
      }

      navigate("notes");
      renderNotes();
    } catch (error) {
      console.error(error);
      showToast("Could not update the note.", "error");
    }
  });

  $("#noteSearch")?.addEventListener("input", renderNotes);
  $("#folderFilter")?.addEventListener("change", renderNotes);
  $("#noteSort")?.addEventListener("change", renderNotes);

  $("#favoritesFilter")?.addEventListener("click", () => {
    state.noteView = state.noteView === "favorites" ? "all" : "favorites";
    renderNotes();
  });

  $("#trashFilter")?.addEventListener("click", () => {
    state.noteView = state.noteView === "trash" ? "all" : "trash";
    renderNotes();
  });
}

/* =========================================================
   STUDY PLANNER
   ========================================================= */

function savePlanner() {
  return writeJSON(KEYS.planner, state.planner);
}

function renderPlanner() {
  const total = state.planner.length;
  const completed = state.planner.filter(task => task.completed).length;
  const pending = total - completed;

  if ($("#plannerTotal")) $("#plannerTotal").textContent = total;
  if ($("#plannerCompleted")) $("#plannerCompleted").textContent = completed;
  if ($("#plannerPending")) $("#plannerPending").textContent = pending;

  const list = $("#plannerTaskList");
  if (!list) return;

  const filter = $("#plannerFilter")?.value || "all";

  const tasks = state.planner
    .filter(task => {
      if (filter === "pending") return !task.completed;
      if (filter === "completed") return task.completed;
      return true;
    })
    .sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  if (!tasks.length) {
    list.innerHTML = '<p class="empty-state">No tasks here yet.</p>';
    return;
  }

  list.innerHTML = tasks.map(task => `
    <article class="task-item ${task.completed ? "completed" : ""}">
      <input type="checkbox" data-task-toggle="${escapeHTML(task.id)}"
        aria-label="Mark task complete"
        ${task.completed ? "checked" : ""}>
      <div class="task-main">
        <strong>${escapeHTML(task.title)}</strong>
        <div class="task-details">
          <span>Due: ${escapeHTML(task.dueDate || "No due date")}</span>
          <span class="priority ${escapeHTML(task.priority || "medium")}">
            ${escapeHTML((task.priority || "medium").toUpperCase())}
          </span>
          ${task.reminder ? "<span>Reminder requested</span>" : ""}
        </div>
      </div>
      <div class="task-actions">
        <button type="button" data-task-delete="${escapeHTML(task.id)}"
          aria-label="Delete task">✕</button>
      </div>
    </article>
  `).join("");
}

function setupPlanner() {
  state.planner = readJSON(KEYS.planner, []);
  if (!Array.isArray(state.planner)) state.planner = [];

  state.planner = state.planner.map(task => ({
    ...task,
    id: task.id || uid(),
    title: String(task.title || "Untitled task"),
    completed: Boolean(task.completed),
    priority: ["low", "medium", "high"].includes(task.priority)
      ? task.priority : "medium",
    reminder: Boolean(task.reminder)
  }));

  $("#plannerForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const title = $("#plannerTask").value.trim();
    if (!title) {
      showToast("Enter a task name.", "error");
      return;
    }

    state.planner.push({
      id: uid(),
      title,
      dueDate: $("#plannerDate").value || "",
      priority: $("#plannerPriority").value || "medium",
      reminder: $("#plannerReminder").checked,
      completed: false,
      createdAt: new Date().toISOString()
    });

    if (!savePlanner()) {
      state.planner.pop();
      return;
    }

    event.target.reset();
    $("#plannerPriority").value = "medium";
    renderPlanner();
    showToast("Study task added.", "success");
  });

  $("#plannerFilter")?.addEventListener("change", renderPlanner);

  $("#plannerTaskList")?.addEventListener("change", event => {
    const id = event.target.dataset.taskToggle;
    if (!id) return;

    const task = state.planner.find(item => item.id === id);
    if (!task) return;

    task.completed = event.target.checked;

    if (savePlanner()) {
      renderPlanner();
      showToast(task.completed ? "Task completed!" : "Task marked pending.");
    }
  });

  $("#plannerTaskList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-task-delete]");
    if (!button) return;

    if (!confirmAction("Delete this study task?")) return;

    const old = state.planner;
    state.planner = old.filter(task => task.id !== button.dataset.taskDelete);

    if (!savePlanner()) {
      state.planner = old;
      return;
    }

    renderPlanner();
    showToast("Task deleted.");
  });

  renderPlanner();
}

/* =========================================================
   FOCUS TIMER
   ========================================================= */

function updateFocusClock() {
  const remaining = Math.max(0, Math.ceil(state.focusRemaining));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  if ($("#focusClock")) {
    $("#focusClock").textContent =
      `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  document.title = state.focusRunning
    ? `${$("#focusClock")?.textContent || "00:00"} · Focus`
    : "DEVELOPER MASTERMIND";
}

function setFocusMode(minutes, button) {
  stopFocusInterval();

  state.focusMinutes = minutes;
  state.focusRemaining = minutes * 60;
  state.focusRunning = false;
  state.focusEndAt = null;
  state.focusStartedAt = null;

  $$(".focus-mode").forEach(item => item.classList.toggle("active", item === button));

  if ($("#focusStatus")) {
    $("#focusStatus").textContent = "Ready to focus?";
  }

  updateFocusClock();
}

function stopFocusInterval() {
  if (state.focusInterval !== null) {
    clearInterval(state.focusInterval);
    state.focusInterval = null;
  }
}

function startFocusInterval() {
  stopFocusInterval();

  state.focusRunning = true;
  state.focusEndAt = Date.now() + state.focusRemaining * 1000;

  if (!state.focusStartedAt) {
    state.focusStartedAt = new Date().toISOString();
    state.focusTaskName = $("#focusTask")?.value.trim() || "Focus session";
  }

  if ($("#focusStatus")) {
    $("#focusStatus").textContent = "Stay focused. You've got this!";
  }

  state.focusInterval = window.setInterval(tickFocusTimer, 250);
  tickFocusTimer();
}

function tickFocusTimer() {
  if (!state.focusRunning || !state.focusEndAt) return;

  state.focusRemaining = Math.max(0, (state.focusEndAt - Date.now()) / 1000);
  updateFocusClock();

  if (state.focusRemaining <= 0) {
    finishFocusSession();
  }
}

function pauseFocusTimer() {
  if (!state.focusRunning) return;

  state.focusRemaining = Math.max(
    0,
    (state.focusEndAt - Date.now()) / 1000
  );

  state.focusRunning = false;
  state.focusEndAt = null;
  stopFocusInterval();

  if ($("#focusStatus")) $("#focusStatus").textContent = "Timer paused.";
  updateFocusClock();
}

function resetFocusTimer() {
  pauseFocusTimer();

  state.focusRemaining = state.focusMinutes * 60;
  state.focusStartedAt = null;
  state.focusTaskName = "";

  if ($("#focusStatus")) $("#focusStatus").textContent = "Ready to focus?";
  updateFocusClock();
}

function saveFocusSession(completed) {
  const startedAt = state.focusStartedAt || new Date().toISOString();
  const elapsedSeconds = Math.max(
    0,
    Math.round(state.focusMinutes * 60 - state.focusRemaining)
  );

  if (elapsedSeconds < 1) return;

  state.focusHistory.unshift({
    id: uid(),
    task: state.focusTaskName || "Focus session",
    minutes: Math.round(elapsedSeconds / 60),
    plannedMinutes: state.focusMinutes,
    completed,
    startedAt,
    endedAt: new Date().toISOString()
  });

  state.focusHistory = state.focusHistory.slice(0, 300);

  writeJSON(KEYS.focus, state.focusHistory);
  renderFocusHistory();
}

function finishFocusSession() {
  stopFocusInterval();
  state.focusRunning = false;
  state.focusRemaining = 0;
  state.focusEndAt = null;

  saveFocusSession(true);

  state.focusStartedAt = null;
  state.focusTaskName = "";

  if ($("#focusStatus")) {
    $("#focusStatus").textContent = "Session complete! Take a moment to rest.";
  }

  updateFocusClock();
  showToast("Focus session completed!", "success");

  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Developer Mastermind", {
        body: "Your focus session is complete."
      });
    }
  } catch (error) {
    console.warn("Notification unavailable.", error);
  }
}

function renderFocusHistory() {
  const list = $("#focusHistory");
  if (!list) return;

  if (!state.focusHistory.length) {
    list.innerHTML = '<p class="empty-state">Your completed sessions will appear here.</p>';
    return;
  }

  list.innerHTML = state.focusHistory.slice(0, 30).map(item => `
    <article class="history-item">
      <div>
        <strong>${escapeHTML(item.task || "Focus session")}</strong>
        <p>${escapeHTML(formatDate(item.startedAt))}</p>
      </div>
      <div>
        <strong>${escapeHTML(String(item.minutes || 0))} min</strong>
        <p>${item.completed ? "Completed" : "Stopped early"}</p>
      </div>
    </article>
  `).join("");
}

function setupFocus() {
  state.focusHistory = readJSON(KEYS.focus, []);
  if (!Array.isArray(state.focusHistory)) state.focusHistory = [];

  state.focusHistory = state.focusHistory.map(item => ({
    ...item,
    id: item.id || uid(),
    minutes: Math.max(0, Number(item.minutes) || 0)
  }));

  $$(".focus-mode").forEach(button => {
    button.addEventListener("click", () => {
      setFocusMode(Number(button.dataset.focusMinutes) || 25, button);
    });
  });

  $("#focusStart")?.addEventListener("click", () => {
    if (state.focusRunning) return;
    if (state.focusRemaining <= 0) {
      state.focusRemaining = state.focusMinutes * 60;
    }
    startFocusInterval();
  });

  $("#focusPause")?.addEventListener("click", pauseFocusTimer);

  $("#focusReset")?.addEventListener("click", () => {
    if (state.focusRunning) saveFocusSession(false);
    resetFocusTimer();
  });

  renderFocusHistory();
  updateFocusClock();
}

/* =========================================================
   PHOTO AND PDF LIBRARY
   ========================================================= */

async function loadLibraryFiles() {
  if (!state.filesDB) return [];

  try {
    return await dbGetAll(state.filesDB, FILES_STORE);
  } catch (error) {
    console.error(error);
    showToast("Could not load library files.", "error");
    return [];
  }
}

function revokeLibraryURLs() {
  for (const url of state.libraryURLs.values()) {
    URL.revokeObjectURL(url);
  }
  state.libraryURLs.clear();
}

async function renderLibrary() {
  const container = $("#libraryFileList");
  if (!container) return;

  const files = await loadLibraryFiles();
  revokeLibraryURLs();

  if (!files.length) {
    container.innerHTML = '<p class="empty-state">No files yet. Add a photo or PDF above.</p>';
    return;
  }

  container.innerHTML = files
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map(file => {
      const isImage = String(file.type || "").startsWith("image/");
      const preview = isImage
        ? `<div class="library-preview" data-preview-id="${escapeHTML(file.id)}"></div>`
        : `<div class="library-preview"><div class="pdf-preview">PDF</div></div>`;

      return `
        <article class="library-card">
          ${preview}
          <div class="library-info">
            <strong>${escapeHTML(file.name || "Untitled file")}</strong>
            <p>${escapeHTML(formatBytes(file.size || file.blob?.size || 0))}</p>
            <div class="library-actions">
              <button type="button" data-file-open="${escapeHTML(file.id)}">Open</button>
              <button type="button" data-file-download="${escapeHTML(file.id)}">Download</button>
              <button type="button" data-file-delete="${escapeHTML(file.id)}">Delete</button>
            </div>
          </div>
        </article>
      `;
    }).join("");

  for (const file of files) {
    if (!String(file.type || "").startsWith("image/")) continue;
    if (!(file.blob instanceof Blob)) continue;

    const previewElement = container.querySelector(
      `[data-preview-id="${CSS.escape(file.id)}"]`
    );

    if (!previewElement) continue;

    const url = URL.createObjectURL(file.blob);
    state.libraryURLs.set(file.id, url);

    const image = document.createElement("img");
    image.src = url;
    image.alt = file.name || "Library image";
    previewElement.appendChild(image);
  }
}

async function addLibraryFiles(fileList) {
  if (!state.filesDB) {
    showToast("Library storage is unavailable.", "error");
    return;
  }

  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    const validType = file.type.startsWith("image/") ||
      file.type === "application/pdf";

    if (!validType) {
      showToast(`Skipped unsupported file: ${file.name}`, "error");
      continue;
    }

    const record = {
      id: uid(),
      name: file.name,
      type: file.type,
      size: file.size,
      createdAt: new Date().toISOString(),
      blob: file
    };

    try {
      await dbPut(state.filesDB, FILES_STORE, record);
    } catch (error) {
      console.error(error);
      showToast(
        `Could not save ${file.name}. Browser storage may be full.`,
        "error"
      );
      break;
    }
  }

  await renderLibrary();
  showToast("Library updated.", "success");
}

async function getLibraryFile(id) {
  if (!state.filesDB) return null;
  return dbGet(state.filesDB, FILES_STORE, id);
}

async function openOrDownloadLibraryFile(id, download = false) {
  try {
    const file = await getLibraryFile(id);

    if (!file || !(file.blob instanceof Blob)) {
      showToast("File not found.", "error");
      return;
    }

    const url = URL.createObjectURL(file.blob);
    const link = document.createElement("a");

    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    if (download) {
      link.download = file.name || "download";
    } else if (file.type.startsWith("image/")) {
      link.download = "";
    }

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    showToast("Could not open this file.", "error");
  }
}

async function deleteLibraryFile(id) {
  if (!confirmAction("Delete this file from your library?")) return;

  try {
    await dbDelete(state.filesDB, FILES_STORE, id);
    showToast("File deleted.");
    await renderLibrary();
  } catch (error) {
    console.error(error);
    showToast("Could not delete the file.", "error");
  }
}

async function printLibraryImages() {
  const files = await loadLibraryFiles();
  const images = files.filter(file =>
    String(file.type || "").startsWith("image/") &&
    file.blob instanceof Blob
  );

  if (!images.length) {
    showToast("Add images before printing.", "error");
    return;
  }

  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    showToast("Allow pop-ups to print images.", "error");
    return;
  }

  const imageURLs = images.map(file => ({
    name: file.name || "Study image",
    url: URL.createObjectURL(file.blob)
  }));

  const content = imageURLs.map(item => `
    <figure>
      <img src="${item.url}" alt="${escapeHTML(item.name)}">
      <figcaption>${escapeHTML(item.name)}</figcaption>
    </figure>
  `).join("");

  printWindow.document.open();
  printWindow.document.write(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Study Images</title>
      <style>
        body { font: 16px Arial, sans-serif; margin: 20px; }
        figure { margin: 0 0 24px; page-break-inside: avoid; }
        img { display: block; max-width: 100%; max-height: 90vh; margin: auto; }
        figcaption { text-align: center; margin-top: 8px; overflow-wrap: anywhere; }
        @media print { button { display: none; } }
      </style>
    </head>
    <body>
      <button onclick="window.print()">Print / Save as PDF</button>
      ${content}
    </body>
    </html>
  `);
  printWindow.document.close();

  printWindow.addEventListener("beforeunload", () => {
    imageURLs.forEach(item => URL.revokeObjectURL(item.url));
  }, { once: true });
}

function setupLibrary() {
  $("#libraryFiles")?.addEventListener("change", async event => {
    await addLibraryFiles(event.target.files);
    event.target.value = "";
  });

  $("#imagesToPdfButton")?.addEventListener("click", printLibraryImages);

  $("#libraryFileList")?.addEventListener("click", async event => {
    const openButton = event.target.closest("[data-file-open]");
    const downloadButton = event.target.closest("[data-file-download]");
    const deleteButton = event.target.closest("[data-file-delete]");

    if (openButton) {
      await openOrDownloadLibraryFile(openButton.dataset.fileOpen, false);
    } else if (downloadButton) {
      await openOrDownloadLibraryFile(downloadButton.dataset.fileDownload, true);
    } else if (deleteButton) {
      await deleteLibraryFile(deleteButton.dataset.fileDelete);
    }
  });
}

/* =========================================================
   FLASHCARDS
   ========================================================= */

function saveFlashcards() {
  return writeJSON(KEYS.flashcards, state.flashcards);
}

function renderFlashcards() {
  const list = $("#flashcardList");
  const count = $("#flashcardCount");
  if (!list) return;

  if (count) {
    count.textContent = `${state.flashcards.length} cards`;
  }

  if (!state.flashcards.length) {
    list.innerHTML = '<p class="empty-state">No flashcards yet. Create your first card above.</p>';
    return;
  }

  list.innerHTML = state.flashcards.map(card => `
    <article class="flashcard-item">
      <div class="flashcard-question">
        Q: ${escapeHTML(card.question)}
      </div>
      <div class="flashcard-answer" hidden>
        A: ${escapeHTML(card.answer)}
      </div>
      <div class="flashcard-actions">
        <button type="button" data-card-reveal="${escapeHTML(card.id)}">
          Reveal Answer
        </button>
        <button type="button" data-card-edit="${escapeHTML(card.id)}">
          Edit
        </button>
        <button type="button" data-card-delete="${escapeHTML(card.id)}">
          Delete
        </button>
      </div>
    </article>
  `).join("");
}

function resetFlashcardForm() {
  state.editingFlashcardId = null;
  $("#flashcardForm")?.reset();

  const submit = $("#flashcardForm button[type='submit']");
  if (submit) submit.textContent = "Add Flashcard";
}

function setupFlashcards() {
  state.flashcards = readJSON(KEYS.flashcards, []);
  if (!Array.isArray(state.flashcards)) state.flashcards = [];

  state.flashcards = state.flashcards.map(card => ({
    ...card,
    id: card.id || uid(),
    question: String(card.question || ""),
    answer: String(card.answer || "")
  }));

  $("#flashcardForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const question = $("#flashcardQuestion").value.trim();
    const answer = $("#flashcardAnswer").value.trim();

    if (!question || !answer) {
      showToast("Enter both a question and an answer.", "error");
      return;
    }

    if (state.editingFlashcardId) {
      const card = state.flashcards.find(
        item => item.id === state.editingFlashcardId
      );

      if (card) {
        card.question = question;
        card.answer = answer;
      }
    } else {
      state.flashcards.unshift({
        id: uid(),
        question,
        answer,
        createdAt: new Date().toISOString()
      });
    }

    if (saveFlashcards()) {
      resetFlashcardForm();
      renderFlashcards();
      showToast("Flashcard saved.", "success");
    }
  });

  $("#flashcardList")?.addEventListener("click", event => {
    const reveal = event.target.closest("[data-card-reveal]");
    const edit = event.target.closest("[data-card-edit]");
    const remove = event.target.closest("[data-card-delete]");

    if (reveal) {
      const card = state.flashcards.find(
        item => item.id === reveal.dataset.cardReveal
      );
      const item = reveal.closest(".flashcard-item");
      const answer = $(".flashcard-answer", item);

      if (card && answer) {
        answer.hidden = !answer.hidden;
        reveal.textContent = answer.hidden ? "Reveal Answer" : "Hide Answer";
      }
      return;
    }

    if (edit) {
      const card = state.flashcards.find(
        item => item.id === edit.dataset.cardEdit
      );
      if (!card) return;

      state.editingFlashcardId = card.id;
      $("#flashcardQuestion").value = card.question;
      $("#flashcardAnswer").value = card.answer;

      const submit = $("#flashcardForm button[type='submit']");
      if (submit) submit.textContent = "Update Flashcard";

      $("#flashcardQuestion")?.focus();
      return;
    }

    if (remove) {
      if (!confirmAction("Delete this flashcard?")) return;

      const old = state.flashcards;
      state.flashcards = old.filter(
        card => card.id !== remove.dataset.cardDelete
      );

      if (!saveFlashcards()) {
        state.flashcards = old;
        return;
      }

      if (state.editingFlashcardId === remove.dataset.cardDelete) {
        resetFlashcardForm();
      }

      renderFlashcards();
      showToast("Flashcard deleted.");
    }
  });

  renderFlashcards();
}

/* =========================================================
   BACKUP AND RESTORE
   ========================================================= */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: type || "application/octet-stream" });
}

async function createBackup() {
  const notes = state.notesDB
    ? await dbGetAll(state.notesDB, NOTES_STORE)
    : [];

  const libraryFiles = state.filesDB
    ? await dbGetAll(state.filesDB, FILES_STORE)
    : [];

  const serializableFiles = [];

  for (const file of libraryFiles) {
    serializableFiles.push({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      createdAt: file.createdAt,
      base64: file.blob instanceof Blob
        ? await blobToBase64(file.blob)
        : null
    });
  }

  return {
    app: "Developer Mastermind",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    notes,
    planner: state.planner,
    focusHistory: state.focusHistory,
    flashcards: state.flashcards,
    theme: document.documentElement.dataset.theme || "dark",
    libraryFiles: serializableFiles
  };
}

async function exportAppData() {
  try {
    showToast("Preparing your backup…");

    const backup = await createBackup();

    saveJSONDownload(
      backup,
      `developer-mastermind-backup-${new Date().toISOString().slice(0, 10)}.json`
    );

    showToast("Backup exported.", "success");
  } catch (error) {
    console.error(error);
    showToast("Could not export all data. Check browser storage.", "error");
  }
}

async function importBackup(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid backup file.");
  }

  if (!confirmAction(
    "Import this backup? Existing items with matching IDs will be updated. Other existing items will be kept."
  )) {
    return;
  }

  if (Array.isArray(data.notes) && state.notesDB) {
    for (const note of data.notes) {
      if (!note || typeof note !== "object") continue;
      await dbPut(state.notesDB, NOTES_STORE, normalizeNote(note));
    }
  }

  if (Array.isArray(data.libraryFiles) && state.filesDB) {
    for (const item of data.libraryFiles) {
      if (!item || typeof item !== "object" || !item.id) continue;
      if (!item.base64) continue;

      const blob = base64ToBlob(item.base64, item.type);
      await dbPut(state.filesDB, FILES_STORE, {
        id: item.id,
        name: item.name || "Imported file",
        type: item.type || blob.type,
        size: blob.size,
        createdAt: item.createdAt || new Date().toISOString(),
        blob
      });
    }
  }

  if (Array.isArray(data.planner)) {
    const existing = new Map(state.planner.map(item => [item.id, item]));

    data.planner.forEach(item => {
      if (!item || typeof item !== "object") return;
      const id = item.id || uid();
      existing.set(id, { ...item, id });
    });

    state.planner = Array.from(existing.values());
    savePlanner();
  }

  if (Array.isArray(data.focusHistory)) {
    const existing = new Map(
      state.focusHistory.map(item => [item.id, item])
    );

    data.focusHistory.forEach(item => {
      if (!item || typeof item !== "object") return;
      const id = item.id || uid();
      existing.set(id, { ...item, id });
    });

    state.focusHistory = Array.from(existing.values())
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, 300);

    writeJSON(KEYS.focus, state.focusHistory);
  }

  if (Array.isArray(data.flashcards)) {
    const existing = new Map(
      state.flashcards.map(item => [item.id, item])
    );

    data.flashcards.forEach(item => {
      if (!item || typeof item !== "object") return;
      const id = item.id || uid();
      existing.set(id, { ...item, id });
    });

    state.flashcards = Array.from(existing.values());
    saveFlashcards();
  }

  if (data.theme === "light" || data.theme === "dark") {
    applyTheme(data.theme);
  }

  await loadNotes();
  renderPlanner();
  renderFocusHistory();
  renderFlashcards();
  await renderLibrary();

  showToast("Backup import finished.", "success");
}

function setupBackupRestore() {
  $("#exportAppData")?.addEventListener("click", exportAppData);

  // Add the import control once, without changing index.html.
  const exportButton = $("#exportAppData");
  if (!exportButton || $("#importAppData")) return;

  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.id = "importAppData";
  importButton.className = "nav-item";
  importButton.innerHTML = "<span>⇧</span> Import Backup";
  exportButton.insertAdjacentElement("afterend", importButton);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "importBackupFile";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  importButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await importBackup(data);
    } catch (error) {
      console.error(error);
      showToast(
        "Import failed. Check that this is a valid backup file.",
        "error"
      );
    } finally {
      fileInput.value = "";
    }
  });
}

/* =========================================================
   CONNECTION STATUS AND SERVICE WORKER
   ========================================================= */

function updateConnectionStatus() {
  const status = $("#connectionStatus");
  if (!status) return;

  const online = navigator.onLine;

  status.textContent = online ? "● Online" : "● Offline";
  status.classList.toggle("online", online);
  status.classList.toggle("offline", !online);
}

function setupConnectionStatus() {
  updateConnectionStatus();
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
}

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // HTTPS or localhost is required by most browsers.
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then(registration => {
        console.info("Service worker registered:", registration.scope);
      })
      .catch(error => {
        console.warn("Service worker registration failed:", error);
      });
  }, { once: true });
}

/* =========================================================
   INITIALIZATION
   ========================================================= */

async function init() {
  setupTheme();
  setupNavigation();
  setupNotes();
  setupPlanner();
  setupFocus();
  setupFlashcards();
  setupBackupRestore();
  setupConnectionStatus();

  try {
    state.notesDB = await openDatabase(
      DB_NAME,
      DB_VERSION,
      NOTES_STORE
    );
    await loadNotes();
  } catch (error) {
    console.error("Notes database error:", error);
    showToast("Notes storage could not be opened.", "error");
  }

  try {
    state.filesDB = await openDatabase(
      FILE_DB_NAME,
      FILE_DB_VERSION,
      FILES_STORE
    );
    await renderLibrary();
  } catch (error) {
    console.error("Library database error:", error);
    showToast("Library storage could not be opened.", "error");
  }

  renderPlanner();
  renderFocusHistory();
  renderFlashcards();
  setupLibrary();
  setupServiceWorker();
  updateFocusClock();
}

document.addEventListener("DOMContentLoaded", init, { once: true });

window.addEventListener("beforeunload", () => {
  stopFocusInterval();
  revokeLibraryURLs();

  state.notesDB?.close();
  state.filesDB?.close();
});
