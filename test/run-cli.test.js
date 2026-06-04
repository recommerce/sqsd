'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveShutdownTimeout } = require('../run-cli');

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
