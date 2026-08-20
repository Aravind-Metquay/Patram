import fs from 'node:fs';
import os from 'node:os';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { LogSink } from './logger.js';

/**
 * Periodic "vitals" heartbeat: one structured log line per interval carrying
 * everything needed to judge whether the machine, not the code, is the limit.
 *
 * Host CPU comes from /proc/stat, which a container sees unfiltered — so this
 * reports real CPU **steal** as well, the number that matters most on a shared
 * vCPU VPS.
 */

interface CpuSample {
  total: number;
  fields: Record<string, number>;
}

const CPU_FIELDS = [
  'user',
  'nice',
  'system',
  'idle',
  'iowait',
  'irq',
  'softirq',
  'steal',
] as const;

function readHostCpu(): CpuSample | null {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0] ?? '';
    if (!line.startsWith('cpu ')) return null;
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const fields: Record<string, number> = {};
    CPU_FIELDS.forEach((name, index) => {
      fields[name] = values[index] ?? 0;
    });
    return { total: values.reduce((sum, value) => sum + value, 0), fields };
  } catch {
    return null;
  }
}

function readNumber(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Container memory usage, cgroup v2 then v1. Null outside a container. */
function readCgroupMemory(): { usedMb: number; limitMb: number | null } | null {
  const current =
    readNumber('/sys/fs/cgroup/memory.current') ??
    readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (current === null) return null;
  const limit =
    readNumber('/sys/fs/cgroup/memory.max') ??
    readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // cgroup v1 reports "no limit" as a huge number rather than "max".
  const limitMb = limit === null || limit > 1e15 ? null : Math.round(limit / 1024 / 1024);
  return { usedMb: Math.round(current / 1024 / 1024), limitMb };
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const pct = (value: number): number => Math.round(value * 1000) / 10;

export interface VitalsOptions {
  intervalMs: number;
  /** Role-specific fields merged into the log line (queue depth, active jobs…). */
  collect?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function startVitals(logger: LogSink, options: VitalsOptions): () => void {
  let lastCpuUsage = process.cpuUsage();
  let lastHrTime = process.hrtime.bigint();
  let lastElu: EventLoopUtilization = performance.eventLoopUtilization();
  let lastHostCpu = readHostCpu();
  const cores = os.cpus().length;

  const tick = async (): Promise<void> => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - lastHrTime) / 1e6;
    lastHrTime = now;

    const cpuUsage = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;

    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();

    const memory = process.memoryUsage();
    const line: Record<string, unknown> = {
      interval_ms: Math.round(elapsedMs),
      // Percentage of one core, so >100 means the process spans cores.
      proc_cpu_pct: pct(cpuMs / elapsedMs),
      proc_cpu_pct_of_host: pct(cpuMs / elapsedMs / cores),
      event_loop_utilization_pct: pct(elu.utilization),
      rss_mb: mb(memory.rss),
      heap_used_mb: mb(memory.heapUsed),
      external_mb: mb(memory.external),
      host_cores: cores,
      host_load1: Math.round(os.loadavg()[0]! * 100) / 100,
      host_load5: Math.round(os.loadavg()[1]! * 100) / 100,
      host_mem_total_mb: mb(os.totalmem()),
      host_mem_free_mb: mb(os.freemem()),
      uptime_s: Math.round(process.uptime()),
    };

    const hostCpu = readHostCpu();
    if (hostCpu && lastHostCpu) {
      const totalDelta = hostCpu.total - lastHostCpu.total;
      if (totalDelta > 0) {
        for (const field of CPU_FIELDS) {
          const delta = (hostCpu.fields[field] ?? 0) - (lastHostCpu.fields[field] ?? 0);
          line[`host_cpu_${field}_pct`] = pct(delta / totalDelta);
        }
        const idle = (hostCpu.fields.idle ?? 0) - (lastHostCpu.fields.idle ?? 0);
        line.host_cpu_busy_pct = pct((totalDelta - idle) / totalDelta);
      }
    }
    if (hostCpu) lastHostCpu = hostCpu;

    const cgroup = readCgroupMemory();
    if (cgroup) {
      line.container_mem_mb = cgroup.usedMb;
      if (cgroup.limitMb !== null) line.container_mem_limit_mb = cgroup.limitMb;
    }

    if (options.collect) {
      try {
        Object.assign(line, await options.collect());
      } catch (error) {
        logger.debug({ err: error }, 'vitals collector failed');
      }
    }

    logger.info(line, 'vitals');
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
