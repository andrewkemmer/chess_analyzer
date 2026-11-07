#!/bin/sh
# Installs Stockfish 17 (x86-64, AVX2) with no root required.
# Usage: ./install_stockfish.sh [dest-dir]   (default: .local-bin)
# Then:  export PATH="$PWD/.local-bin:$PATH"
set -eu
DEST="${1:-.local-bin}"
TMP=/tmp/sf-install-$$
mkdir -p "$DEST" "$TMP"
URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-ubuntu-x86-64-avx2.tar"
echo "Downloading Stockfish 17..."
curl -sL --max-time 300 -o "$TMP/sf.tar" "$URL"
tar xf "$TMP/sf.tar" -C "$TMP"
BIN="$(find "$TMP" -name 'stockfish-ubuntu-x86-64-avx2' -type f | head -1)"
cp "$BIN" "$DEST/stockfish"
chmod +x "$DEST/stockfish"
rm -rf "$TMP"
printf 'quit\n' | "$DEST/stockfish" >/dev/null
echo "Stockfish installed at $DEST/stockfish"
case "$DEST" in
  /*) echo "Run: export PATH=\"$DEST:\$PATH\"" ;;
  *)  echo "Run: export PATH=\"\$PWD/$DEST:\$PATH\"" ;;
esac
