#!/usr/bin/env node
'use strict';

// Lightweight process supervisor for cli.js.
//
// Replaces the (unmaintained) forever-monitor dependency with a small native
// implementation built on child_process.fork. It keeps the same behaviour:
//  - run cli.js in a forked child process (IPC channel enabled),
//  - restart it when it crashes, up to a maximum number of restarts,
//  - back off, then give up, when the child keeps crashing on startup,
//  - on SIGTERM, ask the child to shut down gracefully instead of killing it.

const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const dotenv = require('dotenv');

const MAX_RESTARTS = 1000;
// A process that stays up at least this long is considered healthy; an earlier
// exit counts as a crash for the spinning-restart guard.
const MIN_UPTIME_MS = 22000;
// Consecutive crashes faster than MIN_UPTIME_MS before the supervisor gives up.
// forever-monitor stopped on the very first one; a few retries absorb a slow
// dependency, while still refusing to hot loop on a broken configuration.
const MAX_SPINNING_RESTARTS = 5;
const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30000;
const DEFAULT_WORKER_TIMEOUT_MS = 60000;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const SHUTDOWN_TIMEOUT_BUFFER_MS = 5000;

const childArgs = process.argv.slice(2);
const childPath = path.join(__dirname, 'cli.js');

let restartCount = 0;
let spinningRestarts = 0;
let forceStop = false;
let child = null;
let shutdownTimer = null;
let restartTimer = null;
let shutdownTimeoutMs = 0;

function parseOptionalInteger(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return undefined;
    }

    const parsed = Number(normalized);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function getArgValue(args, longName, shortName) {
    for (let i = 0; i < args.length; ++i) {
        const arg = args[i];

        if (arg === longName || (shortName && arg === shortName)) {
            return args[i + 1];
        }

        if (arg.startsWith(longName + '=')) {
            return arg.slice(longName.length + 1);
        }

        // Attached short form, as in `-t5000`.
        if (shortName && arg.length > shortName.length && arg.startsWith(shortName)) {
            return arg.slice(shortName.length);
        }
    }

    return undefined;
}

function loadEnvironmentFile(args) {
    dotenv.config({
        quiet: true,
        path: path.resolve(process.cwd(), getArgValue(args, '--env') || '.env')
    });
}

function resolveShutdownTimeout(args, env) {
    const explicitShutdownTimeout = parseOptionalInteger(
        getArgValue(args, '--shutdown-timeout') || env.SQSD_SHUTDOWN_TIMEOUT
    );

    if (explicitShutdownTimeout !== undefined) {
        return explicitShutdownTimeout;
    }

    const workerTimeout = parseOptionalInteger(
        getArgValue(args, '--timeout', '-t') || env.SQSD_WORKER_TIMEOUT
    );
    const waitTime = parseOptionalInteger(
        getArgValue(args, '--wait-time') || env.SQSD_WAIT_TIME_SECONDS
    );

    const normalizedWorkerTimeout = workerTimeout === undefined ? DEFAULT_WORKER_TIMEOUT_MS : workerTimeout;
    const normalizedWaitTime = waitTime === undefined ? DEFAULT_WAIT_TIME_SECONDS : waitTime;

    if (normalizedWorkerTimeout === 0) {
        return 0;
    }

    return normalizedWorkerTimeout + (normalizedWaitTime * 1000) + SHUTDOWN_TIMEOUT_BUFFER_MS;
}

// A child that exits before MIN_UPTIME_MS is spinning: restarting it right away
// burns CPU and floods the logs, so consecutive crashes are backed off
// exponentially and eventually abandoned. Uptimes above the threshold clear the
// counter and restart immediately, as a long lived daemon should.
function planRestart(state) {
    if (state.restartCount >= MAX_RESTARTS) {
        return { action: 'giveUp', reason: 'maxRestarts', spinningRestarts: state.spinningRestarts };
    }

    if (state.uptimeMs >= MIN_UPTIME_MS) {
        return { action: 'restart', delayMs: 0, spinningRestarts: 0 };
    }

    const spinningRestarts = state.spinningRestarts + 1;

    if (spinningRestarts > MAX_SPINNING_RESTARTS) {
        return { action: 'giveUp', reason: 'spinning', spinningRestarts: spinningRestarts };
    }

    return {
        action: 'restart',
        delayMs: Math.min(RESTART_BASE_DELAY_MS * Math.pow(2, spinningRestarts - 1), RESTART_MAX_DELAY_MS),
        spinningRestarts: spinningRestarts
    };
}

// A child killed by a signal reports a null exit code. Reporting 0 there would
// hide a forced shutdown, so the conventional 128 + signal code is used instead.
function exitCodeFor(code, signal) {
    if (code !== null && code !== undefined) {
        return code;
    }

    if (signal && os.constants.signals[signal] !== undefined) {
        return 128 + os.constants.signals[signal];
    }

    return 1;
}

function spawnChild() {
    const startedAt = Date.now();
    restartTimer = null;
    child = fork(childPath, childArgs, { stdio: 'inherit' });

    child.on('error', (err) => {
        console.error({ err: err }, 'Error caused SQSD to crash.');
    });

    child.on('exit', (code, signal) => {
        const uptime = Date.now() - startedAt;
        const exitCode = exitCodeFor(code, signal);
        child = null;
        console.info('SQSD stopped.');

        if (forceStop || code === 0) {
            process.exit(exitCode);
        }

        const plan = planRestart({
            uptimeMs: uptime,
            restartCount: restartCount,
            spinningRestarts: spinningRestarts
        });
        spinningRestarts = plan.spinningRestarts;

        if (plan.action === 'giveUp') {
            console.error(plan.reason === 'spinning'
                ? 'SQSD keeps crashing on startup, giving up.'
                : 'SQSD reached the maximum number of restarts, giving up.');
            process.exit(exitCode === 0 ? 1 : exitCode);
        }

        if (plan.delayMs > 0) {
            console.warn({ restartCount: restartCount, delayMs: plan.delayMs },
                'It is likely that an error caused SQSD to crash, restarting after a delay.');
        }

        ++restartCount;
        restartTimer = setTimeout(spawnChild, plan.delayMs);
    });
}

function requestShutdown(signal) {
    console.info(signal + ' signal received, graceful shutdown sqsd');
    forceStop = true;

    if (shutdownTimer) {
        return;
    }

    // Nothing is running yet, a restart was pending: drop it and leave.
    if (!child) {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }

        process.exit(0);
    }

    if (child.connected) {
        try {
            child.send({ action: 'shutdown' });
        }
        catch (err) {
            console.error({ err: err }, 'Unable to send graceful shutdown message to SQSD child.');
            child.kill(signal);
        }
    }
    else {
        child.kill(signal);
    }

    if (shutdownTimeoutMs === 0) {
        console.info('SQSD forced shutdown timeout disabled.');
        return;
    }

    shutdownTimer = setTimeout(() => {
        if (child) {
            console.warn('SQSD child did not stop gracefully, forcing shutdown.');
            child.kill('SIGTERM');
        }
    }, shutdownTimeoutMs);
}

if (require.main === module) {
    loadEnvironmentFile(childArgs);
    shutdownTimeoutMs = resolveShutdownTimeout(childArgs, process.env);

    process.on('SIGTERM', () => requestShutdown('SIGTERM'));
    process.on('SIGINT', () => requestShutdown('SIGINT'));

    spawnChild();
}

exports.resolveShutdownTimeout = resolveShutdownTimeout;
exports.planRestart = planRestart;
exports.exitCodeFor = exitCodeFor;
exports.MAX_RESTARTS = MAX_RESTARTS;
exports.MIN_UPTIME_MS = MIN_UPTIME_MS;
exports.MAX_SPINNING_RESTARTS = MAX_SPINNING_RESTARTS;
