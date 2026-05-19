const https = require('https');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'agroflux-jwt-secret-key-2026';
const INSECURE_TLS = (process.env.INSECURE_TLS === 'true');
const AGENT = INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

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

async function req(options) {
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
    r.end();
  });
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Token ausente' });
  }

  const decoded = verifyToken(auth.split(' ')[1]);
  if (!decoded) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado' });
  }

  try {
    const rows = await fetchOSData(decoded.cookies, decoded.guid);
    res.status(200).json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
