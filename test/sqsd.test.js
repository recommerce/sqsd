'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const { SQSProcessor } = require('../lib');

function commandName(command) {
    return command.constructor.name;
}

function stubPost(t, implementation) {
    const originalPost = axios.post;
    axios.post = implementation;
    t.after(() => {
        axios.post = originalPost;
    });
}

test('posts a message without attributes and deletes it after worker success', async (t) => {
    const requests = [];
    stubPost(t, async (url, body, config) => {
        requests.push({
            url: url,
            body: body.toString('utf8'),
            headers: config.headers,
            timeout: config.timeout
        });
        return { status: 200 };
    });

    const commands = [];
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/queue-name',
        webHook: 'http://worker/message/grid',
        maxMessages: 10,
        concurrency: 3,
        waitTime: 0,
        timeout: 5000,
        daemonized: false
    });

    processor._queue.send = async (command) => {
        commands.push({ name: commandName(command), input: command.input });

        if (commandName(command) === 'ReceiveMessageCommand') {
            return {
                Messages: [{
                    MessageId: 'msg-1',
                    ReceiptHandle: 'receipt-1',
                    Body: 'plain-body'
                }]
            };
        }

        if (commandName(command) === 'DeleteMessageCommand') {
            return {};
        }

        throw new Error('Unexpected command: ' + commandName(command));
    };

    await processor.start();

    assert.equal(commands[0].name, 'ReceiveMessageCommand');
    assert.equal(commands[0].input.MaxNumberOfMessages, 3);
    assert.equal(commands[0].input.WaitTimeSeconds, 0);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://worker/message/grid');
    assert.equal(requests[0].body, 'plain-body');
    assert.equal(requests[0].timeout, 5000);
    assert.equal(requests[0].headers['X-Aws-Sqsd-Msgid'], 'msg-1');
    assert.equal(requests[0].headers['X-Aws-Sqsd-Queue'], 'queue-name');

    assert.deepEqual(commands[1], {
        name: 'DeleteMessageCommand',
        input: {
            ReceiptHandle: 'receipt-1',
            QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/queue-name'
        }
    });
});

test('keeps the SQS message when the worker request fails', async (t) => {
    const requests = [];
    stubPost(t, async (url, body, config) => {
        requests.push({
            url: url,
            body: body.toString('utf8'),
            headers: config.headers
        });
        throw new Error('Request failed with status code 500');
    });

    const commands = [];
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/failing-worker',
        webHook: 'http://worker/message/grid',
        maxMessages: 1,
        concurrency: 1,
        waitTime: 0,
        timeout: 5000,
        daemonized: false
    });

    processor._queue.send = async (command) => {
        commands.push({ name: commandName(command), input: command.input });

        if (commandName(command) === 'ReceiveMessageCommand') {
            return {
                Messages: [{
                    MessageId: 'msg-2',
                    ReceiptHandle: 'receipt-2',
                    Body: 'retry-me',
                    MessageAttributes: {
                        source: {
                            DataType: 'String',
                            StringValue: 'unit-test'
                        }
                    }
                }]
            };
        }

        throw new Error('Unexpected command: ' + commandName(command));
    };

    await processor.start();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['X-Aws-Sqsd-Attr-source'], 'unit-test');
    assert.deepEqual(commands.map(command => command.name), ['ReceiveMessageCommand']);
});

test('resolves queue URL from queue name and clamps SQS receive limits', async () => {
    const commands = [];
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueName: 'named-queue',
        webHook: 'http://127.0.0.1:1/message/grid',
        maxMessages: 50,
        concurrency: 50,
        waitTime: 50,
        daemonized: false
    });

    processor._queue.send = async (command) => {
        commands.push({ name: commandName(command), input: command.input });

        if (commandName(command) === 'GetQueueUrlCommand') {
            return {
                QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/named-queue'
            };
        }

        if (commandName(command) === 'ReceiveMessageCommand') {
            return {};
        }

        throw new Error('Unexpected command: ' + commandName(command));
    };

    await processor.start();

    assert.equal(processor.options.queueUrl, 'https://sqs.eu-west-1.amazonaws.com/123456789012/named-queue');
    assert.deepEqual(commands.map(command => command.name), ['GetQueueUrlCommand', 'ReceiveMessageCommand']);
    assert.equal(commands[1].input.MaxNumberOfMessages, 10);
    assert.equal(commands[1].input.WaitTimeSeconds, 20);
});

test('builds the queue URL from the endpoint URL and the queue name', async () => {
    const commands = [];
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        endpointUrl: 'http://elasticmq:9324/',
        queueName: 'local-queue',
        webHook: 'http://worker/message/grid',
        concurrency: 1,
        waitTime: 0,
        daemonized: false
    });

    processor._queue.send = async (command) => {
        commands.push({ name: commandName(command), input: command.input });

        if (commandName(command) === 'ReceiveMessageCommand') {
            return {};
        }

        throw new Error('Unexpected command: ' + commandName(command));
    };

    await processor.start();

    assert.equal(processor.options.queueUrl, 'http://elasticmq:9324/local-queue');
    assert.deepEqual(commands.map(command => command.name), ['ReceiveMessageCommand']);
    assert.equal(commands[0].input.QueueUrl, 'http://elasticmq:9324/local-queue');
});

test('gives the whole health budget to a single health check attempt', async (t) => {
    const server = http.createServer((req, res) => {
        setTimeout(() => {
            res.writeHead(200);
            res.end('ok');
        }, 1200);
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/slow-health',
        webHook: 'http://worker/message/grid',
        workerHealthUrl: 'http://127.0.0.1:' + server.address().port + '/health',
        workerHealthWaitTime: 5000,
        daemonized: false
    });

    assert.equal(await processor.checkWorkerHealth(), true);
});

test('reports the worker as down once the health budget is exhausted', async () => {
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/dead-health',
        webHook: 'http://worker/message/grid',
        // Nothing listens on port 1, every attempt fails immediately.
        workerHealthUrl: 'http://127.0.0.1:1/health',
        workerHealthWaitTime: 1200,
        daemonized: false
    });

    processor._queue.send = async () => {
        throw new Error('The queue must not be polled when the worker is down');
    };

    assert.equal(await processor.checkWorkerHealth(), false);
    await assert.rejects(processor.start(), /Worker not responding/);
});

test('stops polling and drains in-flight messages once shutdown is requested', async (t) => {
    const processor = new SQSProcessor({
        region: 'eu-west-1',
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/draining-queue',
        webHook: 'http://worker/message/grid',
        maxMessages: 1,
        concurrency: 1,
        waitTime: 0,
        daemonized: true
    });

    stubPost(t, async () => {
        // The supervisor asks for a graceful shutdown while the worker request
        // is still in flight.
        processor.shutdown = true;
        return { status: 200 };
    });

    const commands = [];
    processor._queue.send = async (command) => {
        commands.push(commandName(command));

        if (commandName(command) === 'ReceiveMessageCommand') {
            if (commands.filter(name => name === 'ReceiveMessageCommand').length > 1) {
                throw new Error('The queue must not be polled again after shutdown');
            }

            return {
                Messages: [{
                    MessageId: 'msg-3',
                    ReceiptHandle: 'receipt-3',
                    Body: 'drain-me'
                }]
            };
        }

        return {};
    };

    await processor.start();

    assert.deepEqual(commands, ['ReceiveMessageCommand', 'DeleteMessageCommand']);
    assert.deepEqual(processor.processingMessages, []);
});
