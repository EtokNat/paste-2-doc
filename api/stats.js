const { put, list } = require('@vercel/blob');

const STATS_PATH = 'p2d-stats.json';
const VALID      = new Set(['visit', 'docx', 'gdocs']);
const SOURCES    = new Set(['vercel', 'github']);
const EMPTY      = () => ({ visits: 0, docx: 0, gdocs: 0 });

async function readAll() {
    const { blobs } = await list({ prefix: 'p2d-stats' });
    const found = blobs.find(b => b.pathname === STATS_PATH);
    if (!found) return { vercel: EMPTY(), github: EMPTY() };
    // Use downloadUrl (signed) for private store; fall back to url
    const r = await fetch(found.downloadUrl || found.url);
    if (!r.ok) return { vercel: EMPTY(), github: EMPTY() };
    const data = await r.json();
    // Migrate old flat format { visits, docx, gdocs } → nested under 'vercel'
    if (!data.vercel && !data.github) {
        return { vercel: { visits: data.visits || 0, docx: data.docx || 0, gdocs: data.gdocs || 0 }, github: EMPTY() };
    }
    data.vercel = data.vercel || EMPTY();
    data.github  = data.github  || EMPTY();
    return data;
}

async function writeAll(all) {
    await put(STATS_PATH, JSON.stringify(all), {
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControl: 'no-store',
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.json(EMPTY());
    }

    try {
        if (req.method === 'GET') {
            const source = SOURCES.has(req.query?.source) ? req.query.source : 'vercel';
            const all = await readAll();
            return res.json(all[source]);
        }

        if (req.method === 'POST') {
            let body = req.body;
            if (typeof body === 'string') try { body = JSON.parse(body); } catch {}
            const { action, source } = body || {};
            if (!VALID.has(action)) return res.status(400).json({ error: 'Invalid action' });
            const src = SOURCES.has(source) ? source : 'vercel';

            const all = await readAll();
            const key = action === 'visit' ? 'visits' : action;
            all[src][key] = (all[src][key] || 0) + 1;
            await writeAll(all);
            return res.json(all[src]);
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('stats error:', err.message);
        res.status(200).json(EMPTY());
    }
};
