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
    swap: { total: 0, available: 0, used: 0, percentage: null, enabled: false },
    unreclaimable: { unevictable_kb: null, mlocked_kb: null },
    memoryPressure: {
        supported: false,
        some: { avg10_pct: null, avg60_pct: null, avg300_pct: null, total_us: null },
        full: { avg10_pct: null, avg60_pct: null, avg300_pct: null, total_us: null }
    },
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
 * for 'telemetry' or 'telemetry' configurations.
 *
 * @returns {Promise<Object>} Resolved telemetry configuration object
 * @private
 * @environment server
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
 * @private
 * @environment server
 */
function readLinuxMemInfo() {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    return content.split('\n').reduce((info, line) => {
        const parts = line.split(':');
        if (parts.length === 2) info[parts[0].trim()] = parts[1].trim();
        return info;
    }, {});
}

function readMemoryInfo(linuxMemInfo = null) {
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

        const memInfo = linuxMemInfo || readLinuxMemInfo();

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
        console.error('[@cocreate/telemetry] Error reading memory info:', err.message);
        return { totalMemory: 0, availableMemory: 0, usedMemory: 0, usedMemoryPercentage: 0 };
    }
}

/** Reads Linux swap capacity and current use from /proc/meminfo.  * @private
 * @environment server
 */
function readSwapInfo(linuxMemInfo = null) {
    if (os.platform() !== 'linux') {
        return { total: null, available: null, used: null, percentage: null, enabled: false };
    }

    try {
        const memInfo = linuxMemInfo || readLinuxMemInfo();
        const total = Number.parseInt(memInfo.SwapTotal, 10) || 0;
        const available = Number.parseInt(memInfo.SwapFree, 10) || 0;
        const used = Math.max(0, total - available);

        return {
            total,
            available,
            used,
            percentage: total > 0 ? (used / total) * 100 : null,
            enabled: total > 0
        };
    } catch (error) {
        console.error('[@cocreate/telemetry] Error reading swap info:', error.message);
        return { total: null, available: null, used: null, percentage: null, enabled: false };
    }
}

/** Reads unreclaimable Linux memory counters. Mlocked is a subset of Unevictable.  * @private
 * @environment server
 */
function readUnreclaimableInfo(linuxMemInfo = null) {
    if (os.platform() !== 'linux') {
        return { unevictable_kb: null, mlocked_kb: null };
    }

    try {
        const memInfo = linuxMemInfo || readLinuxMemInfo();
        const parseKb = key => Number.parseInt(memInfo[key], 10);
        return {
            unevictable_kb: Number.isFinite(parseKb('Unevictable')) ? parseKb('Unevictable') : null,
            mlocked_kb: Number.isFinite(parseKb('Mlocked')) ? parseKb('Mlocked') : null
        };
    } catch (error) {
        console.error('[@cocreate/telemetry] Error reading unreclaimable memory info:', error.message);
        return { unevictable_kb: null, mlocked_kb: null };
    }
}

/** Reads Linux memory PSI rolling stall percentages and cumulative stall time.  * @private
 * @environment server
 */
function readMemoryPressureInfo() {
    const empty = {
        supported: false,
        some: { avg10_pct: null, avg60_pct: null, avg300_pct: null, total_us: null },
        full: { avg10_pct: null, avg60_pct: null, avg300_pct: null, total_us: null }
    };
    if (os.platform() !== 'linux') return empty;

    try {
        const lines = fs.readFileSync('/proc/pressure/memory', 'utf8').trim().split('\n');
        const pressure = { ...empty, supported: true };
        for (const line of lines) {
            const [kind, ...fields] = line.trim().split(/\s+/);
            if (!['some', 'full'].includes(kind)) continue;
            const values = Object.fromEntries(fields.map(field => field.split('=')));
            pressure[kind] = {
                avg10_pct: Number.parseFloat(values.avg10),
                avg60_pct: Number.parseFloat(values.avg60),
                avg300_pct: Number.parseFloat(values.avg300),
                total_us: Number.parseInt(values.total, 10)
            };
        }
        return pressure;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[@cocreate/telemetry] Error reading memory pressure info:', error.message);
        }
        return empty;
    }
}

function aggregateMetric(values) {
    const finiteValues = values.filter(Number.isFinite);
    if (!finiteValues.length) return { min: null, max: null, avg: null };
    return {
        min: Math.min(...finiteValues),
        max: Math.max(...finiteValues),
        avg: finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    };
}

function roundMetric(value) {
    return Number.isFinite(value) ? parseFloat(value.toFixed(2)) : null;
}

function getConfiguredThreshold(path) {
    const value = getValueFromObject(telemetryConfig, path);
    if (value === undefined || value === null || value === '') return null;
    const threshold = Number.parseFloat(value);
    return Number.isFinite(threshold) ? threshold : null;
}

function getCordonThresholds() {
    const memoryThreshold = getConfiguredThreshold('safetyLimits.cordonMemoryThreshold');
    const cpuThreshold = getConfiguredThreshold('safetyLimits.cordonCpuThreshold');
    const optional = {
        swap: getConfiguredThreshold('safetyLimits.cordonSwapThreshold'),
        unreclaimable: getConfiguredThreshold('safetyLimits.cordonUnreclaimableThreshold'),
        mlocked: getConfiguredThreshold('safetyLimits.cordonMlockedThreshold'),
        memoryPressure: getConfiguredThreshold('safetyLimits.cordonMemoryPressureThreshold')
    };

    return {
        memory: memoryThreshold === null ? 90 : memoryThreshold,
        cpu: cpuThreshold === null ? 95 : cpuThreshold,
        optional,
        combined: Object.values(optional).some(value => value !== null)
    };
}

function cordonConditions(sample, thresholds) {
    const conditions = [{
        name: 'memory',
        value: sample.memory?.percentage,
        threshold: thresholds.memory
    }];
    if (thresholds.optional.swap !== null) conditions.push({
        name: 'swap',
        value: sample.swap?.percentage,
        threshold: thresholds.optional.swap
    });
    if (thresholds.optional.unreclaimable !== null) conditions.push({
        name: 'unreclaimable',
        value: Number(sample.memory?.total) > 0 && Number.isFinite(sample.unreclaimable?.unevictable_kb)
            ? (sample.unreclaimable.unevictable_kb / sample.memory.total) * 100
            : null,
        threshold: thresholds.optional.unreclaimable
    });
    if (thresholds.optional.mlocked !== null) conditions.push({
        name: 'mlocked',
        value: Number(sample.memory?.total) > 0 && Number.isFinite(sample.unreclaimable?.mlocked_kb)
            ? (sample.unreclaimable.mlocked_kb / sample.memory.total) * 100
            : null,
        threshold: thresholds.optional.mlocked
    });
    if (thresholds.optional.memoryPressure !== null) conditions.push({
        name: 'memoryPressure',
        value: sample.memoryPressure?.some?.avg10_pct,
        threshold: thresholds.optional.memoryPressure
    });
    return conditions;
}

function evaluateThresholds(conditions, thresholdOffset = 0) {
    const results = conditions.map(condition => ({
        ...condition,
        value: condition.value
    }));
    return {
        results,
        allAtOrAbove: results.every(condition => Number.isFinite(condition.value) &&
            condition.value >= condition.threshold + thresholdOffset),
        anyBelow: results.some(condition => Number.isFinite(condition.value) &&
            condition.value < condition.threshold + thresholdOffset),
        allAvailable: results.every(condition => Number.isFinite(condition.value))
    };
}

/**
 * Reads CPU performance ticks across cores natively or using fallback trackers.
 *
 * @returns {Array} List of CPU core tickers and time allocations
 * @private
 * @environment server
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
        console.error('[@cocreate/telemetry] Error reading CPU ticks:', err.message);
        return [];
    }
}

/**
 * Computes CPU core utilization percentages by comparing differential cycle ticks.
 *
 * @param {Array} cpuInfo1 - First historical CPU sample state
 * @param {Array} cpuInfo2 - Newly captured secondary CPU sample state
 * @returns {Array} Differential usage details per hardware core
 * @private
 * @environment server
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
 * @private
 * @environment server
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
 * @private
 * @environment server
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
        console.error('[@cocreate/telemetry] Error capturing custom telemetry transmission:', err.message);
    }
}

/**
 * Core telemetry collection tick. Gathers system and process performance metrics,
 * appends custom metrics, evaluates emergency OOM / cordon limits, and buffers records.
 *
 * @returns {Object} Compiled telemetry snapshot
 * @private
 * @environment server
 */
function read() {
    let linuxMemInfo = null;
    if (os.platform() === 'linux') {
        try {
            linuxMemInfo = readLinuxMemInfo();
        } catch (error) {
            console.error('[@cocreate/telemetry] Error reading Linux memory info:', error.message);
        }
    }
    const memory = readMemoryInfo(linuxMemInfo);
    const swap = readSwapInfo(linuxMemInfo);
    const unreclaimable = readUnreclaimableInfo(linuxMemInfo);
    const memoryPressure = readMemoryPressureInfo();
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

    // Populate active telemetry payload
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
        swap: {
            ...swap,
            percentage: Number.isFinite(swap.percentage) ? parseFloat(swap.percentage.toFixed(2)) : null
        },
        unreclaimable,
        memoryPressure,
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
            console.warn(`[@cocreate/telemetry] [EMERGENCY] Memory threshold breached on 1s tick (${currentTelemetry.memory.percentage}% >= ${targetMemoryThreshold}%). Dispatching direct system-up scaling alarm!`);

            if (server && typeof server.send === 'function') {
                server.send({
                    method: 'telemetry.emergency',
                    data: currentTelemetry
                });
            }
        }
    }

    // --- AUTOMATED INGRESS CORDON TRACKING (CLIENT-SIDE LOAD BALANCING) ---
    const cordonThresholds = getCordonThresholds();
    const cordonMemoryThreshold = cordonThresholds.memory;
    const cordonCpuThreshold = cordonThresholds.cpu;

    const memoryConditions = cordonConditions(currentTelemetry, cordonThresholds);
    const memoryTrigger = evaluateThresholds(memoryConditions);
    const memoryRecovery = evaluateThresholds(memoryConditions, -5);
    const isMemoryLimitBreached = !cordonThresholds.combined
        ? currentTelemetry.memory.percentage >= cordonMemoryThreshold
        : memoryTrigger.allAvailable && memoryTrigger.allAtOrAbove;
    const recoveryBuffer = 5;

    const isResourceSafeToRecover = currentTelemetry.memory.percentage < (cordonMemoryThreshold - recoveryBuffer) &&
        currentTelemetry.cpu.totalUsage < (cordonCpuThreshold - recoveryBuffer);

    if (server) {
        if (isMemoryLimitBreached && !server.state?.isCordon) {
            const details = cordonThresholds.combined
                ? memoryTrigger.results.map(item =>
                    `${item.name}=${item.value.toFixed(2)}% (threshold ${item.threshold}%)`
                ).join(', ')
                : `Active Memory: ${currentTelemetry.memory.percentage}% (Threshold: ${cordonMemoryThreshold}%)`;
            console.warn(
                `[@cocreate/telemetry] [CORDON TRIGGER - INSTANTANEOUS MEMORY SAFETY] ` +
                `Server reached its configured memory safety limits. Firing cordon to sever new connections.\n » ${details}`
            );

            if (typeof server.state?.cordon === 'function') {
                void server.state.cordon(true).catch((error) => {
                    console.error('[@cocreate/telemetry] Failed to cordon worker:', error.message);
                });
            }
        } else if (server.state?.isCordon && (cordonThresholds.combined
            ? memoryRecovery.allAvailable && memoryRecovery.anyBelow &&
                currentTelemetry.cpu.totalUsage < (cordonCpuThreshold - recoveryBuffer)
            : !isMemoryLimitBreached && isResourceSafeToRecover)) {
            console.log(
                `[@cocreate/telemetry] [CORDON RECOVERY] Server has recovered to safe operational margins. Removing cordon.`
            );

            if (typeof server.state?.cordon === 'function') {
                void server.state.cordon(false).catch((error) => {
                    console.error('[@cocreate/telemetry] Failed to uncordon worker:', error.message);
                });
            }
        }
    }

    const writeInterval = parseInt(getValueFromObject(telemetryConfig, 'writeInterval'), 10) || defaults.writeInterval;

    if (Date.now() - lastDbFlushTimestamp >= writeInterval) {
        save().catch(err => {
            console.error('[@cocreate/telemetry] Failed to save telemetry to DB:', err);
        });
    }

    return currentTelemetry;
}

/**
 * Processes buffered raw tick records to calculate minimum, maximum, and average values.
 * Writes aggregated results as a single document utilizing standard server.crud structures.
 * @private
 * @environment server
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
        const swapUsages = dbBuffer.map(sample => sample.swap?.percentage).filter(Number.isFinite);
        const swapAvailable = aggregateMetric(dbBuffer.map(sample => sample.swap?.available));
        const swapUsed = aggregateMetric(dbBuffer.map(sample => sample.swap?.used));
        const unevictable = aggregateMetric(dbBuffer.map(sample => sample.unreclaimable?.unevictable_kb));
        const mlocked = aggregateMetric(dbBuffer.map(sample => sample.unreclaimable?.mlocked_kb));
        const memoryPressureStats = {};
        for (const level of ['some', 'full']) {
            memoryPressureStats[level] = {};
            for (const window of ['avg10_pct', 'avg60_pct', 'avg300_pct']) {
                memoryPressureStats[level][window] = aggregateMetric(
                    dbBuffer.map(sample => sample.memoryPressure?.[level]?.[window])
                );
            }
        }
        const load1m = dbBuffer.map(sample => sample.system.loadavg[0]);
        const heapUsed = dbBuffer.map(sample => sample.process.heapUsed);

        const cpuMin = Math.min(...cpuUsages);
        const cpuMax = Math.max(...cpuUsages);
        const cpuAvg = cpuUsages.reduce((sum, val) => sum + val, 0) / totalSamples;

        // --- STAGGERED AVERAGE CPU CORDON TRACKING ---
        const cordonCpuThreshold = parseInt(getValueFromObject(telemetryConfig, 'safetyLimits.cordonCpuThreshold'), 10) || 95;

        if (cpuAvg >= cordonCpuThreshold && server && !server.state?.isCordon) {
            console.warn(
                `[@cocreate/telemetry] [CORDON TRIGGER - CPU AVERAGE] Server average CPU utilization over sample period breached threshold! Firing cordon to protect host.\n` +
                ` » Average CPU (over ${totalSamples} samples): ${cpuAvg.toFixed(2)}% (Threshold: ${cordonCpuThreshold}%)`
            );

            if (typeof server.state?.cordon === 'function') {
                await server.state.cordon(true);
            }
        }

        const memMin = Math.min(...memUsages);
        const memMax = Math.max(...memUsages);
        const memAvg = memUsages.reduce((sum, val) => sum + val, 0) / totalSamples;
        const swapMin = swapUsages.length ? Math.min(...swapUsages) : null;
        const swapMax = swapUsages.length ? Math.max(...swapUsages) : null;
        const swapAvg = swapUsages.length
            ? swapUsages.reduce((sum, val) => sum + val, 0) / swapUsages.length
            : null;

        const loadAvg1m = load1m.reduce((sum, val) => sum + val, 0) / totalSamples;
        const maxHeap = Math.max(...heapUsed);

        const lastSample = dbBuffer[totalSamples - 1];

        const componentAggregates = {};
        for (const key of Object.keys(customTelemetryRegistry)) {
            componentAggregates[key] = lastSample[key] || null;
        }

        const workerId = server?.workerId || 1;
        const workerCount = server?.workers?.size ?? 0;

        const aggregatedPayload = {
            component: 'telemetry',
            serverId: server?.id,
            workerId: workerId,
            totalWorkers: workerCount,
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
            swap: {
                total_kb: lastSample.swap.total,
                available_kb: lastSample.swap.available,
                used_kb: lastSample.swap.used,
                enabled: lastSample.swap.enabled,
                min_available_kb: swapAvailable.min,
                max_available_kb: swapAvailable.max,
                avg_available_kb: roundMetric(swapAvailable.avg),
                min_used_kb: swapUsed.min,
                max_used_kb: swapUsed.max,
                avg_used_kb: roundMetric(swapUsed.avg),
                min_used_pct: swapMin === null ? null : parseFloat(swapMin.toFixed(2)),
                max_used_pct: swapMax === null ? null : parseFloat(swapMax.toFixed(2)),
                avg_used_pct: swapAvg === null ? null : parseFloat(swapAvg.toFixed(2))
            },
            unreclaimable: {
                unevictable_kb: lastSample.unreclaimable.unevictable_kb,
                mlocked_kb: lastSample.unreclaimable.mlocked_kb,
                unevictable_min_kb: unevictable.min,
                unevictable_max_kb: unevictable.max,
                unevictable_avg_kb: roundMetric(unevictable.avg),
                mlocked_min_kb: mlocked.min,
                mlocked_max_kb: mlocked.max,
                mlocked_avg_kb: roundMetric(mlocked.avg)
            },
            memoryPressure: {
                supported: lastSample.memoryPressure.supported,
                some: {
                    ...lastSample.memoryPressure.some,
                    avg10_min_pct: roundMetric(memoryPressureStats.some.avg10_pct.min),
                    avg10_max_pct: roundMetric(memoryPressureStats.some.avg10_pct.max),
                    avg10_avg_pct: roundMetric(memoryPressureStats.some.avg10_pct.avg),
                    avg60_min_pct: roundMetric(memoryPressureStats.some.avg60_pct.min),
                    avg60_max_pct: roundMetric(memoryPressureStats.some.avg60_pct.max),
                    avg60_avg_pct: roundMetric(memoryPressureStats.some.avg60_pct.avg),
                    avg300_min_pct: roundMetric(memoryPressureStats.some.avg300_pct.min),
                    avg300_max_pct: roundMetric(memoryPressureStats.some.avg300_pct.max),
                    avg300_avg_pct: roundMetric(memoryPressureStats.some.avg300_pct.avg)
                },
                full: {
                    ...lastSample.memoryPressure.full,
                    avg10_min_pct: roundMetric(memoryPressureStats.full.avg10_pct.min),
                    avg10_max_pct: roundMetric(memoryPressureStats.full.avg10_pct.max),
                    avg10_avg_pct: roundMetric(memoryPressureStats.full.avg10_pct.avg),
                    avg60_min_pct: roundMetric(memoryPressureStats.full.avg60_pct.min),
                    avg60_max_pct: roundMetric(memoryPressureStats.full.avg60_pct.max),
                    avg60_avg_pct: roundMetric(memoryPressureStats.full.avg60_pct.avg),
                    avg300_min_pct: roundMetric(memoryPressureStats.full.avg300_pct.min),
                    avg300_max_pct: roundMetric(memoryPressureStats.full.avg300_pct.max),
                    avg300_avg_pct: roundMetric(memoryPressureStats.full.avg300_pct.avg)
                }
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
                console.error(`[@cocreate/telemetry] [WORKER ${server.workerId}] Database telemetry registration rejected:`, dbResponse.error);
            } else if (dbResponse) {
                server.send(dbResponse);
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
        console.error('[@cocreate/telemetry] Error executing database flush:', error.message);
    }
}

/**
 * Returns the cached memory and system snapshot compiled during the last execution sweep.
 *
 * @returns {Object} Active system performance telemetry snapshot
 * @private
 * @environment server
 */
function get() {
    return currentTelemetry;
}

/**
 * Starts active telemetry collection intervals.
 * @private
 * @environment server
 */
function start() {
    const collectionInterval = parseInt(getValueFromObject(telemetryConfig, 'collectionInterval'), 10) || defaults.collectionInterval;
    const customWriteInterval = parseInt(getValueFromObject(telemetryConfig, 'writeInterval'), 10) || defaults.writeInterval;
    const workerId = server?.workerId || 1;
    const workerCount = server?.workers?.size ?? 0;

    stop();
    lastCpuInfo = readCpuInfo();

    const phaseOffset = (workerCount > 0 ? ((workerId - 1) % workerCount) / workerCount : 0) * customWriteInterval;
    lastDbFlushTimestamp = Date.now() - phaseOffset;

    dbBuffer = [];

    console.log(`[@cocreate/telemetry] [WORKER ${workerId}] Monitoring telemetry.`);
    activeIntervalId = setInterval(read, collectionInterval);
}

/**
 * Stops active telemetry collection intervals.
 * @private
 * @environment server
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
 * @public
 * @environment server
 */
async function init(serverInstance) {
    server = serverInstance;

    await loadTelemetryConfig();

    const telemetryEnabled = getValueFromObject(telemetryConfig, 'enabled') !== false &&
        getValueFromObject(telemetryConfig, 'enabled') !== 'false';

    if (telemetryEnabled) {
        start();
    } else {
        console.log('[@cocreate/telemetry] Monitoring is disabled.');
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
        readMemoryInfo,
        readSwapInfo,
        readUnreclaimableInfo,
        readMemoryPressureInfo
    };
}

export default {
    init
};

/**
 * High-throughput, non-blocking dual-buffered telemetry orchestrator for CoCreate Server. Measures real-time multi-tenant bandwidth, API operation tracing, and consumption analytics without event-loop lag.
 *
 * @module telemetry
 * @environment server
 */
