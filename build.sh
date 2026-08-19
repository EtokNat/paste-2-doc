#!/usr/bin/env bash
set -e
PANDOC_VER="3.9"
URL="https://github.com/jgm/pandoc/releases/download/${PANDOC_VER}/pandoc-${PANDOC_VER}-linux-amd64.tar.gz"
curl -fsSL "$URL" -o _pd.tar.gz
tar xzf _pd.tar.gz "pandoc-${PANDOC_VER}/bin/pandoc"
mkdir -p api
cp "pandoc-${PANDOC_VER}/bin/pandoc" api/pandoc
chmod +x api/pandoc
rm -rf _pd.tar.gz "pandoc-${PANDOC_VER}"
echo "pandoc bundled: $(api/pandoc --version | head -1)"
