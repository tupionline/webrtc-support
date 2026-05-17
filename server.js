// Load .env in local development — split only on FIRST = so base64 values with = work
try {
  require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => {
    const i = l.indexOf('=');
    if (i > 0) {
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      if (k && v && !k.startsWith('#')) process.env[k] = v;
    }
  });
} catch {}

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));

// ── AI assist endpoint ────────────────────────────────────────────────────────
app.post('/ai-assist', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'AI not configured — set ANTHROPIC_API_KEY' });

  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image provided' });

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
          { type: 'text', text: `You are a remote technical support assistant. A customer is showing you their problem via camera.

Analyze this image and respond ONLY with valid JSON (no markdown, no extra text):
{
  "problem": "What you see and the likely issue (2-3 sentences)",
  "suggestions": [
    {
      "title": "Short fix title",
      "description": "One practical sentence of advice",
      "youtube": "search terms for a helpful YouTube tutorial"
    }
  ]
}

Provide 3-4 suggestions. If no clear problem is visible, describe what you see and suggest diagnostic steps.` }
        ]
      }]
    });

    const result = JSON.parse(msg.content[0].text.trim());
    res.json(result);
  } catch (e) {
    console.error(`[${ts()}] AI assist error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ICE config endpoint — keeps TURN credentials off the client bundle ──────
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: [
        `turn:${process.env.TURN_HOST || 'openrelay.metered.ca'}:80`,
        `turn:${process.env.TURN_HOST || 'openrelay.metered.ca'}:443`,
        `turns:${process.env.TURN_HOST || 'openrelay.metered.ca'}:443?transport=tcp`,
      ],
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

// ── Server: plain HTTP on Railway (TLS terminated at proxy), HTTPS locally ──
const PORT = process.env.PORT || 3000;
const isProd = !!process.env.PORT;

let server;
if (isProd) {
  const http = require('http');
  server = http.createServer(app);
} else {
  const https = require('https');
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 365, keySize: 2048 });
  server = https.createServer({ key: pems.private, cert: pems.cert }, app);
}

// ── WebSocket signalling ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = {}; // { customer: ws, agent: ws }

wss.on('connection', (ws) => {
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      role = msg.role;
      if (clients[role] && clients[role] !== ws) clients[role].close();
      clients[role] = ws;
      console.log(`[${ts()}] ${role} connected`);

      const other = peer(role);
      if (clients[other]?.readyState === ws.OPEN) {
        clients[other].send(JSON.stringify({ type: 'peer-joined', role }));
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }));
      }
      return;
    }

    const other = peer(role);
    if (clients[other]?.readyState === ws.OPEN) {
      clients[other].send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    if (!role || clients[role] !== ws) return;
    delete clients[role];
    console.log(`[${ts()}] ${role} disconnected`);
    const other = peer(role);
    if (clients[other]?.readyState === ws.OPEN)
      clients[other].send(JSON.stringify({ type: 'peer-left', role }));
  });

  ws.on('error', (err) => console.error(`[${ts()}] WS error (${role}):`, err.message));
});

function peer(role) { return role === 'customer' ? 'agent' : 'customer'; }
function ts() { return new Date().toTimeString().slice(0, 8); }

function getLocalIP() {
  for (const nets of Object.values(os.networkInterfaces()))
    for (const net of nets)
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  if (isProd) {
    console.log(`\n✅  WebRTC Support Server running (production) on port ${PORT}\n`);
  } else {
    const localIP = getLocalIP();
    console.log('\n✅  WebRTC Support Server running (local)\n');
    console.log(`  Agent    →  https://localhost:${PORT}/agent.html`);
    console.log(`  Customer →  https://${localIP}:${PORT}/customer.html\n`);
    console.log('⚠️  First visit: click "Advanced → Proceed" to accept the self-signed cert.\n');
  }
});
