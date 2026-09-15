#!/bin/bash
# Double-click to start the Planning Tool and open it in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org and run this again."
  read -r -p "Press return to close."
  exit 1
fi
node server.js &
SERVER_PID=$!
sleep 1
PORT=$(node -e "try{console.log(require('./config.json').server.port||4322)}catch(e){console.log(4322)}")
open "http://localhost:${PORT}"
echo ""
echo "Planning Tool is running. Close this window or press Ctrl-C to stop it."
wait $SERVER_PID
