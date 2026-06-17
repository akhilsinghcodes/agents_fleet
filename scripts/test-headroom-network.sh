#!/bin/bash

# Test script to verify headroom-shell only connects to localhost:8787
# Run this with: bash scripts/test-headroom-network.sh
#
# Requirements:
# - Node.js and npm (to run the dev server)
# - tcpdump (to capture network traffic)
# - The headroom proxy running on localhost:8787

set -e

echo "=== Headroom Shell Network Verification Test ==="
echo ""
echo "This test will:"
echo "1. Capture network traffic on localhost"
echo "2. Create a headroom-shell session"
echo "3. Run a test command"
echo "4. Verify no external API calls were made"
echo ""

# Create a temporary directory for our test
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

PCAP_FILE="$TEST_DIR/headroom-test.pcap"
TEST_REPO=$(pwd)

echo "Test directory: $TEST_DIR"
echo "PCAP file: $PCAP_FILE"
echo ""

# Start tcpdump in background to capture traffic
# Filter for TCP connections to ports commonly used by AI APIs
echo "Starting network capture..."
sudo tcpdump -i lo -w "$PCAP_FILE" -n \
  'tcp and (dst port 443 or dst port 80 or dst port 8787)' \
  > /dev/null 2>&1 &
TCPDUMP_PID=$!
trap "sudo kill $TCPDUMP_PID 2>/dev/null || true; rm -rf $TEST_DIR" EXIT

# Give tcpdump a moment to start
sleep 1

echo "Creating headroom-shell session..."
echo ""

# Create the session via the API
SESSION=$(curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"repoPath\": \"$TEST_REPO\",
    \"command\": \"echo 'test'\",
    \"headroom\": true
  }" | jq -r '.session.id')

echo "Session ID: $SESSION"
echo ""

# Give it time to run
sleep 2

# Stop tcpdump
echo "Stopping network capture..."
sudo kill $TCPDUMP_PID 2>/dev/null || true
sleep 1

echo ""
echo "=== Network Analysis ==="
echo ""

# Analyze the capture
if command -v tcpdump &> /dev/null; then
  echo "TCP connections captured:"
  tcpdump -r "$PCAP_FILE" -n 'tcp[tcpflags] & tcp-syn != 0' 2>/dev/null | grep -E ">\s" || echo "  (none to analyze)"
  echo ""
fi

# Check for known AI API endpoints
echo "Checking for external AI API calls..."
echo ""

EXTERNAL_CALLS=0

# Common AI API endpoints to check for
declare -a ENDPOINTS=(
  "api.openai.com"
  "api.anthropic.com"
  "generativelanguage.googleapis.com"
  "api.cohere.com"
  "api.replicate.com"
)

for endpoint in "${ENDPOINTS[@]}"; do
  # Try to resolve and check if there are connections
  if host "$endpoint" &>/dev/null; then
    IP=$(host "$endpoint" | grep "address" | head -1 | awk '{print $NF}')
    if [ -n "$IP" ]; then
      # Check if any packets went to this IP (simple check)
      if tcpdump -r "$PCAP_FILE" -n "dst $IP" 2>/dev/null | grep -q ""; then
        echo "❌ FOUND external connection to: $endpoint ($IP)"
        EXTERNAL_CALLS=$((EXTERNAL_CALLS + 1))
      fi
    fi
  fi
done

if [ $EXTERNAL_CALLS -eq 0 ]; then
  echo "✅ No external AI API calls detected"
else
  echo ""
  echo "⚠️  Found $EXTERNAL_CALLS external API call(s)"
fi

echo ""
echo "=== Localhost Connections ==="
echo ""

# Check for localhost:8787 connections
echo "Checking for localhost:8787 connections:"
if tcpdump -r "$PCAP_FILE" -n 'dst 127.0.0.1 port 8787' 2>/dev/null | grep -q ""; then
  echo "✅ Found connections to localhost:8787 (headroom proxy)"
else
  echo "⚠️  No connections to localhost:8787 found"
fi

echo ""
echo "=== Full Capture Summary ==="
tcpdump -r "$PCAP_FILE" -n 2>/dev/null | tail -20 || echo "(tcpdump not available for full analysis)"

echo ""
echo "Test complete!"
