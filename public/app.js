/**
 * SynchroList - Frontend State, Sync Engine, and Logic
 */

// Application State
let tasks = [];
let historyStack = [];
const MAX_HISTORY = 5;

// Sync Engine State
let syncStatus = 'synced'; // 'synced', 'offline', 'syncing'
let retryCount = 0;
let retryTimer = null;
const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const PERIODIC_SYNC_INTERVAL_MS = 30000;

// Filter & Sort State
let currentFilter = 'all'; // 'all', 'active', 'completed'
let searchQuery = '';
let currentSort = 'createdAt'; // 'dueDate', 'priority', 'status', 'createdAt'

// DOM Elements
const todoForm = document.getElementById('todo-form');
const taskTextInput = document.getElementById('task-text');
const taskPriorityInput = document.getElementById('task-priority');
const taskDueDateInput = document.getElementById('task-due-date');
const todoListContainer = document.getElementById('todo-list');
const syncIndicator = document.getElementById('sync-indicator');
const syncText = document.getElementById('sync-text');
const statsTotal = document.getElementById('stats-total');
const statsCompleted = document.getElementById('stats-completed');
const statsCompletionRate = document.getElementById('stats-completion-rate');
const filterSearch = document.getElementById('filter-search');
const sortSelect = document.getElementById('sort-select');
const filterBtns = document.querySelectorAll('.filter-btn');
const toastContainer = document.getElementById('toast-container');

// Set default due date to today
const today = new Date().toISOString().split('T')[0];
taskDueDateInput.value = today;
taskDueDateInput.min = today;

/**
 * ----------------------------------------------------
 * LOCAL STORAGE & STATE PERSISTENCE
 * ----------------------------------------------------
 */

// Save state to LocalStorage
function saveToLocal() {
  localStorage.setItem('synchrolist_tasks', JSON.stringify(tasks));
}

// Load state from LocalStorage
function loadFromLocal() {
  const localData = localStorage.getItem('synchrolist_tasks');
  return localData ? JSON.parse(localData) : [];
}

// Get tombstones of deleted tasks (to prevent resurrected tasks on merge)
function getDeletedTombstones() {
  const tombstones = localStorage.getItem('synchrolist_tombstones');
  return tombstones ? JSON.parse(tombstones) : {};
}

// Save tombstone for a deleted task
function saveDeletedTombstone(taskId) {
  const tombstones = getDeletedTombstones();
  tombstones[taskId] = Date.now();
  localStorage.setItem('synchrolist_tombstones', JSON.stringify(tombstones));
}

// Remove tombstone (e.g. if task is re-added or during cleanup)
function removeDeletedTombstone(taskId) {
  const tombstones = getDeletedTombstones();
  delete tombstones[taskId];
  localStorage.setItem('synchrolist_tombstones', JSON.stringify(tombstones));
}

/**
 * ----------------------------------------------------
 * HISTORY / UNDO SYSTEM
 * ----------------------------------------------------
 */

// Push a copy of current tasks array onto history stack
function pushHistory() {
  if (historyStack.length >= MAX_HISTORY) {
    historyStack.shift(); // Remove oldest
  }
  // Deep copy tasks
  historyStack.push(JSON.parse(JSON.stringify(tasks)));
}

// Trigger undo operation
function undo() {
  if (historyStack.length === 0) return;
  
  const previousState = historyStack.pop();
  
  // Track which IDs are being restored vs removed to adjust tombstones
  const currentIds = tasks.map(t => t.id);
  const previousIds = previousState.map(t => t.id);
  
  // If a task is restored, remove its deletion tombstone
  previousIds.forEach(id => {
    if (!currentIds.includes(id)) {
      removeDeletedTombstone(id);
    }
  });

  // If a task restoration deletes a newly created task, we add it to tombstones
  currentIds.forEach(id => {
    if (!previousIds.includes(id)) {
      saveDeletedTombstone(id);
    }
  });

  tasks = previousState;
  saveToLocal();
  renderUI();
  triggerSync();
  showToast('Action undone successfully!', false);
}

// Display a floating undo notification toast
function showToast(message, allowUndo = true) {
  // Clear existing toasts first to prevent clutter
  toastContainer.innerHTML = '';

  const toast = document.createElement('div');
  toast.className = 'toast';
  
  const textSpan = document.createElement('span');
  textSpan.className = 'toast-message';
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (allowUndo && historyStack.length > 0) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn-undo';
    undoBtn.textContent = 'Undo';
    undoBtn.onclick = () => {
      undo();
      toast.classList.add('animate-out');
      setTimeout(() => toast.remove(), 300);
    };
    toast.appendChild(undoBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-toast';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = () => {
    toast.classList.add('animate-out');
    setTimeout(() => toast.remove(), 300);
  };
  toast.appendChild(closeBtn);

  toastContainer.appendChild(toast);

  // Automatically remove toast after 5 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('animate-out');
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

/**
 * ----------------------------------------------------
 * MERGE & CONFLICT RESOLUTION ALGORITHM
 * ----------------------------------------------------
 */

/**
 * Merge local tasks and server tasks using Last-Edit-Wins based on updatedAt timestamp.
 * Integrates deletion tombstones to ensure deleted tasks do not reappear on sync.
 */
function mergeState(localTasks, serverTasks) {
  const mergedMap = new Map();
  const tombstones = getDeletedTombstones();

  // 1. Process local tasks
  localTasks.forEach(task => {
    mergedMap.set(task.id, task);
  });

  // 2. Merge server tasks
  serverTasks.forEach(serverTask => {
    const localTask = mergedMap.get(serverTask.id);
    const tombstoneTime = tombstones[serverTask.id];

    // Check if task has been deleted locally
    if (tombstoneTime && tombstoneTime >= serverTask.updatedAt) {
      // Server task is older than local deletion, ignore it
      mergedMap.delete(serverTask.id);
      return;
    }

    if (localTask) {
      // Task exists in both: choose the one with the highest updatedAt
      if (serverTask.updatedAt > localTask.updatedAt) {
        mergedMap.set(serverTask.id, serverTask);
      }
    } else {
      // Task exists only on server
      mergedMap.set(serverTask.id, serverTask);
    }
  });

  return Array.from(mergedMap.values());
}

/**
 * ----------------------------------------------------
 * SYNC ENGINE (REST Client + Exponential Backoff)
 * ----------------------------------------------------
 */

// Update visual sync state indicator
function updateSyncStatus(status) {
  syncStatus = status;
  syncIndicator.className = 'sync-indicator';
  
  if (status === 'synced') {
    syncIndicator.classList.add('status-synced');
    syncText.textContent = 'Synced';
  } else if (status === 'offline') {
    syncIndicator.classList.add('status-offline');
    syncText.textContent = 'Offline - Saving Locally';
  } else if (status === 'syncing') {
    syncIndicator.classList.add('status-syncing');
    syncText.textContent = retryCount > 0 ? `Retrying (${retryCount})...` : 'Syncing...';
  }
}

// Trigger an immediate sync request
function triggerSync() {
  // Clear any pending retry timer as we are initiating a new sync action
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  syncWithServer();
}

// Asynchronously POST client state to backend server with retry logic
async function syncWithServer() {
  updateSyncStatus('syncing');

  try {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(tasks)
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    // Success! Reset retries and flag synced
    retryCount = 0;
    updateSyncStatus('synced');
  } catch (error) {
    console.warn('Sync failed:', error);
    
    // Increment retry and schedule backoff retry
    retryCount++;
    const nextRetryMs = Math.min(
      BACKOFF_INITIAL_MS * Math.pow(2, retryCount - 1),
      BACKOFF_MAX_MS
    );
    
    updateSyncStatus('offline');
    
    console.log(`Scheduling retry in ${nextRetryMs / 1000}s (Attempt ${retryCount})`);
    retryTimer = setTimeout(() => {
      syncWithServer();
    }, nextRetryMs);
  }
}

// Initial pull on dashboard load
async function loadAndSyncInitialState() {
  updateSyncStatus('syncing');
  const localList = loadFromLocal();
  tasks = localList; // Load locally first for instant rendering
  renderUI();

  try {
    const response = await fetch('/api/tasks');
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }
    const serverList = await response.json();
    
    // Run merging conflict resolution
    const mergedList = mergeState(localList, serverList);
    
    tasks = mergedList;
    saveToLocal();
    renderUI();
    
    // Propagate merged state back to the server so both are clean
    updateSyncStatus('synced');
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasks)
    });
  } catch (error) {
    console.error('Initial sync fetch failed. Operating offline.', error);
    updateSyncStatus('offline');
  }
}

/**
 * ----------------------------------------------------
 * MUTATIONS & EVENT HANDLERS
 * ----------------------------------------------------
 */

// Add new task
todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const text = taskTextInput.value.trim();
  const priority = taskPriorityInput.value;
  const dueDate = taskDueDateInput.value;
  
  if (!text || !priority || !dueDate) return;

  pushHistory();

  const newTask = {
    id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    text,
    completed: false,
    priority,
    dueDate,
    updatedAt: Date.now()
  };

  // If we had a tombstone for this ID (unlikely but possible), clear it
  removeDeletedTombstone(newTask.id);

  tasks.unshift(newTask);
  saveToLocal();
  renderUI();
  
  // Clear and reset form input
  taskTextInput.value = '';
  taskPriorityInput.value = 'medium';
  taskDueDateInput.value = today;

  triggerSync();
  showToast('Task added successfully!');
});

// Toggle completed status
function toggleTask(id) {
  pushHistory();
  
  tasks = tasks.map(task => {
    if (task.id === id) {
      return {
        ...task,
        completed: !task.completed,
        updatedAt: Date.now()
      };
    }
    return task;
  });

  saveToLocal();
  renderUI();
  triggerSync();
}

// Delete task
function deleteTask(id) {
  pushHistory();
  
  const taskToDelete = tasks.find(t => t.id === id);
  const taskName = taskToDelete ? `"${taskToDelete.text.substring(0, 20)}..."` : 'Task';

  // Record tombstone for offline-safe deletion sync
  saveDeletedTombstone(id);

  tasks = tasks.filter(task => task.id !== id);
  saveToLocal();
  renderUI();
  triggerSync();
  showToast(`${taskName} deleted.`);
}

// Edit a task's inline values (Priority or Due Date changes dynamically)
function updateTaskDetails(id, fields) {
  pushHistory();
  
  tasks = tasks.map(task => {
    if (task.id === id) {
      return {
        ...task,
        ...fields,
        updatedAt: Date.now()
      };
    }
    return task;
  });

  saveToLocal();
  renderUI();
  triggerSync();
}

/**
 * ----------------------------------------------------
 * SORTING, FILTERING & RENDER ENGINE
 * ----------------------------------------------------
 */

// Filter and Sort Handler setup
filterSearch.addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase();
  renderUI();
});

sortSelect.addEventListener('change', (e) => {
  currentSort = e.target.value;
  renderUI();
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderUI();
  });
});

// Priority weight mapper for sorting
const priorityWeight = {
  high: 3,
  medium: 2,
  low: 1
};

// Render tasks list and metrics
function renderUI() {
  // 1. Filter tasks
  let filteredTasks = tasks.filter(task => {
    // Search match
    const matchesSearch = task.text.toLowerCase().includes(searchQuery);
    
    // Status filter match
    let matchesStatus = true;
    if (currentFilter === 'active') {
      matchesStatus = !task.completed;
    } else if (currentFilter === 'completed') {
      matchesStatus = task.completed;
    }
    
    return matchesSearch && matchesStatus;
  });

  // 2. Sort tasks
  filteredTasks.sort((a, b) => {
    if (currentSort === 'dueDate') {
      return new Date(a.dueDate) - new Date(b.dueDate);
    }
    if (currentSort === 'priority') {
      return priorityWeight[b.priority] - priorityWeight[a.priority];
    }
    if (currentSort === 'status') {
      return (a.completed === b.completed) ? 0 : a.completed ? 1 : -1;
    }
    if (currentSort === 'createdAt') {
      // Extract timestamp from ID or updatedAt
      return b.updatedAt - a.updatedAt;
    }
    return 0;
  });

  // 3. Clear container
  todoListContainer.innerHTML = '';

  // 4. Render elements
  if (filteredTasks.length === 0) {
    todoListContainer.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
        <h3>No tasks found</h3>
        <p>${searchQuery || currentFilter !== 'all' ? 'Try adjusting your filters or search terms.' : 'Create your first task above!'}</p>
      </div>
    `;
  } else {
    filteredTasks.forEach(task => {
      const isOverdue = !task.completed && new Date(task.dueDate) < new Date(today);
      
      const todoItem = document.createElement('div');
      todoItem.className = `todo-item ${task.completed ? 'completed' : ''}`;
      
      todoItem.innerHTML = `
        <div class="todo-item-left">
          <input type="checkbox" class="todo-checkbox" ${task.completed ? 'checked' : ''} aria-label="Toggle task completion">
          <div class="todo-details">
            <span class="todo-text">${escapeHTML(task.text)}</span>
            <div class="todo-meta">
              <span class="todo-badge badge-priority-${task.priority}">${task.priority}</span>
              <span class="todo-due-date ${isOverdue ? 'overdue' : ''}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                ${formatDateDisplay(task.dueDate)} ${isOverdue ? '(Overdue)' : ''}
              </span>
            </div>
          </div>
        </div>
        
        <div class="todo-item-actions">
          <!-- Edit priority inline -->
          <div class="select-wrapper select-sm" style="width: auto;">
            <select class="select-priority-edit" aria-label="Edit priority">
              <option value="low" ${task.priority === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${task.priority === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${task.priority === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>

          <!-- Edit due date inline -->
          <input type="date" class="date-edit-inline" value="${task.dueDate}" min="${today}" aria-label="Edit due date" style="width: 120px; padding: 0.2rem 0.5rem; font-size: 0.85rem;">

          <button class="btn-action btn-action-delete" title="Delete Task" aria-label="Delete task">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>
      `;

      // Attach Event Listeners to inner controls
      const checkbox = todoItem.querySelector('.todo-checkbox');
      checkbox.addEventListener('change', () => toggleTask(task.id));

      const priorityEdit = todoItem.querySelector('.select-priority-edit');
      priorityEdit.addEventListener('change', (e) => updateTaskDetails(task.id, { priority: e.target.value }));

      const dateEdit = todoItem.querySelector('.date-edit-inline');
      dateEdit.addEventListener('change', (e) => updateTaskDetails(task.id, { dueDate: e.target.value }));

      const deleteBtn = todoItem.querySelector('.btn-action-delete');
      deleteBtn.addEventListener('click', () => deleteTask(task.id));

      todoListContainer.appendChild(todoItem);
    });
  }

  // 5. Update Metrics Panel
  updateStats();
}

// Calculate metrics
function updateStats() {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

  statsTotal.textContent = total;
  statsCompleted.textContent = completed;
  statsCompletionRate.textContent = `${rate}%`;
}

// Helper: Escape HTML to avoid XSS injections
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Helper: Format date string for human readability
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * ----------------------------------------------------
 * INITIALIZATION & HEARTBEAT/PERIODIC SYNC
 * ----------------------------------------------------
 */

// Initialize state
loadAndSyncInitialState();

// Start periodic sync every 30 seconds
setInterval(() => {
  if (syncStatus !== 'syncing') {
    console.log('Running periodic state check and sync...');
    syncWithServer();
  }
}, PERIODIC_SYNC_INTERVAL_MS);
