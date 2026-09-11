'use strict';

// Option resolution shared by cli.js and its tests.
//
// Precedence, from the weakest to the strongest source:
//   built-in defaults  <  environment variables  <  command line flags
//
// Only values that are actually defined take part in the merge, so an unset
// environment variable never shadows a default and a flag that was not typed on
// the command line never shadows an environment variable.

const DEFAULTS = {
    region: "us-east-1",
    maxMessages: 10,
    daemonized: false,
    sleep: 0,
    waitTime: 20,
    userAgent: "sqsd",
    contentType: 'application/json',
    concurrency: 3,
    timeout: 60000,
    workerHealthWaitTime: 10000,
    sslEnabled: true,
    verbose: 0
};

function parseOptionalInteger(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return undefined;
    }

    const parsed = Number(normalized);
    return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const normalized = String(value).trim().toLowerCase();
    if (normalized in { "1":1, "yes":1, "true":1 }) {
        return true;
    }

    if (normalized in { "0":1, "no":1, "false":1 }) {
        return false;
    }

    return undefined;
}

function mergeDefined() {
    const result = {};

    for (let i = 0; i < arguments.length; ++i) {
        const source = arguments[i] || {};
        Object.keys(source).forEach((key) => {
            if (source[key] !== undefined) {
                result[key] = source[key];
            }
        });
    }

    return result;
}

function readEnvironment(env) {
    return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        region: env.SQSD_QUEUE_REGION_NAME || env.AWS_DEFAULT_REGION,
        queueUrl: env.SQSD_QUEUE_URL,
        maxMessages: parseOptionalInteger(env.SQSD_MAX_MESSAGES_PER_REQUEST),
        daemonized: parseOptionalBoolean(env.SQSD_RUN_DAEMONIZED),
        sleep: parseOptionalInteger(env.SQSD_SLEEP_SECONDS),
        waitTime: parseOptionalInteger(env.SQSD_WAIT_TIME_SECONDS),
        webHook: env.SQSD_WORKER_HTTP_URL,
        userAgent: env.SQSD_WORKER_USER_AGENT,
        contentType: env.SQSD_WORKER_HTTP_REQUEST_CONTENT_TYPE,
        concurrency: parseOptionalInteger(env.SQSD_WORKER_CONCURRENCY),
        timeout: parseOptionalInteger(env.SQSD_WORKER_TIMEOUT),
        workerHealthUrl: env.SQSD_WORKER_HEALTH_URL,
        workerHealthWaitTime: parseOptionalInteger(env.SQSD_WORKER_HEALTH_WAIT_TIME),
        endpointUrl: env.SQSD_ENDPOINT_URL,
        queueName: env.SQSD_QUEUE_NAME,
        sslEnabled: parseOptionalBoolean(env.SQSD_SSL_ENABLED)
    };
}

// commander exposes an option in opts() as soon as it declares a default value,
// even when the flag was never typed. Relying on the mere presence of the key
// would make those defaults win over the environment, so the source of each
// value is checked instead.
function readCommandLine(command, keys) {
    const options = command.opts();
    const result = {};

    keys.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(options, key)) {
            return;
        }

        const source = command.getOptionValueSource(key);
        if (source === undefined || source === 'default') {
            return;
        }

        result[key] = options[key];
    });

    return result;
}

function resolveOptions(command, env) {
    const environment = readEnvironment(env);
    return mergeDefined(DEFAULTS, environment, readCommandLine(command, Object.keys(environment)));
}

exports.DEFAULTS = DEFAULTS;
exports.parseOptionalInteger = parseOptionalInteger;
exports.parseOptionalBoolean = parseOptionalBoolean;
exports.mergeDefined = mergeDefined;
exports.readEnvironment = readEnvironment;
exports.readCommandLine = readCommandLine;
exports.resolveOptions = resolveOptions;
