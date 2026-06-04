#!/usr/bin/env node
'use strict';
const path = require('path');
const { program } = require('commander');




function increaseVerbosity(v, total) {
    return total + 1;
}
var pkg = require('./package.json');

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
        const source = arguments[i];
        Object.keys(source).forEach((key) => {
            if (source[key] !== undefined) {
                result[key] = source[key];
            }
        });
    }

    return result;
}

program.version(pkg.version)
    .option('-w, --web-hook [value]', 'The webhook url to which messages from queue be posted. Required' )
    .option('-q, --queue-url [value]', 'Your queue URL.')
    .option('--queue-name [value]', 'The name of the queue. Fetched from queue URL if empty.')
    .option('--access-key-id [value]', 'Your AWS Access Key. Leave empty if use IAM roles.')
    .option('--secret-access-key [value]', 'Your AWS Secret Access Key. Leave empty if use IAM roles.')
    .option('--endpoint-url [value]', 'Endpoint URL when using a fake SQS service. Leave empty when using Amazon SQS.')
    .option('-r, --region [value]', 'The region name of the AWS SQS queue')
    .option('-m, --max-messages [value]', 'Max number of messages to retrieve per SQS request.',parseInt )
    .option('-d, --daemonized ', 'Whether to continue running with empty queue'  )
    .option('-s, --sleep [value]', 'Number of seconds to wait after polling empty queue when daemonized', parseInt)
    .option('-t, --timeout [value]', 'Timeout for waiting response from worker, ms' )
    .option('--worker-health-url [value]', 'Url for checking that worker is running, useful when running in linked containers and worker needs some time to  up' )
    .option('--worker-health-wait-time [value]', 'Timeout for waiting while worker become  health, ms', parseInt)
    .option('--wait-time [value]', 'Long polling wait time when querying the queue.', parseInt)
    .option('--shutdown-timeout [value]', 'Max time to wait for in-flight messages during shutdown, ms. Use 0 to disable forced shutdown.', parseInt)
    .option('--content-type [value]', 'Content-Type header sent to the worker.' )
    .option('--concurrency [value]', 'Max number of concurrent worker HTTP requests.', parseInt,  3  )
    .option('--user-agent [value]', 'User agent',  "sqsd"  )
    .option('--env [value]', 'Path to .env file to load environment variables from. Optional', '.env')
    .option('--ssl-enabled [value]', 'Deprecated no-op. Endpoint protocol is determined by the URL scheme.')
    .option('-v, --verbose', 'A value that can be increased', increaseVerbosity, 0)


process.argv[1] = 'sqsd';
program.parse(process.argv);

// commander >=7 exposes parsed options through opts() instead of attaching
// them directly to the program instance.
var opts = program.opts();

var defaults = {
     region: "us-east-1"
    , maxMessages: 10
    , daemonized: false
    , sleep: 0
    , waitTime: 20
    , shutdownTimeout: undefined
    , userAgent: "sqsd"
    , contentType: 'application/json'
    , concurrency: 3
    , timeout: 60000
    , workerHealthWaitTime: 10000
    , sslEnabled: true
    , verbose: 0
}

const dotenv = require('dotenv');
dotenv.config({
    quiet: true,
    path: path.resolve(process.cwd(), opts.env || '.env')
});

var envParams = { accessKeyId: process.env.AWS_ACCESS_KEY_ID
    , secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    , sessionToken: process.env.AWS_SESSION_TOKEN
    , region: process.env.SQSD_QUEUE_REGION_NAME || process.env.AWS_DEFAULT_REGION
    , queueUrl: process.env.SQSD_QUEUE_URL
    , maxMessages: parseOptionalInteger(process.env.SQSD_MAX_MESSAGES_PER_REQUEST)
    , daemonized: parseOptionalBoolean(process.env.SQSD_RUN_DAEMONIZED)
    , sleep: parseOptionalInteger(process.env.SQSD_SLEEP_SECONDS)
    , waitTime: parseOptionalInteger(process.env.SQSD_WAIT_TIME_SECONDS)
    , shutdownTimeout: parseOptionalInteger(process.env.SQSD_SHUTDOWN_TIMEOUT)
    , webHook: process.env.SQSD_WORKER_HTTP_URL
    , userAgent: process.env.SQSD_WORKER_USER_AGENT
    , contentType: process.env.SQSD_WORKER_HTTP_REQUEST_CONTENT_TYPE
    , concurrency: parseOptionalInteger(process.env.SQSD_WORKER_CONCURRENCY)
    , timeout: parseOptionalInteger(process.env.SQSD_WORKER_TIMEOUT)
    , workerHealthUrl: process.env.SQSD_WORKER_HEALTH_URL
    , workerHealthWaitTime: parseOptionalInteger(process.env.SQSD_WORKER_HEALTH_WAIT_TIME)
    , endpointUrl: process.env.SQSD_ENDPOINT_URL
    , queueName: process.env.SQSD_QUEUE_NAME
    , sslEnabled: parseOptionalBoolean(process.env.SQSD_SSL_ENABLED)
}

var extractedCliArgs = {};
Object.keys(envParams).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(opts, key)) {
        extractedCliArgs[key] = opts[key];
    }
});
var mergedParams = mergeDefined(defaults, envParams, extractedCliArgs);

if (!mergedParams.webHook) {
    console.log ( "--web-hook is required")
    //program.outputHelp();
    process.exit(1);
}


const debug = require('debug')("sqsd");
const sqsd = require('./lib/index').SQSProcessor;

console.log('SQSD v' + pkg.version);
const daemon = new sqsd(mergedParams);

process.on('message', function (message) {
    if (message.action == 'shutdown') {
        daemon.shutdown = true;
    }
});

daemon.start()
    .then(()=>{
        process.exit(0);
    })
    .catch( err=> {
        console.error( err )
        process.exit(1);
    })
