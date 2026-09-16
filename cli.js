#!/usr/bin/env node
'use strict';
const path = require('path');
const { program } = require('commander');
const { resolveOptions } = require('./lib/options');




function increaseVerbosity(v, total) {
    return total + 1;
}
var pkg = require('./package.json');

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
    // Read by the supervisor (run-cli.js), declared here so that it shows up in --help.
    .option('--shutdown-timeout [value]', 'Max time to wait for in-flight messages during shutdown, ms. Use 0 to disable forced shutdown.', parseInt)
    .option('--content-type [value]', 'Content-Type header sent to the worker.' )
    .option('--concurrency [value]', 'Max number of concurrent worker HTTP requests.', parseInt )
    .option('--user-agent [value]', 'User agent' )
    .option('--env [value]', 'Path to .env file to load environment variables from. Optional', '.env')
    .option('--ssl-enabled [value]', 'Deprecated no-op. Endpoint protocol is determined by the URL scheme.')
    .option('-v, --verbose', 'A value that can be increased', increaseVerbosity, 0)


process.argv[1] = 'sqsd';
program.parse(process.argv);

// commander >=7 exposes parsed options through opts() instead of attaching
// them directly to the program instance.
var opts = program.opts();

const dotenv = require('dotenv');
dotenv.config({
    quiet: true,
    path: path.resolve(process.cwd(), opts.env || '.env')
});

var mergedParams = resolveOptions(program, process.env);

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
