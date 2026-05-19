const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'agroflux-jwt-secret-key-2026';
const INSECURE_TLS = (process.env.INSECURE_TLS === 'true');
const NODE_ENV = process.env.NODE_ENV || 'production';
const AGENT = (INSECURE_TLS && (NODE_ENV !== 'production')) ? new https.Agent({ rejectUnauthorized: false }) : undefined;

function generateToken(payload, expiresInSeconds = 86400) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch { return null; }
}

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

async function authSimpleFarm(username, password) {
  const loginPayload = `UserName=${encodeURIComponent(username)}&Password=${encodeURIComponent(password)}`;
  const loginRes = await req({
    hostname: 'simplefarm.usinapitangueiras.com.br',
    port: 8050,
    path: '/Login/AuthenticateUser',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(loginPayload),
      'User-Agent': 'Mozilla/5.0',
    },
  }, loginPayload);
  const cookies = extractCookies(loginRes.headers['set-cookie']);
  if (!cookies) {
    console.error('Status:', loginRes.status, 'Body:', loginRes.body.slice(0, 200));
    throw new Error('Credenciais inválidas');
  }
  return cookies;
}

async function getGuid(cookies) {
  const mainRes = await req({
    hostname: 'simplefarm.usinapitangueiras.com.br',
    port: 8050,
    path: '/Home/Main?panelId=165',
    method: 'GET',
    headers: { 'Cookie': cookies, 'User-Agent': 'Mozilla/5.0' },
  });
  const match = mainRes.body.match(/limitedGuid\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('GUID não encontrado');
  return match[1];
}

async function fetchOSData(cookies, guid) {
  const today = new Date().toISOString().split('T')[0];
  const dataRes = await req({
    hostname: 'api-simplefarm.usinapitangueiras.com.br',
    port: 8051,
    path: `/api/PanelObject/GetWidgetList?userPanelId=165&referenceDate=${today}&widgets=1519`,
    method: 'GET',
    headers: { 'Authorization': `limited ${guid}`, 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  let parsed;
  try { parsed = JSON.parse(dataRes.body); } catch { throw new Error('Resposta inválida da API'); }
  return parsed?.data?.[0]?.DataSource ?? [];
}

const MIME = {
  ".html": 'text/html; charset=utf-8',
  ".css": 'text/css',
  ".js": 'application/javascript',
  ".json": 'application/json',
  ".ico": 'image/x-icon',
  ".png": 'image/png',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // LOGIN
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: 'Usuário e senha obrigatórios' }));
        }

        const cookies = await authSimpleFarm(username, password);
        const guid = await getGuid(cookies);

        const token = generateToken({ username, cookies, guid });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, token }));
      } catch (err) {
        console.error('Erro no login:', err.message);
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // DADOS (requer token)
  if (urlPath === '/api/os' && req.method === 'GET') {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401);
      return res.end(JSON.stringify({ ok: false, error: 'Token ausente' }));
    }

    const decoded = verifyToken(auth.split(' ')[1]);
    if (!decoded) {
      res.writeHead(401);
      return res.end(JSON.stringify({ ok: false, error: 'Token inválido ou expirado' }));
    }

    try {
      const rows = await fetchOSData(decoded.cookies, decoded.guid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rows }));
    } catch (err) {
      console.error('Erro ao buscar OS:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ARQUIVOS ESTÁTICOS
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(__dirname, filePath.replace(/\.\./g, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 – ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso.`);
  } else {
    console.error('Erro:', err);
  }
  process.exit(1);
});