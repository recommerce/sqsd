#!/usr/bin/env node
'use strict';

// Lightweight process supervisor for cli.js.
//
// Replaces the (unmaintained) forever-monitor dependency with a small native
// implementation built on child_process.fork. It keeps the same behaviour:
//  - run cli.js in a forked child process (IPC channel enabled),
//  - restart it when it crashes, up to a maximum number of restarts,
//  - on SIGTERM, ask the child to shut down gracefully instead of killing it.

const path = require('path');
const { fork } = require('child_process');
const dotenv = require('dotenv');

const MAX_RESTARTS = 1000;
// A process that stays up at least this long is considered healthy; an earlier
// exit counts as a crash for the spinning-restart guard.
const MIN_UPTIME_MS = 22000;
const DEFAULT_WORKER_TIMEOUT_MS = 60000;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const SHUTDOWN_TIMEOUT_BUFFER_MS = 5000;

const childArgs = process.argv.slice(2);
const childPath = path.join(__dirname, 'cli.js');

let restartCount = 0;
let forceStop = false;
let child = null;
let shutdownTimer = null;
let shutdownTimeoutMs = resolveShutdownTimeout(childArgs, process.env);

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

        if (arg.indexOf(longName + '=') === 0) {
            return arg.slice(longName.length + 1);
        }

        if (shortName && arg.indexOf(shortName) === 0 && arg.length > shortName.length) {
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

function spawnChild() {
    const startedAt = Date.now();
    child = fork(childPath, childArgs, { stdio: 'inherit' });

    child.on('error', (err) => {
        console.error({ err: err }, 'Error caused SQSD to crash.');
    });

    child.on('exit', (code, signal) => {
        const uptime = Date.now() - startedAt;
        console.info('SQSD stopped.');

        if (forceStop || code === 0) {
            process.exit(code === null ? 0 : code);
        }

        if (restartCount >= MAX_RESTARTS) {
            console.error('SQSD reached the maximum number of restarts, giving up.');
            process.exit(code === null ? 1 : code);
        }

        if (uptime < MIN_UPTIME_MS) {
            console.warn({ restartCount: restartCount }, 'It is likely that an error caused SQSD to crash.');
        }

        ++restartCount;
        spawnChild();
    });
}

function requestShutdown(signal) {
    console.info(signal + ' signal received, graceful shutdown sqsd');
    forceStop = true;

    if (shutdownTimer) {
        return;
    }

    if (child && child.connected) {
        try {
            child.send({ action: 'shutdown' });
        }
        catch (err) {
            console.error({ err: err }, 'Unable to send graceful shutdown message to SQSD child.');
            child.kill(signal);
        }
    }
    else if (child) {
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
