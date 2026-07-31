#!/bin/bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$HOME/cfield-dashboard"
node build-html.mjs >> update.log 2>&1
echo "Updated at $(date)" >> update.log
