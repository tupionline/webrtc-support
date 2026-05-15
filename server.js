const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Self-signed cert — required so mobile browsers allow camera on local network
const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 365, keySize: 2048 });
const server = https.createServer({ key: pems.private, cert: pems.cert }, app);
const wss = new WebSocketServer({ server });

// Single-session: only one customer and one agent at a time
const clients = {}; // { customer: ws, agent: ws }

wss.on('connection', (ws) => {
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      role = msg.role;

      // Kick previous connection for the same role
      if (clients[role] && clients[role] !== ws) {
        clients[role].close();
      }

      clients[role] = ws;
      console.log(`[${ts()}] ${role} connected`);

      // Notify both peers if the other is already present
      const other = peer(role);
      if (clients[other]?.readyState === ws.OPEN) {
        clients[other].send(JSON.stringify({ type: 'peer-joined', role }));
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }));
      }
      return;
    }

    // Relay all signalling messages to the other peer
    const other = peer(role);
    if (clients[other]?.readyState === ws.OPEN) {
      clients[other].send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    if (!role) return;
    if (clients[role] === ws) {
      delete clients[role];
      console.log(`[${ts()}] ${role} disconnected`);
      const other = peer(role);
      if (clients[other]?.readyState === ws.OPEN) {
        clients[other].send(JSON.stringify({ type: 'peer-left', role }));
      }
    }
  });

  ws.on('error', (err) => console.error(`[${ts()}] WS error (${role}):`, err.message));
});

function peer(role) { return role === 'customer' ? 'agent' : 'customer'; }
function ts() { return new Date().toTimeString().slice(0, 8); }

function getLocalIP() {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const PORT = 3000;
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅  WebRTC Support Server running\n');
  console.log(`  Agent    →  https://localhost:${PORT}/agent.html`);
  console.log(`  Customer →  https://${localIP}:${PORT}/customer.html\n`);
  console.log('⚠️  First visit: click "Advanced → Proceed" to accept the self-signed cert.\n');
});
