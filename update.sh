#!/bin/bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$HOME/cfield-dashboard"

# Generate report
node build-html.mjs >> update.log 2>&1

# Push to GitHub (backup)
unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY
git add index.html data.json rankings-snapshot.json update.log
git commit -m "Daily update: $(date +%Y-%m-%d)" >> update.log 2>&1
git push >> update.log 2>&1

# Deploy to Surge (primary - accessible in China)
npx surge --project . --domain cfield-dashboard.surge.sh >> update.log 2>&1

echo "Updated & deployed at $(date)" >> update.log
echo "Done: https://cfield-dashboard.surge.sh"
