# Full-Stack Offline-First To-Do Application

A robust, full-stack To-Do application built with **Vanilla JavaScript** on the frontend and **Node.js/Express** on the backend. This app is architected with an **offline-first philosophy**, utilizing `localStorage` for instant UI rendering alongside a resilient background synchronization engine featuring automatic retry mechanisms and conflict resolution.

---
## Project Demo Video
https://github.com/user-attachments/assets/005c5a8d-6064-4b85-a8c4-7afa6e67534f

## Features

*   **Instant UI Updates (Optimistic UI):** User mutations (add, toggle, delete, edit) update the UI and local storage instantly—eliminating network lag.
*   **Bi-directional Data Sync:** Automatically syncs local changes to the server periodically (every 30 seconds) and instantly upon user interaction.
*   **Conflict Resolution:** Implements a **Last-Edit-Wins** strategy. If data changes on both the client and server, the latest timestamp (`updatedAt`) determines the ground truth.
*   **Network Resiliency:** 
    *   Gracefully falls back to local storage if the backend server is unreachable.
    *   An **Exponential Backoff Retry Mechanism** automatically attempts reconnection during network blips.
    *   Live **Sync Status Indicator** (`● Synced`, `○ Offline`, or `🔄 Retrying...`).
*   **Advanced Task Management:** 
    *   Priority levels (High, Medium, Low) with visual badges.
    *   Due dates tracking.
    *   Filter and sort features by date, priority, or completion status.
*   **Multi-Step Undo System:** A temporary toast notification allows you to undo deletions or modifications seamlessly.

---

## Tech Stack

*   **Frontend:** Vanilla JS (ES6+), HTML5, CSS3 (Modern, responsive flexbox/grid layout)
*   **Backend:** Node.js, Express.js
*   **Persistence:** `localStorage` (Client) & JSON File Backup via Node `fs/promises` (Server)

---

## Getting Started
Prerequisites
Make sure you have Node.js installed on your machine.

1. Installation
  Navigate to the project root directory and install the required dependencies:
  Bash
  npm install

2. Running the App
  Start the Express server:
  Bash
  npm start
  The server will boot up and automatically initialize the data/tasks.json file as an empty array [] if it doesn't already exist.

3. Open the Application
  Open your web browser and navigate to:
  Plaintext
  http://localhost:3000

## Testing Scenarios
To verify the app's structural integrity, try testing these scenarios:

1.Test Offline Functionality:

  Open your browser's Developer Tools (F12), go to the Network tab, and toggle Offline mode.

  Add or toggle tasks. Notice the UI updates instantly and the indicator switches to ○ Offline.

  Toggle Online mode back on. Watch the indicator shift to 🔄 Retrying... and then successfully push your changes back to the server.

2.Test Hard Refresh Persistence:

  Add a few items, modify their priorities, and hit Ctrl + R (or Cmd + R). The exact state will reload instantly from localStorage while seamlessly validating with the backend.

3.Test Server Crash Recovery:

  Stop your terminal process (Ctrl + C in your terminal).

  Keep using the web app. Start making changes.

  Restart the server (npm start). The frontend will automatically catch the heartbeat, reconnect, and push all backlogged edits via the Last-Edit-Wins protocol.
