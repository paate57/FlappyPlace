// server.js
// Server Node.js per canvas collaborativo 2000x2000 pixel
// Versione ottimizzata per Render.com

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Configurazione
const CANVAS_SIZE = 2000;
const COOLDOWN_MS = 5000;
const UPDATE_BATCH_INTERVAL = 100;

// Palette di 16 colori fissi
const COLORS = [
  '#FFFFFF', '#E4E4E4', '#888888', '#222222',
  '#FFA7D1', '#E50000', '#E59500', '#A06A42',
  '#E5D900', '#94E044', '#02BE01', '#00D3DD',
  '#0083C7', '#0000EA', '#CF6EE4', '#820080'
];

// Stato del server - UN SOLO ARRAY per tutto il canvas
const canvas = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
const userCooldowns = new Map();
const pendingUpdates = [];
let _isSaving = false;

console.log(`Canvas inizializzato: ${CANVAS_SIZE}x${CANVAS_SIZE} pixel (${(canvas.length / 1024 / 1024).toFixed(2)} MB)`);

// Funzioni pixel
function getPixelIndex(x, y) {
  return y * CANVAS_SIZE + x;
}

function setPixel(x, y, colorIndex) {
  if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) return false;
  if (colorIndex < 0 || colorIndex >= COLORS.length) return false;
  canvas[getPixelIndex(x, y)] = colorIndex;
  return true;
}

function getPixel(x, y) {
  return canvas[getPixelIndex(x, y)];
}

// Ottieni una regione del canvas
function getRegion(x, y, width, height) {
  const region = new Uint8Array(width * height);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const worldX = x + dx;
      const worldY = y + dy;
      if (worldX >= 0 && worldX < CANVAS_SIZE && worldY >= 0 && worldY < CANVAS_SIZE) {
        region[dy * width + dx] = canvas[getPixelIndex(worldX, worldY)];
      }
    }
  }
  return region;
}

// Cooldown
function canUserDraw(userId) {
  const lastDraw = userCooldowns.get(userId);
  if (!lastDraw) return true;
  return Date.now() - lastDraw >= COOLDOWN_MS;
}

function updateUserCooldown(userId) {
  userCooldowns.set(userId, Date.now());
}

// Carica canvas da PNG
function loadCanvasFromPNG() {
  const savedPath = path.join(__dirname, 'canvas-snapshot.png');
  if (!fs.existsSync(savedPath)) {
    console.log('Nessuno snapshot trovato - canvas vuoto');
    return;
  }

  fs.createReadStream(savedPath)
    .pipe(new PNG())
    .on('parsed', function() {
      if (this.width !== CANVAS_SIZE || this.height !== CANVAS_SIZE) {
        console.warn(`Snapshot size ${this.width}x${this.height} differs from CANVAS_SIZE ${CANVAS_SIZE}`);
      }

      const paletteRGB = COLORS.map(col => [
        parseInt(col.slice(1,3), 16),
        parseInt(col.slice(3,5), 16),
        parseInt(col.slice(5,7), 16)
      ]);

      const w = Math.min(this.width, CANVAS_SIZE);
      const h = Math.min(this.height, CANVAS_SIZE);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * this.width + x) << 2;
          const r = this.data[idx];
          const g = this.data[idx + 1];
          const b = this.data[idx + 2];

          let bestIndex = 0;
          let bestDist = Infinity;
          for (let i = 0; i < paletteRGB.length; i++) {
            const [pr, pg, pb] = paletteRGB[i];
            const dist = (r-pr)*(r-pr) + (g-pg)*(g-pg) + (b-pb)*(b-pb);
            if (dist < bestDist) {
              bestDist = dist;
              bestIndex = i;
            }
          }
          setPixel(x, y, bestIndex);
        }
      }
      console.log(`Canvas caricato da snapshot: ${savedPath}`);
    })
    .on('error', (err) => {
      console.error('Errore caricamento PNG:', err);
    });
}

loadCanvasFromPNG();

// Server HTTP
const server = http.createServer((req, res) => {
  // Servire index.html
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Servire styles.css
  if (req.url === '/styles.css') {
    fs.readFile(path.join(__dirname, 'styles.css'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('styles.css not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
    return;
  }

  // Endpoint per salvare snapshot manuale
  if (req.method === 'POST' && req.url === '/save-snapshot') {
    if (_isSaving) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'save_in_progress' }));
      return;
    }

    _isSaving = true;
    const outPath = path.join(__dirname, 'canvas-snapshot.png');
    exportCanvasToPNG(outPath).then(() => {
      _isSaving = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', path: outPath }));
    }).catch((err) => {
      _isSaving = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  // Health check per Render
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Flappy Place Server running');
});

// WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substr(2, 9);
  console.log(`Client connesso: ${userId} (totale: ${wss.clients.size})`);
  
  ws.send(JSON.stringify({
    type: 'init',
    userId,
    canvasSize: CANVAS_SIZE,
    colors: COLORS,
    cooldown: COOLDOWN_MS
  }));
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'getRegion') {
        const { x, y, width, height } = msg;
        const region = getRegion(x, y, width, height);
        
        ws.send(JSON.stringify({
          type: 'region',
          x, y, width, height,
          data: Array.from(region)
        }));
      }
      
      else if (msg.type === 'drawPixel') {
        if (!canUserDraw(userId)) {
          ws.send(JSON.stringify({
            type: 'cooldown',
            remaining: COOLDOWN_MS - (Date.now() - userCooldowns.get(userId))
          }));
          return;
        }
        
        const { x, y, color } = msg;
        if (setPixel(x, y, color)) {
          updateUserCooldown(userId);
          pendingUpdates.push({ x, y, color });
          
          ws.send(JSON.stringify({
            type: 'drawSuccess',
            cooldownUntil: Date.now() + COOLDOWN_MS
          }));
        }
      }
    } catch (err) {
      console.error('Errore messaggio:', err);
    }
  });
  
  ws.on('close', () => {
    console.log(`Client disconnesso: ${userId} (rimanenti: ${wss.clients.size})`);
  });
});

// Broadcast aggiornamenti
setInterval(() => {
  if (pendingUpdates.length === 0) return;
  
  const updates = pendingUpdates.splice(0);
  const message = JSON.stringify({
    type: 'pixelUpdates',
    updates
  });
  
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}, UPDATE_BATCH_INTERVAL);

// Pulizia cooldown
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of userCooldowns.entries()) {
    if (now - timestamp > COOLDOWN_MS * 10) {
      userCooldowns.delete(userId);
    }
  }
}, 60000);

// Export PNG
function exportCanvasToPNG(outputPath) {
  return new Promise((resolve, reject) => {
    const png = new PNG({ width: CANVAS_SIZE, height: CANVAS_SIZE });

    for (let i = 0; i < canvas.length; i++) {
      const colorIndex = canvas[i];
      const color = COLORS[colorIndex] || '#000000';
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);

      const idx = i << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }

    const tmpPath = outputPath + '.tmp';
    const out = fs.createWriteStream(tmpPath);

    out.on('finish', () => {
      fs.rename(tmpPath, outputPath, (err) => {
        if (err) {
          try { fs.unlinkSync(tmpPath); } catch (e) {}
          return reject(err);
        }
        console.log(`Canvas salvato in ${outputPath}`);
        resolve();
      });
    });

    out.on('error', (err) => {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      reject(err);
    });

    png.pack().pipe(out);
  });
}

// Shutdown graceful
async function saveAndExit(signal) {
  if (_isSaving) return;
  _isSaving = true;
  console.log(`Ricevuto ${signal} - salvataggio canvas...`);
  try {
    await exportCanvasToPNG(path.join(__dirname, 'canvas-snapshot.png'));
    console.log('Salvataggio completato');
  } catch (err) {
    console.error('Errore salvataggio:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => saveAndExit('SIGINT'));
process.on('SIGTERM', () => saveAndExit('SIGTERM'));
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await saveAndExit('uncaughtException');
});

// Porta dinamica per Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server in ascolto su porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});