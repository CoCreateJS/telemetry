# CoCreate Server Telemetry

`@cocreate/server-telemetry` samples host and process health from each CoCreate Server worker, aggregates the samples, stores historical telemetry, and protects overloaded workers by cordoning them locally.

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

- Host memory reaches `safetyLimits.cordonMemoryThreshold` during a collection tick.
- Average host CPU reaches `safetyLimits.cordonCpuThreshold` during an aggregation interval.

The worker is uncordoned when both memory and CPU fall at least five percentage points below their respective cordon thresholds. A worker cannot be uncordoned while it is shedding, draining, or shutting down.

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
            cordonCpuThreshold: 95
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

## Usage

CoCreate Server initializes the module with its server instance:

```js
import ServerTelemetry from "@cocreate/server-telemetry";

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

Other server components can contribute metrics without writing directly to the telemetry collection:

```js
server.telemetry.send("mesh", {
    connections: 12,
    organizations: 4
});
```

The latest registered values for each component are included in subsequent samples and aggregate records.

## Installation

```bash
npm install @cocreate/server-telemetry
```

or:

```bash
yarn add @cocreate/server-telemetry
```

## License

CoCreate Server Telemetry is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
