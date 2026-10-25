#!/usr/bin/env bash
# Double-click in Finder to start Basalt (opens Terminal).
cd "$(dirname "$0")" && ./start.sh "$@"
status=$?
echo
read -r -p "Press Enter to close this window." _
exit $status
