const {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    GetQueueUrlCommand
} = require("@aws-sdk/client-sqs");
const debug = require('debug')("sqsd");
const error = require('debug')('sqsd:error');
const axios = require("axios");

const delay = time => new Promise(res=>setTimeout(res,time));
const MAX_MESSAGES_PER_RECEIVE = 10;
const MAX_WAIT_TIME_SECONDS = 20;
const WORKER_HEALTH_RETRY_DELAY = 1000;
// Floor for a single health check request, so that a zero or nearly exhausted
// budget still performs one meaningful attempt instead of timing out at once.
const MIN_WORKER_HEALTH_ATTEMPT_TIMEOUT = 1000;

function coerceInteger(value, fallback, min, max) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    const parsed = Number(value);
    let normalized = Number.isInteger(parsed) ? parsed : fallback;

    if (min !== undefined) {
        normalized = Math.max(min, normalized);
    }

    if (max !== undefined) {
        normalized = Math.min(max, normalized);
    }

    return normalized;
}

function coerceBoolean(value) {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized in { "1":1, "yes":1, "true":1 }) {
            return true;
        }
        if (normalized in { "0":1, "no":1, "false":1 }) {
            return false;
        }
    }

    return Boolean(value);
}

function normalizeOptions(options) {
    const normalized = Object.assign({}, options);

    normalized.maxMessages = coerceInteger(normalized.maxMessages, MAX_MESSAGES_PER_RECEIVE, 1, MAX_MESSAGES_PER_RECEIVE);
    normalized.concurrency = coerceInteger(normalized.concurrency, 3, 1);
    normalized.waitTime = coerceInteger(normalized.waitTime, MAX_WAIT_TIME_SECONDS, 0, MAX_WAIT_TIME_SECONDS);
    normalized.sleep = coerceInteger(normalized.sleep, 0, 0);
    normalized.timeout = coerceInteger(normalized.timeout, 60000, 0);
    normalized.workerHealthWaitTime = coerceInteger(normalized.workerHealthWaitTime, 10000, 0);
    normalized.daemonized = coerceBoolean(normalized.daemonized);
    normalized.userAgent = normalized.userAgent || "sqsd";
    normalized.contentType = normalized.contentType || "application/json";

    return normalized;
}

function getQueueNameFromQueueUrl(queueUrl) {
    const parts = String(queueUrl).split('?')[0].split('/').filter(Boolean);
    return parts[parts.length - 1];
}

function buildEndpointQueueUrl(endpointUrl, queueName) {
    return String(endpointUrl).replace(/\/+$/, '') + '/' + queueName;
}

function Defer() {
    let resolve, reject;
    const promise = new Promise(function() {
        resolve = arguments[0];
        reject = arguments[1];
    });
    return {
        resolve: resolve,
        reject: reject,
        promise: promise
    };
}

class SQSProcessor {

    constructor(options) {
        this.options = normalizeOptions(options);

        if (this.options.queueUrl && !this.options.queueName) {
            this.options.queueName = getQueueNameFromQueueUrl(this.options.queueUrl);
        }

        const config = {
            region: this.options.region
        };

        // In AWS SDK v3 credentials are passed as a dedicated object. When left
        // empty the default credential provider chain (IAM roles, env, ...) is used.
        if (this.options.accessKeyId && this.options.secretAccessKey) {
            config.credentials = {
                accessKeyId: this.options.accessKeyId,
                secretAccessKey: this.options.secretAccessKey,
                sessionToken: this.options.sessionToken
            };
        }

        if (this.options.endpointUrl) {
            config.endpoint = this.options.endpointUrl;
            if (this.options.queueName) {
                this.options.queueUrl = buildEndpointQueueUrl(this.options.endpointUrl, this.options.queueName);
            }
        }

        this._queue = new SQSClient(config);
        this.processingMessages = [];
        this.shutdown = false;

    }

    async resolveQueueUrl () {
        if (this.options.queueUrl) {
            return;
        }

        if (!this.options.queueName) {
            throw new Error("Either queueUrl or queueName is required");
        }

        const result = await this._queue.send(new GetQueueUrlCommand({
            QueueName: this.options.queueName
        }));

        this.options.queueUrl = result.QueueUrl;
    }

    async postToWorker (messageBody, sqsMessage) {
        const attributes = sqsMessage.Attributes || {};
        const messageAttributes = sqsMessage.MessageAttributes || {};
        const headers = {
            'User-Agent': this.options.userAgent,
            'content-type': this.options.contentType,
            'X-Aws-Sqsd-Msgid': sqsMessage.MessageId,
            'X-Aws-Sqsd-Queue': this.options.queueName
        };

        if (attributes.ApproximateFirstReceiveTimestamp)
            headers['X-Aws-Sqsd-First-Received-At'] = attributes.ApproximateFirstReceiveTimestamp;

        if (attributes.ApproximateReceiveCount)
            headers['X-Aws-Sqsd-Receive-Count'] = attributes.ApproximateReceiveCount;

        if (attributes.SenderId)
            headers['X-Aws-Sqsd-Sender-Id'] = attributes.SenderId;

        if (attributes.AWSTraceHeader)
            headers['X-Amzn-Trace-Id'] = attributes.AWSTraceHeader;

        for(let name in messageAttributes) {
            const value = messageAttributes[name];
            if (value && value.StringValue !== undefined) {
                headers['X-Aws-Sqsd-Attr-'+name] = value.StringValue;
            }
        }

        debug( "WebHook POST %s, %O",  this.options.webHook, headers)

        return axios.post( this.options.webHook,
            Buffer.from(messageBody === undefined || messageBody === null ? '' : String(messageBody)),
            {
                headers: headers,
                timeout: this.options.timeout
            }
        )

    }

    handleMessage (sqsMessage) {
        this.processingMessages.push( sqsMessage )
        const messageBody = sqsMessage.Body;
        const receipt_handle = sqsMessage.ReceiptHandle;

        const startTime = new Date().getTime();
        sqsMessage.promise = (async () => {
            try {
                const postResult = await this.postToWorker(messageBody, sqsMessage);
                debug(  "Received result from worker, MessageId: %s  statusCode:%s ", sqsMessage.MessageId, postResult.status)
                await this._queue.send(new DeleteMessageCommand({
                    ReceiptHandle: receipt_handle,
                    QueueUrl: this.options.queueUrl
                }))
                debug("Message successful removed from sqs, %o ", {MessageId: sqsMessage.MessageId, taskTime: new Date().getTime() - startTime})
                debug( "Message successful processed,  MessageId: %s ", sqsMessage.MessageId)
            }
            catch(err) {
                // A non 2XX answer is rejected by the axios default
                // validateStatus, so the worker status code is carried by the
                // error response and is the first thing to look at in the logs.
                const status = err.response && err.response.status;
                error("Error while Message process, MessageId: %s  statusCode:%s  %s",
                    sqsMessage.MessageId,
                    status === undefined ? "n/a" : status,
                    err.message)
            }
            finally {
                const index = this.processingMessages.indexOf(sqsMessage);
                if (index > -1) {
                    this.processingMessages.splice(index, 1);
                }
                this.scheduleRun();
            }
        })();
        return sqsMessage.promise;
    }


    async doCheckWorkerHealth (beginTimeStamp) {
        debug("try ping worker by " + this.options.workerHealthUrl)
        const deadline = beginTimeStamp + this.options.workerHealthWaitTime;

        while (true) {
            // workerHealthWaitTime caps how long we wait for the worker to come
            // up, not how fast it has to answer: the whole remaining budget is
            // handed to a single attempt. Capping an attempt any lower would
            // declare a healthy but slow worker down, forever.
            const remaining = deadline - new Date().getTime();
            const attemptTimeout = Math.max(remaining, MIN_WORKER_HEALTH_ATTEMPT_TIMEOUT);

            try {
                await axios.get(this.options.workerHealthUrl, {
                    timeout: attemptTimeout
                })
                debug("Worker is health.")
                return true
            }
            catch(e){
                error("Check worker failed: " + e.message)
                const timeLeft = deadline - new Date().getTime();
                if (timeLeft <= 0)
                    return false;
                await delay(Math.min(WORKER_HEALTH_RETRY_DELAY, timeLeft))
            }
        }
    }

    async checkWorkerHealth () {
        if (this.healthChecked !== undefined) //cached result, no sense to check worker on each cycle
            return this.healthChecked;
        if (!this.options.workerHealthUrl)
            return true
        debug("Check worker for health")
        this.healthChecked = await this.doCheckWorkerHealth(new Date().getTime())
        return this.healthChecked
    }


    async tick  () {
        if (this.shutdown) {
            return this.waitForFinish();
        }

        const availableSlots = this.options.concurrency - this.processingMessages.length;
        if (  this.polling || availableSlots <= 0 ) {
            return
        }

        const messagesToReceive = Math.min(this.options.maxMessages, availableSlots, MAX_MESSAGES_PER_RECEIVE);
        debug("Start Polling For %s Messages", messagesToReceive)
        this.polling = true;
        try {
            const data = await this._queue.send(new ReceiveMessageCommand({
                MaxNumberOfMessages: messagesToReceive,
                WaitTimeSeconds: this.options.waitTime,
                MessageSystemAttributeNames: ["All"],
                MessageAttributeNames: ["All"],
                QueueUrl: this.options.queueUrl
            }));

            if ( data && Array.isArray(data.Messages) && data.Messages.length >0 ) {
                debug( "Messages Received: %s ", data.Messages.length )
                data.Messages.forEach( m => {
                    this.handleMessage(m);
                })
            }
            else {
                debug("No Messages Received via poll time")
                if (this.options.daemonized && this.options.sleep > 0) {
                    await delay(this.options.sleep * 1000)
                }
            }
        }
        finally {
            this.polling = false;
        }

        return this.scheduleRun();
    }



    scheduleRun  () {
        if (this.options.daemonized) {
            if (this.shutdown) {
                this.waitForFinish()
                .then(()=>{
                    this.deferredStop.resolve();
                })
            }
            else {
                this.tick()
                .catch((e)=> {
                    this.deferredStop.reject(e);
                })
            }
        }
        else{
            debug("not a daemon, wait and exit")
            return this.waitForFinish()
        }
    }

    waitForFinish  () {
        debug("Wait for rest messages")
        return Promise.all(  this.processingMessages.map( x => x.promise ) )
    }


    async start () {
        await this.resolveQueueUrl()
        let health = await  this.checkWorkerHealth()
        if (!health) {
            throw new Error("Worker not responding, cannot continue")
        }
        if (this.options.daemonized) {
            this.deferredStop = new Defer();//used to to stop if error happens, should works infinite in OK scenario
            await this.scheduleRun();
            return this.deferredStop.promise;
        }
        else
            return this.tick()

    }


}


exports.SQSProcessor = SQSProcessor;
