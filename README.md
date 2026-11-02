# CoCreate Server Telemetry

`@cocreate/telemetry` samples host and process health from each CoCreate Server worker, aggregates the samples, stores historical telemetry, and protects overloaded workers by cordoning them locally.

## What it measures

Each collection tick records:

| Group | Values | Scope |
| --- | --- | --- |
| CPU | Total utilization and utilization per logical core | Host |
| Memory | Total, available, used, and percentage used | Host |
| System | Load averages and operating-system uptime | Host |
| Process | Uptime, heap total, heap used, RSS, and external memory | Worker process |
| Custom | Latest values registered by other server components | Component-defined |

Memory values are stored in kilobytes. On Linux, memory and CPU are read from `/proc/meminfo` and `/proc/stat`. Other platforms use the corresponding Node.js `os` APIs.

The module runs once in every server worker. Host-level CPU and memory values therefore describe the same node, while process values identify the individual worker.

## Collection and persistence

Samples are collected in an in-memory array at `collectionInterval`. At `writeInterval`, the worker calculates minimum, maximum, and average values and creates one record in the `servers_telemetry` array.

Each aggregate includes `serverId`, `workerId`, `totalWorkers`, the interval duration, sample count, CPU, memory, system, process, and custom component metrics. Worker flushes are phase-shifted across the write interval to avoid every worker writing simultaneously.

When `retentionDays` is greater than zero, worker 1 removes historical telemetry older than the configured retention period.

## Worker protection

Telemetry cordons only the worker in which it is running:

```js
await server.state.cordon(true);
```

It does not broadcast the cordon through `server.send()`. The worker state manager closes that worker's edge listeners and reports its state to the primary process. If all workers become unavailable, CoCreate Server activates its primary fallback and responds with HTTP 503.

A worker is cordoned when either:

- Host memory reaches `safetyLimits.cordonMemoryThreshold` during a collection tick when no optional memory thresholds are configured.
- Average host CPU reaches `safetyLimits.cordonCpuThreshold` during an aggregation interval.

Optional memory thresholds can be added under `safetyLimits`. When any are configured, telemetry checks the current sample on each collection tick and requires the RAM threshold and every configured optional memory threshold to be met together. These safety checks are immediate; persisted min/max/average values are for analysis and do not delay cordoning. CPU remains an independent cordon trigger using its aggregation-interval average. Recovery from a combined memory cordon occurs when any combined memory metric falls at least five percentage points below its threshold and current CPU is at least five points below its threshold. A worker cannot be uncordoned while it is shedding, draining, or shutting down.

### Emergency scaling signal

When memory reaches `scaleUpMemoryThreshold`, telemetry sends a `telemetry.emergency` server event. When safety limits are enabled, a dynamic threshold based on host cores and memory may lower this threshold. Emergency events have a five-minute cooldown.

## Configuration

Configuration is loaded through `@cocreate/config` using the `telemetry` key. Organization-specific overrides are queried with `type: "telemetry"` and the current server and cluster scope.

```js
{
    telemetry: {
        enabled: true,
        collectionInterval: 1000,
        writeInterval: 60000,
        retentionDays: 0,
        scaleUpMemoryThreshold: 85,
        safetyLimits: {
            cordonMemoryThreshold: 90,
            cordonCpuThreshold: 95,
            cordonSwapThreshold: 50,
            cordonUnreclaimableThreshold: 10,
            cordonMlockedThreshold: 5,
            cordonMemoryPressureThreshold: 10
        }
    }
}
```

| Setting | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Starts collection unless set to `false` or `"false"`. |
| `collectionInterval` | `1000` | Milliseconds between samples. |
| `writeInterval` | `60000` | Milliseconds between aggregate writes. |
| `retentionDays` | `0` | Days of history to retain; `0` disables automatic deletion. |
| `scaleUpMemoryThreshold` | `85` | Memory percentage that emits the emergency scaling signal. |
| `safetyLimits` | enabled | Set to `false` to disable dynamic adjustment of the emergency memory threshold. |
| `safetyLimits.cordonMemoryThreshold` | `90` | Memory percentage that cordons the local worker. |
| `safetyLimits.cordonCpuThreshold` | `95` | Average CPU percentage that cordons the local worker. |
| `safetyLimits.cordonSwapThreshold` | unset | Optional current swap-used percentage; when set, joins RAM as a required combined cordon condition. |
| `safetyLimits.cordonUnreclaimableThreshold` | unset | Optional current `Unevictable` memory as a percentage of physical RAM; includes `Mlocked`. |
| `safetyLimits.cordonMlockedThreshold` | unset | Optional current `Mlocked` memory as a percentage of physical RAM. This is a subset of `Unevictable`. |
| `safetyLimits.cordonMemoryPressureThreshold` | unset | Optional current Linux PSI `some.avg10` percentage. |

## Usage

CoCreate Server initializes the module with its server instance:

```js
import ServerTelemetry from "@cocreate/telemetry";

const telemetry = await ServerTelemetry.init(server);
```

The initialized service exposes:

| Method | Description |
| --- | --- |
| `start()` | Starts or restarts collection. |
| `stop()` | Stops collection. |
| `get()` | Returns the latest telemetry snapshot. |
| `read()` | Collects and returns one snapshot. |
| `save()` | Aggregates and persists the buffered samples. |
| `send(component, data)` | Adds or updates custom metrics for a component. |
| `readCpuInfo()` | Reads the raw CPU tick snapshot. |
| `readMemoryInfo()` | Reads current host memory information. |
| `readSwapInfo()` | Reads Linux swap capacity and use. Other platforms report swap as unavailable. |
| `readUnreclaimableInfo()` | Reads Linux `Unevictable` and `Mlocked` memory counters. |
| `readMemoryPressureInfo()` | Reads Linux memory PSI stall metrics when the kernel exposes them. |

Other server components can contribute metrics without writing directly to the telemetry collection:

```js
server.telemetry.send("mesh", {
    connections: 12,
    organizations: 4
});
```

The latest registered values for each component are included in subsequent samples and aggregate records.

Each telemetry snapshot and persisted aggregate includes a separate `swap` object with total, available, and used capacity in KiB, plus interval min/max/average values and swap utilization percentages. On Linux, these values come from `/proc/meminfo`; when swap is disabled, percentage fields are `null` so zero swap use is not confused with an available swap cushion.

The `unreclaimable` object records `Unevictable` and `Mlocked` memory in KiB, with interval min/max/average values. `Mlocked` is a subset of `Unevictable`; do not add the two values together. The `memoryPressure` object records Linux PSI `some` and `full` stall percentages for the kernel's 10-, 60-, and 300-second windows, plus cumulative stall time in microseconds. Persisted records include interval min/max/average values for each rolling PSI percentage. Optional safety thresholds can use current swap, unreclaimable memory, mlocked memory, and PSI alongside RAM to cordon a worker immediately; interval aggregates are persisted for later analysis.

## Installation

```bash
npm install @cocreate/telemetry
```

or:

```bash
yarn add @cocreate/telemetry
```

## License

CoCreate Server Telemetry is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
