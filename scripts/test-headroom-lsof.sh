#!/bin/bash

# Simpler test using lsof to check open network connections
# Run this with: bash scripts/test-headroom-lsof.sh
#
# This monitors which ports/IPs the PTY process connects to
# without requiring sudo or tcpdump

set -e

echo "=== Headroom Shell Network Test (using lsof) ==="
echo ""
echo "This test will:"
echo "1. Create a headroom-shell session"
echo "2. Monitor its network connections"
echo "3. Verify only localhost:8787 is contacted"
echo ""

TEST_REPO=$(pwd)

# Get PID of the main process (the PTY) - we'll need to find it
# For now, just create the session and monitor

echo "Starting headroom-shell session..."
echo ""

# Create the session via the API
SESSION_DATA=$(curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"repoPath\": \"$TEST_REPO\",
    \"command\": \"echo 'Testing headroom connectivity'; sleep 1\",
    \"headroom\": true
  }")

SESSION=$(echo "$SESSION_DATA" | jq -r '.session.id')
echo "Session ID: $SESSION"
echo ""

# Give the process time to start
sleep 0.5

# Get all Node processes and their network connections
echo "=== Network Connections from Node Processes ==="
echo ""

if command -v lsof &>/dev/null; then
  # Get Node PIDs
  NODE_PIDS=$(pgrep -f "node|tsx" | head -10)

  if [ -z "$NODE_PIDS" ]; then
    echo "⚠️  No Node processes found. Is the dev server running?"
    exit 1
  fi

  echo "Monitoring Node processes for network connections..."
  echo ""

  # Check each Node process for network connections
  EXTERNAL_FOUND=0
  LOCALHOST_FOUND=0

  for pid in $NODE_PIDS; do
    CONNECTIONS=$(lsof -p "$pid" -nP 2>/dev/null | grep TCP | grep ESTABLISHED || true)

    if [ -n "$CONNECTIONS" ]; then
      echo "Process $pid connections:"
      echo "$CONNECTIONS" | while read line; do
        echo "  $line"

        # Check for external IPs (not 127.0.0.1 or localhost)
        if ! echo "$line" | grep -qE "127\.0\.0\.1|localhost|\[::\]"; then
          if echo "$line" | grep -qE "->.*:[0-9]+" && ! echo "$line" | grep -qE "LISTEN"; then
            echo "    ⚠️  EXTERNAL CONNECTION DETECTED"
            EXTERNAL_FOUND=1
          fi
        fi

        # Check for localhost:8787
        if echo "$line" | grep -qE "127\.0\.0\.1:8787|localhost:8787"; then
          echo "    ✅ localhost:8787 (headroom proxy)"
          LOCALHOST_FOUND=1
        fi
      done
      echo ""
    fi
  done

  echo "=== Summary ==="
  echo ""
  if [ $EXTERNAL_FOUND -eq 0 ]; then
    echo "✅ No external API connections detected"
  else
    echo "❌ External connections were made"
  fi

  if [ $LOCALHOST_FOUND -eq 1 ]; then
    echo "✅ Connections to localhost:8787 confirmed"
  else
    echo "⚠️  No connections to localhost:8787 were observed"
  fi

else
  echo "lsof not found. Install with: brew install lsof (macOS) or apt-get install lsof (Linux)"
  exit 1
fi

echo ""
echo "Test complete!"
echo ""
echo "Note: For more comprehensive testing, run:"
echo "  sudo bash scripts/test-headroom-network.sh"
