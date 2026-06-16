const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure tasks.json exists and is initialized
async function initStorage() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.access(DATA_FILE);
    } catch {
      // File does not exist, initialize with empty array
      await fs.writeFile(DATA_FILE, JSON.stringify([], null, 2), 'utf-8');
      console.log('Initialized tasks.json with an empty array.');
    }
  } catch (error) {
    console.error('Error initializing storage:', error);
  }
}

// GET /api/tasks - Read and return the JSON array of tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    const tasks = JSON.parse(data);
    res.json(tasks);
  } catch (error) {
    console.error('Error reading tasks:', error);
    // If read fails for some reason (e.g. corruption), fallback to empty list
    res.status(500).json({ error: 'Failed to read tasks from storage' });
  }
});

// POST /api/tasks - Receive full client state and overwrite storage (last write wins)
app.post('/api/tasks', async (req, res) => {
  try {
    const tasks = req.body;
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Payload must be a JSON array of tasks' });
    }
    await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving tasks:', error);
    res.status(500).json({ error: 'Failed to save tasks' });
  }
});

// Fallback for SPA or serving index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server after initializing storage
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
});
