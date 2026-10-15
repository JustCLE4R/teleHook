#!/usr/bin/env bash

# Settings come from the same .env as the server, so the limit tests (b, c)
# match it. As for the server, a variable set in the shell wins over .env,
# and .env over the defaults below. Only these keys are read: the file is
# never sourced, so the bot token stays out of this script.
#
#   PORT                         server port, for the default API URL
#   MAX_ATTACHMENTS_PER_REQUEST  server limit, for test b
#   MAX_ATTACHMENT_SIZE_MB       server limit, for test c
#   TELEHOOK_API_URL             e.g. https://telehook.yudistira.dev/api/send
#   TELEHOOK_CHAT_IDS            comma-separated chat IDs to send to
ENV_FILE="${TELEHOOK_ENV_FILE:-$(dirname "${BASH_SOURCE[0]}")/../.env}"

# Prints the value of $1 from the shell, else from .env, else $2.
setting() {
    local value="${!1:-}"
    if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
        # The last assignment wins; CRLF, surrounding quotes and a trailing
        # comment on unquoted values are removed.
        value=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" |
            tail -n 1 | tr -d '\r' |
            sed -e 's/^[[:space:]]*//' \
                -e 's/^\([^"'"'"'].*\)[[:space:]]#.*$/\1/' \
                -e 's/[[:space:]]*$//' \
                -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
    fi
    printf '%s' "${value:-$2}"
}

PORT=$(setting PORT 3000)
API_URL=$(setting TELEHOOK_API_URL "http://localhost:$PORT/api/send")
CHAT_IDS=$(setting TELEHOOK_CHAT_IDS "5064323191,-5441480508")
MAX_ATTACHMENTS=$(setting MAX_ATTACHMENTS_PER_REQUEST 5)
MAX_ATTACHMENT_SIZE_MB=$(setting MAX_ATTACHMENT_SIZE_MB 10)

LAST_RESPONSE="No requests sent yet."

# Files generated for the tests below, removed on exit.
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Sends a request and records the body, HTTP status and duration.
send() {
    LAST_RESPONSE=$(curl -sS -X POST "$API_URL" \
        -w '\n\n-> HTTP %{http_code} in %{time_total}s' "$@" 2>&1)
}

while true; do
    clear

    echo "=================================="
    echo "       Telehook API Tester"
    echo "=================================="
    if [ -f "$ENV_FILE" ]; then
        echo "Settings from: $ENV_FILE"
    else
        echo "Settings from: defaults ($ENV_FILE not found)"
    fi
    echo "Server limits: $MAX_ATTACHMENTS files, $MAX_ATTACHMENT_SIZE_MB MB each"
    echo "=================================="
    echo "1. Send message with multiple files"
    echo "2. Send message with one file"
    echo "3. Send text-only message"
    echo "---- more deliveries (sends to Telegram) ----"
    echo "4. Send text-only message as JSON"
    echo "5. Send two photos and a log (PNG, JPEG, text)"
    echo "6. Send a long message with one file (too long for a caption)"
    echo "7. Send command output from stdin as a file"
    echo "8. Send a server snapshot (README recipe)"
    echo "9. Send a message read from a file (UTF-8, emoji, starts with @)"
    echo "h. Send with a custom X-Request-Id and show the headers"
    echo "---- rejected requests (nothing is sent to Telegram) ----"
    echo "a. Empty file                      -> 400"
    echo "b. Too many files ($((MAX_ATTACHMENTS + 1)))              -> 400"
    echo "c. File over ${MAX_ATTACHMENT_SIZE_MB} MB                 -> 413"
    echo "d. Invalid chat ID                 -> 400"
    echo "e. Urlencoded form                 -> 415"
    echo "f. Cross-site browser request      -> 403"
    echo "g. Burst until rate limited        -> 429 with countdown"
    echo "----"
    echo "s. Settings (API URL: $API_URL, chats: $CHAT_IDS)"
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
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=High CPU on node-1 (multiple files)" \
                -F "files=@files/sample.png" \
                -F "files=@files/test.log"
            ;;

        2)
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=High CPU on node-1 (single file)" \
                -F "files=@files/sample.png"
            ;;

        3)
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=Test notification from Telehook"
            ;;

        4)
            # The JSON API takes chat_ids as an array.
            json_ids="\"${CHAT_IDS//,/\",\"}\""
            send -H "Content-Type: application/json" \
                -d "{\"chat_ids\":[$json_ids],\"message\":\"Test notification from Telehook (JSON)\"}"
            ;;

        5)
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=High CPU on node-1 (two photos and a log)" \
                -F "files=@files/sample.png" \
                -F "files=@files/sample.jpg" \
                -F "files=@files/test.log"
            ;;

        6)
            # Over Telegram's 1024-character caption limit, so the message is
            # sent first and the file follows as a reply.
            printf 'Line %02d: High CPU on node-1, load average 9.87, 8.12, 7.01\n' \
                $(seq 1 25) > "$WORK_DIR/long-message.txt"
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=<$WORK_DIR/long-message.txt" \
                -F "files=@files/sample.png"
            ;;

        7)
            send -F "chat_ids=$CHAT_IDS" \
                -F "message=System info from $(hostname) (from stdin)" \
                -F "files=@-;filename=system-info.txt" \
                < <({ uname -a; date; df -h; } 2>&1)
            ;;

        8)
            snapshot="$WORK_DIR/snapshot"
            rm -rf "$snapshot" && mkdir -p "$snapshot"
            {
                echo "== uptime"; uptime
                echo "== memory"; free -m
                echo "== disk"; df -h
                echo "== top processes"; ps aux --sort=-%cpu | head -n 15
            } > "$snapshot/diagnostics.txt" 2>&1
            tail -n 200 files/test.log > "$snapshot/app-error.log" 2>/dev/null
            # Matches nothing, so it stays empty and must be skipped.
            grep OOM files/test.log > "$snapshot/oom.log" 2>/dev/null

            snapshot_files=()
            for file in "$snapshot"/*; do
                # An empty file would reject the whole request, alert included.
                [ -s "$file" ] && snapshot_files+=(-F "files=@$file")
            done
            send -F "chat_ids=$CHAT_IDS" \
                --form-string "message=High CPU on $(hostname) (snapshot)" \
                "${snapshot_files[@]}"
            ;;

        9)
            # Read from a file, curl takes the bytes as they are: no special
            # meaning for a leading @, and no shell encoding issues.
            printf '@oncall 🚨 Disk 95%% full on node-1 — check /var/log ✓\nSecond line: ünïcödé\n' \
                > "$WORK_DIR/message.txt"
            send -F "chat_ids=$CHAT_IDS" -F "message=<$WORK_DIR/message.txt"
            ;;

        h)
            request_id="fire-$(date +%s)"
            send -i -H "X-Request-Id: $request_id" \
                -F "chat_ids=$CHAT_IDS" \
                -F "message=Test notification with request ID $request_id"
            ;;

        a)
            : > "$WORK_DIR/empty.log"
            send -F "chat_ids=$CHAT_IDS" -F "message=Should be rejected" \
                -F "files=@$WORK_DIR/empty.log"
            ;;

        b)
            too_many=()
            for _ in $(seq 0 "$MAX_ATTACHMENTS"); do
                too_many+=(-F "files=@files/test.log")
            done
            send -F "chat_ids=$CHAT_IDS" -F "message=Should be rejected" \
                "${too_many[@]}"
            ;;

        c)
            head -c $((MAX_ATTACHMENT_SIZE_MB * 1024 * 1024 + 1)) /dev/zero \
                > "$WORK_DIR/too-big.log"
            send -F "chat_ids=$CHAT_IDS" -F "message=Should be rejected" \
                -F "files=@$WORK_DIR/too-big.log"
            ;;

        d)
            send -F "chat_ids=not-a-chat-id" -F "message=Should be rejected"
            ;;

        e)
            send -d "chat_ids=5064323191&message=Should be rejected"
            ;;

        f)
            send -H "Origin: https://evil.example" \
                -F "chat_ids=$CHAT_IDS" -F "message=Should be rejected"
            ;;

        g)
            # Invalid requests still count toward the limit but are rejected
            # before reaching Telegram, so this sends no messages.
            for attempt in $(seq 1 100); do
                send -F "chat_ids=not-a-chat-id" -F "message=Burst"
                case "$LAST_RESPONSE" in
                    *"HTTP 429"*) break ;;
                esac
            done
            LAST_RESPONSE="Rate limited after $attempt requests:"$'\n'"$LAST_RESPONSE"
            ;;

        s)
            read -rp "API URL [$API_URL]: " value
            [ -n "$value" ] && API_URL="$value"
            read -rp "Chat IDs, comma-separated [$CHAT_IDS]: " value
            [ -n "$value" ] && CHAT_IDS="$value"
            LAST_RESPONSE="Settings updated."
            ;;

        0)
            echo "Exiting Telehook API Tester."
            exit 0
            ;;

        *)
            LAST_RESPONSE="Invalid option. Please select 0-9, a-h or s."
            ;;
    esac
done