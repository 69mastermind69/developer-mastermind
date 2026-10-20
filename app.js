
/* =========================================
   DEVELOPER MASTERMIND
   File: app.js
   Notes + Study Planner + Focus Timer
   + Photo/PDF Library + Flashcards
========================================= */

"use strict";

/* ---------- Configuration ---------- */

const DB_NAME = "developer_mastermind_db";
const DB_VERSION = 2;
const NOTES_STORE = "notes";

const STORAGE_KEYS = {
  planner: "dm_planner_tasks_v1",
  flashcards: "dm_flashcards_v1",
  theme: "dm_theme",
  focusHistory: "dm_focus_history_v1",
  library: "dm_library_files_v1"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const makeId = () =>
  window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const escapeHTML = (value = "") =>
  String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

const safeDate = value => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
};

const readJSON = (key, fallback = []) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch (error) {
    console.warn(`Could not read ${key}:`, error);
    return fallback;
  }
};

const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Could not save ${key}:`, error);
    showToast(
      "Storage full or unavailable. Please remove some files or export a backup.",
      "error"
    );
    return false;
  }
};

let notesDB = null;
let currentNoteId = null;
let currentNoteFolder = "all";
let currentNoteFilter = "all";
let currentSearch = "";
let currentFocusMinutes = 25;
let focusRemainingSeconds = 25 * 60;
let focusInterval = null;
let focusRunning = false;
let focusStartedAt = null;
let focusTaskName = "";

/* ---------- Toast Messages ---------- */

function showToast(message, type = "success") {
  let toast = $("#toast") || $(".toast") || $("#toastMessage");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "dmGeneratedToast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.remove("success", "error");
  toast.classList.add(type === "error" ? "error" : "success");
  toast.hidden = false;

  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    if (toast.id === "dmGeneratedToast") {
      toast.remove();
    } else {
      toast.hidden = true;
    }
  }, 3000);
}

/* =========================================
   THEME
========================================= */

function setupTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || "light";

  document.documentElement.dataset.theme = savedTheme;

  const themeButtons = [
    $("#themeToggle"),
    $("#themeButton"),
    $("#toggleTheme"),
    ...$$("[data-action='toggle-theme']")
  ].filter(Boolean);

  themeButtons.forEach(button => {
    button.addEventListener("click", toggleTheme);
    updateThemeButton(button);
  });
}

function updateThemeButton(button) {
  if (!button) return;

  const dark = document.documentElement.dataset.theme === "dark";
  button.setAttribute("aria-pressed", String(dark));
  button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");

  if (button.dataset.iconOnly === "true") {
    button.textContent = dark ? "☀️" : "🌙";
  }
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";

  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEYS.theme, next);

  [
    $("#themeToggle"),
    $("#themeButton"),
    $("#toggleTheme"),
    ...$$("[data-action='toggle-theme']")
  ].filter(Boolean).forEach(updateThemeButton);
}

/* =========================================
   NOTES DATABASE
   Keeps the existing database version 2.
========================================= */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support IndexedDB."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = event => {
      notesDB = event.target.result;

      notesDB.onversionchange = () => {
        notesDB.close();
      };

      resolve(notesDB);
    };

    request.onerror = () => {
      reject(request.error || new Error("Could not open Notes database."));
    };

    request.onblocked = () => {
      console.warn("Notes database upgrade is blocked by another open tab.");
    };
  });
}

function normalizeNote(note = {}) {
  const now = new Date().toISOString();

  return {
    id: note.id || makeId(),
    title: String(note.title || ""),
    content: String(note.content || ""),
    folder: String(note.folder || "General"),
    tags: Array.isArray(note.tags) ? note.tags : [],
    favorite: Boolean(note.favorite),
    deletedAt: note.deletedAt || null,
    createdAt: note.createdAt || now,
    updatedAt: note.updatedAt || now
  };
}

function notesTransaction(mode, action) {
  return new Promise((resolve, reject) => {
    if (!notesDB) {
      reject(new Error("Notes database is not ready."));
      return;
    }

    let transaction;

    try {
      transaction = notesDB.transaction(NOTES_STORE, mode);
      const store = transaction.objectStore(NOTES_STORE);
      action(store, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function getAllNotes() {
  return notesTransaction("readonly", (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function saveNote(note) {
  const normalized = normalizeNote(note);

  return notesTransaction("readwrite", (store, resolve, reject) => {
    const request = store.put(normalized);
    request.onsuccess = () => resolve(normalized);
    request.onerror = () => reject(request.error);
  });
}

function deleteNoteFromDB(id) {
  return notesTransaction("readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

async function getNoteById(id) {
  const notes = await getAllNotes();
  return notes.find(note => note.id === id) || null;
}

/* ---------- Notes UI ---------- */

function getNotesGrid() {
  return $("#notesGrid") ||
    $("#notesContainer") ||
    $("#notesList") ||
    $(".notes-grid") ||
    $(".note-grid");
}

function getNoteTitleInput() {
  return $("#noteTitle") || $("#titleInput") || $("#editorTitle");
}

function getNoteContentInput() {
  return $("#noteContent") || $("#contentInput") || $("#editorContent");
}

function getVisibleNotes() {
  return getAllNotes().then(notes => {
    return notes.filter(note => {
      const searchText =
        `${note.title} ${note.content} ${(note.tags || []).join(" ")}`
          .toLowerCase();

      if (currentNoteFilter === "trash" && !note.deletedAt) return false;
      if (currentNoteFilter !== "trash" && note.deletedAt) return false;
      if (currentNoteFilter === "favorites" && !note.favorite) return false;

      if (
        currentNoteFolder !== "all" &&
        note.folder !== currentNoteFolder
      ) {
        return false;
      }

      if (currentSearch && !searchText.includes(currentSearch.toLowerCase())) {
        return false;
      }

      return true;
    }).sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  });
}

async function renderNotes() {
  const grid = getNotesGrid();
  if (!grid) return;

  try {
    const notes = await getVisibleNotes();

    if (!notes.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <h3>No notes found</h3>
          <p>Create a new note or change your filters.</p>
        </div>
      `;
      updateNotesStats();
      return;
    }

    grid.innerHTML = notes.map(note => {
      const title = note.title.trim() || "Untitled note";
      const content = note.content.trim() || "No content yet.";
      const tags = (note.tags || [])
        .map(tag => `<span class="note-tag">${escapeHTML(tag)}</span>`)
        .join("");

      return `
        <article class="note-card" data-note-id="${escapeHTML(note.id)}">
          <div class="note-card-header">
            <h3>${escapeHTML(title)}</h3>
            <button
              class="icon-button"
              type="button"
              data-note-action="favorite"
              data-id="${escapeHTML(note.id)}"
              aria-label="${note.favorite ? "Remove from favorites" : "Add to favorites"}"
              title="${note.favorite ? "Unfavorite" : "Favorite"}"
            >${note.favorite ? "★" : "☆"}</button>
          </div>

          <p>${escapeHTML(content.slice(0, 260))}${content.length > 260 ? "…" : ""}</p>

          <div class="note-tags">${tags}</div>

          <div class="note-card-footer">
            <span>${escapeHTML(note.folder || "General")}</span>
            <span>${escapeHTML(safeDate(note.updatedAt))}</span>
          </div>

          <div class="note-card-actions">
            ${
              note.deletedAt
                ? `
                  <button type="button" data-note-action="restore" data-id="${escapeHTML(note.id)}">Restore</button>
                  <button type="button" data-note-action="purge" data-id="${escapeHTML(note.id)}">Delete forever</button>
                `
                : `
                  <button type="button" data-note-action="edit" data-id="${escapeHTML(note.id)}">Edit</button>
                  <button type="button" data-note-action="trash" data-id="${escapeHTML(note.id)}">Move to trash</button>
                `
            }
          </div>
        </article>
      `;
    }).join("");

    updateNotesStats();
  } catch (error) {
    console.error(error);
    showToast("Could not load notes.", "error");
  }
}

async function updateNotesStats() {
  try {
    const notes = await getAllNotes();
    const active = notes.filter(note => !note.deletedAt);
    const favorites = active.filter(note => note.favorite);
    const trash = notes.filter(note => note.deletedAt);

    setText("#notesCount", active.length);
    setText("#totalNotes", active.length);
    setText("#favoriteNotesCount", favorites.length);
    setText("#trashNotesCount", trash.length);
    setText("#dashboardNotesCount", active.length);
  } catch (error) {
    console.warn("Notes statistics unavailable:", error);
  }
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value);
}

function showEditor() {
  showView("editor");

  const editor = $("#editorView") || $(".editor-view");
  if (editor) editor.hidden = false;
}

async function createNewNote() {
  currentNoteId = null;

  const titleInput = getNoteTitleInput();
  const contentInput = getNoteContentInput();

  if (titleInput) titleInput.value = "";
  if (contentInput) contentInput.value = "";

  const folderInput = $("#noteFolder") || $("#folderInput");
  const tagsInput = $("#noteTags") || $("#tagsInput");

  if (folderInput) folderInput.value = "General";
  if (tagsInput) tagsInput.value = "";

  const editorHeading = $("#editorHeading") || $("#editorTitleLabel");
  if (editorHeading) editorHeading.textContent = "New Note";

  showEditor();
  if (titleInput) titleInput.focus();
}

async function editNote(id) {
  const note = await getNoteById(id);
  if (!note) {
    showToast("Note not found.", "error");
    return;
  }

  currentNoteId = note.id;

  const titleInput = getNoteTitleInput();
  const contentInput = getNoteContentInput();
  const folderInput = $("#noteFolder") || $("#folderInput");
  const tagsInput = $("#noteTags") || $("#tagsInput");

  if (titleInput) titleInput.value = note.title;
  if (contentInput) contentInput.value = note.content;
  if (folderInput) folderInput.value = note.folder;
  if (tagsInput) tagsInput.value = (note.tags || []).join(", ");

  const editorHeading = $("#editorHeading") || $("#editorTitleLabel");
  if (editorHeading) editorHeading.textContent = "Edit Note";

  showEditor();
}

async function saveCurrentNote() {
  const titleInput = getNoteTitleInput();
  const contentInput = getNoteContentInput();

  if (!titleInput || !contentInput) {
    showToast("Note editor fields were not found.", "error");
    return;
  }

  const oldNote = currentNoteId
    ? await getNoteById(currentNoteId)
    : null;

  const now = new Date().toISOString();
  const tagsInput = $("#noteTags") || $("#tagsInput");
  const folderInput = $("#noteFolder") || $("#folderInput");

  const tags = tagsInput
    ? tagsInput.value.split(",").map(tag => tag.trim()).filter(Boolean)
    : [];

  const note = normalizeNote({
    ...(oldNote || {}),
    id: currentNoteId || makeId(),
    title: titleInput.value.trim(),
    content: contentInput.value,
    folder: folderInput?.value.trim() || "General",
    tags,
    favorite: oldNote?.favorite || false,
    deletedAt: null,
    createdAt: oldNote?.createdAt || now,
    updatedAt: now
  });

  await saveNote(note);
  currentNoteId = note.id;

  showToast("Note saved.");
  showView("notes");
  await renderNotes();
}

async function trashNote(id) {
  const note = await getNoteById(id);
  if (!note) return;

  note.deletedAt = new Date().toISOString();
  note.updatedAt = new Date().toISOString();

  await saveNote(note);
  showToast("Note moved to trash.");
  await renderNotes();
}

async function restoreNote(id) {
  const note = await getNoteById(id);
  if (!note) return;

  note.deletedAt = null;
  note.updatedAt = new Date().toISOString();

  await saveNote(note);
  showToast("Note restored.");
  await renderNotes();
}

async function permanentlyDeleteNote(id) {
  const confirmed = window.confirm(
    "Permanently delete this note? This cannot be undone."
  );
  if (!confirmed) return;

  await deleteNoteFromDB(id);
  showToast("Note permanently deleted.");
  await renderNotes();
}

async function toggleNoteFavorite(id) {
  const note = await getNoteById(id);
  if (!note) return;

  note.favorite = !note.favorite;
  note.updatedAt = new Date().toISOString();

  await saveNote(note);
  await renderNotes();
}

async function exportNotes() {
  const notes = await getAllNotes();
  downloadTextFile(
    JSON.stringify(notes, null, 2),
    `developer-mastermind-notes-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json"
  );
  showToast("Notes backup exported.");
}

async function importNotes(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed)) {
      throw new Error("Invalid backup format.");
    }

    for (const item of parsed) {
      if (item && typeof item === "object") {
        await saveNote(normalizeNote(item));
      }
    }

    await renderNotes();
    showToast("Notes backup imported.");
  } catch (error) {
    console.error(error);
    showToast("Could not import this backup file.", "error");
  }
}

function downloadTextFile(content, filename, mimeType = "text/plain") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupNotes() {
  const newButtons = [
    $("#newNoteButton"),
    $("#newNoteBtn"),
    $("#createNoteButton"),
    ...$$("[data-action='new-note']")
  ].filter(Boolean);

  newButtons.forEach(button => {
    button.addEventListener("click", createNewNote);
  });

  const saveButtons = [
    $("#saveNoteButton"),
    $("#saveNoteBtn"),
    ...$$("[data-action='save-note']")
  ].filter(Boolean);

  saveButtons.forEach(button => {
    button.addEventListener("click", () => {
      saveCurrentNote().catch(error => {
        console.error(error);
        showToast("Could not save note.", "error");
      });
    });
  });

  const cancelButtons = [
    $("#cancelNoteButton"),
    $("#cancelNoteBtn"),
    ...$$("[data-action='cancel-note']")
  ].filter(Boolean);

  cancelButtons.forEach(button => {
    button.addEventListener("click", () => showView("notes"));
  });

  const searchInput =
    $("#notesSearch") || $("#noteSearch") || $("#searchNotes");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      currentSearch = searchInput.value.trim();
      renderNotes();
    });
  }

  const folderSelect = $("#folderFilter") || $("#notesFolderFilter");
  if (folderSelect) {
    folderSelect.addEventListener("change", () => {
      currentNoteFolder = folderSelect.value || "all";
      renderNotes();
    });
  }

  const filterButtons = $$("[data-note-filter]");
  filterButtons.forEach(button => {
    button.addEventListener("click", () => {
      currentNoteFilter = button.dataset.noteFilter || "all";

      filterButtons.forEach(item => item.classList.remove("active"));
      button.classList.add("active");

      renderNotes();
    });
  });

  const exportButton =
    $("#exportNotesButton") || $("#exportNotes");

  exportButton?.addEventListener("click", () => {
    exportNotes().catch(error => {
      console.error(error);
      showToast("Could not export notes.", "error");
    });
  });

  const importInput =
    $("#importNotesInput") || $("#importNotesFile");

  importInput?.addEventListener("change", event => {
    importNotes(event.target.files?.[0]).finally(() => {
      event.target.value = "";
    });
  });

  const grid = getNotesGrid();

  grid?.addEventListener("click", event => {
    const button = event.target.closest("[data-note-action]");
    if (!button) return;

    const { noteAction, id } = button.dataset;
    if (!id) return;

    const actions = {
      edit: () => editNote(id),
      trash: () => trashNote(id),
      restore: () => restoreNote(id),
      purge: () => permanentlyDeleteNote(id),
      favorite: () => toggleNoteFavorite(id)
    };

    if (actions[noteAction]) {
      actions[noteAction]().catch(error => {
        console.error(error);
        showToast("Could not complete this note action.", "error");
      });
    }
  });
}

/* =========================================
   NAVIGATION
========================================= */

const pageTitles = {
  home: "Dashboard",
  notes: "Notes",
  editor: "Note Editor",
  planner: "Study Planner",
  focus: "Focus Timer",
  library: "Photo & PDF Library",
  flashcards: "Flashcards & Revision"
};

function showView(view) {
  const knownViews = [
    "home",
    "notes",
    "editor",
    "planner",
    "focus",
    "library",
    "flashcards"
  ];

  const selected = knownViews.includes(view) ? view : "home";

  const viewIds = {
    home: ["homeView", "dashboardView"],
    notes: ["notesView"],
    editor: ["editorView"],
    planner: ["plannerView"],
    focus: ["focusView"],
    library: ["libraryView"],
    flashcards: ["flashcardsView"]
  };

  const allViewIds = Object.values(viewIds).flat();

  allViewIds.forEach(id => {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  });

  const placeholder = $("#placeholderView");
  if (placeholder) placeholder.hidden = true;

  let target = null;

  for (const id of viewIds[selected] || []) {
    target = document.getElementById(id);
    if (target) break;
  }

  if (target) {
    target.hidden = false;
  } else if (selected === "home" || selected === "notes" || selected === "editor") {
    // Some existing versions place the dashboard or notes directly in the main area.
    const fallback = $(`[data-page="${selected}"]`);
    if (fallback) {
      fallback.hidden = false;
    } else if (placeholder) {
      placeholder.hidden = false;
      setText("#placeholderTitle", pageTitles[selected]);
      setText("#placeholderDescription", "This section is not available in this HTML version.");
    }
  } else if (placeholder) {
    placeholder.hidden = false;
    setText("#placeholderTitle", pageTitles[selected]);
    setText("#placeholderDescription", "This section is being prepared.");
  }

  $$("[data-view]").forEach(button => {
    const active = button.dataset.view === selected;
    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  setText("#breadcrumb", pageTitles[selected]);
  setText("#pageBreadcrumb", pageTitles[selected]);

  if (selected === "notes") renderNotes();
  if (selected === "planner") renderPlanner();
  if (selected === "focus") updateFocusDisplay();
  if (selected === "library") renderLibrary();
  if (selected === "flashcards") renderFlashcards();
}

function setupNavigation() {
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (!button) return;

    event.preventDefault();
    showView(button.dataset.view);
  });

  $$("[data-go-to]").forEach(button => {
    button.addEventListener("click", () => {
      showView(button.dataset.goTo);
    });
  });
}

/* =========================================
   STUDY PLANNER
========================================= */

function getPlannerTasks() {
  return readJSON(STORAGE_KEYS.planner, []);
}

function savePlannerTasks(tasks) {
  return writeJSON(STORAGE_KEYS.planner, tasks);
}

function setupPlanner() {
  const form = $("#plannerForm");
  if (!form) return;

  const dateInput = $("#plannerDate");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  form.addEventListener("submit", event => {
    event.preventDefault();

    const taskInput = $("#plannerTask");
    const priorityInput = $("#plannerPriority");
    const reminderInput = $("#plannerReminder");

    const title = taskInput?.value.trim();
    if (!title) {
      showToast("Please enter a task.", "error");
      taskInput?.focus();
      return;
    }

    const tasks = getPlannerTasks();

    tasks.push({
      id: makeId(),
      title,
      date: dateInput?.value || "",
      priority: priorityInput?.value || "medium",
      reminder: Boolean(reminderInput?.checked),
      completed: false,
      createdAt: new Date().toISOString()
    });

    if (!savePlannerTasks(tasks)) return;

    form.reset();

    if (dateInput) {
      dateInput.value = new Date().toISOString().slice(0, 10);
    }

    renderPlanner();
    showToast("Study task added.");
  });

  $("#plannerFilter")?.addEventListener("change", renderPlanner);

  $("#plannerTaskList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-planner-action]");
    if (!button) return;

    const { plannerAction, id } = button.dataset;
    const tasks = getPlannerTasks();
    const task = tasks.find(item => item.id === id);

    if (!task) return;

    if (plannerAction === "delete") {
      const updated = tasks.filter(item => item.id !== id);
      savePlannerTasks(updated);
      renderPlanner();
      showToast("Task deleted.");
    }

    if (plannerAction === "complete") {
      task.completed = !task.completed;
      savePlannerTasks(tasks);
      renderPlanner();
    }
  });

  $("#plannerTaskList")?.addEventListener("change", event => {
    const checkbox = event.target.closest("[data-planner-check]");
    if (!checkbox) return;

    const tasks = getPlannerTasks();
    const task = tasks.find(item => item.id === checkbox.dataset.plannerCheck);

    if (!task) return;

    task.completed = checkbox.checked;
    savePlannerTasks(tasks);
    renderPlanner();
  });

  renderPlanner();
}

function renderPlanner() {
  const list = $("#plannerTaskList");
  if (!list) return;

  const allTasks = getPlannerTasks();
  const filter = $("#plannerFilter")?.value || "all";

  setText("#plannerTotal", allTasks.length);
  setText("#plannerCompleted", allTasks.filter(task => task.completed).length);
  setText("#plannerPending", allTasks.filter(task => !task.completed).length);

  let tasks = [...allTasks];

  if (filter === "pending") tasks = tasks.filter(task => !task.completed);
  if (filter === "completed") tasks = tasks.filter(task => task.completed);
  if (filter === "today") {
    const today = new Date().toISOString().slice(0, 10);
    tasks = tasks.filter(task => task.date === today);
  }

  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
  });

  if (!tasks.length) {
    list.innerHTML = `
      <div class="module-empty">
        No study tasks yet. Add a task above to get started.
      </div>
    `;
    return;
  }

  list.innerHTML = tasks.map(task => {
    const priority = ["low", "medium", "high"].includes(task.priority)
      ? task.priority
      : "medium";

    return `
      <article class="planner-task ${task.completed ? "completed" : ""}">
        <input
          type="checkbox"
          data-planner-check="${escapeHTML(task.id)}"
          ${task.completed ? "checked" : ""}
          aria-label="Mark ${escapeHTML(task.title)} as completed"
        >

        <div class="planner-task-main">
          <p class="planner-task-title">${escapeHTML(task.title)}</p>
          <div class="planner-task-meta">
            ${task.date ? `<span>📅 ${escapeHTML(task.date)}</span>` : ""}
            <span class="priority priority-${priority}">${escapeHTML(priority)}</span>
            ${task.reminder ? "<span>🔔 Reminder requested</span>" : ""}
          </div>
        </div>

        <div class="planner-task-actions">
          <button type="button" data-planner-action="delete" data-id="${escapeHTML(task.id)}">
            Delete
          </button>
        </div>
      </article>
    `;
  }).join("");
}

/* =========================================
   FOCUS TIMER
========================================= */

function setupFocusTimer() {
  const modeButtons = $$(".focus-mode");

  modeButtons.forEach(button => {
    button.addEventListener("click", () => {
      if (focusRunning) {
        showToast("Pause the timer before changing its mode.", "error");
        return;
      }

      const minutes = Number(button.dataset.focusMinutes);
      if (!Number.isFinite(minutes) || minutes < 1) return;

      currentFocusMinutes = minutes;
      focusRemainingSeconds = minutes * 60;

      modeButtons.forEach(item => {
        item.classList.toggle("active", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });

      updateFocusDisplay();
    });
  });

  $("#focusStart")?.addEventListener("click", startFocusTimer);
  $("#focusPause")?.addEventListener("click", pauseFocusTimer);
  $("#focusReset")?.addEventListener("click", resetFocusTimer);

  renderFocusHistory();
  updateFocusDisplay();
}

function startFocusTimer() {
  if (focusRunning) return;

  if (focusRemainingSeconds <= 0) {
    focusRemainingSeconds = currentFocusMinutes * 60;
  }

  focusTaskName = $("#focusTask")?.value.trim() || "Study session";
  focusStartedAt = Date.now();
  focusRunning = true;

  clearInterval(focusInterval);

  focusInterval = setInterval(() => {
    if (document.hidden) {
      // Keep counting while the page is hidden; calculate elapsed time from timestamps.
    }

    const elapsed = Math.floor((Date.now() - focusStartedAt) / 1000);
    focusRemainingSeconds = Math.max(
      0,
      currentFocusMinutes * 60 - elapsed
    );

    updateFocusDisplay();

    if (focusRemainingSeconds <= 0) {
      completeFocusSession();
    }
  }, 250);

  updateFocusDisplay();
}

function pauseFocusTimer() {
  if (!focusRunning) return;

  const elapsed = Math.floor((Date.now() - focusStartedAt) / 1000);
  focusRemainingSeconds = Math.max(
    0,
    currentFocusMinutes * 60 - elapsed
  );

  clearInterval(focusInterval);
  focusInterval = null;
  focusRunning = false;
  focusStartedAt = null;

  updateFocusDisplay();
}

function resetFocusTimer() {
  clearInterval(focusInterval);
  focusInterval = null;
  focusRunning = false;
  focusStartedAt = null;
  focusRemainingSeconds = currentFocusMinutes * 60;

  updateFocusDisplay();
}

function completeFocusSession() {
  clearInterval(focusInterval);
  focusInterval = null;
  focusRunning = false;
  focusStartedAt = null;
  focusRemainingSeconds = 0;

  const history = readJSON(STORAGE_KEYS.focusHistory, []);

  history.unshift({
    id: makeId(),
    task: focusTaskName || "Study session",
    minutes: currentFocusMinutes,
    completedAt: new Date().toISOString()
  });

  writeJSON(STORAGE_KEYS.focusHistory, history.slice(0, 100));
  renderFocusHistory();
  updateFocusDisplay();
  showToast("Focus session complete! Great work.");

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Developer Mastermind", {
        body: "Your focus session is complete."
      });
    } catch (error) {
      console.warn("Notification could not be shown.", error);
    }
  }
}

function updateFocusDisplay() {
  const minutes = Math.floor(focusRemainingSeconds / 60);
  const seconds = focusRemainingSeconds % 60;

  setText(
    "#focusClock",
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  );

  setText(
    "#focusStatus",
    focusRunning ? "Focus session in progress…" : "Ready when you are."
  );

  const startButton = $("#focusStart");
  const pauseButton = $("#focusPause");

  if (startButton) startButton.disabled = focusRunning;
  if (pauseButton) pauseButton.disabled = !focusRunning;

  document.title = focusRunning
    ? `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} — Focus Timer`
    : "Developer Mastermind";
}

function renderFocusHistory() {
  const container = $("#focusHistory");
  if (!container) return;

  const history = readJSON(STORAGE_KEYS.focusHistory, []);

  if (!history.length) {
    container.innerHTML = `
      <div class="module-empty">Your completed focus sessions will appear here.</div>
    `;
    return;
  }

  container.innerHTML = `
    <h3>Recent sessions</h3>
    <div class="module-list">
      ${history.slice(0, 10).map(session => `
        <article class="module-item">
          <div class="module-item-main">
            <h3>${escapeHTML(session.task || "Study session")}</h3>
            <p>${escapeHTML(String(session.minutes))} minutes · ${escapeHTML(safeDate(session.completedAt))}</p>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

/* =========================================
   PHOTO & PDF LIBRARY
   Files are saved locally in this browser.
========================================= */

function getLibraryFiles() {
  return readJSON(STORAGE_KEYS.library, []);
}

function setupLibrary() {
  const input = $("#libraryFiles");
  if (!input) return;

  input.addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const currentFiles = getLibraryFiles();

    for (const file of files) {
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
        showToast(`Unsupported file: ${file.name}`, "error");
        continue;
      }

      // Keep each upload reasonably small for browser storage.
      if (file.size > 3 * 1024 * 1024) {
        showToast(
          `${file.name} is over 3 MB. Choose a smaller file for local storage.`,
          "error"
        );
        continue;
      }

      try {
        const dataUrl = await fileToDataURL(file);

        currentFiles.unshift({
          id: makeId(),
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl,
          addedAt: new Date().toISOString()
        });
      } catch (error) {
        console.error(error);
        showToast(`Could not read ${file.name}.`, "error");
      }
    }

    if (writeJSON(STORAGE_KEYS.library, currentFiles)) {
      showToast("Library updated.");
    }

    input.value = "";
    renderLibrary();
  });

  $("#imagesToPdfButton")?.addEventListener("click", printImagesToPDF);

  $("#libraryFileList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-library-action]");
    if (!button) return;

    const file = getLibraryFiles().find(
      item => item.id === button.dataset.id
    );

    if (!file) return;

    if (button.dataset.libraryAction === "open") {
      openLibraryFile(file);
    }

    if (button.dataset.libraryAction === "download") {
      downloadDataURL(file.dataUrl, file.name);
    }

    if (button.dataset.libraryAction === "delete") {
      const remaining = getLibraryFiles().filter(
        item => item.id !== file.id
      );

      if (writeJSON(STORAGE_KEYS.library, remaining)) {
        renderLibrary();
        showToast("File removed from library.");
      }
    }
  });

  renderLibrary();
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderLibrary() {
  const container = $("#libraryFileList");
  if (!container) return;

  const files = getLibraryFiles();

  if (!files.length) {
    container.innerHTML = `
      <div class="module-empty">
        No files yet. Choose photos or PDFs above to add them.
      </div>
    `;
    return;
  }

  container.innerHTML = files.map(file => {
    const isImage = file.type?.startsWith("image/");

    return `
      <article class="library-file">
        ${
          isImage
            ? `<img src="${file.dataUrl}" alt="${escapeHTML(file.name)}" loading="lazy">`
            : `<div class="empty-state-icon">📄</div>`
        }

        <div class="library-file-name">${escapeHTML(file.name)}</div>
        <div class="library-file-meta">
          ${escapeHTML(formatFileSize(file.size))} · ${escapeHTML(safeDate(file.addedAt))}
        </div>

        <div class="library-file-actions">
          <button type="button" data-library-action="open" data-id="${escapeHTML(file.id)}">Open</button>
          <button type="button" data-library-action="download" data-id="${escapeHTML(file.id)}">Download</button>
          <button type="button" data-library-action="delete" data-id="${escapeHTML(file.id)}">Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadDataURL(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openLibraryFile(file) {
  const newWindow = window.open();

  if (!newWindow) {
    showToast("Allow pop-ups to open this file.", "error");
    return;
  }

  const isImage = file.type?.startsWith("image/");

  newWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHTML(file.name)}</title>
        <style>
          body {
            margin: 0;
            padding: 20px;
            font-family: Arial, sans-serif;
            background: #171923;
            color: white;
            text-align: center;
          }
          img {
            display: block;
            max-width: 100%;
            max-height: 90vh;
            margin: 20px auto;
            object-fit: contain;
          }
          iframe {
            width: 100%;
            height: 85vh;
            border: 0;
            background: white;
          }
        </style>
      </head>
      <body>
        <h3>${escapeHTML(file.name)}</h3>
        ${
          isImage
            ? `<img src="${file.dataUrl}" alt="${escapeHTML(file.name)}">`
            : `<iframe title="${escapeHTML(file.name)}" src="${file.dataUrl}"></iframe>`
        }
      </body>
    </html>
  `);

  newWindow.document.close();
}

function printImagesToPDF() {
  const images = getLibraryFiles().filter(file =>
    file.type?.startsWith("image/")
  );

  if (!images.length) {
    showToast("Add at least one image first.", "error");
    return;
  }

  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    showToast("Allow pop-ups to create a PDF.", "error");
    return;
  }

  const imageHTML = images.map(file => `
    <section>
      <h3>${escapeHTML(file.name)}</h3>
      <img src="${file.dataUrl}" alt="${escapeHTML(file.name)}">
    </section>
  `).join("");

  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Images to PDF</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 18px; }
          section { page-break-after: always; text-align: center; }
          img { max-width: 100%; max-height: 85vh; object-fit: contain; }
          @media print {
            section { break-after: page; }
            section:last-child { break-after: auto; }
          }
        </style>
      </head>
      <body>
        ${imageHTML}
        <script>
          window.onload = () => setTimeout(() => window.print(), 500);
        <\/script>
      </body>
    </html>
  `);

  printWindow.document.close();
  showToast("In the print window, choose Save as PDF.");
}

/* =========================================
   FLASHCARDS
========================================= */

function getFlashcards() {
  return readJSON(STORAGE_KEYS.flashcards, []);
}

function saveFlashcards(cards) {
  return writeJSON(STORAGE_KEYS.flashcards, cards);
}

function setupFlashcards() {
  const form = $("#flashcardForm");
  if (!form) return;

  form.addEventListener("submit", event => {
    event.preventDefault();

    const questionInput = $("#flashcardQuestion");
    const answerInput = $("#flashcardAnswer");

    const question = questionInput?.value.trim();
    const answer = answerInput?.value.trim();

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
      createdAt: new Date().toISOString()
    });

    if (!saveFlashcards(cards)) return;

    form.reset();
    renderFlashcards();
    showToast("Flashcard added.");
  });

  $("#flashcardList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-flashcard-action]");
    if (!button) return;

    const id = button.dataset.id;
    const action = button.dataset.flashcardAction;
    const cards = getFlashcards();
    const card = cards.find(item => item.id === id);

    if (!card) return;

    if (action === "toggle-answer") {
      const answer = $(`[data-answer-for="${CSS.escape(id)}"]`);
      if (answer) answer.hidden = !answer.hidden;
      button.textContent = answer?.hidden ? "Show answer" : "Hide answer";
    }

    if (action === "known") {
      card.known = !card.known;
      saveFlashcards(cards);
      renderFlashcards();
    }

    if (action === "delete") {
      saveFlashcards(cards.filter(item => item.id !== id));
      renderFlashcards();
      showToast("Flashcard deleted.");
    }
  });

  renderFlashcards();
}

function renderFlashcards() {
  const container = $("#flashcardList");
  if (!container) return;

  const cards = getFlashcards();

  setText("#flashcardCount", cards.length);

  if (!cards.length) {
    container.innerHTML = `
      <div class="module-empty">
        No flashcards yet. Add a question and answer to start revising.
      </div>
    `;
    return;
  }

  container.innerHTML = cards.map(card => `
    <article class="flashcard-item ${card.known ? "known" : ""}">
      <h3 class="flashcard-question">${escapeHTML(card.question)}</h3>

      <div
        class="flashcard-answer"
        data-answer-for="${escapeHTML(card.id)}"
        hidden
      >${escapeHTML(card.answer)}</div>

      <div class="flashcard-actions">
        <button
          type="button"
          data-flashcard-action="toggle-answer"
          data-id="${escapeHTML(card.id)}"
        >Show answer</button>

        <button
          type="button"
          data-flashcard-action="known"
          data-id="${escapeHTML(card.id)}"
        >${card.known ? "Revise again" : "Mark learned"}</button>

        <button
          type="button"
          data-flashcard-action="delete"
          data-id="${escapeHTML(card.id)}"
        >Delete</button>
      </div>
    </article>
  `).join("");
}

/* =========================================
   CONNECTION STATUS + SERVICE WORKER
========================================= */

function setupConnectionStatus() {
  const update = () => {
    const online = navigator.onLine;

    $$(".connection-status").forEach(element => {
      element.classList.toggle("offline", !online);
      element.textContent = online ? "Online" : "Offline";
    });

    setText("#connectionStatus", online ? "Online" : "Offline");
  };

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

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

/* =========================================
   GLOBAL BACKUP
========================================= */

function setupLocalDataBackup() {
  const exportButton = $("#exportAppData");

  exportButton?.addEventListener("click", async () => {
    try {
      const notes = await getAllNotes();

      const backup = {
        app: "Developer Mastermind",
        exportedAt: new Date().toISOString(),
        notes,
        planner: getPlannerTasks(),
        flashcards: getFlashcards(),
        focusHistory: readJSON(STORAGE_KEYS.focusHistory, []),
        library: getLibraryFiles()
      };

      downloadTextFile(
        JSON.stringify(backup, null, 2),
        `developer-mastermind-backup-${new Date().toISOString().slice(0, 10)}.json`,
        "application/json"
      );

      showToast("App backup exported.");
    } catch (error) {
      console.error(error);
      showToast("Could not export app data.", "error");
    }
  });
}

/* =========================================
   INITIALIZATION
========================================= */

async function init() {
  setupTheme();
  setupNavigation();
  setupNotes();
  setupPlanner();
  setupFocusTimer();
  setupLibrary();
  setupFlashcards();
  setupConnectionStatus();
  setupLocalDataBackup();

  try {
    await openDatabase();
    await renderNotes();
  } catch (error) {
    console.error("Notes database error:", error);
    showToast(
      "Notes could not be opened. Your existing data has not been intentionally deleted.",
      "error"
    );
  }

  setupServiceWorker();

  // Keep the initial screen consistent with the existing HTML.
  const activeNav = $("[data-view].active");
  if (activeNav) {
    showView(activeNav.dataset.view);
  } else {
    showView("home");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
