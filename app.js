"use strict";

const DB_NAME = "developer_mastermind_db";
const DB_VERSION = 1;
const STORE_NAME = "notes";

let db = null;
let currentNoteId = null;
let currentView = "home";
let deferredInstallPrompt = null;
let toastTimer = null;

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
      "Plan your study sessions, organise deadlines and manage reminders. This module will be added in a later phase."
  },
  focus: {
    title: "Focus Timer",
    icon: "◉",
    description:
      "A Pomodoro timer, custom focus sessions and study history are planned for this module."
  },
  library: {
    title: "Photo & PDF Library",
    icon: "▧",
    description:
      "Organise photos, files and PDFs locally. OCR and document tools will be added in a later phase."
  },
  flashcards: {
    title: "Flashcards & Revision",
    icon: "▱",
    description:
      "Create study cards, review important topics and track your revision progress in a future module."
  }
};

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support IndexedDB."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id"
        });

        store.createIndex("updatedAt", "updatedAt", {
          unique: false
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getNote(id) {
  return new Promise((resolve, reject) => {
    const request = getStore().get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putNote(note) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(note);

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
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
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
  elements.toast.textContent = message;
  elements.toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2600);
}

function setSaveStatus(message, saved = false) {
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle("saved", saved);
}

function getSearchTerm() {
  return currentView === "notes"
    ? elements.notesSearch.value.trim().toLocaleLowerCase()
    : elements.search.value.trim().toLocaleLowerCase();
}

function filterNotes(notes, term) {
  if (!term) return notes;

  return notes.filter((note) => {
    const searchableText = [
      note.title,
      note.content
    ].join(" ").toLocaleLowerCase();

    return searchableText.includes(term);
  });
}

function noteCardHTML(note) {
  const title = escapeHTML(note.title || "Untitled note");
  const content = escapeHTML(note.content || "No content yet.");
  const date = escapeHTML(formatDate(note.updatedAt));
  const colors = ["#8a7cff", "#4c9ce8", "#27b68a", "#e9a34f"];
  const color = colors[(String(note.id).charCodeAt(0) || 0) % colors.length];

  return `
    <article class="note-card"
      style="--note-accent: ${color}"
      data-note-id="${escapeHTML(note.id)}"
      tabindex="0"
      role="button"
      aria-label="Open note: ${title}">
      <div class="note-card-top">
        <span class="note-type">PERSONAL NOTE</span>
        <span class="note-date">${date}</span>
      </div>
      <div class="note-title">${title}</div>
      <div class="note-preview">${content}</div>
      <div class="note-card-bottom">
        <span>Stored locally</span>
        <span class="note-open">Open →</span>
      </div>
    </article>
  `;
}

function emptyStateHTML(hasSearch) {
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
      <p>Create a note to save what you learn. Your note will stay on this device.</p>
      <button class="primary-button" data-action="new-note">＋ Create a note</button>
    </div>
  `;
}

async function renderNotes() {
  try {
    const allNotes = await getAllNotes();

    allNotes.sort((a, b) => {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    elements.totalNotes.textContent = String(allNotes.length);

    const dashboardResults = filterNotes(
      allNotes,
      elements.search.value.trim().toLocaleLowerCase()
    ).slice(0, 6);

    const allResults = filterNotes(
      allNotes,
      elements.notesSearch.value.trim().toLocaleLowerCase()
    );

    elements.notesGrid.innerHTML = dashboardResults.length
      ? dashboardResults.map(noteCardHTML).join("")
      : emptyStateHTML(Boolean(elements.search.value.trim()));

    elements.allNotesGrid.innerHTML = allResults.length
      ? allResults.map(noteCardHTML).join("")
      : emptyStateHTML(Boolean(elements.notesSearch.value.trim()));
  } catch (error) {
    console.error("Could not load notes:", error);
    showToast("Could not load notes. Please reload the app.");
  }
}

function showView(view) {
  currentView = view;

  elements.dashboard.classList.toggle("hidden", view !== "home");
  elements.notes.classList.toggle("hidden", view !== "notes");
  elements.editor.classList.toggle("hidden", view !== "editor");
  elements.placeholder.classList.toggle(
    "hidden",
    !Object.prototype.hasOwnProperty.call(placeholderPages, view)
  );

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const titles = {
    home: "Dashboard",
    notes: "My Notes",
    editor: "Note Editor"
  };

  elements.breadcrumb.textContent =
    titles[view] || placeholderPages[view]?.title || "Dashboard";

  elements.sidebar.classList.remove("open");

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

async function createNewNote() {
  currentNoteId = null;

  elements.title.value = "";
  elements.content.value = "";
  elements.editorDate.textContent = "New note";
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

    currentNoteId = note.id;
    elements.title.value = note.title || "";
    elements.content.value = note.content || "";
    elements.editorDate.textContent = "Last edited " + formatDate(note.updatedAt);
    setSaveStatus("Saved on this device", true);

    showView("editor");
  } catch (error) {
    console.error(error);
    showToast("Could not open this note.");
  }
}

async function saveCurrentNote(showMessage = true) {
  const title = elements.title.value.trim();
  const content = elements.content.value;

  if (!title && !content.trim()) {
    setSaveStatus("Nothing to save");
    return;
  }

  const now = new Date().toISOString();
  let original = null;

  if (currentNoteId) {
    original = await getNote(currentNoteId);
  }

  const note = {
    id: currentNoteId || makeId(),
    title: title || "Untitled note",
    content,
    createdAt: original?.createdAt || now,
    updatedAt: now
  };

  setSaveStatus("Saving…");

  try {
    await putNote(note);
    currentNoteId = note.id;
    elements.editorDate.textContent = "Last edited " + formatDate(now);
    setSaveStatus("Saved on this device", true);

    await renderNotes();

    if (showMessage) {
      showToast("Note saved on this device.");
    }
  } catch (error) {
    console.error("Save failed:", error);
    setSaveStatus("Save failed");
    showToast("Could not save. Check available device storage.");
  }
}

async function deleteCurrentNote() {
  if (!currentNoteId) {
    showView("notes");
    return;
  }

  const confirmed = window.confirm(
    "Delete this note permanently? This starter version does not have a trash or restore feature yet."
  );

  if (!confirmed) return;

  try {
    await deleteNoteFromDatabase(currentNoteId);
    currentNoteId = null;
    await renderNotes();
    showView("notes");
    showToast("Note deleted.");
  } catch (error) {
    console.error(error);
    showToast("Could not delete this note.");
  }
}

function setTheme(theme) {
  const allowed = ["light", "dark", "system"];

  if (!allowed.includes(theme)) {
    theme = "system";
  }

  try {
    localStorage.setItem("dm_theme", theme);
  } catch (error) {
    console.warn("Theme preference could not be saved.", error);
  }

  applyTheme(theme);
}

function applyTheme(theme) {
  const prefersDark = window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const effectiveTheme =
    theme === "system" ? (prefersDark ? "dark" : "light") : theme;

  document.documentElement.dataset.theme = effectiveTheme;

  const themeButton = $("#themeButton");
  themeButton.textContent =
    effectiveTheme === "dark" ? "☼" : "◐";

  themeButton.title = "Current theme: " + theme + ". Click to change.";
  themeButton.setAttribute("aria-label", "Current theme: " + theme + ". Change theme.");
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

function openNoteFromCard(event) {
  const card = event.target.closest("[data-note-id]");

  if (card) {
    openNote(card.dataset.noteId);
    return;
  }

  const createButton = event.target.closest('[data-action="new-note"]');

  if (createButton) {
    createNewNote();
  }
}

function setupNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
    });
  });

  $("#newNoteButton").addEventListener("click", createNewNote);
  $("#heroNoteButton").addEventListener("click", createNewNote);
  $("#notesNewButton").addEventListener("click", createNewNote);
  $("#viewAllNotes").addEventListener("click", () => showView("notes"));
  $("#backToNotes").addEventListener("click", () => showView("notes"));
  $("#saveNoteButton").addEventListener("click", () => saveCurrentNote(true));
  $("#deleteNoteButton").addEventListener("click", deleteCurrentNote);
  $("#themeButton").addEventListener("click", cycleTheme);

  $("#placeholderNotesButton").addEventListener("click", () => showView("notes"));

  $("#menuButton").addEventListener("click", () => {
    elements.sidebar.classList.toggle("open");
  });

  elements.search.addEventListener("input", renderNotes);
  elements.notesSearch.addEventListener("input", renderNotes);

  elements.notesGrid.addEventListener("click", openNoteFromCard);
  elements.allNotesGrid.addEventListener("click", openNoteFromCard);

  for (const grid of [elements.notesGrid, elements.allNotesGrid]) {
    grid.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target.matches("[data-note-id]")
      ) {
        event.preventDefault();
        openNote(event.target.dataset.noteId);
      }
    });
  }

  let autosaveTimer = null;

  const scheduleAutosave = () => {
    setSaveStatus("Unsaved changes");

    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      saveCurrentNote(false);
    }, 700);
  };

  elements.title.addEventListener("input", scheduleAutosave);
  elements.content.addEventListener("input", scheduleAutosave);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installButton").title = "Install app";
  });

  $("#installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast(
        "Use your browser menu and choose Install app or Add to Home screen."
      );
      return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
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

        if (theme === "system") {
          applyTheme("system");
        }
      });
  }
}

async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    $("#offlineStatus").textContent = "Limited";
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
    $("#offlineStatus").textContent = "Ready";
  } catch (error) {
    console.error("Service worker registration failed:", error);
    $("#offlineStatus").textContent = "Limited";
  }
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  $("#connectionText").textContent = online
    ? "Local workspace"
    : "Offline mode";

  $("#offlineStatus").textContent = online ? "Ready" : "Offline";
}

async function init() {
  setupTheme();
  setupNavigation();
  updateConnectionStatus();

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  try {
    db = await openDatabase();
    await renderNotes();
    await setupServiceWorker();
  } catch (error) {
    console.error("App startup failed:", error);
    showToast(
      "Local database could not start. Please use an updated browser."
    );
    $("#offlineStatus").textContent = "Check browser";
  }
}

document.addEventListener("DOMContentLoaded", init);
