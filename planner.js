
"use strict";

/* DEVELOPER MASTERMIND — STUDY PLANNER
   Separate local storage; does not modify the Notes database.
*/

(() => {
  const STORAGE_KEY = "dm_study_planner_v1";
  let tasks = [];
  let activeFilter = "all";
  let editingId = null;
  let reminderTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);

  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);

  const makeId = () => (
    window.crypto?.randomUUID?.() ||
    Date.now().toString(36) + Math.random().toString(36).slice(2)
  );

  const localDate = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const formatDate = (value) => {
    if (!value) return "No deadline";
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? "No deadline"
      : new Intl.DateTimeFormat(undefined, {
          day: "numeric", month: "short", year: "numeric"
        }).format(date);
  };

  function loadTasks() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      tasks = Array.isArray(stored)
        ? stored.filter((task) =>
            task && typeof task.id === "string" &&
            typeof task.title === "string"
          )
        : [];
    } catch (error) {
      console.warn("Planner data could not be read.", error);
      tasks = [];
    }
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      return true;
    } catch (error) {
      console.error("Planner save failed:", error);
      toast("Could not save. Check browser storage space/settings.");
      return false;
    }
  }

  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove("show"), 3000);
  }

  function getPage() {
    let page = $("#plannerModuleView");
    if (page) return page;

    page = document.createElement("section");
    page.id = "plannerModuleView";
    page.className = "page hidden";
    page.innerHTML = `
      <div class="page-heading planner-heading">
        <div>
          <div class="eyebrow">YOUR PERSONAL STUDY PLAN</div>
          <h1>Study <span class="gradient-text">Planner.</span></h1>
          <p class="subtitle">Break your goals into small, manageable tasks.</p>
        </div>
        <button type="button" class="primary-button" id="plannerExport">Export tasks</button>
      </div>

      <div class="planner-stats" aria-live="polite">
        <article class="planner-stat">
          <span>Total tasks</span><strong id="plannerTotal">0</strong>
        </article>
        <article class="planner-stat">
          <span>Pending</span><strong id="plannerPending">0</strong>
        </article>
        <article class="planner-stat">
          <span>Completed</span><strong id="plannerCompleted">0</strong>
        </article>
        <article class="planner-stat">
          <span>Due today / overdue</span><strong id="plannerDue">0</strong>
        </article>
      </div>

      <div class="planner-panel">
        <h2 id="plannerFormHeading">Add a study task</h2>
        <form id="plannerForm">
          <label class="planner-field planner-full">
            Task title *
            <input id="plannerTitle" maxlength="160" required
              placeholder="e.g. Revise chapter 3">
          </label>

          <label class="planner-field">
            Subject
            <input id="plannerSubject" maxlength="80"
              placeholder="e.g. Biology">
          </label>

          <label class="planner-field">
            Deadline
            <input id="plannerDeadline" type="date">
          </label>

          <label class="planner-field">
            Priority
            <select id="plannerPriority">
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          </label>

          <label class="planner-field">
            Reminder (optional)
            <input id="plannerReminder" type="datetime-local">
          </label>

          <label class="planner-field planner-full">
            Notes (optional)
            <textarea id="plannerDetails" rows="3" maxlength="1500"
              placeholder="What do you want to cover?"></textarea>
          </label>

          <div class="planner-form-actions planner-full">
            <button class="primary-button" type="submit" id="plannerSubmit">
              Add task
            </button>
            <button class="secondary-button hidden" type="button" id="plannerCancel">
              Cancel edit
            </button>
            <button class="secondary-button" type="button" id="plannerEnableReminders">
              Enable reminders
            </button>
          </div>
          <p class="planner-help planner-full">
            Tasks are saved in this browser on this device. Reminders work only
            when this page is open; browser notifications depend on permission
            and browser support.
          </p>
        </form>
      </div>

      <div class="planner-list-panel">
        <div class="planner-list-heading">
          <div>
            <h2>Your tasks</h2>
            <p class="section-subtitle">Filter your work and track your progress.</p>
          </div>
          <label class="planner-search-label">
            <span class="sr-only">Search tasks</span>
            <input id="plannerSearch" type="search"
              placeholder="Search tasks..." autocomplete="off">
          </label>
        </div>

        <div class="planner-filters" role="group" aria-label="Filter tasks">
          <button type="button" data-planner-filter="all" class="active">All</button>
          <button type="button" data-planner-filter="pending">Pending</button>
          <button type="button" data-planner-filter="completed">Completed</button>
          <button type="button" data-planner-filter="today">Due today</button>
          <button type="button" data-planner-filter="overdue">Overdue</button>
        </div>

        <div id="plannerTaskList" class="planner-task-list" aria-live="polite"></div>
      </div>
    `;

    const footer = document.querySelector(".page-footer");
    if (footer?.parentNode) footer.parentNode.insertBefore(page, footer);
    else document.querySelector(".main-content")?.appendChild(page);

    return page;
  }

  function showPlanner() {
    const page = getPage();

    document.querySelectorAll(".main-content > .page").forEach((item) => {
      item.classList.add("hidden");
    });

    page.classList.remove("hidden");

    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === "planner");
    });

    const breadcrumb = $("#breadcrumbCurrent");
    if (breadcrumb) breadcrumb.textContent = "Study Planner";

    $("#sidebar")?.classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
  }

  function resetForm() {
    editingId = null;
    $("#plannerForm")?.reset();
    $("#plannerFormHeading").textContent = "Add a study task";
    $("#plannerSubmit").textContent = "Add task";
    $("#plannerCancel").classList.add("hidden");
  }

  function startEdit(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;

    editingId = id;
    $("#plannerTitle").value = task.title;
    $("#plannerSubject").value = task.subject || "";
    $("#plannerDeadline").value = task.deadline || "";
    $("#plannerPriority").value = task.priority || "medium";
    $("#plannerReminder").value = task.reminder || "";
    $("#plannerDetails").value = task.details || "";

    $("#plannerFormHeading").textContent = "Edit study task";
    $("#plannerSubmit").textContent = "Save changes";
    $("#plannerCancel").classList.remove("hidden");

    $("#plannerTitle").focus();
    $("#plannerForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleSubmit(event) {
    event.preventDefault();

    const title = $("#plannerTitle").value.trim();
    if (!title) {
      toast("Please enter a task title.");
      $("#plannerTitle").focus();
      return;
    }

    const deadline = $("#plannerDeadline").value;
    const reminder = $("#plannerReminder").value;
    const now = new Date().toISOString();

    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      toast("Please choose a valid deadline.");
      return;
    }

    if (reminder && Number.isNaN(new Date(reminder).getTime())) {
      toast("Please choose a valid reminder time.");
      return;
    }

    const oldTask = tasks.find((item) => item.id === editingId);

    const task = {
      id: editingId || makeId(),
      title,
      subject: $("#plannerSubject").value.trim().slice(0, 80),
      deadline,
      priority: $("#plannerPriority").value,
      reminder,
      details: $("#plannerDetails").value.trim().slice(0, 1500),
      completed: oldTask?.completed === true,
      createdAt: oldTask?.createdAt || now,
      updatedAt: now,
      notified: oldTask?.notified || false
    };

    const previousTasks = tasks.slice();

    if (editingId) {
      tasks = tasks.map((item) => item.id === editingId ? task : item);
    } else {
      tasks.unshift(task);
    }

    if (!saveTasks()) {
      tasks = previousTasks;
      return;
    }

    resetForm();
    render();
    toast(editingId ? "Task updated." : "Study task added.");
  }

  function toggleComplete(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;

    const previous = task.completed;
    task.completed = !previous;
    task.updatedAt = new Date().toISOString();

    if (!saveTasks()) {
      task.completed = previous;
      return;
    }

    render();
    toast(task.completed ? "Task completed. Well done!" : "Task marked pending.");
  }

  function deleteTask(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;

    if (!window.confirm(`Delete "${task.title}" from your planner?`)) return;

    const previous = tasks;
    tasks = tasks.filter((item) => item.id !== id);

    if (!saveTasks()) {
      tasks = previous;
      return;
    }

    if (editingId === id) resetForm();
    render();
    toast("Task deleted.");
  }

  function taskCard(task) {
    const today = localDate();
    const overdue = !task.completed && task.deadline && task.deadline < today;
    const dueToday = !task.completed && task.deadline === today;

    const deadlineText = task.deadline
      ? formatDate(task.deadline)
      : "No deadline";

    const statusText = task.completed
      ? "Completed"
      : overdue ? "Overdue"
      : dueToday ? "Due today" : "Pending";

    return `
      <article class="planner-task ${task.completed ? "is-completed" : ""}">
        <label class="planner-task-check">
          <input type="checkbox" data-task-action="toggle"
            data-task-id="${escapeHTML(task.id)}"
            ${task.completed ? "checked" : ""}
            aria-label="Mark ${escapeHTML(task.title)} completed">
        </label>

        <div class="planner-task-main">
          <div class="planner-task-top">
            <h3>${escapeHTML(task.title)}</h3>
            <span class="planner-priority priority-${escapeHTML(task.priority || "medium")}">
              ${escapeHTML((task.priority || "medium").toUpperCase())}
            </span>
          </div>

          <div class="planner-task-meta">
            ${task.subject ? `<span>📚 ${escapeHTML(task.subject)}</span>` : ""}
            <span>📅 ${escapeHTML(deadlineText)}</span>
            <span class="${overdue ? "planner-overdue" : ""}">${escapeHTML(statusText)}</span>
          </div>

          ${task.details
            ? `<p class="planner-task-details">${escapeHTML(task.details)}</p>`
            : ""}

          ${task.reminder
            ? `<p class="planner-task-reminder">🔔 Reminder: ${escapeHTML(
                new Date(task.reminder).toLocaleString()
              )}</p>`
            : ""}

          <div class="planner-task-actions">
            <button type="button" data-task-action="edit"
              data-task-id="${escapeHTML(task.id)}">Edit</button>
            <button type="button" data-task-action="delete"
              data-task-id="${escapeHTML(task.id)}">Delete</button>
          </div>
        </div>
      </article>
    `;
  }

  function render() {
    const page = getPage();
    if (page.classList.contains("hidden")) return;

    const today = localDate();
    const pending = tasks.filter((task) => !task.completed);
    const completed = tasks.filter((task) => task.completed);
    const due = pending.filter((task) => task.deadline && task.deadline <= today);

    $("#plannerTotal").textContent = String(tasks.length);
    $("#plannerPending").textContent = String(pending.length);
    $("#plannerCompleted").textContent = String(completed.length);
    $("#plannerDue").textContent = String(due.length);

    document.querySelectorAll("[data-planner-filter]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.plannerFilter === activeFilter
      );
    });

    const query = ($("#plannerSearch").value || "").trim().toLocaleLowerCase();

    const filtered = tasks.filter((task) => {
      if (activeFilter === "pending" && task.completed) return false;
      if (activeFilter === "completed" && !task.completed) return false;
      if (activeFilter === "today" &&
          (task.completed || task.deadline !== today)) return false;
      if (activeFilter === "overdue" &&
          (task.completed || !task.deadline || task.deadline >= today)) return false;

      const searchText = [
        task.title, task.subject, task.details, task.priority
      ].join(" ").toLocaleLowerCase();

      return !query || searchText.includes(query);
    });

    filtered.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;

      const dateA = a.deadline || "9999-12-31";
      const dateB = b.deadline || "9999-12-31";
      if (dateA !== dateB) return dateA.localeCompare(dateB);

      const priorityRank = { high: 0, medium: 1, low: 2 };
      return (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    });

    $("#plannerTaskList").innerHTML = filtered.length
      ? filtered.map(taskCard).join("")
      : `<div class="planner-empty">
           <div class="empty-state-icon">✓</div>
           <h3>No tasks found</h3>
           <p>Add a study task or choose another filter.</p>
         </div>`;
  }

  async function enableReminders() {
    if (!("Notification" in window)) {
      toast("This browser does not support notifications.");
      return;
    }

    if (!window.isSecureContext) {
      toast("Notifications need a secure HTTPS page.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        toast("Reminders enabled while this page is open.");
        checkReminders();
      } else {
        toast("Notification permission was not granted.");
      }
    } catch (error) {
      console.warn("Notification permission failed:", error);
      toast("Could not enable notifications in this browser.");
    }
  }

  function checkReminders() {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const now = Date.now();
    let changed = false;

    tasks.forEach((task) => {
      if (!task.completed && task.reminder && !task.notified &&
          new Date(task.reminder).getTime() <= now) {
        try {
          new Notification("Study reminder", {
            body: task.title,
            tag: `dm-planner-${task.id}`
          });
          task.notified = true;
          changed = true;
        } catch (error) {
          console.warn("Notification could not be displayed.", error);
        }
      }
    });

    if (changed) saveTasks();
  }

  function exportTasks() {
    const payload = {
      app: "Developer MASTERMIND Study Planner",
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mastermind-study-plan-${localDate()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Planner backup exported.");
  }

  function setupEvents() {
    const page = getPage();

    $("#plannerForm").addEventListener("submit", handleSubmit);
    $("#plannerCancel").addEventListener("click", resetForm);
    $("#plannerEnableReminders").addEventListener("click", enableReminders);
    $("#plannerExport").addEventListener("click", exportTasks);

    $("#plannerSearch").addEventListener("input", render);

    page.querySelectorAll("[data-planner-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.plannerFilter;
        render();
      });
    });

    $("#plannerTaskList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-action]");
      if (!button) return;

      const id = button.dataset.taskId;
      if (button.dataset.taskAction === "edit") startEdit(id);
      if (button.dataset.taskAction === "delete") deleteTask(id);
    });

    $("#plannerTaskList").addEventListener("change", (event) => {
      const input = event.target.closest('[data-task-action="toggle"]');
      if (input) toggleComplete(input.dataset.taskId);
    });

    // Capture navigation before app.js handles the same click.
    document.addEventListener("click", (event) => {
      const nav = event.target.closest(".nav-item[data-view]");
      if (!nav) return;

      if (nav.dataset.view === "planner") {
        event.preventDefault();
        event.stopImmediatePropagation();
        showPlanner();
      } else {
        $("#plannerModuleView")?.classList.add("hidden");
      }
    }, true);

    $("#placeholderNotesButton")?.addEventListener("click", () => {
      $("#plannerModuleView")?.classList.add("hidden");
    });

    reminderTimer = window.setInterval(checkReminders, 30 * 1000);
    window.addEventListener("focus", checkReminders);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkReminders();
    });
  }

  function init() {
    loadTasks();
    getPage();
    setupEvents();
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
