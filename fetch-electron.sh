#!/bin/bash
# Parallel range-download of the Electron binary zip, then unpack into
# node_modules/electron/dist exactly as the postinstall would.
set -e
cd "/c/KomarovLocal/Kimi Code/KimiUsageWidget"
VER=33.4.11
ZIP=electron-v${VER}-win32-x64.zip
URL="https://cdn.npmmirror.com/binaries/electron/${VER}/${ZIP}"
OUT="/tmp/${ZIP}"
PARTS=8

SIZE=$(curl -4 -sI -L "$URL" | grep -i '^content-length:' | tail -1 | tr -d '\r' | awk '{print $2}')
if [ -z "$SIZE" ]; then echo "could not get size"; exit 1; fi
echo "zip size: $SIZE bytes"
# fall back to plain curl if small
CHUNK=$(( (SIZE + PARTS - 1) / PARTS ))
rm -f /tmp/el-part-* "$OUT"
pids=()
for i in $(seq 0 $((PARTS-1))); do
  START=$((i * CHUNK))
  END=$(( (i+1) * CHUNK - 1 ))
  if [ $END -ge $SIZE ]; then END=$((SIZE - 1)); fi
  if [ $START -ge $SIZE ]; then break; fi
  curl -4 -s -L --retry 5 --retry-delay 2 -r ${START}-${END} -o /tmp/el-part-$i "$URL" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
cat /tmp/el-part-* > "$OUT"
GOT=$(stat -c %s "$OUT")
echo "downloaded $GOT / $SIZE"
if [ "$GOT" != "$SIZE" ]; then echo "SIZE MISMATCH"; exit 1; fi

mkdir -p node_modules/electron/dist
unzip -q -o "$OUT" -d node_modules/electron/dist
printf 'electron.exe' > node_modules/electron/path.txt
rm -f /tmp/el-part-* "$OUT"
echo "electron binary installed:"
ls node_modules/electron/dist/electron.exe
