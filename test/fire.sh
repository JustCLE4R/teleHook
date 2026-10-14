#!/usr/bin/env bash

API_URL="http://localhost:3000/api/send"
# API_URL="https://telehook.yudistira.dev/api/send"
CHAT_IDS="5064323191,-5441480508"

LAST_RESPONSE="No requests sent yet."

while true; do
    clear

    echo "=================================="
    echo "       Telehook API Tester"
    echo "=================================="
    echo "1. Send message with multiple files"
    echo "2. Send message with one file"
    echo "3. Send text-only message"
    echo "0. Exit"
    echo "=================================="

    echo
    echo "========== Last API Response =========="
    printf '%s\n' "$LAST_RESPONSE"
    echo "======================================="
    echo

    read -rn1 -p "Select an option: " choice
    echo

    case "$choice" in
        1)
            LAST_RESPONSE=$(curl -sS -X POST "$API_URL" \
                -F "chat_ids=$CHAT_IDS" \
                -F "message=High CPU on node-1 (multiple files)" \
                -F "files=@files/sample.png" \
                -F "files=@files/test.log" 2>&1)

            ;;

        2)
            LAST_RESPONSE=$(curl -sS -X POST "$API_URL" \
                -F "chat_ids=$CHAT_IDS" \
                -F "message=High CPU on node-1 (single file)" \
                -F "files=@files/sample.png" 2>&1)

            ;;

        3)
            LAST_RESPONSE=$(curl -sS -X POST "$API_URL" \
                -F "chat_ids=$CHAT_IDS" \
                -F "message=Test notification from Telehook" 2>&1)

            ;;

        0)
            echo "Exiting Telehook API Tester."
            exit 0
            ;;

        *)
            LAST_RESPONSE="Invalid option. Please select 0, 1, 2, or 3."
            ;;
    esac
done