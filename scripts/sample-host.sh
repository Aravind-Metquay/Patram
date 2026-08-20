#!/usr/bin/env bash
# Samples host and container resource use into CSV files while a load test runs.
# Works on any Linux host with Docker - no Prometheus needed.
#
#   ./scripts/sample-host.sh                 # 5s samples into ./metrics
#   INTERVAL=2 OUT_DIR=metrics/c2 ./scripts/sample-host.sh
#
# Stop with Ctrl-C. Columns are documented in the header row of each file.
set -uo pipefail

INTERVAL="${INTERVAL:-5}"
OUT_DIR="${OUT_DIR:-metrics}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
CONTAINER_FILTER="${CONTAINER_FILTER:-pdf-service}"

mkdir -p "$OUT_DIR"
HOST_CSV="$OUT_DIR/host-$TAG.csv"
CONTAINER_CSV="$OUT_DIR/containers-$TAG.csv"

echo "ts,cpu_busy_pct,cpu_user_pct,cpu_system_pct,cpu_iowait_pct,cpu_steal_pct,load1,load5,mem_total_mb,mem_used_mb,mem_available_mb,swap_used_mb" > "$HOST_CSV"
echo "ts,container,cpu_pct,mem_used_mb,mem_limit_mb,pids" > "$CONTAINER_CSV"

echo "sampling every ${INTERVAL}s"
echo "  host       -> $HOST_CSV"
echo "  containers -> $CONTAINER_CSV"
echo "Ctrl-C to stop. Keep this running for the whole load test."

# /proc/stat fields: user nice system idle iowait irq softirq steal
read -r _ p_user p_nice p_system p_idle p_iowait p_irq p_softirq p_steal _ < /proc/stat

while true; do
  sleep "$INTERVAL"
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  read -r _ c_user c_nice c_system c_idle c_iowait c_irq c_softirq c_steal _ < /proc/stat
  HOST_LINE=$(awk -v tsv="$TS" \
    -v pu="$p_user" -v pn="$p_nice" -v ps="$p_system" -v pi="$p_idle" -v pw="$p_iowait" -v pq="$p_irq" -v pf="$p_softirq" -v pt="$p_steal" \
    -v cu="$c_user" -v cn="$c_nice" -v cs="$c_system" -v ci="$c_idle" -v cw="$c_iowait" -v cq="$c_irq" -v cf="$c_softirq" -v ct="$c_steal" \
    'BEGIN {
       du=cu-pu; dn=cn-pn; ds=cs-ps; di=ci-pi; dw=cw-pw; dq=cq-pq; df=cf-pf; dt=ct-pt;
       total=du+dn+ds+di+dw+dq+df+dt;
       if (total <= 0) total = 1;
       printf "%s,%.1f,%.1f,%.1f,%.1f,%.1f", tsv, 100*(total-di)/total, 100*(du+dn)/total, 100*ds/total, 100*dw/total, 100*dt/total;
     }')
  p_user=$c_user; p_nice=$c_nice; p_system=$c_system; p_idle=$c_idle
  p_iowait=$c_iowait; p_irq=$c_irq; p_softirq=$c_softirq; p_steal=$c_steal

  LOADS=$(awk '{printf "%s,%s", $1, $2}' /proc/loadavg)
  MEM=$(free -m | awk '/^Mem:/ {printf "%s,%s,%s", $2, $3, $7} /^Swap:/ {printf ",%s", $3}')
  echo "$HOST_LINE,$LOADS,$MEM" >> "$HOST_CSV"

  # Container stats. MemUsage looks like "123.4MiB / 1.945GiB".
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' 2>/dev/null \
    | grep -- "$CONTAINER_FILTER" \
    | awk -F'\t' -v tsv="$TS" '
        function mb(value) {
          gsub(/[[:space:]]/, "", value);
          if (value ~ /GiB$/) { sub(/GiB$/, "", value); return value * 1024 }
          if (value ~ /MiB$/) { sub(/MiB$/, "", value); return value }
          if (value ~ /KiB$/) { sub(/KiB$/, "", value); return value / 1024 }
          if (value ~ /B$/)   { sub(/B$/, "", value);   return value / 1048576 }
          return value
        }
        {
          split($3, parts, "/");
          cpu = $2; sub(/%/, "", cpu);
          printf "%s,%s,%s,%.1f,%.1f,%s\n", tsv, $1, cpu, mb(parts[1]), mb(parts[2]), $4;
        }' >> "$CONTAINER_CSV"
done
