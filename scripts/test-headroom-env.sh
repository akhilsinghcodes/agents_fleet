#!/bin/bash

# Test that verifies env vars are correctly set in headroom-shell sessions
# Run this with: bash scripts/test-headroom-env.sh
#
# This creates a headroom-shell session that prints out the relevant env vars
# and verifies they all point to localhost:8787

set -e

echo "=== Headroom Shell Environment Variables Test ==="
echo ""

TEST_REPO=$(pwd)

echo "Creating headroom-shell session that outputs environment variables..."
echo ""

# Create a session that runs a command to print the env vars we care about
SESSION_DATA=$(curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"repoPath\": \"$TEST_REPO\",
    \"command\": \"env | grep -E 'LITELLM|ANTHROPIC|OPENAI' | sort\",
    \"headroom\": true
  }")

SESSION=$(echo "$SESSION_DATA" | jq -r '.session.id')
echo "Session ID: $SESSION"
echo ""

# Give it time to collect output
sleep 2

echo "=== Environment Variables in PTY ==="
echo ""

# Query the session's PTY chunks to see what was output
CHUNKS=$(curl -s "http://localhost:3001/api/sessions/$SESSION/pty?limit=100" | jq -r '.chunks[].data' 2>/dev/null | tr '\n' ' ')

if [ -z "$CHUNKS" ]; then
  echo "⚠️  No PTY output captured yet. Give the session more time to run."
  echo ""
  echo "Try checking manually:"
  echo "  curl http://localhost:3001/api/sessions/$SESSION/pty"
  exit 0
fi

echo "$CHUNKS" | tr ' ' '\n' | while read line; do
  if [ -n "$line" ]; then
    echo "$line"
  fi
done

echo ""
echo "=== Verification ==="
echo ""

# Check if the expected vars are set to localhost:8787
VARS_TO_CHECK=(
  "LITELLM_URL=http://localhost:8787"
  "ANTHROPIC_BASE_URL=http://localhost:8787"
  "OPENAI_BASE_URL=http://localhost:8787/v1"
)

ALL_GOOD=true

for var in "${VARS_TO_CHECK[@]}"; do
  if echo "$CHUNKS" | grep -q "$var"; then
    echo "✅ $var"
  else
    echo "❌ $var not found"
    ALL_GOOD=false
  fi
done

echo ""

if [ "$ALL_GOOD" = true ]; then
  echo "✅ All environment variables correctly set to localhost:8787"
else
  echo "⚠️  Some environment variables not found in output"
fi

echo ""
echo "Test complete!"