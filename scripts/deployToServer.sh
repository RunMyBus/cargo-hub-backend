#!/usr/bin/env bash
# Deploy backend to server: SSH in, git pull, restart PM2.
# Usage: ./scripts/deployToServer.sh
# No "set -e" so the script keeps going even if one command fails.

# Connect and run all steps on the server in one SSH session.
# Using ";" so each command runs even if the previous one failed.
ssh -i ~/.ssh/id_rsa root@209.38.120.207 "su - ubuntu -c 'cd ~/cargo-hub-backend; git pull origin main; npm install --production; pm2 restart cargo-hub-backend; pm2 save'"

echo "Deploy completed."
