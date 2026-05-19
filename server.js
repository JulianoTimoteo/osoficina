/**
 * Proxy – Gestão Oficina (SimpleFarm)
 * Credenciais via .env
 */
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

let USER = null;
let PASSWORD = null;
try { require('dotenv').config({ path: path.resolve(__dirname, '.env') }); } catch {}
USER = process.env.LOGIN_USER;
PASSWORD = process.env.LOGIN_PASSWORD;
if (!USER || !PASSWORD) {
  try { require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); } catch {}
  USER = process.env.LOGIN_USER;
  PASSWORD = process.env.LOGIN_PASSWORD;
}
if (!USER || !PASSWORD) {
  console.error("Env LOGIN_USER and LOGIN_PASSWORD must be set in .env");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const INSECURE_TLS = (process.env.INSECURE_TLS === 'true');
const NODE_ENV = process.env.NODE_ENV || 'production';
const AGENT = (INSECURE_TLS && (NODE_ENV !== 'production')) ? new https.Agent({ rejectUnauthorized: false }) : undefined;

// Helpers
function req(options, body) {
  return new Promise((resolve, reject) => {
    options.agent = AGENT;
    const r = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function extractCookies(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return arr.map(c => c.split(';')[0]).join('; ');
}

async function fetchOSData() {
  const today = new Date().toISOString().split('T')[0];
  // Login
  const loginPayload = `UserName=${encodeURIComponent(USER)}&Password=${encodeURIComponent(PASSWORD)}`;
  const loginRes = await req({
    hostname: 'simplefarm.usinapitangueiras.com.br',
    port: 8050,
    path: '/Login/AuthenticateUser',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(loginPayload),
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
  }, loginPayload);
  const cookies = extractCookies(loginRes.headers['set-cookie']);
  if (!cookies) throw new Error('Login falhou — verifique usuário e senha no server.js');

  // GUID
  const mainRes = await req({
    hostname: 'simplefarm.usinapitangueiras.com.br',
    port: 8050,
    path: '/Home/Main?panelId=165',
    method: 'GET',
    headers: {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
  });
  const guidMatch = mainRes.body.match(/limitedGuid\s*=\s*['"]([^'"]+)['"]/);
  if (!guidMatch) throw new Error('GUID não encontrado — sessão inválida ou estrutura do HTML mudou');
  const guid = guidMatch[1];

  // Data
  const dataRes = await req({
    hostname: 'api-simplefarm.usinapitangueiras.com.br',
    port: 8051,
    path: `/api/PanelObject/GetWidgetList?userPanelId=165&referenceDate=${today}&widgets=1519`,
    method: 'GET',
    headers: {
      'Authorization': `limited ${guid}`,
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, */*',
    },
  });
  let parsed;
  try { parsed = JSON.parse(dataRes.body); } catch { throw new Error('API retornou resposta inválida (não é JSON)'); }
  const rows = parsed?.data?.[0]?.DataSource ?? [];
  return rows;
}

const MIME = {
  ".html": 'text/html; charset=utf-8',
  ".css": 'text/css',
  ".js": 'application/javascript',
  ".json": 'application/json',
  ".ico": 'image/x-icon',
  ".png": 'image/png',
};

const rateWindowMs = 60 * 1000;
const rateLimit = 20;
const rateMap = {};
function allowRequest(ip) {
  const now = Date.now();
  const rec = rateMap[ip] || { t: now, c: 0 };
  if (now - rec.t > rateWindowMs) { rec.t = now; rec.c = 0; }
  rec.c += 1;
  rateMap[ip] = rec;
  return rec.c <= rateLimit;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

// Server
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString();
  if (!allowRequest(ip)) {
    res.statusCode = 429;
    res.end('Too many requests');
    return;
  }
  applySecurityHeaders(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;

  if (urlPath === '/api/os') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    try {
      const rows = await fetchOSData();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, rows }));
    } catch (err) {
      console.error('ERRO ao buscar OS:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(__dirname, filePath.replace(/\.\./g, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 – Arquivo não encontrado: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════');
  console.log(`  ✅  Servidor rodando!`);
  console.log(`      Abra: http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Porta ${PORT} já está em uso. Feche o outro processo ou mude o PORT.\n`);
  } else {
    console.error('Erro no servidor:', err);
  }
  process.exit(1);
});
