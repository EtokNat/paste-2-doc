const { execFileSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const COLWIDTH_LUA = require('./colwidth');

// Complex LaTeX environments Google Docs cannot render from OMML
const COMPLEX_ENV_RE = /\\begin\{(align\*?|aligned\*?|alignat\*?|alignedat\*?|gather\*?|gathered\*?|eqnarray\*?|multline\*?|flalign\*?|[BbpvV]?matrix|smallmatrix|cases\*?|split|CD)\}/;

// Fetch an SVG from CodeCogs and convert it to a proper RGB PNG via resvg.
// CodeCogs PNG output is 4-bit palette-indexed which Google Docs cannot display;
// the SVG output uses pure path elements and renders cleanly at any size.
const BODY_FONT_PT = 12;   // pandoc DOCX body text size (word/styles.xml docDefaults)
const CODECOGS_PT = 10;    // CodeCogs svg.image default = TeX \normalsize
const RENDER_DPI = 300;

async function fetchMathPng(latex) {
    const url = 'https://latex.codecogs.com/svg.image?' + encodeURIComponent(latex.trim());
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`CodeCogs SVG ${res.status}`);
    const svg = await res.text();
    if (!svg.includes('<svg')) throw new Error('CodeCogs returned invalid SVG');

    // CodeCogs emits the natural size in points (e.g. width='28.97pt'). Scale the
    // 10pt glyphs up to the 12pt body so the image matches surrounding text instead
    // of being forced to a fixed 4in width (which blew short equations up ~10x).
    const wMatch = svg.match(/width=['"]([\d.]+)pt/);
    const widthIn = wMatch ? parseFloat(wMatch[1]) * (BODY_FONT_PT / CODECOGS_PT) / 72 : null;

    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(svg, {
        background: 'white',               // solid white — visible in dark mode
        fitTo: { mode: 'width', value: widthIn ? Math.round(widthIn * RENDER_DPI) : 1200 },
        font: { loadSystemFonts: false }   // SVG uses paths only — no fonts needed
    });
    return { png: Buffer.from(resvg.render().asPng()), widthIn };
}

function normalizeMath(text) {
    // pandoc's texmath can't parse these amsmath commands; they'd leak as raw
    // TeX into the DOCX. Map them to equivalents pandoc understands.
    text = text.replace(/\\cfrac(?:\[[^\]]*\])?/g, '\\dfrac')
               .replace(/\\dbinom/g, '\\binom')
               .replace(/\\tbinom/g, '\\binom');

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
                writeFileSync(imgPath, result.value.png);
                // Embed at the natural width (in) so the glyphs stay 12pt. Explicit
                // width also stops pandoc from deriving a tiny size from the PNG DPI.
                const width = result.value.widthIn != null ? `${result.value.widthIn}in` : '4in';
                processed = processed.slice(0, start) +
                    `\n\n![](${imgPath}){width=${width} fig-align="center"}\n\n` +
                    processed.slice(end);
            }
            // On failure: leave $$...$$ — pandoc converts it to OMML (best effort)
        }

        const mdPath = join(tmp, 'input.md');
        const docxPath = join(tmp, 'output.docx');
        writeFileSync(mdPath, processed, 'utf8');
        writeFileSync(join(tmp, 'colwidth.lua'), COLWIDTH_LUA);

        execFileSync(getPandoc(), [
            mdPath,
            '-o', docxPath,
            '-f', 'markdown+tex_math_dollars+raw_html',
            '-t', 'docx',
            '--lua-filter', join(tmp, 'colwidth.lua'),
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
