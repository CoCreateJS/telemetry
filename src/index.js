/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import fs from 'node:fs';
import os from 'node:os';
import Config from '@cocreate/config';
import { getValueFromObject } from '@cocreate/utils';

// ==============================================================================
// Module-Level Sandbox State (ESM Singleton Container)
// ==============================================================================
let server = null;          // Reference to the main CoCreateServer instance
let activeIntervalId = null;    // Storage for the core execution loop interval
let lastCpuInfo = null;         // Cache for the previous CPU metrics sample
let metricsConfig = null;       // In-memory reference to loaded configuration map
let dbBuffer = [];              // In-memory array to accumulate raw metric ticks
let lastDbFlushTimestamp = Date.now(); // Record of last database persistence execution
let lastEmergencyAlertTimestamp = 0;   // Throttling lock for high-priority OOM warnings

// Registry for dynamic metrics pushed by external modules (e.g. socket-mesh)
const customMetricsRegistry = {};

// Active state snapshot populated on every poll tick
let currentMetrics = {
    cpu: { totalUsage: 0, cores: [] },
    memory: { total: 0, available: 0, used: 0, percentage: 0 },
    system: { loadavg: [0, 0, 0], uptime: 0 },
    process: { uptime: 0, heapTotal: 0, heapUsed: 0, rss: 0, external: 0 },
    timestamp: null
};

// Default configurations
const defaults = {
    collectionInterval: 1000,
    writeInterval: 60000,
    retentionDays: 0, // Default set to 0 (infinite retention, never auto-delete)
    broadcast: true
};

/**
 * Reads memory allocations using a local-dev fallback if Linux /proc is unavailable.
 * Supports cross-platform safety (macOS and Windows environments).
 * 
 * @returns {Object} Metric payload containing hardware-allocated details
 */
export function readMemoryInfo() {
    try {
        if (os.platform() !== 'linux') {
            const totalMemoryBytes = os.totalmem();
            const freeMemoryBytes = os.freemem();
            const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;
            const usedMemoryPercentage = (usedMemoryBytes / totalMemoryBytes) * 100;

            return {
                totalMemory: Math.round(totalMemoryBytes / 1024),
                availableMemory: Math.round(freeMemoryBytes / 1024),
                usedMemory: Math.round(usedMemoryBytes / 1024),
                usedMemoryPercentage
            };
        }

        const memInfoContent = fs.readFileSync('/proc/meminfo', 'utf8');
        const memInfoLines = memInfoContent.split('\n');
        const memInfo = memInfoLines.reduce((info, line) => {
            const parts = line.split(':');
            if (parts.length === 2) {
                info[parts[0].trim()] = parts[1].trim();
            }
            return info;
        }, {});

        const totalMemory = parseInt(memInfo['MemTotal'], 10);
        const availableMemory = parseInt(memInfo['MemAvailable'] || memInfo['MemFree'], 10);
        const usedMemory = totalMemory - availableMemory;
        const usedMemoryPercentage = (usedMemory / totalMemory) * 100;

        return {
            totalMemory,
            availableMemory,
            usedMemory,
            usedMemoryPercentage
        };
    } catch (err) {
        console.error('[@cocreate/metrics] Error reading memory info:', err.message);
        return { totalMemory: 0, availableMemory: 0, usedMemory: 0, usedMemoryPercentage: 0 };
    }
}

/**
 * Reads CPU performance ticks across cores natively or using fallback trackers.
 * 
 * @returns {Array} List of CPU core tickers and time allocations
 */
export function readCpuInfo() {
    try {
        if (os.platform() !== 'linux') {
            const cpus = os.cpus();
            return cpus.map((cpu, index) => {
                const t = cpu.times;
                return {
                    core: `cpu${index}`,
                    times: [t.user, t.nice, t.sys, t.idle, t.irq]
                };
            });
        }

        const cpuInfoContent = fs.readFileSync('/proc/stat', 'utf8');
        const cpuLines = cpuInfoContent.split('\n');
        return cpuLines
            .filter(line => line.startsWith('cpu'))
            .map(line => {
                const parts = line.split(/\s+/).filter(Boolean);
                return {
                    core: parts[0],
                    times: parts.slice(1).map(Number),
                };
            });
    } catch (err) {
        console.error('[@cocreate/metrics] Error reading CPU ticks:', err.message);
        return [];
    }
}

/**
 * Computes CPU core utilization percentages by comparing differential cycle ticks.
 * 
 * @param {Array} cpuInfo1 - First historical CPU sample state
 * @param {Array} cpuInfo2 - Newly captured secondary CPU sample state
 * @returns {Array} Differential usage details per hardware core
 */
export function calculateCpuUsage(cpuInfo1, cpuInfo2) {
    if (!cpuInfo1 || !cpuInfo1.length || !cpuInfo2 || !cpuInfo2.length) return [];

    return cpuInfo1.map((coreInfo1) => {
        const coreInfo2 = cpuInfo2.find(c => c.core === coreInfo1.core);
        if (!coreInfo2) return { core: coreInfo1.core, usage: 0 };

        const idle1 = coreInfo1.times[3] || 0;
        const idle2 = coreInfo2.times[3] || 0;

        const total1 = coreInfo1.times.reduce((acc, val) => acc + val, 0);
        const total2 = coreInfo2.times.reduce((acc, val) => acc + val, 0);

        const totalDiff = total2 - total1;
        const idleDiff = idle2 - idle1;

        return {
            core: coreInfo1.core,
            usage: totalDiff > 0 ? Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100)) : 0,
        };
    });
}

/**
 * Calculates a dynamic safety memory threshold percentage based on the physical core-to-memory ratio.
 * This is symmetrically checked locally in metrics.js to align the 1-second emergency loops.
 * 
 * @returns {number} Calculated maximum safe memory percentage threshold (capped between 50% and 90%)
 */
function calculateDynamicSafetyThreshold() {
    const coresCount = os.cpus().length;
    const totalMemoryMb = os.totalmem() / 1024 / 1024;
    
    const allocationRatePerCoreMs = 15; // Estimated peak allocation speed in MB/sec under sustained load
    const bootWindowSeconds = 60;      // Boot delay window for new instances
    
    const requiredHeadroomMb = coresCount * allocationRatePerCoreMs * bootWindowSeconds;
    const headroomPercentage = (requiredHeadroomMb / totalMemoryMb) * 100;
    
    const maxSafePercentage = Math.round(100 - headroomPercentage);
    
    // Safety clamps: Prevent calculated values from getting too extreme
    return Math.max(50, Math.min(90, maxSafePercentage));
}

/**
 * Dynamic Metrics Ingestion Protocol.
 * Allows other platform modules (like socket-mesh.js) to push specific performance
 * stats directly to the core telemetry registry to be emitted and serialized.
 * 
 * @param {string} component - Name of the reporting component (e.g., 'mesh')
 * @param {Object} data - Key/Value pairs of custom tracking attributes
 */
export function send(component, data) {
    if (!component || typeof component !== 'string' || !data || typeof data !== 'object') {
        return;
    }
    try {
        customMetricsRegistry[component] = {
            ...customMetricsRegistry[component],
            ...data,
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        console.error('[@cocreate/metrics] Error capturing custom metric transmission:', err.message);
    }
}

/**
 * Core execution tick. Collects system specs, appends external custom registries,
 * and commits rolls to database buffer limits. Excludes event-emitter or callback leaks.
 */
export function read() {
    const memory = readMemoryInfo();
    const currentCpuInfo = readCpuInfo();

    let cpuTotalUsage = 0;
    let coresUsage = [];

    if (lastCpuInfo) {
        coresUsage = calculateCpuUsage(lastCpuInfo, currentCpuInfo);
        if (coresUsage.length > 0) {
            const detailedCores = coresUsage.filter(c => c.core !== 'cpu');
            const targetSet = detailedCores.length > 0 ? detailedCores : coresUsage;
            
            const totalSum = targetSet.reduce((sum, core) => sum + core.usage, 0);
            cpuTotalUsage = totalSum / targetSet.length;
        }
    }

    lastCpuInfo = currentCpuInfo;

    const processMemory = process.memoryUsage();

    // Populate active metrics payload
    currentMetrics = {
        cpu: {
            totalUsage: parseFloat(cpuTotalUsage.toFixed(2)),
            cores: coresUsage
        },
        memory: {
            total: memory.totalMemory,
            available: memory.availableMemory,
            used: memory.usedMemory,
            percentage: parseFloat(memory.usedMemoryPercentage.toFixed(2))
        },
        system: {
            loadavg: os.loadavg(),
            uptime: Math.round(os.uptime())
        },
        process: {
            uptime: Math.round(process.uptime()),
            heapTotal: Math.round(processMemory.heapTotal / 1024),
            heapUsed: Math.round(processMemory.heapUsed / 1024),
            rss: Math.round(processMemory.rss / 1024),
            external: Math.round(processMemory.external / 1024)
        },
        // Symmetrically merge custom component blocks directly into the heartbeat payload
        ...customMetricsRegistry,
        timestamp: new Date().toISOString()
    };

    dbBuffer.push(JSON.parse(JSON.stringify(currentMetrics)));

    // --- INSTANTANEOUS 1-SECOND OOM PROTECTION CHECK ---
    // If memory spikes above the threshold on any individual 1-second sample,
    // fire an immediate emergency signal to the Master process.
    let targetMemoryThreshold = metricsConfig 
        ? parseInt(getValueFromObject(metricsConfig, 'metrics.scaleUpMemoryThreshold'), 10) 
        : 85;

    // Apply Dynamic Safety limits to 1s emergency checks if enabled (on by default)
    const isSafetyLimitsEnabled = getValueFromObject(metricsConfig, 'metrics.safetyLimits') !== false && getValueFromObject(metricsConfig, 'metrics.safetyLimits') !== 'false';
    
    if (isSafetyLimitsEnabled) {
        const dynamicSafetyThreshold = calculateDynamicSafetyThreshold();
        if (targetMemoryThreshold > dynamicSafetyThreshold) {
            targetMemoryThreshold = dynamicSafetyThreshold;
        }
    }

    if (currentMetrics.memory.percentage >= targetMemoryThreshold) {
        const emergencyCooldown = 300000; // Throttle to maximum 1 emergency signal every 5 minutes per worker node
        if (Date.now() - lastEmergencyAlertTimestamp >= emergencyCooldown) {
            lastEmergencyAlertTimestamp = Date.now();
            console.warn(`[@cocreate/metrics] [EMERGENCY] Memory threshold breached on 1s tick (${currentMetrics.memory.percentage}% >= ${targetMemoryThreshold}%). Dispatching direct system-up scaling alarm!`);
            
            server.send({
                method: 'metric.emergency',
                data: currentMetrics
            });
        }
    }

    // Dynamic Time-Staggering Check:
    // All workers write their own process stats, but their flush intervals are staggered
    // using a round-robin calculation to prevent massive write collisions.
    const customWriteInterval = metricsConfig 
        ? parseInt(getValueFromObject(metricsConfig, 'metrics.writeInterval'), 10) 
        : defaults.writeInterval;

    const writeInterval = isNaN(customWriteInterval) ? defaults.writeInterval : customWriteInterval;

    if (Date.now() - lastDbFlushTimestamp >= writeInterval) {
        flushMetricsToDatabase().catch(err => {
            console.error('[@cocreate/metrics] Failed to flush staggered DB metrics:', err);
        });
    }

    return currentMetrics;
}

/**
 * Processes buffered raw tick records to calculate minimum, maximum, and average values.
 * Writes aggregated results as a single document utilizing standard server.crud structures.
 * Also emits the statistical metrics directly to the IPC loop using fail-fast server.send().
 * Cleans up outdated database telemetry metrics if retentionDays is configured.
 */
export async function flushMetricsToDatabase() {
    if (dbBuffer.length === 0) {
        lastDbFlushTimestamp = Date.now();
        return;
    }

    try {
        const totalSamples = dbBuffer.length;
        
        const cpuUsages = dbBuffer.map(sample => sample.cpu.totalUsage);
        const memUsages = dbBuffer.map(sample => sample.memory.percentage);
        const load1m = dbBuffer.map(sample => sample.system.loadavg[0]);
        const heapUsed = dbBuffer.map(sample => sample.process.heapUsed);

        // Compute statistical aggregates
        const cpuMin = Math.min(...cpuUsages);
        const cpuMax = Math.max(...cpuUsages);
        const cpuAvg = cpuUsages.reduce((sum, val) => sum + val, 0) / totalSamples;

        const memMin = Math.min(...memUsages);
        const memMax = Math.max(...memUsages);
        const memAvg = memUsages.reduce((sum, val) => sum + val, 0) / totalSamples;

        const loadAvg1m = load1m.reduce((sum, val) => sum + val, 0) / totalSamples;
        const maxHeap = Math.max(...heapUsed);

        const lastSample = dbBuffer[totalSamples - 1];

        // Gather any custom component keys injected during the current buffer window
        const componentAggregates = {};
        for (const key of Object.keys(customMetricsRegistry)) {
            componentAggregates[key] = lastSample[key] || null;
        }

        const workerId = server.workerId;
        const totalWorkers = server.totalWorkers;

        const aggregatedPayload = {
            component: 'metrics',
            serverId: server.id,
            workerId: workerId,
            totalWorkers: totalWorkers,
            timestamp: new Date().toISOString(),
            interval_seconds: Math.round((Date.now() - lastDbFlushTimestamp) / 1000),
            samples_collected: totalSamples,
            cpu: {
                min: parseFloat(cpuMin.toFixed(2)),
                max: parseFloat(cpuMax.toFixed(2)),
                avg: parseFloat(cpuAvg.toFixed(2))
            },
            memory: {
                total_kb: lastSample.memory.total,
                min_used_pct: parseFloat(memMin.toFixed(2)),
                max_used_pct: parseFloat(memMax.toFixed(2)),
                avg_used_pct: parseFloat(memAvg.toFixed(2))
            },
            system: {
                loadavg_1m_avg: parseFloat(loadAvg1m.toFixed(2)),
                os_uptime: lastSample.system.uptime
            },
            process: {
                worker_uptime: lastSample.process.uptime,
                max_heap_kb: maxHeap
            },
            // Save dynamic custom telemetry blocks
            custom: componentAggregates
        };

        // Clear local buffer immediately to avoid execution loop overlap
        dbBuffer = [];
        lastDbFlushTimestamp = Date.now();

        // 1. DISPATCH LIVE EVENT VIA SERVER SEND (FAIL-FAST)
        // Replaced workerStorage loops. Directly fire the 'metric' method upstream.
        // It should route cleanly or throw immediately.
        server.send({
            method: 'metric',
            data: aggregatedPayload
        });

        // 2. WRITE HISTORICAL RECORD TO DATABASE
        // Target standard CoCreate server storage configuration using server.crud directly
        const dbResponse = await server.crud.send({
            method: 'object.create',
            array: 'system_telemetry',
            object: aggregatedPayload,
            organization_id: server.organization_id,
            host: server.host
        });

        if (dbResponse && dbResponse.error) {
            console.error('[@cocreate/metrics] Database telemetry registration rejected:', dbResponse.error);
        } else if (dbResponse) {
            const broadcastConfig = metricsConfig 
                ? getValueFromObject(metricsConfig, 'metrics.broadcast')
                : defaults.broadcast;

            const isBroadcastEnabled = broadcastConfig !== false && broadcastConfig !== 'false';

            if (isBroadcastEnabled) {
                // Inject broadcast parameters onto the validated response object
                dbResponse.broadcast = broadcastConfig;
                server.wsManager.send(dbResponse);
            }
        }

        // Clean up outdated telemetry logs if configured
        const configuredRetention = metricsConfig 
            ? parseInt(getValueFromObject(metricsConfig, 'metrics.retentionDays'), 10) 
            : defaults.retentionDays;

        const retentionDays = isNaN(configuredRetention) ? defaults.retentionDays : configuredRetention;

        // Only Worker 1 handles retention pruning to prevent lock disputes
        if (retentionDays > 0 && workerId === 1) {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            await server.crud.send({
                method: 'object.delete',
                array: 'system_telemetry',
                object: {
                    timestamp: { $lt: cutoffDate.toISOString() }
                },
                organization_id: server.organization_id,
                host: server.host
            });
        }

    } catch (error) {
        console.error('[@cocreate/metrics] Error executing database flush:', error.message);
    }
}

/**
 * Returns the cached memory and system snapshot compiled during the last execution sweep.
 * 
 * @returns {Object} Active system performance telemetry snapshot
 */
export function get() {
    return currentMetrics;
}

/**
 * Integrates metrics capabilities, loads configuration, and schedules staggered execution threads.
 * Returns the functional API contract directly instead of mutating the parent server context.
 * 
 * @param {Object} serverCtx - The core instantiated server environment
 * @returns {Object} Functional API contract for the metrics subsystem
 */
export async function init(serverCtx) {
    server = serverCtx;

    // Define functional API contract
    const metricsAPI = {
        init,
        stop,
        send,
        get,
        read,
        readCpuInfo,
        readMemoryInfo,
        calculateCpuUsage,
        flushMetricsToDatabase
    };

    // Load nested telemetry parameters matching standard configuration queries
    metricsConfig = await Config({
        'metrics': ''
    });

    const metricsEnabled = getValueFromObject(metricsConfig, 'metrics.enabled') !== false && getValueFromObject(metricsConfig, 'metrics.enabled') !== 'false';

    if (!metricsEnabled) {
        console.log('[@cocreate/metrics] Monitoring is disabled by configuration.');
        return metricsAPI;
    }

    const collectionInterval = parseInt(getValueFromObject(metricsConfig, 'metrics.collectionInterval'), 10) || defaults.collectionInterval;
    const customWriteInterval = parseInt(getValueFromObject(metricsConfig, 'metrics.writeInterval'), 10) || defaults.writeInterval;
    
    const workerId = server.workerId;
    const totalWorkers = server.totalWorkers;
    
    // Staggered launch delays to prevent resource spikes during multi-worker server boots
    const staggeredDelay = (workerId * collectionInterval) + (totalWorkers * collectionInterval);

    stop();

    lastCpuInfo = readCpuInfo();
    
    // Mathematically offset the first write target so that worker logging phases
    // are perfectly staggered across the write window, avoiding write overlaps!
    const phaseOffset = ((workerId - 1) / totalWorkers) * customWriteInterval;
    lastDbFlushTimestamp = Date.now() - phaseOffset;
    
    dbBuffer = [];

    console.log(`[@cocreate/metrics] Starting poller on Worker ${process.pid} (Worker ID: ${workerId}/${totalWorkers}, Write Offset Phase: ${phaseOffset}ms)`);
    activeIntervalId = setInterval(read, collectionInterval);

    return metricsAPI;
}

export function stop() {
    if (activeIntervalId) {
        clearInterval(activeIntervalId);
        activeIntervalId = null;
    }
}

// Default export matches standard functional API entry contract
export default {
    init,
    stop,
    send,
    get,
    read,
    readCpuInfo,
    readMemoryInfo,
    calculateCpuUsage,
    flushMetricsToDatabase
};