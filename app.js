
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
      if (filter === "completed") return task.completed;
      return true;
    })
    .sort((a, b) => {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  if (!filtered.length) {
    list.innerHTML = `<p class="empty-state">No tasks to display.</p>`;
    return;
  }

  list.innerHTML = filtered.map(task => `
    <article class="task-item ${task.completed ? "completed" : ""}">
      <input type="checkbox" data-task-complete="${escapeHTML(task.id)}"
        aria-label="Mark ${escapeHTML(task.title)} as complete"
        ${task.completed ? "checked" : ""}>
      <div class="task-item-content">
        <div class="task-item-title">${escapeHTML(task.title)}</div>
        <div class="task-item-meta">
          <span>${task.dueDate ? `Due: ${escapeHTML(task.dueDate)}` : "No due date"}</span>
          <span class="priority priority-${escapeHTML(task.priority)}">${escapeHTML(task.priority)}</span>
          ${task.reminder ? "<span>Reminder requested</span>" : ""}
        </div>
      </div>
      <button type="button" class="task-delete"
        data-task-delete="${escapeHTML(task.id)}">Delete</button>
    </article>
  `).join("");
}

function setupPlanner() {
  $("#plannerForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const title = $("#plannerTask").value.trim();
    if (!title) {
      showToast("Enter a task name.", "error");
      return;
    }

    const dueDate = $("#plannerDate").value;

    if (dueDate && !isValidDateString(dueDate)) {
      showToast("Please choose a valid due date.", "error");
      return;
    }

    const tasks = getPlannerTasks();

    tasks.push({
      id: makeId(),
      title,
      dueDate,
      priority: $("#plannerPriority").value,
      reminder: $("#plannerReminder").checked,
      completed: false,
      createdAt: new Date().toISOString()
    });

    if (!savePlannerTasks(tasks)) return;

    $("#plannerForm").reset();
    $("#plannerPriority").value = "medium";

    renderPlanner();
    showToast("Study task added.");
  });

  $("#plannerFilter")?.addEventListener("change", renderPlanner);

  $("#plannerTaskList")?.addEventListener("change", event => {
    const checkbox = event.target.closest("[data-task-complete]");
    if (!checkbox) return;

    const tasks = getPlannerTasks();
    const task = tasks.find(item => item.id === checkbox.dataset.taskComplete);

    if (!task) return;

    task.completed = checkbox.checked;
    task.completedAt = checkbox.checked ? new Date().toISOString() : null;

    if (savePlannerTasks(tasks)) {
      renderPlanner();
      showToast(task.completed ? "Task completed." : "Task marked pending.");
    }
  });

  $("#plannerTaskList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-task-delete]");
    if (!button) return;

    const tasks = getPlannerTasks().filter(
      task => task.id !== button.dataset.taskDelete
    );

    if (savePlannerTasks(tasks)) {
      renderPlanner();
      showToast("Task deleted.");
    }
  });
}

/* ---------- Focus Timer ---------- */

function getFocusHistory() {
  return readJSON(STORAGE_KEYS.focus, []);
}

function renderFocusClock() {
  const clock = $("#focusClock");
  if (!clock) return;

  const minutes = Math.floor(focusRemainingSeconds / 60);
  const seconds = focusRemainingSeconds % 60;

  clock.textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderFocusHistory() {
  const container = $("#focusHistory");
  if (!container) return;

  const history = getFocusHistory();

  if (!history.length) {
    container.innerHTML = `<p class="muted">No completed sessions yet.</p>`;
    return;
  }

  container.innerHTML = history.slice(0, 20).map(session => `
    <div class="history-item">
      <div>
        <strong>${escapeHTML(session.task || "Study Session")}</strong>
        <div class="muted small-text">${escapeHTML(session.mode || "Focus")}</div>
      </div>
      <div>
        <strong>${escapeHTML(String(session.minutes))} min</strong>
        <div class="muted small-text">${escapeHTML(formatDateTime(session.completedAt))}</div>
      </div>
    </div>
  `).join("");
}

function setFocusMode(minutes) {
  if (focusRunning) {
    showToast("Pause or reset the timer before changing modes.", "error");
    return;
  }

  focusModeMinutes = minutes;
  focusRemainingSeconds = minutes * 60;
  focusSessionStartedAt = null;
  focusWasPaused = false;

  $$(".focus-mode").forEach(button => {
    button.classList.toggle(
      "active",
      Number(button.dataset.focusMinutes) === minutes
    );
  });

  $("#focusStatus").textContent = "Ready to focus?";
  renderFocusClock();
}

function finishFocusSession() {
  if (focusInterval !== null) {
    clearInterval(focusInterval);
    focusInterval = null;
  }

  focusRunning = false;
  focusEndTime = null;

  const task = $("#focusTask")?.value.trim() || "Study Session";

  const history = getFocusHistory();

  history.unshift({
    id: makeId(),
    task,
    mode: focusModeMinutes === 25
      ? "Focus"
      : focusModeMinutes === 5
        ? "Short Break"
        : focusModeMinutes === 15
          ? "Long Break"
          : "Custom Session",
    minutes: focusModeMinutes,
    completedAt: new Date().toISOString()
  });

  saveJSONSafely(STORAGE_KEYS.focus, history.slice(0, 200));

  focusRemainingSeconds = 0;
  renderFocusClock();
  renderFocusHistory();

  $("#focusStatus").textContent = "Session complete!";
  showToast("Timer complete! Take a moment to review your progress.");

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Developer Mastermind", {
        body: "Your timer session has finished."
      });
    } catch (error) {
      console.warn("Notification could not be shown:", error);
    }
  }
}

function saveJSONSafely(key, value) {
  return writeJSON(key, value);
}

function tickFocusTimer() {
  if (!focusRunning || !focusEndTime) return;

  focusRemainingSeconds = Math.max(
    0,
    Math.ceil((focusEndTime - Date.now()) / 1000)
  );

  renderFocusClock();

  if (focusRemainingSeconds <= 0) {
    finishFocusSession();
  }
}

function startFocusTimer() {
  if (focusRunning) return;

  if (focusRemainingSeconds <= 0) {
    focusRemainingSeconds = focusModeMinutes * 60;
  }

  focusRunning = true;
  focusWasPaused = false;
  focusSessionStartedAt = focusSessionStartedAt || new Date().toISOString();
  focusEndTime = Date.now() + focusRemainingSeconds * 1000;

  $("#focusStatus").textContent = "Timer running…";

  if (focusInterval !== null) clearInterval(focusInterval);

  focusInterval = window.setInterval(tickFocusTimer, 250);
  tickFocusTimer();
}

function pauseFocusTimer() {
  if (!focusRunning) return;

  tickFocusTimer();

  if (!focusRunning) return;

  focusRunning = false;
  focusWasPaused = true;
  focusEndTime = null;

  if (focusInterval !== null) {
    clearInterval(focusInterval);
    focusInterval = null;
  }

  $("#focusStatus").textContent = "Paused";
}

function resetFocusTimer() {
  focusRunning = false;
  focusEndTime = null;
  focusSessionStartedAt = null;
  focusWasPaused = false;

  if (focusInterval !== null) {
    clearInterval(focusInterval);
    focusInterval = null;
  }

  focusRemainingSeconds = focusModeMinutes * 60;

  renderFocusClock();
  $("#focusStatus").textContent = "Ready to focus?";
}

function setupFocusTimer() {
  $$(".focus-mode").forEach(button => {
    button.addEventListener("click", () => {
      const minutes = Number(button.dataset.focusMinutes);

      if (Number.isFinite(minutes) && minutes > 0) {
        setFocusMode(minutes);
      }
    });
  });

  $("#focusStart")?.addEventListener("click", startFocusTimer);
  $("#focusPause")?.addEventListener("click", pauseFocusTimer);
  $("#focusReset")?.addEventListener("click", resetFocusTimer);

  renderFocusClock();
  renderFocusHistory();
}

/* ---------- Photo & PDF Library ---------- */

function isAllowedLibraryFile(file) {
  return file.type === "application/pdf" || file.type.startsWith("image/");
}

function getFileExtension(name) {
  const parts = String(name || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

async function handleLibraryFiles(event) {
  const input = event.target;
  const selectedFiles = [...(input.files || [])];

  if (!selectedFiles.length) return;

  let added = 0;

  try {
    for (const file of selectedFiles) {
      if (!isAllowedLibraryFile(file)) {
        showToast(`Unsupported file: ${file.name}`, "error");
        continue;
      }

      if (file.size > 20 * 1024 * 1024) {
        showToast(`${file.name} is over the 20 MB limit.`, "error");
        continue;
      }

      const record = {
        id: makeId(),
        name: file.name,
        type: file.type,
        size: file.size,
        addedAt: new Date().toISOString(),
        blob: file
      };

      await saveLibraryFile(record);
      added++;
    }

    await renderLibrary();

    if (added) showToast(`${added} file(s) added to your library.`);
  } catch (error) {
    console.error(error);
    showToast("Could not save files. Check browser storage space.", "error");
  } finally {
    input.value = "";
  }
}

async function renderLibrary() {
  const container = $("#libraryFileList");
  if (!container || !filesDB) return;

  try {
    const files = await getAllLibraryFiles();

    if (!files.length) {
      container.innerHTML = `<p class="empty-state">Your library is empty. Add an image or PDF file.</p>`;
      return;
    }

    container.innerHTML = files
      .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
      .map(file => {
        const isImage = file.type.startsWith("image/");

        return `
          <article class="library-item" data-library-id="${escapeHTML(file.id)}">
            ${isImage
              ? `<div class="library-preview" data-preview-for="${escapeHTML(file.id)}"></div>`
              : `<div class="card-icon">PDF</div>`}
            <h3>${escapeHTML(file.name)}</h3>
            <p class="muted small-text">${(file.size / 1024).toFixed(1)} KB</p>
            <div class="library-item-actions">
              <button type="button" data-file-open="${escapeHTML(file.id)}">Open</button>
              <button type="button" data-file-download="${escapeHTML(file.id)}">Download</button>
              <button type="button" data-file-delete="${escapeHTML(file.id)}">Remove</button>
            </div>
          </article>
        `;
      }).join("");

    for (const file of files) {
      if (!file.type.startsWith("image/") || !(file.blob instanceof Blob)) continue;

      const preview = container.querySelector(
        `[data-preview-for="${CSS.escape(file.id)}"]`
      );

      if (!preview) continue;

      const image = document.createElement("img");
      image.alt = file.name;
      image.loading = "lazy";
      image.src = URL.createObjectURL(file.blob);

      image.addEventListener("load", () => {
        // The URL stays active while the image remains displayed.
      });

      preview.appendChild(image);
    }
  } catch (error) {
    console.error(error);
    showToast("Could not load the library.", "error");
  }
}

async function findLibraryFile(id) {
  const files = await getAllLibraryFiles();
  return files.find(file => file.id === id) || null;
}

async function openLibraryFile(id, download = false) {
  try {
    const file = await findLibraryFile(id);

    if (!file || !(file.blob instanceof Blob)) {
      showToast("File not found.", "error");
      return;
    }

    const url = URL.createObjectURL(file.blob);

    if (download) {
      const link = document.createElement("a");
      link.href = url;
      link.download = safeFilename(file.name);
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } else {
      const opened = window.open(url, "_blank", "noopener");

      if (!opened) {
        URL.revokeObjectURL(url);
        showToast("Pop-up blocked. Use Download instead.", "error");
        return;
      }

      // Keep the object URL alive while the opened document is using it.
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (error) {
    console.error(error);
    showToast("Could not open the file.", "error");
  }
}

async function removeLibraryFile(id) {
  if (!confirm("Remove this file from your library?")) return;

  try {
    await deleteLibraryFile(id);
    await renderLibrary();
    showToast("File removed.");
  } catch (error) {
    console.error(error);
    showToast("Could not remove this file.", "error");
  }
}

async function printLibraryImages() {
  try {
    const files = await getAllLibraryFiles();
    const images = files.filter(file =>
      file.type.startsWith("image/") && file.blob instanceof Blob
    );

    if (!images.length) {
      showToast("Add at least one image first.", "error");
      return;
    }

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
      showToast("Allow pop-ups to create a printable document.", "error");
      return;
    }

    const urls = images.map(file => ({
      name: file.name,
      url: URL.createObjectURL(file.blob)
    }));

    printWindow.document.open();
    printWindow.document.write(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Images to PDF</title>
        <style>
          body { font: 16px Arial, sans-serif; margin: 20px; }
          figure { margin: 0 0 24px; page-break-inside: avoid; }
          img { display: block; max-width: 100%; max-height: 90vh; margin: auto; }
          figcaption { margin-top: 8px; text-align: center; }
          @media print { .help { display: none; } }
        </style>
      </head>
      <body>
        <p class="help">Choose Print → Save as PDF in your browser.</p>
        ${urls.map(item => `
          <figure>
            <img src="${item.url}" alt="">
            <figcaption>${escapeHTML(item.name)}</figcaption>
          </figure>
        `).join("")}
        <script>
          window.addEventListener("load", () => {
            const images = [...document.images];
            Promise.all(images.map(img => img.complete
              ? Promise.resolve()
              : new Promise(resolve => {
                  img.onload = resolve;
                  img.onerror = resolve;
                })
            )).then(() => window.print());
          });
        <\/script>
      </body>
      </html>
    `);
    printWindow.document.close();

    // Object URLs must remain alive until printing finishes.
    printWindow.addEventListener("afterprint", () => {
      urls.forEach(item => URL.revokeObjectURL(item.url));
    }, { once: true });
  } catch (error) {
    console.error(error);
    showToast("Could not prepare the printable document.", "error");
  }
}

function setupLibrary() {
  $("#libraryFiles")?.addEventListener("change", handleLibraryFiles);
  $("#imagesToPdfButton")?.addEventListener("click", printLibraryImages);

  $("#libraryFileList")?.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.fileOpen) {
      await openLibraryFile(button.dataset.fileOpen, false);
    } else if (button.dataset.fileDownload) {
      await openLibraryFile(button.dataset.fileDownload, true);
    } else if (button.dataset.fileDelete) {
      await removeLibraryFile(button.dataset.fileDelete);
    }
  });
}

/* ---------- Flashcards ---------- */

function getFlashcards() {
  return readJSON(STORAGE_KEYS.flashcards, []);
}

function saveFlashcards(cards) {
  return writeJSON(STORAGE_KEYS.flashcards, cards);
}

function renderFlashcards() {
  const container = $("#flashcardList");
  if (!container) return;

  const cards = getFlashcards();

  $("#flashcardCount").textContent =
    `${cards.length} card${cards.length === 1 ? "" : "s"}`;

  if (!cards.length) {
    container.innerHTML = `<p class="empty-state">No flashcards yet. Create your first card above.</p>`;
    return;
  }

  container.innerHTML = cards.map(card => `
    <article class="flashcard">
      <div class="flashcard-question">${escapeHTML(card.question)}</div>
      <button type="button" class="secondary-button"
        data-flashcard-reveal="${escapeHTML(card.id)}">Show Answer</button>
      <div class="flashcard-answer" data-flashcard-answer="${escapeHTML(card.id)}" hidden>
        ${escapeHTML(card.answer).replace(/\n/g, "<br>")}
      </div>
      <p class="muted small-text">
        ${card.known ? "✓ Marked as learned" : "Not learned yet"}
      </p>
      <div class="flashcard-actions">
        <button type="button" data-flashcard-known="${escapeHTML(card.id)}">
          ${card.known ? "Mark to Review" : "Mark Learned"}
        </button>
        <button type="button" data-flashcard-delete="${escapeHTML(card.id)}">
          Delete
        </button>
      </div>
    </article>
  `).join("");
}

function setupFlashcards() {
  $("#flashcardForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const question = $("#flashcardQuestion").value.trim();
    const answer = $("#flashcardAnswer").value.trim();

    if (!question || !answer) {
      showToast("Enter both a question and an answer.", "error");
      return;
    }

    const cards = getFlashcards();

    cards.unshift({
      id: makeId(),
      question,
      answer,
      known: false,
      createdAt: new Date().toISOString(),
      reviewedAt: null
    });

    if (!saveFlashcards(cards)) return;

    $("#flashcardForm").reset();
    renderFlashcards();
    showToast("Flashcard added.");
  });

  $("#flashcardList")?.addEventListener("click", event => {
    const reveal = event.target.closest("[data-flashcard-reveal]");
    const known = event.target.closest("[data-flashcard-known]");
    const remove = event.target.closest("[data-flashcard-delete]");

    if (reveal) {
      const answer = $("#flashcardList").querySelector(
        `[data-flashcard-answer="${CSS.escape(reveal.dataset.flashcardReveal)}"]`
      );

      if (answer) {
        answer.hidden = !answer.hidden;
        reveal.textContent = answer.hidden ? "Show Answer" : "Hide Answer";
      }
      return;
    }

    if (known) {
      const cards = getFlashcards();
      const card = cards.find(item => item.id === known.dataset.flashcardKnown);
      if (!card) return;

      card.known = !card.known;
      card.reviewedAt = new Date().toISOString();

      if (saveFlashcards(cards)) {
        renderFlashcards();
        showToast(card.known ? "Marked as learned." : "Added back to revision.");
      }
      return;
    }

    if (remove) {
      if (!confirm("Delete this flashcard?")) return;

      const cards = getFlashcards().filter(
        item => item.id !== remove.dataset.flashcardDelete
      );

      if (saveFlashcards(cards)) {
        renderFlashcards();
        showToast("Flashcard deleted.");
      }
    }
  });
}

/* ---------- Full App Backup / Restore ---------- */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataURL) {
  const parts = String(dataURL).split(",");
  if (parts.length < 2) throw new Error("Invalid file data.");

  const match = parts[0].match(/data:([^;]+);base64/i);
  if (!match) throw new Error("Unsupported backup file format.");

  const binary = atob(parts[1]);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: match[1] });
}

async function exportAppBackup() {
  try {
    const notes = await getAllNotes();
    const files = await getAllLibraryFiles();

    const fileRecords = [];

    for (const file of files) {
      fileRecords.push({
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        addedAt: file.addedAt,
        dataURL: await blobToDataURL(file.blob)
      });
    }

    const backup = {
      app: "Developer Mastermind",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      notes,
      planner: getPlannerTasks(),
      focusHistory: getFocusHistory(),
      flashcards: getFlashcards(),
      libraryFiles: fileRecords,
      theme: localStorage.getItem(STORAGE_KEYS.theme) || "dark"
    };

    const blob = new Blob(
      [JSON.stringify(backup, null, 2)],
      { type: "application/json" }
    );

    downloadBlob(blob, `developer-mastermind-backup-${new Date().toISOString().slice(0, 10)}.json`);
    showToast("Full app backup exported.");
  } catch (error) {
    console.error(error);
    showToast("Backup failed. Check available storage and try again.", "error");
  }
}

async function importAppBackup(file) {
  if (!file) return;

  if (file.size > 100 * 1024 * 1024) {
    showToast("Backup is larger than 100 MB.", "error");
    return;
  }

  try {
    const backup = JSON.parse(await file.text());

    if (
      !backup ||
      backup.app !== "Developer Mastermind" ||
      backup.formatVersion !== 1
    ) {
      throw new Error("This is not a supported Developer Mastermind backup.");
    }

    if (!Array.isArray(backup.notes) ||
        !Array.isArray(backup.planner) ||
        !Array.isArray(backup.flashcards)) {
      throw new Error("Backup data is incomplete.");
    }

    if (!confirm(
      "Restore this backup? Existing records with the same IDs will be replaced. Other existing records will remain."
    )) return;

    for (const rawNote of backup.notes) {
      const note = normalizeNote(rawNote);
      await saveNoteRecord(note);
    }

    // Merge tasks and cards by ID, rather than deleting existing data.
    const existingTasks = getPlannerTasks();
    const taskMap = new Map(existingTasks.map(item => [item.id, item]));

    backup.planner.forEach(item => {
      if (item && item.id) taskMap.set(item.id, item);
    });

    if (!savePlannerTasks([...taskMap.values()])) {
      throw new Error("Could not restore planner tasks.");
    }

    const existingCards = getFlashcards();
    const cardMap = new Map(existingCards.map(item => [item.id, item]));

    backup.flashcards.forEach(item => {
      if (item && item.id) cardMap.set(item.id, item);
    });

    if (!saveFlashcards([...cardMap.values()])) {
      throw new Error("Could not restore flashcards.");
    }

    const existingHistory = getFocusHistory();
    const historyMap = new Map(existingHistory.map(item => [item.id, item]));

    (Array.isArray(backup.focusHistory) ? backup.focusHistory : [])
      .forEach(item => {
        if (item && item.id) historyMap.set(item.id, item);
      });

    if (!writeJSON(STORAGE_KEYS.focus, [...historyMap.values()].slice(0, 200))) {
      throw new Error("Could not restore focus history.");
    }

    for (const fileRecord of (Array.isArray(backup.libraryFiles) ? backup.libraryFiles : [])) {
      if (!fileRecord?.dataURL || !fileRecord?.id) continue;

      await saveLibraryFile({
        id: fileRecord.id,
        name: fileRecord.name || "Restored file",
        type: fileRecord.type || "application/octet-stream",
        size: fileRecord.size || 0,
        addedAt: fileRecord.addedAt || new Date().toISOString(),
        blob: dataURLToBlob(fileRecord.dataURL)
      });
    }

    if (backup.theme === "light" || backup.theme === "dark") {
      localStorage.setItem(STORAGE_KEYS.theme, backup.theme);
      document.documentElement.dataset.theme = backup.theme;
    }

    await renderNotes();
    renderPlanner();
    renderFocusHistory();
    await renderLibrary();
    renderFlashcards();

    showToast("Backup restored. Review your data.");
  } catch (error) {
    console.error(error);
    showToast(`Restore failed: ${error.message || "Invalid backup file."}`, "error");
  }
}

function setupBackupRestore() {
  $("#exportAppData")?.addEventListener("click", exportAppBackup);

  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.className = "nav-item";
  importButton.id = "importAppData";
  importButton.innerHTML = "<span>⇧</span> Import Backup";

  const exportButton = $("#exportAppData");

  if (exportButton && !$("#importAppData")) {
    exportButton.insertAdjacentElement("afterend", importButton);
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;
  fileInput.id = "backupFileInput";
  document.body.appendChild(fileInput);

  importButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await importAppBackup(file);
    fileInput.value = "";
  });
}

/* ---------- Connection Status ---------- */

function setupConnectionStatus() {
  const update = () => {
    const status = $("#connectionStatus");
    if (!status) return;

    status.textContent = navigator.onLine
      ? "● Online"
      : "● Offline";
  };

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

/* ---------- Service Worker ---------- */

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then(registration => {
        console.log("Service worker registered:", registration.scope);
      })
      .catch(error => {
        console.warn("Service worker registration failed:", error);
      });
  });
}

/* ---------- Initialise ---------- */

async function init() {
  setupTheme();
  setupNavigation();
  setupNotes();
  setupPlanner();
  setupFocusTimer();
  setupFlashcards();
  setupBackupRestore();
  setupConnectionStatus();

  try {
    await openNotesDatabase();
    await openFilesDatabase();

    await renderNotes();
    renderPlanner();
    renderFocusHistory();
    await renderLibrary();
    renderFlashcards();
  } catch (error) {
    console.error("App initialisation failed:", error);
    showToast(
      "Some app data could not be opened. Do not clear browser storage; export any accessible data first.",
      "error"
    );
  }

  setupLibrary();
  setupServiceWorker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
