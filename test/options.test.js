'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Command } = require('commander');
const { resolveOptions, mergeDefined, parseOptionalInteger, parseOptionalBoolean } = require('../lib/options');

function parse(argv) {
    const command = new Command();

    command
        .option('-w, --web-hook [value]', 'webhook')
        .option('-q, --queue-url [value]', 'queue url')
        .option('--queue-name [value]', 'queue name')
        .option('-r, --region [value]', 'region')
        .option('-m, --max-messages [value]', 'max messages', parseInt)
        .option('-d, --daemonized ', 'daemonized')
        .option('-s, --sleep [value]', 'sleep', parseInt)
        .option('-t, --timeout [value]', 'timeout')
        .option('--wait-time [value]', 'wait time', parseInt)
        .option('--concurrency [value]', 'concurrency', parseInt)
        .option('--user-agent [value]', 'user agent')
        .exitOverride();

    command.parse(argv, { from: 'user' });

    return command;
}

test('falls back to the built-in defaults when nothing is configured', () => {
    const options = resolveOptions(parse([]), {});

    assert.equal(options.concurrency, 3);
    assert.equal(options.maxMessages, 10);
    assert.equal(options.waitTime, 20);
    assert.equal(options.userAgent, 'sqsd');
    assert.equal(options.daemonized, false);
    assert.equal(options.region, 'us-east-1');
});

test('honours environment variables for options that carry a default', () => {
    const options = resolveOptions(parse([]), {
        SQSD_WORKER_CONCURRENCY: '25',
        SQSD_WORKER_USER_AGENT: 'custom-agent',
        SQSD_MAX_MESSAGES_PER_REQUEST: '5',
        SQSD_RUN_DAEMONIZED: 'true',
        SQSD_SLEEP_SECONDS: '7'
    });

    assert.equal(options.concurrency, 25);
    assert.equal(options.userAgent, 'custom-agent');
    assert.equal(options.maxMessages, 5);
    assert.equal(options.daemonized, true);
    assert.equal(options.sleep, 7);
});

test('lets command line flags win over environment variables', () => {
    const options = resolveOptions(parse(['--concurrency', '4', '--user-agent', 'from-cli']), {
        SQSD_WORKER_CONCURRENCY: '25',
        SQSD_WORKER_USER_AGENT: 'from-env'
    });

    assert.equal(options.concurrency, 4);
    assert.equal(options.userAgent, 'from-cli');
});

test('ignores empty and malformed environment variables', () => {
    const options = resolveOptions(parse([]), {
        SQSD_WORKER_CONCURRENCY: '',
        SQSD_MAX_MESSAGES_PER_REQUEST: 'not-a-number',
        SQSD_RUN_DAEMONIZED: 'maybe'
    });

    assert.equal(options.concurrency, 3);
    assert.equal(options.maxMessages, 10);
    assert.equal(options.daemonized, false);
});

test('reads the webhook from either source', () => {
    assert.equal(resolveOptions(parse([]), { SQSD_WORKER_HTTP_URL: 'http://env/hook' }).webHook, 'http://env/hook');
    assert.equal(resolveOptions(parse(['-w', 'http://cli/hook']), { SQSD_WORKER_HTTP_URL: 'http://env/hook' }).webHook, 'http://cli/hook');
    assert.equal(resolveOptions(parse([]), {}).webHook, undefined);
});

test('mergeDefined skips undefined values but keeps falsy ones', () => {
    assert.deepEqual(mergeDefined({ a: 1, b: 2 }, { a: undefined, b: 0 }), { a: 1, b: 0 });
});

test('parses optional scalars', () => {
    assert.equal(parseOptionalInteger('  12 '), 12);
    assert.equal(parseOptionalInteger('1.5'), undefined);
    assert.equal(parseOptionalInteger(''), undefined);
    assert.equal(parseOptionalBoolean('YES'), true);
    assert.equal(parseOptionalBoolean('0'), false);
    assert.equal(parseOptionalBoolean('nope'), undefined);
});
