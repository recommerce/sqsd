'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveShutdownTimeout,
    planRestart,
    exitCodeFor,
    MAX_RESTARTS,
    MIN_UPTIME_MS,
    MAX_SPINNING_RESTARTS
} = require('../run-cli');

test('derives shutdown timeout from defaults', () => {
    assert.equal(resolveShutdownTimeout([], {}), 85000);
});

test('derives shutdown timeout from worker timeout and wait time env vars', () => {
    assert.equal(resolveShutdownTimeout([], {
        SQSD_WORKER_TIMEOUT: '300000',
        SQSD_WAIT_TIME_SECONDS: '1'
    }), 306000);
});

test('uses explicit shutdown timeout from env over derived timeout', () => {
    assert.equal(resolveShutdownTimeout([], {
        SQSD_WORKER_TIMEOUT: '300000',
        SQSD_WAIT_TIME_SECONDS: '1',
        SQSD_SHUTDOWN_TIMEOUT: '120000'
    }), 120000);
});

test('uses explicit shutdown timeout from CLI over env', () => {
    assert.equal(resolveShutdownTimeout(['--shutdown-timeout', '9000'], {
        SQSD_SHUTDOWN_TIMEOUT: '120000'
    }), 9000);
});

test('uses CLI worker timeout and wait time when no explicit shutdown timeout is set', () => {
    assert.equal(resolveShutdownTimeout(['--timeout=1000', '--wait-time', '2'], {}), 8000);
    assert.equal(resolveShutdownTimeout(['-t1000', '--wait-time=2'], {}), 8000);
});

test('allows disabling the internal forced shutdown timeout', () => {
    assert.equal(resolveShutdownTimeout([], {
        SQSD_SHUTDOWN_TIMEOUT: '0'
    }), 0);

    assert.equal(resolveShutdownTimeout([], {
        SQSD_WORKER_TIMEOUT: '0'
    }), 0);
});

test('restarts a long running child immediately and clears the spinning counter', () => {
    assert.deepEqual(planRestart({ uptimeMs: MIN_UPTIME_MS, restartCount: 12, spinningRestarts: 3 }), {
        action: 'restart',
        delayMs: 0,
        spinningRestarts: 0
    });
});

test('backs off exponentially when the child crashes on startup', () => {
    const delays = [];
    let spinningRestarts = 0;

    for (let i = 0; i < MAX_SPINNING_RESTARTS; ++i) {
        const plan = planRestart({ uptimeMs: 10, restartCount: i, spinningRestarts: spinningRestarts });
        assert.equal(plan.action, 'restart');
        spinningRestarts = plan.spinningRestarts;
        delays.push(plan.delayMs);
    }

    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
});

test('gives up once the child has crashed on startup too many times', () => {
    const plan = planRestart({ uptimeMs: 10, restartCount: 5, spinningRestarts: MAX_SPINNING_RESTARTS });

    assert.equal(plan.action, 'giveUp');
    assert.equal(plan.reason, 'spinning');
});

test('gives up once the maximum number of restarts is reached', () => {
    const plan = planRestart({ uptimeMs: 60000, restartCount: MAX_RESTARTS, spinningRestarts: 0 });

    assert.equal(plan.action, 'giveUp');
    assert.equal(plan.reason, 'maxRestarts');
});

test('reports the conventional exit code for a child killed by a signal', () => {
    assert.equal(exitCodeFor(0, null), 0);
    assert.equal(exitCodeFor(3, null), 3);
    assert.equal(exitCodeFor(null, 'SIGTERM'), 143);
    assert.equal(exitCodeFor(null, 'SIGINT'), 130);
    assert.equal(exitCodeFor(null, null), 1);
});
