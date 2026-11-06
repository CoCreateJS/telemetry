import assert from 'node:assert/strict';
import test from 'node:test';
import config from '@cocreate/config';
import Telemetry from '../src/index.js';

test('telemetry reads the live Map count and handles zero children without an invalid phase offset', async t => {
    t.mock.method(config, 'get', () => undefined);
    t.mock.method(config, 'query', async () => undefined);
    t.mock.method(console, 'log', () => {});
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000000 });
    const messages = [];
    const server = { id: 'node', workerId: 3, organization_id: 'tenant', workers: new Map(),
        send: payload => messages.push(payload) };
    Object.defineProperty(server, 'totalWorkers', { get() { assert.fail('Use the live worker collection'); } });
    const telemetry = await Telemetry.init(server);
    t.after(() => telemetry.stop());
    telemetry.stop();
    telemetry.read();
    await telemetry.save();
    const first = messages.find(message => message.data?.totalWorkers !== undefined);
    assert.equal(first.data.totalWorkers, 0);
    assert(Number.isFinite(first.data.interval_seconds));
    server.workers.set(1, {});
    server.workers.set(2, {});
    t.mock.timers.tick(1000);
    telemetry.read();
    await telemetry.save();
    const samples = messages.filter(message => message.data?.totalWorkers !== undefined);
    assert.equal(samples.at(-1).data.totalWorkers, 2);
});
