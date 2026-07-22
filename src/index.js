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

let server = null;          // Reference to the main CoCreateServer instance
let activeIntervalId = null;        // Storage for the core execution loop interval
let lastCpuInfo = null;             // Cache for the previous CPU telemetry sample
let telemetryConfig = null;         // In-memory reference to loaded configuration map
let dbBuffer = [];                  // In-memory array to accumulate raw telemetry ticks
let lastDbFlushTimestamp = Date.now(); // Record of last database persistence execution
let lastEmergencyAlertTimestamp = 0;   // Throttling lock for high-priority OOM warnings

// Registry for dynamic telemetry pushed by external modules (e.g. server-mesh)
const customTelemetryRegistry = {};

// Active state snapshot populated on every poll tick
let currentTelemetry = {
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
 * @returns {Object} Telemetry payload containing hardware-allocated details
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
        console.error('[@cocreate/server-telemetry] Error reading memory info:', err.message);
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
        console.error('[@cocreate/server-telemetry] Error reading CPU ticks:', err.message);
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
 * This is symmetrically checked locally in server-telemetry.js to align the 1-second emergency loops.
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
 * Dynamic Telemetry Ingestion Protocol.
 * Allows other platform modules (like server-mesh.js) to push specific performance
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
        customTelemetryRegistry[component] = {
            ...customTelemetryRegistry[component],
            ...data,
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        console.error('[@cocreate/server-telemetry] Error capturing custom telemetry transmission:', err.message);
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

    // Populate active server-telemetry payload
    currentTelemetry = {
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
        ...customTelemetryRegistry,
        timestamp: new Date().toISOString()
    };

    dbBuffer.push(JSON.parse(JSON.stringify(currentTelemetry)));

    // --- INSTANTANEOUS 1-SECOND OOM PROTECTION CHECK ---
    let targetMemoryThreshold = telemetryConfig 
        ? parseInt(getValueFromObject(telemetryConfig, 'server-telemetry.scaleUpMemoryThreshold'), 10) 
        : 85;

    const isSafetyLimitsEnabled = getValueFromObject(telemetryConfig, 'server-telemetry.safetyLimits') !== false && getValueFromObject(telemetryConfig, 'server-telemetry.safetyLimits') !== 'false';
    
    if (isSafetyLimitsEnabled) {
        const dynamicSafetyThreshold = calculateDynamicSafetyThreshold();
        if (targetMemoryThreshold > dynamicSafetyThreshold) {
            targetMemoryThreshold = dynamicSafetyThreshold;
        }
    }

    if (currentTelemetry.memory.percentage >= targetMemoryThreshold) {
        const emergencyCooldown = 300000; 
        if (Date.now() - lastEmergencyAlertTimestamp >= emergencyCooldown) {
            lastEmergencyAlertTimestamp = Date.now();
            console.warn(`[@cocreate/server-telemetry] [EMERGENCY] Memory threshold breached on 1s tick (${currentTelemetry.memory.percentage}% >= ${targetMemoryThreshold}%). Dispatching direct system-up scaling alarm!`);
            
            server.send({
                method: 'telemetry.emergency',
                data: currentTelemetry
            });
        }
    }

    // --- AUTOMATED INGRESS CORDON TRACKING (CLIENT-SIDE LOAD BALANCING) ---
    // User-configurable limit nested inside safetyLimits, safetyOptions, or defined flat
    const cordonMemoryThreshold = telemetryConfig 
        ? parseInt(
            getValueFromObject(telemetryConfig, 'server-telemetry.safetyLimits.cordonMemoryThreshold') ||
            getValueFromObject(telemetryConfig, 'server-telemetry.safetyOptions.cordonMemoryThreshold') ||
            getValueFromObject(telemetryConfig, 'server-telemetry.cordonMemoryThreshold'), 10
          )
        : 90;

    const cordonCpuThreshold = telemetryConfig 
        ? parseInt(
            getValueFromObject(telemetryConfig, 'server-telemetry.safetyLimits.cordonCpuThreshold') ||
            getValueFromObject(telemetryConfig, 'server-telemetry.safetyOptions.cordonCpuThreshold') ||
            getValueFromObject(telemetryConfig, 'server-telemetry.cordonCpuThreshold'), 10
          )
        : 95;

    const actualMemoryThreshold = isNaN(cordonMemoryThreshold) ? 90 : cordonMemoryThreshold;
    const actualCpuThreshold = isNaN(cordonCpuThreshold) ? 95 : cordonCpuThreshold;

    // Memory limits are evaluated instantaneously on the 1-second loop
    const isMemoryLimitBreached = currentTelemetry.memory.percentage >= actualMemoryThreshold;
    
    const recoveryBuffer = 5;
    // Recovering is still active on the 1-second tick: both current CPU and Memory must be safely down
    const isResourceSafeToRecover = currentTelemetry.memory.percentage < (actualMemoryThreshold - recoveryBuffer) && 
                                    currentTelemetry.cpu.totalUsage < (actualCpuThreshold - recoveryBuffer);

    // Decoupled state execution: Telemetry acts as a sensor sending updates to the Server core.
    if (isMemoryLimitBreached && !server.isCordon) {
        // Detailed log displaying active memory and threshold limits when Cordon activates instantly
        console.warn(
            `[@cocreate/server-telemetry] [CORDON TRIGGER] Server reached instantaneous memory limit! Firing cordon to sever new connections.\n` +
            ` » Active Memory: ${currentTelemetry.memory.percentage}% (Threshold: ${actualMemoryThreshold}%)`
        );

        server.send({
            method: 'cordon',
            broadcast: true,
            active: true
        });
    } else if (!isMemoryLimitBreached && server.isCordon && isResourceSafeToRecover) {
        // Detailed log showing that the worker has settled back under safe thresholds, letting traffic back in
        console.log(
            `[@cocreate/server-telemetry] [CORDON RECOVERY] Server has recovered to safe operational margins! Removing cordon.\n` +
            ` » Active Memory: ${currentTelemetry.memory.percentage}% (Safe limit must be < ${actualMemoryThreshold - recoveryBuffer}%)\n` +
            ` » Active CPU: ${currentTelemetry.cpu.totalUsage}% (Safe limit must be < ${actualCpuThreshold - recoveryBuffer}%)`
        );

        server.send({
            method: 'cordon',
            broadcast: true,
            active: false
        });
    }

    // Dynamic Time-Staggering Check
    const customWriteInterval = telemetryConfig 
        ? parseInt(getValueFromObject(telemetryConfig, 'server-telemetry.writeInterval'), 10) 
        : defaults.writeInterval;

    const writeInterval = isNaN(customWriteInterval) ? defaults.writeInterval : customWriteInterval;

    if (Date.now() - lastDbFlushTimestamp >= writeInterval) {
        flushTelemetryToDatabase().catch(err => {
            console.error('[@cocreate/server-telemetry] Failed to flush staggered DB telemetry:', err);
        });
    }

    return currentTelemetry;
}

/**
 * Processes buffered raw tick records to calculate minimum, maximum, and average values.
 * Writes aggregated results as a single document utilizing standard server.crud structures.
 */
export async function flushTelemetryToDatabase() {
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

        const cpuMin = Math.min(...cpuUsages);
        const cpuMax = Math.max(...cpuUsages);
        const cpuAvg = cpuUsages.reduce((sum, val) => sum + val, 0) / totalSamples;

        // --- STAGGERED AVERAGE CPU CORDON TRACKING ---
        const cordonCpuThreshold = telemetryConfig 
            ? parseInt(
                getValueFromObject(telemetryConfig, 'server-telemetry.safetyLimits.cordonCpuThreshold') ||
                getValueFromObject(telemetryConfig, 'server-telemetry.safetyOptions.cordonCpuThreshold') ||
                getValueFromObject(telemetryConfig, 'server-telemetry.cordonCpuThreshold'), 10
              )
            : 95;
        const actualCpuThreshold = isNaN(cordonCpuThreshold) ? 95 : cordonCpuThreshold;

        // If average CPU utilization over the sample window breaches the threshold, fire cordon
        if (cpuAvg >= actualCpuThreshold && !server.isCordon) {
            console.warn(
                `[@cocreate/server-telemetry] [CORDON TRIGGER - CPU AVERAGE] Server average CPU utilization over sample period breached threshold! Firing cordon to protect host.\n` +
                ` » Average CPU (over ${totalSamples} samples): ${cpuAvg.toFixed(2)}% (Threshold: ${actualCpuThreshold}%)`
            );

            server.send({
                method: 'cordon',
                broadcast: true,
                active: true
            });
        }

        const memMin = Math.min(...memUsages);
        const memMax = Math.max(...memUsages);
        const memAvg = memUsages.reduce((sum, val) => sum + val, 0) / totalSamples;

        const loadAvg1m = load1m.reduce((sum, val) => sum + val, 0) / totalSamples;
        const maxHeap = Math.max(...heapUsed);

        const lastSample = dbBuffer[totalSamples - 1];

        const componentAggregates = {};
        for (const key of Object.keys(customTelemetryRegistry)) {
            componentAggregates[key] = lastSample[key] || null;
        }

        const workerId = server.workerId;
        const totalWorkers = server.totalWorkers;

        const aggregatedPayload = {
            component: 'server-telemetry',
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
            custom: componentAggregates
        };

        dbBuffer = [];
        lastDbFlushTimestamp = Date.now();

        // 1. DISPATCH LIVE EVENT VIA SERVER SEND
        server.send({
            method: 'telemetry',
            data: aggregatedPayload
        });

        // 2. WRITE HISTORICAL RECORD TO DATABASE
        const dbResponse = await server.crud.send({
            method: 'object.create',
            array: 'system_telemetry',
            object: aggregatedPayload,
            organization_id: server.organization_id,
            host: server.host
        });

        if (dbResponse && dbResponse.error) {
            console.error('[@cocreate/server-telemetry] Database telemetry registration rejected:', dbResponse.error);
        } else if (dbResponse) {
            const broadcastConfig = telemetryConfig 
                ? getValueFromObject(telemetryConfig, 'server-telemetry.broadcast')
                : defaults.broadcast;

            const isBroadcastEnabled = broadcastConfig !== false && broadcastConfig !== 'false';

            if (isBroadcastEnabled) {
                dbResponse.broadcast = broadcastConfig;
                server.wsManager.send(dbResponse);
            }
        }

        // Clean up outdated telemetry logs if configured
        const configuredRetention = telemetryConfig 
            ? parseInt(getValueFromObject(telemetryConfig, 'server-telemetry.retentionDays'), 10) 
            : defaults.retentionDays;

        const retentionDays = isNaN(configuredRetention) ? defaults.retentionDays : configuredRetention;

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
        console.error('[@cocreate/server-telemetry] Error executing database flush:', error.message);
    }
}

/**
 * Returns the cached memory and system snapshot compiled during the last execution sweep.
 * 
 * @returns {Object} Active system performance telemetry snapshot
 */
export function get() {
    return currentTelemetry;
}

/**
 * Integrates server-telemetry capabilities, loads configuration, and schedules staggered execution threads.
 */
export async function init(serverCtx) {
    server = serverCtx;

    const telemetryAPI = {
        init,
        stop,
        send,
        get,
        read,
        readCpuInfo,
        readMemoryInfo,
        calculateCpuUsage,
        flushTelemetryToDatabase
    };

    telemetryConfig = await Config.get('telemetry');

    const telemetryEnabled = getValueFromObject(telemetryConfig, 'server-telemetry.enabled') !== false && getValueFromObject(telemetryConfig, 'server-telemetry.enabled') !== 'false';

    if (!telemetryEnabled) {
        console.log('[@cocreate/server-telemetry] Monitoring is disabled by configuration.');
        return telemetryAPI;
    }

    const collectionInterval = parseInt(getValueFromObject(telemetryConfig, 'server-telemetry.collectionInterval'), 10) || defaults.collectionInterval;
    const customWriteInterval = parseInt(getValueFromObject(telemetryConfig, 'server-telemetry.writeInterval'), 10) || defaults.writeInterval;
    
    const workerId = server.workerId;
    const totalWorkers = server.totalWorkers;

    stop();

    lastCpuInfo = readCpuInfo();
    
    const phaseOffset = ((workerId - 1) / totalWorkers) * customWriteInterval;
    lastDbFlushTimestamp = Date.now() - phaseOffset;
    
    dbBuffer = [];

    console.log(`[@cocreate/server-telemetry] [WORKER ${workerId}] Monitoring telemetry.`);
    activeIntervalId = setInterval(read, collectionInterval);

    return telemetryAPI;
}

export function stop() {
    if (activeIntervalId) {
        clearInterval(activeIntervalId);
        activeIntervalId = null;
    }
}

export default {
    init,
    stop,
    send,
    get,
    read,
    readCpuInfo,
    readMemoryInfo,
    calculateCpuUsage,
    flushTelemetryToDatabase
};
