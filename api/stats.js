const { put, list } = require('@vercel/blob');

const STATS_PATH = 'p2d-stats.json';
const VALID = new Set(['visit', 'docx', 'gdocs']);

async function readStats() {
    const { blobs } = await list({ prefix: 'p2d-stats' });
    const found = blobs.find(b => b.pathname === STATS_PATH);
    if (!found) return { visits: 0, docx: 0, gdocs: 0 };
    const r = await fetch(found.url);
    if (!r.ok) return { visits: 0, docx: 0, gdocs: 0 };
    return r.json();
}

async function writeStats(stats) {
    await put(STATS_PATH, JSON.stringify(stats), {
        access: 'public',
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0,
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Return zeroes gracefully if Blob store not yet configured
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.json({ visits: 0, docx: 0, gdocs: 0 });
    }

    try {
        if (req.method === 'GET') {
            return res.json(await readStats());
        }

        if (req.method === 'POST') {
            let body = req.body;
            if (typeof body === 'string') try { body = JSON.parse(body); } catch {}
            const { action } = body || {};
            if (!VALID.has(action)) return res.status(400).json({ error: 'Invalid action' });

            const stats = await readStats();
            stats[action] = (stats[action] || 0) + 1;
            await writeStats(stats);
            return res.json(stats);
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('stats error:', err.message);
        // Don't crash the page over missing stats
        res.status(200).json({ visits: 0, docx: 0, gdocs: 0 });
    }
};
