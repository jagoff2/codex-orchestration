import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Orchestrator } from './orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

const orchestrator = new Orchestrator();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/missions', (_req, res) => {
  res.json({ missions: orchestrator.listMissions() });
});

app.get('/api/missions/:id', (req, res) => {
  const mission = orchestrator.getMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  res.json({ mission });
});

app.post('/api/missions', async (req, res) => {
  const { goal, context } = req.body ?? {};
  if (!goal || typeof goal !== 'string') {
    res.status(400).json({ error: 'goal is required' });
    return;
  }
  try {
    const mission = await orchestrator.createMission({ goal, context });
    res.status(201).json({ mission });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const distDir = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

const server = http.createServer(app);
console.log(`[codex-orchestrator] Debug mode ${config.debug ? 'enabled' : 'disabled'}`);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(event) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

const forwardEvents = [
  'mission:created',
  'mission:planning',
  'mission:planned',
  'mission:executing',
  'mission:completed',
  'mission:failed',
  'agent:started',
  'agent:finished',
];

forwardEvents.forEach((eventName) => {
  orchestrator.on(eventName, (payload) => {
    broadcast({ type: eventName, payload });
  });
});

orchestrator.runner.on('event', (payload) => broadcast({ type: 'codex:event', payload }));
orchestrator.runner.on('stderr', (payload) => broadcast({ type: 'codex:stderr', payload }));
orchestrator.runner.on('timeout', (payload) => broadcast({ type: 'codex:timeout', payload }));
orchestrator.runner.on('spawn', (payload) => broadcast({ type: 'codex:spawn', payload }));

server.listen(config.server.port, config.server.host, () => {
  console.log(`Orchestrator server listening on http://${config.server.host}:${config.server.port}`);
});
