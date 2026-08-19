const { execFileSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

// Complex LaTeX environments Google Docs cannot render from OMML
const COMPLEX_ENV_RE = /\\begin\{(align\*?|aligned\*?|alignat\*?|alignedat\*?|gather\*?|gathered\*?|eqnarray\*?|multline\*?|flalign\*?|[BbpvV]?matrix|smallmatrix|cases\*?|split|CD)\}/;

// Fetch an SVG from CodeCogs and convert it to a proper RGB PNG via resvg.
// CodeCogs PNG output is 4-bit palette-indexed which Google Docs cannot display;
// the SVG output uses pure path elements and renders cleanly at any size.
async function fetchMathPng(latex) {
    const url = 'https://latex.codecogs.com/svg.image?' + encodeURIComponent(latex.trim());
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`CodeCogs SVG ${res.status}`);
    const svg = await res.text();
    if (!svg.includes('<svg')) throw new Error('CodeCogs returned invalid SVG');

    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(svg, {
        background: 'white',               // solid white — visible in dark mode
        fitTo: { mode: 'width', value: 1200 }, // 1200px ÷ 4in = 300 DPI — crisp
        font: { loadSystemFonts: false }   // SVG uses paths only — no fonts needed
    });
    return Buffer.from(resvg.render().asPng());
}

function normalizeMath(text) {
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`);

    const shieldStore = [];
    const SHIELD = '\x01S', SHIELDEND = '\x01';
    const shield = m => { shieldStore.push(m); return `${SHIELD}${shieldStore.length-1}${SHIELDEND}`; };
    text = text
        .replace(/\$\$([\s\S]+?)\$\$/g, shield)
        .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, shield);

    text = text.replace(
        /\\begin\{(equation\*?|displaymath)\}([\s\S]+?)\\end\{\1\}/g,
        (_, _env, m) => `$$${m.trim()}$$`
    );
    text = text.replace(
        /\\begin\{(align\*?|aligned\*?|alignat\*?|alignedat\*?|gather\*?|gathered\*?|eqnarray\*?|multline\*?|flalign\*?|[BbpvV]?matrix|smallmatrix|cases\*?|split|CD)\}([\s\S]+?)\\end\{\1\}/g,
        (_, env, m) => `$$\\begin{${env}}${m}\\end{${env}}$$`
    );

    text = text.replace(new RegExp(`${SHIELD}(\\d+)${SHIELDEND}`, 'g'), (_, i) => shieldStore[+i]);
    text = text.replace(/\$\$[ \t]+([\s\S]+?)[ \t]+\$\$/g, (_, m) => `$$${m}$$`);
    text = text.replace(/(?<!\$)\$[ \t]+([^\n$]+?)[ \t]+\$(?!\$)/g, (_, m) => `$${m}$`);

    return text;
}

function getPandoc() {
    const bundled = path.join(__dirname, 'pandoc');
    try {
        require('fs').accessSync(bundled, require('fs').constants.X_OK);
        return bundled;
    } catch (_) {
        return 'pandoc';
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        let body = req.body;
        if (typeof body === 'string') body = JSON.parse(body);
        const markdown = (body?.markdown || '').trim();
        if (!markdown) return res.status(400).json({ error: 'Empty markdown' });

        const normalized = normalizeMath(markdown);

        // Locate every $$...$$ block that contains a complex environment
        const blocks = [];
        const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
        let m;
        while ((m = DISPLAY_RE.exec(normalized)) !== null) {
            if (COMPLEX_ENV_RE.test(m[1])) {
                blocks.push({ start: m.index, end: DISPLAY_RE.lastIndex, latex: m[1] });
            }
        }

        const uid = crypto.randomBytes(8).toString('hex');
        const tmp = join(os.tmpdir(), `p2d-gdocs-${uid}`);
        mkdirSync(tmp, { recursive: true });

        // Fetch all PNGs in parallel; fall back to OMML if one fails
        const pngResults = await Promise.allSettled(blocks.map(b => fetchMathPng(b.latex)));

        // Replace from end → start so earlier offsets stay valid
        let processed = normalized;
        for (let i = blocks.length - 1; i >= 0; i--) {
            const { start, end } = blocks[i];
            const result = pngResults[i];
            if (result.status === 'fulfilled') {
                const imgPath = join(tmp, `eq_${i}.png`);
                writeFileSync(imgPath, result.value);
                // Standalone paragraph → pandoc uses Figure style (centred) in DOCX
                // {width=5in} prevents pandoc from using the image DPI to compute a tiny size
                processed = processed.slice(0, start) +
                    `\n\n![](${imgPath}){width=4in fig-align="center"}\n\n` +
                    processed.slice(end);
            }
            // On failure: leave $$...$$ — pandoc converts it to OMML (best effort)
        }

        const mdPath = join(tmp, 'input.md');
        const docxPath = join(tmp, 'output.docx');
        writeFileSync(mdPath, processed, 'utf8');

        execFileSync(getPandoc(), [
            mdPath,
            '-o', docxPath,
            '-f', 'markdown+tex_math_dollars+raw_html',
            '-t', 'docx',
        ], { timeout: 25000 });

        const docxBytes = readFileSync(docxPath);
        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename="document_gdocs.docx"');
        res.setHeader('Content-Length', docxBytes.length);
        res.status(200).end(docxBytes);

    } catch (err) {
        console.error('convert-gdocs error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
