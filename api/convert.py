from http.server import BaseHTTPRequestHandler
import json
import os
import subprocess
import tempfile
import re
import stat


def normalize_math(text):
    # \( ... \) → $ ... $
    text = re.sub(r'\\\((.+?)\\\)', r'$\1$', text, flags=re.DOTALL)
    # \[ ... \] → $$ ... $$
    text = re.sub(r'\\\[(.+?)\\\]', r'$$\1$$', text, flags=re.DOTALL)
    return text


def get_pandoc():
    bundled = os.path.join(os.path.dirname(__file__), 'pandoc')
    if os.path.exists(bundled):
        try:
            os.chmod(bundled, os.stat(bundled).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        except Exception:
            pass
        return bundled
    return 'pandoc'  # fall back to system pandoc


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default access log noise

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            md = data.get('markdown', '').strip()
            if not md:
                raise ValueError('Empty markdown')

            md = normalize_math(md)

            tmpdir = tempfile.mkdtemp()
            md_path = os.path.join(tmpdir, 'input.md')
            docx_path = os.path.join(tmpdir, 'output.docx')

            with open(md_path, 'w', encoding='utf-8') as f:
                f.write(md)

            result = subprocess.run(
                [get_pandoc(), md_path, '-o', docx_path,
                 '-f', 'markdown+tex_math_dollars+raw_html',
                 '-t', 'docx'],
                capture_output=True, text=True, timeout=25
            )

            if result.returncode != 0:
                raise RuntimeError(result.stderr)

            with open(docx_path, 'rb') as f:
                docx_bytes = f.read()

            self.send_response(200)
            self.send_header('Content-Type',
                             'application/vnd.openxmlformats-officedocument'
                             '.wordprocessingml.document')
            self.send_header('Content-Disposition',
                             'attachment; filename="document.docx"')
            self.send_cors()
            self.send_header('Content-Length', str(len(docx_bytes)))
            self.end_headers()
            self.wfile.write(docx_bytes)

        except Exception as e:
            msg = json.dumps({'error': str(e)}).encode()
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_cors()
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
