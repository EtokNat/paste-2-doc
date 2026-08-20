const { execFileSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const COLWIDTH_LUA = require('./colwidth');

function normalizeMath(text) {
    // pandoc's texmath can't parse these amsmath commands; they'd leak as raw
    // TeX into the DOCX. Map them to equivalents pandoc understands.
    text = text.replace(/\\cfrac(?:\[[^\]]*\])?/g, '\\dfrac')
               .replace(/\\dbinom/g, '\\binom')
               .replace(/\\tbinom/g, '\\binom');

    // 1. Backslash-paren/bracket → dollar delimiters  (\( \) and \[ \])
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`);

    // 2. Shield existing $$…$$ and $…$ so the environment regexes below
    //    don't re-wrap content already inside math delimiters.
    const shieldStore = [];
    const SHIELD = '\x01S', SHIELDEND = '\x01';
    const shield = m => { shieldStore.push(m); return `${SHIELD}${shieldStore.length-1}${SHIELDEND}`; };
    text = text
        .replace(/\$\$([\s\S]+?)\$\$/g, shield)
        .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, shield);

    // 3. Bare LaTeX block environments → $$…$$
    //    equation/displaymath: strip wrapper (pandoc drops \begin{equation} as RawBlock "tex")
    text = text.replace(
        /\\begin\{(equation\*?|displaymath)\}([\s\S]+?)\\end\{\1\}/g,
        (_, _env, m) => `$$${m.trim()}$$`
    );
    //    All other block environments: keep wrapper inside $$.
    //    Single combined regex so the outermost environment is consumed first,
    //    leaving nested environments as content rather than being double-wrapped.
    text = text.replace(
        /\\begin\{(align\*?|aligned\*?|alignat\*?|alignedat\*?|gather\*?|gathered\*?|eqnarray\*?|multline\*?|flalign\*?|[BbpvV]?matrix|smallmatrix|cases\*?|split|CD)\}([\s\S]+?)\\end\{\1\}/g,
        (_, env, m) => `$$\\begin{${env}}${m}\\end{${env}}$$`
    );

    // 4. Restore shielded blocks
    text = text.replace(new RegExp(`${SHIELD}(\\d+)${SHIELDEND}`, 'g'), (_, i) => shieldStore[+i]);

    // 5. Fix pandoc's strict adjacency rule (tex_math_dollars):
    //    opening/closing $ must be flush against content — strip boundary spaces.
    text = text.replace(/\$\$[ \t]+([\s\S]+?)[ \t]+\$\$/g, (_, m) => `$$${m}$$`);
    text = text.replace(/(?<!\$)\$[ \t]+([^\n$]+?)[ \t]+\$(?!\$)/g, (_, m) => `$${m}$`);

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
        writeFileSync(join(tmp, 'colwidth.lua'), COLWIDTH_LUA);

        execFileSync(getPandoc(), [
            mdPath,
            '-o', docxPath,
            '-f', 'markdown+tex_math_dollars+raw_html',
            '-t', 'docx',
            '--lua-filter', join(tmp, 'colwidth.lua'),
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
