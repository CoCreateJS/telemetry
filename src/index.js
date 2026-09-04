/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
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

import fs from 'node:fs';
import os from 'node:os';
import config from '@cocreate/config';
import { getValueFromObject, dotNotationToObject } from '@cocreate/utils';

let server = null;                     // Reference to the main CoCreateServer instance
let activeIntervalId = null;           // Storage for the core execution loop interval
let lastCpuInfo = null;                // Cache for the previous CPU telemetry sample
let telemetryConfig = {};              // In-memory reference to loaded configuration map
let dbBuffer = [];                     // In-memory array to accumulate raw telemetry ticks
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

// Default configuration settings
const defaults = {
    collectionInterval: 1000,
    writeInterval: 60000,
    retentionDays: 0 // Default set to 0 (infinite retention, never auto-delete)
};

/**
 * Loads telemetry configuration using @cocreate/config and queries database overrides
 * for 'telemetry' or 'server-telemetry' configurations.
 * 
 * @returns {Promise<Object>} Resolved telemetry configuration object
 */
async function loadTelemetryConfig() {
    const sysConfig = await config.get('telemetry');

    let dbConfig = null;
    if (server && server.organization_id) {
        dbConfig = await config.query({
            type: 'telemetry',
            organization_id: server.organization_id,
            server: server.host,
            cluster: server.cluster_id
        });
    }

    if (sysConfig) {
        dotNotationToObject(telemetryConfig, sysConfig);
    }

    if (dbConfig) {
        dotNotationToObject(telemetryConfig, dbConfig);
    }

    return telemetryConfig;
}

/**
 * Reads memory allocations using a local-dev fallback if Linux /proc is unavailable.
 * Supports cross-platform safety (macOS and Windows environments).
 * 
 * @returns {Object} Telemetry payload containing hardware-allocated details
 */
function readMemoryInfo() {
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
function readCpuInfo() {
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
                    times: parts.slice(1).map(Number)
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
function calculateCpuUsage(cpuInfo1, cpuInfo2) {
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
            usage: totalDiff > 0 ? Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100)) : 0
        };
    });
}

/**
 * Calculates a dynamic safety memory threshold percentage based on physical core-to-memory ratio.
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
 * Ingests custom component performance telemetry stats into the core registry.
 * 
 * @param {string} component - Name of the reporting component (e.g., 'mesh')
 * @param {Object} data - Key/Value pairs of custom tracking attributes
 */
function send(component, data) {
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
 * Core telemetry collection tick. Gathers system and process performance metrics,
 * appends custom metrics, evaluates emergency OOM / cordon limits, and buffers records.
 * 
 * @returns {Object} Compiled telemetry snapshot
 */
function read() {
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
    let targetMemoryThreshold = parseInt(getValueFromObject(telemetryConfig, 'scaleUpMemoryThreshold'), 10) || 85;

    const safetyConfig = getValueFromObject(telemetryConfig, 'safetyLimits');
    const isSafetyLimitsEnabled = safetyConfig !== false && safetyConfig !== 'false';

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

            if (server && typeof server.send === 'function') {
                server.send({
                    method: 'telemetry.emergency',
                    data: currentTelemetry
                });
            }
        }
    }

    // --- AUTOMATED INGRESS CORDON TRACKING (CLIENT-SIDE LOAD BALANCING) ---
    const cordonMemoryThreshold = parseInt(getValueFromObject(telemetryConfig, 'safetyLimits.cordonMemoryThreshold'), 10) || 90;
    const cordonCpuThreshold = parseInt(getValueFromObject(telemetryConfig, 'safetyLimits.cordonCpuThreshold'), 10) || 95;

    const isMemoryLimitBreached = currentTelemetry.memory.percentage >= cordonMemoryThreshold;
    const recoveryBuffer = 5;

    const isResourceSafeToRecover = currentTelemetry.memory.percentage < (cordonMemoryThreshold - recoveryBuffer) &&
        currentTelemetry.cpu.totalUsage < (cordonCpuThreshold - recoveryBuffer);

    if (server) {
        if (isMemoryLimitBreached && !server.state?.isCordon) {
            console.warn(
                `[@cocreate/server-telemetry] [CORDON TRIGGER] Server reached instantaneous memory limit! Firing cordon to sever new connections.\n` +
                ` » Active Memory: ${currentTelemetry.memory.percentage}% (Threshold: ${cordonMemoryThreshold}%)`
            );

            if (typeof server.state?.cordon === 'function') {
                void server.state.cordon(true).catch((error) => {
                    console.error('[@cocreate/server-telemetry] Failed to cordon worker:', error.message);
                });
            }
        } else if (!isMemoryLimitBreached && server.state?.isCordon && isResourceSafeToRecover) {
            console.log(
                `[@cocreate/server-telemetry] [CORDON RECOVERY] Server has recovered to safe operational margins! Removing cordon.\n` +
                ` » Active Memory: ${currentTelemetry.memory.percentage}% (Safe limit must be < ${cordonMemoryThreshold - recoveryBuffer}%)\n` +
                ` » Active CPU: ${currentTelemetry.cpu.totalUsage}% (Safe limit must be < ${cordonCpuThreshold - recoveryBuffer}%)`
            );

            if (typeof server.state?.cordon === 'function') {
                void server.state.cordon(false).catch((error) => {
                    console.error('[@cocreate/server-telemetry] Failed to uncordon worker:', error.message);
                });
            }
        }
    }

    const writeInterval = parseInt(getValueFromObject(telemetryConfig, 'writeInterval'), 10) || defaults.writeInterval;

    if (Date.now() - lastDbFlushTimestamp >= writeInterval) {
        save().catch(err => {
            console.error('[@cocreate/server-telemetry] Failed to save telemetry to DB:', err);
        });
    }

    return currentTelemetry;
}

/**
 * Processes buffered raw tick records to calculate minimum, maximum, and average values.
 * Writes aggregated results as a single document utilizing standard server.crud structures.
 */
async function save() {
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
        const cordonCpuThreshold = parseInt(getValueFromObject(telemetryConfig, 'safetyLimits.cordonCpuThreshold'), 10) || 95;

        if (cpuAvg >= cordonCpuThreshold && server && !server.state?.isCordon) {
            console.warn(
                `[@cocreate/server-telemetry] [CORDON TRIGGER - CPU AVERAGE] Server average CPU utilization over sample period breached threshold! Firing cordon to protect host.\n` +
                ` » Average CPU (over ${totalSamples} samples): ${cpuAvg.toFixed(2)}% (Threshold: ${cordonCpuThreshold}%)`
            );

            if (typeof server.state?.cordon === 'function') {
                await server.state.cordon(true);
            }
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

        const workerId = server?.workerId || 1;
        const totalWorkers = server?.totalWorkers || 1;

        const aggregatedPayload = {
            component: 'server-telemetry',
            serverId: server?.id,
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
        if (server && typeof server.send === 'function') {
            server.send({
                method: 'telemetry',
                data: aggregatedPayload
            });
        }

        // 2. WRITE HISTORICAL RECORD TO DATABASE
        if (server?.crud) {
            const dbResponse = await server.crud.send({
                method: 'object.create',
                array: 'servers_telemetry',
                object: aggregatedPayload,
                organization_id: server.organization_id,
                host: server.host
            });

            if (dbResponse && dbResponse.error) {
                console.error(`[@cocreate/server-telemetry] [WORKER ${server.workerId}] Database telemetry registration rejected:`, dbResponse.error);
            } else if (dbResponse) {
                server.wsManager.send(dbResponse);
            }
        }

        // Clean up outdated telemetry logs if configured
        const parsedRetention = parseInt(getValueFromObject(telemetryConfig, 'retentionDays'), 10);
        const retentionDays = isNaN(parsedRetention) ? defaults.retentionDays : parsedRetention;

        if (retentionDays > 0 && workerId === 1 && server?.crud) {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            await server.crud.send({
                method: 'object.delete',
                array: 'servers_telemetry',
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
function get() {
    return currentTelemetry;
}

/**
 * Starts active telemetry collection intervals.
 */
function start() {
    const collectionInterval = parseInt(getValueFromObject(telemetryConfig, 'collectionInterval'), 10) || defaults.collectionInterval;
    const customWriteInterval = parseInt(getValueFromObject(telemetryConfig, 'writeInterval'), 10) || defaults.writeInterval;
    const workerId = server?.workerId || 1;
    const totalWorkers = server?.totalWorkers || 1;

    stop();
    lastCpuInfo = readCpuInfo();

    const phaseOffset = ((workerId - 1) / totalWorkers) * customWriteInterval;
    lastDbFlushTimestamp = Date.now() - phaseOffset;

    dbBuffer = [];

    console.log(`[@cocreate/server-telemetry] [WORKER ${workerId}] Monitoring telemetry.`);
    activeIntervalId = setInterval(read, collectionInterval);
}

/**
 * Stops active telemetry collection intervals.
 */
function stop() {
    if (activeIntervalId) {
        clearInterval(activeIntervalId);
        activeIntervalId = null;
    }
}

/**
 * Initializes the TelemetryManager service and starts polling timers.
 * 
 * @param {Object} serverInstance - Core server instance
 * @returns {Promise<Object>} Telemetry service public interface
 */
async function init(serverInstance) {
    server = serverInstance;

    await loadTelemetryConfig();

    const telemetryEnabled = getValueFromObject(telemetryConfig, 'enabled') !== false &&
        getValueFromObject(telemetryConfig, 'enabled') !== 'false';

    if (telemetryEnabled) {
        start();
    } else {
        console.log('[@cocreate/server-telemetry] Monitoring is disabled.');
    }

    return {
        config: telemetryConfig,
        start,
        stop,
        send,
        get,
        read,
        save,
        readCpuInfo,
        readMemoryInfo
    };
}

export default {
    init
};
