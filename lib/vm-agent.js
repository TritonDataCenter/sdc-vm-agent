/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * vm-agent.js
 */

var async = require('async');
var backoff = require('backoff');

var VM = require('./vm');
var VMAPI = require('./vmapi-client');

var VM_PATH = '/vms/%s';

var _versionCache = null;
function getAgentVersion() {
    if (_versionCache === null) {
        _versionCache = require('../package.json').version;
    }
    return _versionCache;
}

function VmAgent(options) {
    this.options = options;
    this.log = options.log;
    this.sample = null;
    this.lastFullSample = null;
    this.uuid = options.uuid;
    this.version = getAgentVersion();

    var userAgent = 'vm-agent/' + this.version +
        ' (' + 'node/' + process.versions.node + ')' +
        ' server/' + this.uuid;

    this.vmapiClient = new VMAPI({
        url: options.url,
        log: options.log,
        userAgent: userAgent
    });

    this.eventWatcher = VM.createEventWatcher({
        log: options.log
    });

    // Hash that gets built by doing vmadm.lookup
    this.sample = {};
    // Serial queues for sending VM updates serially
    this.queues = {};
}


VmAgent.prototype.start = function () {
    var self = this;
    var log = this.log;

    this.initializeEventWatcher();

    // Wrap our initial full sample in a retry-backoff
    var opts = { uuid: this.uuid };
    var fn = this.sendFullSample.bind(this, opts);
    this.retryUpdate(fn, opts, onRetry);

    function onRetry(err) {
        if (err) {
            log.error(err, 'Failed retry-backoff for initial sendFullSample');
            return;
        }

        log.info('Initial VMs state was successfully sent. Good to go');
        self.eventWatcher.updateState(self.sample);
        self.eventWatcher.lastCfgEvent = self.lastFullSample;
        self.eventWatcher.start();
    }
};


/*
 * Initializes the EventWatcher event listeners
 */
VmAgent.prototype.initializeEventWatcher = function () {
    var self = this;
    var log = this.log;
    var eventWatcher = this.eventWatcher;

    eventWatcher.on('state', function (uuid, state) {
        log.debug('state event for %s state: %s', uuid, state);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('zone_state', function (uuid, zone_state) {
        log.debug('zone_state event for %s newstate: %s', uuid, zone_state);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('zone_xml', function (uuid) {
        log.debug('fs.watch event on /etc/zones for %s', uuid);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('destroyed', function (uuid) {
        var vm = self.sample[uuid];
        if (!vm) {
            log.warn('VM %s appears to have gone away but ' +
                'self.sample doesn\'t have it', uuid);
            return;
        }

        log.info('Found a destroyed VM %s', uuid);
        vm.state = 'destroyed';
        vm.zone_state = 'destroyed';
        self.pushSample({ uuid: uuid, cachedVm: vm });
    });

    eventWatcher.on('err', function (err) {
        log.error(err, 'eventWatcher saw en error');
    });
};


VmAgent.prototype.setSample = function (sample) {
    var self = this;

    Object.keys(sample).forEach(function (key) {
        self.sample[key] = sample[key];
    });
};


/*
 * On startup, sendFullSample updates all VMs on the server. This will be a
 * blocking call before we turn on the event listeners so we allow
 * vm-agent to report the full state of the server first. It also gives us time
 * for VMAPI to be fully ready and responding to requests before we keep going
 */
VmAgent.prototype.sendFullSample = function (opts, callback) {
    var self = this;
    var log = this.log;
    var vmapiClient = this.vmapiClient;

    this.updateSample({}, function (err, sample) {
        if (err) {
            log.error(err, 'updateSample failed, cannot sendFullSample');
            callback(err);
            return;

        } else if (Object.keys(sample).length === 0) {
            log.warn('empty sample returned by vmadm lookup');
            callback();
            return;
        }

        self.setSample(sample);

        vmapiClient.updateServerVms(self.uuid, sample, function (vmapiErr) {
            if (vmapiErr) {
                log.error(vmapiErr, 'Could not sendFullSample');
                return callback(vmapiErr);
            }

            return callback();
        });
    });
};


/*
 * This function will call vmapiClient.updateVm(). When options.vm exists was
 * passed it means that a vm is tentatively destroyed and we double check that
 * there. In case the vm is not destroyed we reload its data with vmadm lookup.
 * At the end we call updateVm to update the vm data on VMAPI
 */
VmAgent.prototype.sendSample = function (options, callback) {
    var self = this;
    var log = this.log;
    var vmapiClient = this.vmapiClient;

    // if vm was destroyed else vmadm lookup
    if (options.cachedVm && options.cachedVm.state === 'destroyed') {
        var destSample = {};
        destSample[options.uuid] = options.cachedVm;
        this.setSample(destSample);
        this.eventWatcher.removeState(options.uuid);

        vmapiClient.updateVm(options.cachedVm, callback);

    } else {
        this.updateSample(options, function (err, sample) {
            if (err) {
                log.error(err, 'updateSample failed, cannot sendSample');
                callback(err);

            } else if (Object.keys(sample).length === 0) {
                log.warn('empty sample returned by vmadm lookup');
                callback();

            } else {
                self.eventWatcher.updateState(sample);
                self.setSample(sample);
                var vm = sample[options.uuid];
                vmapiClient.updateVm(vm, callback);
            }
        });
    }
};


/*
 * Initializes the serial queue for a single uuid and pushes the item to be
 * processed.
 */
VmAgent.prototype.pushSample = function (options) {
    var uuid = options.uuid|| this.uuid;

    if (this.queues[uuid] === undefined) {
        this.queues[uuid] = this.createQueue(uuid);
    }

    this.queues[uuid].push(options);
};


/*
 * Retries an update operation.
 */
VmAgent.prototype.retryUpdate = function (fn, options, callback) {
    var log = this.log;
    var retryOpts = { initialDelay: 2000, maxDelay: 64000 };

    function logAttempt(aLog, host) {
        function _log(number, delay, err) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }

            aLog.error(err, 'retry error for %s', options.uuid);
            aLog[level]({
                ip: host,
                attempt: number,
                delay: delay
            }, 'retry attempt for %s', options.uuid);
        }

        return (_log);
    }

    var retry = backoff.call(fn, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.error({ uuid: options.uuid },
                'Could not retry operation after %d attempts', attempts);
            return callback(err);
        }

        return callback();
    });

    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: retryOpts.initialDelay,
        maxDelay: retryOpts.maxDelay
    }));

    retry.failAfter(retryOpts.retries || Infinity);
    retry.on('backoff', logAttempt(log));

    retry.start();
};


/*
 * Initializes a serial queue for a uuid
 */
VmAgent.prototype.createQueue = function (uuid) {
    var self = this;
    var log = this.log;

    var queue = async.queue(function (opts, callback) {
        var fn = self.sendSample.bind(self, opts);
        self.retryUpdate(fn, opts, function (err) {
            if (err) {
                log.error(err, 'Error updating VM %', uuid);
                return callback(err);
            }

            return callback();
        });
    }, 1);

    queue.drain = function () {
        log.trace('serial queue for %s has been drained', uuid);
    };

    queue.saturated = function () {
        log.trace('serial queue for % has been saturated', uuid);
    };

    return queue;
};


/*
 *
 *  Sample format that gets loaded from vmadm.lookup:
 *
 *    {
 *    '70ac24a6-962a-4711-92f6-6dc6a53ea59e':
 *    { uuid: '70ac24a6-962a-4711-92f6-6dc6a53ea59e',
 *       owner_uuid: '930896af-bf8c-48d4-885c-6573a94b1853',
 *       quota: 25,
 *       max_physical_memory: 128,
 *       zone_state: 'running',
 *       state: 'running',
 *       brand: 'joyent-minimal',
 *       cpu_cap: 100,
 *       last_modified: '2014-04-29T23:30:17.000Z' },
 *    '9181f298-a867-49c6-9f34-d57584e7047e':
 *     { uuid: '9181f298-a867-49c6-9f34-d57584e7047e',
 *       owner_uuid: '930896af-bf8c-48d4-885c-6573a94b1853',
 *       quota: 25,
 *       max_physical_memory: 1024,
 *       zone_state: 'running',
 *       state: 'running',
 *       brand: 'joyent-minimal',
 *       cpu_cap: 300,
 *       last_modified: '2014-04-29T23:36:33.000Z' } },
 *       ...
 *       ...
 *   }
 */

VmAgent.prototype.updateSample = function (options, callback) {
    var self = this;
    var log = this.log;
    var uuid = options.uuid;

    var newSample;

    function lookup(cb) {
        // If we fail a lookup, newSample gets reset on every retry
        newSample = {};
        var searchOpts = {};
        var query;

        if (uuid) {
            searchOpts.uuid = uuid;
            query = 'uuid=' + uuid;
        } else {
            query = 'uuid=*';
        }

        log.debug('Starting updateSample ' + query);

        VM.list(searchOpts, function (err, vmobjs) {
            if (err) {
                log.error(err, 'ERROR: unable update VM list');
                return cb(err);
            }

            var vmobj;
            var running = 0;
            var notRunning = 0;
            var nonInventory = 0;

            for (vmobj in vmobjs) {
                vmobj = vmobjs[vmobj];
                if (!vmobj.do_not_inventory) {
                    newSample[vmobj.uuid] = vmobj;
                    if (vmobj.zone_state === 'running') {
                        running++;
                    } else {
                        notRunning++;
                    }
                } else {
                    newSample[vmobj.uuid] = vmobj;
                    newSample[vmobj.uuid].state = 'destroyed';
                    nonInventory++;
                }
            }

            var lookupResults = {
                running: running,
                notRunning: notRunning,
                nonInventory: nonInventory
            };
            log.trace(lookupResults, 'Lookup query results');

            return cb(null);
        });
    }

    function logAttempt(aLog, host) {
        function _log(number, delay) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }
            aLog[level]({
                ip: host,
                attempt: number,
                delay: delay
            }, 'updateSample retry attempt');
        }

        return (_log);
    }

    var retry = backoff.call(lookup, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;
        if (err) {
            log.error('Could not updateSample after %d attempts', attempts);
            return callback(err);
        }

        self.lastFullSample = (new Date()).getTime() / 1000;

        return callback(null, newSample);
    });

    var retryOpts = { initialDelay: 200, maxDelay: 2000 };
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: retryOpts.initialDelay,
        maxDelay: retryOpts.maxDelay
    }));

    retry.failAfter(5);
    retry.on('backoff', logAttempt(log));
    retry.start();
};


module.exports = VmAgent;
