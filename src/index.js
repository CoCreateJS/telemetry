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
import server from '@cocreate/server';

const baseInterval = 1000; // Base interval (1 second)

/**
 * Parses and calculates operating system memory usage guidelines.
 */
export function readMemoryInfo() {
    try {
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
        // Fallback for non-Linux platforms (like local Windows/macOS development)
        return null;
    }
}

/**
 * Reads CPU performance indicators directly from proc stat cycles.
 */
export function readCpuInfo() {
    try {
        const cpuInfoContent = fs.readFileSync('/proc/stat', 'utf8');
        const cpuLines = cpuInfoContent.split('\n');
        return cpuLines
            .filter(line => line.startsWith('cpu'))
            .map(line => {
                const parts = line.split(' ').filter(p => p.trim() !== '');
                return {
                    core: parts[0],
                    times: parts.slice(1).map(Number),
                };
            });
    } catch (err) {
        return [];
    }
}

/**
 * Calculates CPU utilization percentages across core time diffs.
 */
export function calculateCpuUsage(cpuInfo1, cpuInfo2) {
    if (!cpuInfo1.length || !cpuInfo2.length) return [];
    
    return cpuInfo1.map((coreInfo1, index) => {
        const coreInfo2 = cpuInfo2[index];
        if (!coreInfo2) return { core: coreInfo1.core, usage: 0 };
        
        const idle1 = coreInfo1.times[3];
        const idle2 = coreInfo2.times[3];

        const total1 = coreInfo1.times.reduce((acc, val) => acc + val, 0);
        const total2 = coreInfo2.times.reduce((acc, val) => acc + val, 0);

        const totalDiff = total2 - total1;
        const idleDiff = idle2 - idle1;

        return {
            core: coreInfo1.core,
            usage: totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0,
        };
    });
}

/**
 * Reads memory allocations and samples CPU usage cycles.
 */
export function readMetrics() {
    readMemoryInfo();
    const cpuInfo1 = readCpuInfo();
    setTimeout(() => {
        const cpuInfo2 = readCpuInfo();
        const cpuUsage = calculateCpuUsage(cpuInfo1, cpuInfo2);
        let cpuTotalUsage = 0;
        
        cpuUsage.forEach(coreUsage => {
            cpuTotalUsage += coreUsage.usage;
        });
        
        if (cpuUsage.length > 0) {
            cpuTotalUsage = cpuTotalUsage / cpuUsage.length;
        }
        // console.log(`CPU usage: ${cpuTotalUsage.toFixed(2)}%`);
    }, 1000); // 1-second interval
}

/**
 * Self-Activating Auto-Initialization Loop.
 * Silently waits in the background for the parent server to finish initializing,
 * then extracts process topology and schedules metric updates.
 */
export function init() {
    if (server && server.isInitialized) {
        const workerId = server.workerId !== undefined ? server.workerId : 0;
        const totalWorkers = server.totalWorkers || 1;
        const delay = (workerId * baseInterval) + (totalWorkers * baseInterval);
        
        setInterval(readMetrics, delay);
    } else {
        // If the central server is not yet initialized, check again in 500ms
        setTimeout(init, 500);
    }
}

// Start auto-activation monitoring sequence instantly upon import evaluation
init();

// Default export added to resolve ESM import SyntaxErrors
export default {
    init,
    readMetrics,
    readCpuInfo,
    readMemoryInfo,
    calculateCpuUsage
};