const https = require('https');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'agroflux-jwt-secret-key-2026';
const INSECURE_TLS = (process.env.INSECURE_TLS === 'true');
const AGENT = INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

function generateToken(payload, expiresInSeconds = 86400) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function extractCookies(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return arr.map(c => c.split(';')[0]).join('; ');
}

async function req(options, body) {
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
  if (!cookies) throw new Error('Credenciais inválidas');
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Usuário e senha obrigatórios' });
    }

    const cookies = await authSimpleFarm(username, password);
    const guid = await getGuid(cookies);
    const token = generateToken({ username, cookies, guid });

    res.status(200).json({ ok: true, token });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
};
