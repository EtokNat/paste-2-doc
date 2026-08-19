const { execFileSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

function normalizeMath(text) {
    // \( ... \) → $ ... $  (AI inline math delimiters)
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
    // \[ ... \] → $$ ... $$  (AI display math delimiters)
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`);
    return text;
}

function getPandoc() {
    // Bundled binary (placed here by build.sh during Vercel build)
    const bundled = path.join(__dirname, 'pandoc');
    try {
        require('fs').accessSync(bundled, require('fs').constants.X_OK);
        return bundled;
    } catch (_) {
        return 'pandoc'; // fall back to system (local dev)
    }
}

module.exports = async function handler(req, res) {
    // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        let body = req.body;
        if (typeof body === 'string') body = JSON.parse(body);

        const markdown = (body?.markdown || '').trim();
        if (!markdown) return res.status(400).json({ error: 'Empty markdown' });

        const normalized = normalizeMath(markdown);

        // Write to a unique temp directory
        const uid  = crypto.randomBytes(8).toString('hex');
        const tmp  = join(os.tmpdir(), `p2d-${uid}`);
        mkdirSync(tmp, { recursive: true });

        const mdPath   = join(tmp, 'input.md');
        const docxPath = join(tmp, 'output.docx');
        writeFileSync(mdPath, normalized, 'utf8');

        execFileSync(getPandoc(), [
            mdPath,
            '-o', docxPath,
            '-f', 'markdown+tex_math_dollars+raw_html',
            '-t', 'docx',
        ], { timeout: 20000 });

        const docxBytes = readFileSync(docxPath);

        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename="document.docx"');
        res.setHeader('Content-Length', docxBytes.length);
        res.status(200).end(docxBytes);

    } catch (err) {
        console.error('convert error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
