#!/usr/bin/env bash
# telehook-watch: checks this server and sends alerts, with diagnostics
# attached, to a teleHook instance. Run it every minute from a systemd timer
# or cron.
#
#   telehook-watch.sh check              run the checks; alert on problems
#   telehook-watch.sh test               send a test alert with a snapshot
#   telehook-watch.sh send MESSAGE [FILE...]
#                                        send any message and files, e.g. from
#                                        a backup or deploy script
#
# Settings are read from $TELEHOOK_WATCH_CONF (default
# /etc/telehook-watch.conf). See telehook-watch.conf.example.

set -uo pipefail

CONF="${TELEHOOK_WATCH_CONF:-/etc/telehook-watch.conf}"
if [ -f "$CONF" ]; then
    # shellcheck source=/dev/null
    . "$CONF"
fi

# ---- settings and defaults --------------------------------------------------
TELEHOOK_URL="${TELEHOOK_URL:-}"
TELEHOOK_CHAT_IDS="${TELEHOOK_CHAT_IDS:-}"
# Extra header for a reverse proxy in front of teleHook, e.g.
# "Authorization: Basic dXNlcjpwYXNz". Empty sends none.
TELEHOOK_HEADER="${TELEHOOK_HEADER:-}"
HOST_LABEL="${HOST_LABEL:-$(hostname)}"

DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-90}"
# Mount points to ignore (extended regex), e.g. snap and container mounts.
DISK_EXCLUDE="${DISK_EXCLUDE:-^/(snap|run|dev|sys|proc|boot/efi)(/|$)|/var/lib/docker/}"
MEM_MIN_AVAILABLE_PERCENT="${MEM_MIN_AVAILABLE_PERCENT:-10}"
LOAD_MAX_PER_CPU="${LOAD_MAX_PER_CPU:-2.0}"
SERVICES="${SERVICES:-}"             # systemd units that must be active
URLS="${URLS:-}"                     # URLs that must answer 2xx/3xx
URL_TIMEOUT="${URL_TIMEOUT:-10}"
LOG_FILES="${LOG_FILES:-}"           # logs to attach (their last lines)
LOG_LINES="${LOG_LINES:-200}"

REPEAT_MINUTES="${REPEAT_MINUTES:-60}"   # resend a still-failing problem after
NOTIFY_RESOLVED="${NOTIFY_RESOLVED:-1}"  # 1: tell when a problem is fixed
STATE_DIR="${STATE_DIR:-/var/lib/telehook-watch}"

# Must not exceed the server's MAX_ATTACHMENTS_PER_REQUEST and
# MAX_ATTACHMENT_SIZE_MB, or teleHook rejects the whole request.
MAX_FILES="${MAX_FILES:-5}"
MAX_FILE_BYTES="${MAX_FILE_BYTES:-$((9 * 1024 * 1024))}"
SEND_TIMEOUT="${SEND_TIMEOUT:-180}"  # teleHook may retry Telegram for a while

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ---- helpers ----------------------------------------------------------------
note() {
    if command -v logger >/dev/null 2>&1; then
        logger -t telehook-watch -- "$*"
    fi
    printf 'telehook-watch: %s\n' "$*" >&2
}

require_settings() {
    if [ -z "$TELEHOOK_URL" ] || [ -z "$TELEHOOK_CHAT_IDS" ]; then
        note "TELEHOOK_URL and TELEHOOK_CHAT_IDS must be set (config: $CONF)"
        exit 2
    fi
}

# Sends MESSAGE with up to MAX_FILES non-empty FILEs. If teleHook rejects the
# request because of the files (4xx), sends the message alone so the alert is
# not lost. Prints teleHook's response; fails if nothing was accepted.
send_alert() {
    local message="$1"
    shift
    local args=() count=0 file
    for file in "$@"; do
        [ -s "$file" ] || continue          # empty files would reject the request
        [ "$count" -lt "$MAX_FILES" ] || break
        if [ "$(wc -c < "$file")" -gt "$MAX_FILE_BYTES" ]; then
            tail -c "$MAX_FILE_BYTES" "$file" > "$WORK_DIR/trimmed-$count-$(basename "$file")"
            file="$WORK_DIR/trimmed-$count-$(basename "$file")"
        fi
        args+=(-F "files=@$file")
        count=$((count + 1))
    done

    # Telegram allows 4096 characters; keep a margin for multi-byte text.
    message="${message:0:4000}"
    local status
    status=$(post "$message" "${args[@]}")
    if [ "${status:0:1}" = 4 ] && [ "$count" -gt 0 ]; then
        note "teleHook rejected the files (HTTP $status); sending the message alone"
        status=$(post "$message")
    fi
    case "$status" in
        200 | 207) return 0 ;;
        *)
            note "alert not accepted by teleHook (HTTP $status): $(head -c 500 "$WORK_DIR/response")"
            return 1
            ;;
    esac
}

# POSTs one request; prints the HTTP status, keeps the body in $WORK_DIR/response.
post() {
    local message="$1"
    shift
    local headers=(-H "X-Request-Id: telehook-watch-${HOST_LABEL//[^A-Za-z0-9_.-]/_}-$(date +%s)")
    [ -n "$TELEHOOK_HEADER" ] && headers+=(-H "$TELEHOOK_HEADER")
    # Read from a file, curl sends the text byte for byte: no special meaning
    # for a leading @ or <, and no command-line encoding issues.
    printf '%s' "$message" > "$WORK_DIR/message.txt"
    # --retry covers teleHook itself being briefly unreachable. curl prints
    # 000 as the status when no response arrived at all.
    if ! curl -sS -o "$WORK_DIR/response" -w '%{http_code}' \
        --max-time "$SEND_TIMEOUT" --retry 3 --retry-delay 5 --retry-connrefused \
        "${headers[@]}" \
        -F "chat_ids=$TELEHOOK_CHAT_IDS" \
        -F "message=<$WORK_DIR/message.txt" \
        "$@" "$TELEHOOK_URL" 2>"$WORK_DIR/curl-error"; then
        cp "$WORK_DIR/curl-error" "$WORK_DIR/response"
    fi
}

# Writes a system snapshot to $1.
snapshot() {
    {
        echo "== $HOST_LABEL at $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo; echo "== uptime / load"; uptime
        echo; echo "== memory"; free -m 2>/dev/null || cat /proc/meminfo
        echo; echo "== disk"; df -hP -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -hP
        echo; echo "== top CPU"; ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu 2>/dev/null | head -n 15
        echo; echo "== top memory"; ps -eo pid,user,%mem,rss,etime,comm --sort=-%mem 2>/dev/null | head -n 15
        if command -v systemctl >/dev/null 2>&1; then
            echo; echo "== failed units"; systemctl --failed --no-legend --no-pager 2>/dev/null
        fi
        echo; echo "== recent kernel messages"; dmesg -T 2>/dev/null | tail -n 30
    } > "$1" 2>&1
}

# ---- checks: each failing check prints "key|description" ---------------------
check_disk() {
    # --output keeps mount points with spaces intact (GNU df); other df
    # versions fall back to the POSIX columns.
    { df --output=pcent,target -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null ||
        df -P | awk '{ $1 = $2 = $3 = $4 = ""; print }'; } | tail -n +2 |
        while read -r use mount; do
            use="${use%\%}"
            [[ "$mount" =~ $DISK_EXCLUDE ]] && continue
            if [ "$use" -ge "$DISK_MAX_PERCENT" ] 2>/dev/null; then
                echo "disk:$mount|Disk $mount is ${use}% full (limit ${DISK_MAX_PERCENT}%)"
            fi
        done
}

check_memory() {
    [ -r /proc/meminfo ] || return 0
    awk -v min="$MEM_MIN_AVAILABLE_PERCENT" '
        /^MemTotal:/ { total = $2 }
        /^MemAvailable:/ { avail = $2; known = 1 }
        END {
            # MemAvailable exists since Linux 3.14; without it, skip the check.
            if (known && total > 0 && avail * 100 / total < min)
                printf "memory|Only %d%% memory available (%d MB of %d MB; limit %d%%)\n",
                    avail * 100 / total, avail / 1024, total / 1024, min
        }' /proc/meminfo
}

check_load() {
    [ -r /proc/loadavg ] || return 0
    local cpus
    cpus=$(nproc 2>/dev/null || echo 1)
    awk -v cpus="$cpus" -v max="$LOAD_MAX_PER_CPU" '{
        if ($2 / cpus > max)
            printf "load|Load average %s over 5 minutes on %d CPUs (limit %s per CPU)\n", $2, cpus, max
    }' /proc/loadavg
}

check_services() {
    local unit state
    for unit in $SERVICES; do
        state=$(systemctl is-active "$unit" 2>/dev/null)
        [ "$state" = active ] || echo "service:$unit|Service $unit is ${state:-unknown}"
    done
}

check_urls() {
    local url code
    for url in $URLS; do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$URL_TIMEOUT" -L "$url" 2>/dev/null)
        case "$code" in
            2?? | 3??) ;;
            000) echo "url:$url|$url is unreachable (no response within ${URL_TIMEOUT}s)" ;;
            *) echo "url:$url|$url answered HTTP $code" ;;
        esac
    done
}

# ---- commands ---------------------------------------------------------------
run_checks() {
    require_settings
    mkdir -p "$STATE_DIR" || { note "cannot create $STATE_DIR"; exit 2; }

    # One run at a time, if flock is available.
    if command -v flock >/dev/null 2>&1; then
        exec 9> "$STATE_DIR/.lock"
        flock -n 9 || exit 0
    fi

    local problems
    problems=$({ check_disk; check_memory; check_load; check_services; check_urls; } | sort -u)

    # A problem is reported when new, then every REPEAT_MINUTES while it lasts.
    # Its state file holds the time it was last reported and its description.
    local now due=() lines=() current=() key text state_file last
    now=$(date +%s)
    while IFS='|' read -r key text; do
        [ -n "$key" ] || continue
        lines+=("• $text")
        state_file="$STATE_DIR/$(state_name "$key")"
        current+=("$state_file")
        last=$(head -n 1 "$state_file" 2>/dev/null)
        if [ -z "$last" ] || [ $((now - last)) -ge $((REPEAT_MINUTES * 60)) ]; then
            due+=("$state_file" "$text")
        fi
    done <<< "$problems"

    if [ "${#due[@]}" -gt 0 ]; then
        local files=() unit log
        snapshot "$WORK_DIR/diagnostics.txt"
        files+=("$WORK_DIR/diagnostics.txt")
        # Journal of each failing service.
        for unit in $SERVICES; do
            if grep -q "^service:$unit|" <<< "$problems"; then
                journalctl -u "$unit" -n "$LOG_LINES" --no-pager > "$WORK_DIR/$unit.journal.txt" 2>&1
                files+=("$WORK_DIR/$unit.journal.txt")
            fi
        done
        for log in $LOG_FILES; do
            [ -r "$log" ] || continue
            tail -n "$LOG_LINES" "$log" > "$WORK_DIR/$(basename "$log")"
            files+=("$WORK_DIR/$(basename "$log")")
        done

        local message
        message="🔥 $HOST_LABEL: ${#lines[@]} problem(s)"$'\n'"$(printf '%s\n' "${lines[@]}")"
        if send_alert "$message" "${files[@]}"; then
            local i
            for ((i = 0; i < ${#due[@]}; i += 2)); do
                printf '%s\n%s\n' "$now" "${due[i + 1]}" > "${due[i]}"
            done
            note "alert sent: ${#lines[@]} problem(s)"
        fi
    fi

    # Problems that were reported before and are now gone.
    local resolved=() was=()
    for state_file in "$STATE_DIR"/*; do
        [ -f "$state_file" ] || continue
        if ! printf '%s\n' "${current[@]}" | grep -qxF "$state_file"; then
            resolved+=("$state_file")
            was+=("• was: $(sed -n 2p "$state_file")")
        fi
    done
    if [ "${#resolved[@]}" -gt 0 ]; then
        if [ "$NOTIFY_RESOLVED" = 1 ]; then
            send_alert "✅ $HOST_LABEL: ${#resolved[@]} problem(s) resolved"$'\n'"$(printf '%s\n' "${was[@]}")" ||
                return 1
        fi
        rm -f "${resolved[@]}"
    fi
}

# A file name for a problem key, e.g. "disk:/var" → "disk__var".
state_name() {
    printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

case "${1:-check}" in
    check)
        run_checks
        ;;
    test)
        require_settings
        snapshot "$WORK_DIR/diagnostics.txt"
        send_alert "🧪 Test alert from $HOST_LABEL (telehook-watch)" "$WORK_DIR/diagnostics.txt" &&
            cat "$WORK_DIR/response" && echo
        ;;
    send)
        require_settings
        [ $# -ge 2 ] || { echo "usage: $0 send MESSAGE [FILE...]" >&2; exit 2; }
        shift
        message="$1"
        shift
        send_alert "$message" "$@" && cat "$WORK_DIR/response" && echo
        ;;
    *)
        echo "usage: $0 [check | test | send MESSAGE [FILE...]]" >&2
        exit 2
        ;;
esac
