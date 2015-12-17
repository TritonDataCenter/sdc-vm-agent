/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Overview of Responsibilities
 * ============================
 *
 * The job of vm-agent is to tell VMAPI about changes to VMs that occur on the
 * CN. Except in case of errors, operations performed on the CN through SDC APIs
 * should not need this, as cn-agent tasks do a load of the VM state after each
 * action is performed and the results are put into VMAPI.
 *
 * The primary cases where vm-agent is solely responsible for letting SDC know
 * about changes are:
 *
 *  * In the case of errors where a process crashes before updating VMAPI but
 *    after making a change, or in the case of inconsistency due to other bugs.
 *    The data on the CN is always treated as more correct and VMAPI should be
 *    updated with the actual state on the CN.
 *
 *  * In case of changes performed manually by operators. When an operator makes
 *    a change to a VM from the GZ on the CN, the APIs will not know about this
 *    change unless told by vm-agent.
 *
 *  * When operations are triggered from within VMs themselves. This includes
 *    shutdown and restart operations performed from within the VM, but also
 *    includes customer_metadata changes made through the mdata-put and
 *    mdata-delete operations from within.
 *
 *  * When VMs themselves experience the unexpected. Whether it is a KVM VM has
 *    its qemu process crash sending the zone to the 'stopped' state or an
 *    LX/docker container has its init crash without a restart policy in place,
 *    there are many ways a container can change state without there being a
 *    corresponding API action.
 *
 * vm-agent must notice changes to the VMs on the CN and report these to VMAPI.
 *
 *
 * Theory of Operation
 * ===================
 *
 * On startup vm-agent will:
 *
 *  * Start a watcher which will notify vm-agent of VM create/delete/modify
 *
 *  * Load the set of VMs that VMAPI thinks should be on this CN
 *
 *  * Load the set of VMs that are on this machine (vmadm lookup)
 *
 *  * Compare the two lists and:
 *
 *     * If there are VMs that exist on the CN, but not VMAPI or have different
 *       properties between the two: the VM object will be updated in VMAPI.
 *
 *     * If there are VMs that exist in VMAPI but not on the CN, the object
 *       returned by VMAPI will be modified to have state=destroyed and
 *       zone_state=destroyed and PUT back into VMAPI.
 *
 * The initial update to VMAPI is currently done through the:
 *
 *     PUT /vms?server_uuid=<uuid>
 *
 * facility. And includes only the set of updates determined by the comparison
 * described above.
 *
 * If there are errors in any part of this, the entire process will be restarted
 * after a delay. This means a fresh lookup from both systems, so we only ever
 * PUT just-looked-up data into VMAPI. The delay between retry attempts will
 * double on each failure, up to some maximum value. (MAX_UPDATE_DELAY)
 *
 * After startup, most of the work of vm-agent will be processing the queue of
 * events as they come in from the watcher. When an event occurs, the VM's uuid
 * is added to the queue.
 *
 * The queue is processed in FIFO order, one item at a time. However, since we
 * only want to sent fresh data to VMAPI, only the uuids ever exist in the queue
 * and if the uuid of a VM already exists in the queue, it is not requeued.
 *
 * The processing of a VM uuid from the queue involves:
 *
 *   * Loading the current VM object via vmadm
 *
 *   * If the VM does not exist:
 *
 *       * The last seen VM object for this VM will be PUT to VMAPI, with state
 *         and zone_state fields changed to 'destroyed'
 *
 *   * If the VM does exist:
 *
 *       * The new VM object for this VM will be PUT to VMAPI
 *
 * If there are any errors with the update for an individual VM, there will be a
 * delay and then that VM's uuid is added back to the queue (only if the uuid
 * is not already queued) and we will re-run this process when it is next loaded
 * from the queue. The delay before re-queueing will double on each failure, up
 * to some maximum value (MAX_UPDATE_DELAY) but the delay will be reset on a
 * sucessful update.
 *
 *
 * Important Notes
 * ===============
 *
 * VMs which have the 'do_not_inventory' property set are not visible to
 * vm-agent. They should be treated exactly the same as VMs which do not exist
 * on this CN.
 *
 */

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var diff = require('deep-diff').diff;
var vasync = require('vasync');
var vmadm = require('vmadm');

var VmWatcher = require('./vm-watcher');
var VMAPI = require('./vmapi-client');

// initial and maximum values to delay between VMAPI retries. (in ms)
var INITIAL_UPDATE_DELAY = 500;
var MAX_UPDATE_DELAY = 30000;


function VmAgent(options) {
    var self = this;
    var packageJson = path.join(path.dirname(__dirname), 'package.json');
    var userAgent;

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalNumber(options.periodic_interval,
        'options.periodic_interval');
    assert.uuid(options.server_uuid, 'options.server_uuid');
    assert.string(options.vmapi_url, 'options.vmapi_url');

    // Load the list of fields that VmWatcher will be watching, which we'll
    // use when comparing objects. Since VMAPI and vmadm have different default
    // fields, this is the common list. We start with just those fields that
    // we're actually watching for changes.
    self.comparisonFields = VmWatcher.WATCHED_FIELDS;

    // We add boot_timestamp to notice case where zone has rebooted between
    // events.
    if (self.comparisonFields.indexOf('boot_timestamp') === -1) {
        self.comparisonFields.push('boot_timestamp');
    }

    if (options.periodic_interval) {
        self.periodicInterval = options.periodic_interval;
    }

    self.log = options.log;
    self.server_uuid = options.server_uuid;
    self.version = JSON.parse(fs.readFileSync(packageJson)).version;

    assert(self.version, 'missing package.json version');

    userAgent = 'vm-agent/' + self.version
        + ' (node/' + process.versions.node + ')'
        + ' server/' + self.server_uuid;

    self.vmapiClient = new VMAPI({
        url: options.vmapi_url,
        log: options.log,
        userAgent: userAgent
    });

    // Now setup the properties that we can reset later (on .stop() for example)
    self.initializeProperties();
}

/*
 * This sets or resets the resettable properties on the VmAgent instance.
 */
VmAgent.prototype.initializeProperties = function initializeProperties() {
    var self = this;

    if (self.watcher) {
        self.watcher.stop();
        self.watcher = null;
    }

    // vasync doesn't allow us to clear a queue, so kill and create a new one.
    if (self.queue) {
        self.queue.kill();
    }

    self.queue = vasync.queue(function _updateVmapiVm(vm_uuid, callback) {
        // closure so self is correct here
        if (!self.ready) {
            callback();
            return;
        }
        self.updateVmapiVm(vm_uuid, callback);
    }, 1);

    // set values to defaults
    self.updateDelay = INITIAL_UPDATE_DELAY;
    self.dirtyVms = [];
    self.retryDelays = {};
    self.ready = false;
    self.lastSeenVms = {};
};

VmAgent.prototype.updateVmapiVm = function updateVmapiVm(vm_uuid, callback) {
    var self = this;

    assert.ok(self.ready, 'no updates until init complete');

    /*
     * The VM has either been created, modified or deleted.
     *
     * We do a vmadm load here and if the VM does not exist, grab the last
     * object we have for the VM from self.lastSeenVms and do a PUT with
     * that object but 'state' and 'zone_state' set to 'destroyed. If the VM
     * does exist, we just PUT the object as-is and update self.lastSeenVms.
     *
     */
    vasync.pipeline({arg: {}, funcs: [
        function _loadVm(stash, cb) {
            var opts = {log: self.log, uuid: vm_uuid};
            var startLoad = (new Date()).getTime();

            // NOTE: vmadm.load handles filtering out the do_not_inventory VMs
            vmadm.load(opts, function _onVmLoad(err, vmobj) {
                var doneLoad = (new Date()).getTime();

                if (!self.ready) {
                    // in case we shutdown while loading
                    cb();
                    return;
                }

                self.log.debug({
                    action: 'vmadm.load',
                    elapsed: (doneLoad - startLoad),
                    err: (err && err.restCode) ? err.restCode : err
                }, 'completed vmadm.load() for updateVmapiVm()');

                if (err && err.restCode === 'VmNotFound') {
                    assert.ok(self.lastSeenVms.hasOwnProperty(vm_uuid),
                        'VM ' + vm_uuid + ' not seen before');

                    self.lastSeenVms[vm_uuid].state = 'destroyed';
                    self.lastSeenVms[vm_uuid].zone_state = 'destroyed';
                    stash.vmobj = self.lastSeenVms[vm_uuid];

                    cb();
                    return;
                } else if (err) {
                    cb(err);
                    return;
                }

                self.lastSeenVms[vm_uuid] = vmobj;
                stash.vmobj = vmobj;
                cb();
            });
        }, function _putVm(stash, cb) {
            var startUpdate = (new Date()).getTime();

            if (!self.ready) {
                // in case we shutdown while running
                cb();
                return;
            }

            assert.object(stash.vmobj, 'require VM object');

            self.vmapiClient.updateVm(stash.vmobj, function _onVmUpdate(err) {
                var doneUpdate = (new Date()).getTime();

                self.log.debug({
                    action: 'VMAPI.updateVm',
                    elapsed: (doneUpdate - startUpdate),
                    err: err
                }, 'completed VMAPI.updateVm() for updateVmapiVm()');

                cb(err);
            });
        }
    ]}, function _updateVmComplete(err) {
        if (!err || !self.ready) {
            // on success we clear the retryDelay for next time.
            if (self.retryDelays[vm_uuid]) {
                clearTimeout(self.retryDelays[vm_uuid].timer);
                delete self.retryDelays[vm_uuid];
            }

            callback();
            return;
        }

        self.log.warn({err: err, vm_uuid: vm_uuid},
            'update failed, scheduling retry');
        self.scheduleRetryUpdate(vm_uuid);

        callback(err);
    });
};

/*
 * This is called when a VM has failed an update. It is responsible for waiting
 * for (and incrementing) the delay and then re-queuing the update if there's
 * not already a timer doing the same thing.
 */
VmAgent.prototype.scheduleRetryUpdate = function scheduleRetryUpdate(vm_uuid) {
    var self = this;
    var delay;

    assert.uuid(vm_uuid, 'vm_uuid');

    if (self.retryDelays[vm_uuid] && self.retryDelays[vm_uuid].timer) {
        // Had an error, but we also already have a timer, so don't start
        // another one, or increment the delay.
        return;
    }

    // On any error when we don't already have a timer running, we set a
    // timer to re-queue the VM. This is always safe since in the worst
    // case we do an extra update with the latest data.
    if (!self.retryDelays[vm_uuid]) {
        self.retryDelays[vm_uuid] = {delay: INITIAL_UPDATE_DELAY};
    }
    delay = self.retryDelays[vm_uuid].delay;

    // Increment for next time.
    self.retryDelays[vm_uuid].delay *= 2;
    if (self.retryDelays[vm_uuid].delay > MAX_UPDATE_DELAY) {
        self.retryDelays[vm_uuid].delay = MAX_UPDATE_DELAY;
    }

    self.log.trace('scheduling retry for ' + vm_uuid + ' in ' + delay + ' ms');
    self.retryDelays[vm_uuid].timer = setTimeout(function _delayedRetry() {
        if (self.retryDelays[vm_uuid]) {
            delete self.retryDelays[vm_uuid].timer;
        }
        self.queueVm(vm_uuid);
    }, delay);
};

/*
 * The fact that we use this queue serially has the additional advantage
 * currently of debouncing updates that are coming in frequently. For example if
 * a VM is under heavy modification and posting 'modify' events multiple times
 * per second, most of the time we'll never have more than one update pending in
 * the queue.
 */
VmAgent.prototype.queueVm = function queueVm(vm_uuid) {
    var self = this;
    var alreadyQueued = false;
    var queueIdx;

    // If we don't already have a queued update for this VM, queue one.
    //
    // NOTE: the queue.queued does not include any vm_uuid that is currently
    // being processed, which is fine because we may be past the lookup and
    // in the waiting for VMAPI phase. We need to update again when we can.
    //
    for (queueIdx in self.queue.queued) {
        if (self.queue.queued[queueIdx].task === vm_uuid) {
            alreadyQueued = true;
        }
    }
    if (!alreadyQueued) {
        self.queue.push(vm_uuid);
    }
};

VmAgent.prototype.setupWatcher = function setupWatcher() {
    var self = this;

    // Setup the watcher that will notice VM changes and add to the
    // update-to-VMAPI queue.
    self.watcher = new VmWatcher({
        log: self.log,
        periodicInterval: self.periodicInterval // may be undefined
    });

    function _onVmEvent(vm_uuid, name, watcher) {
        self.log.debug('Saw ' + name + ': ' + vm_uuid
            + (watcher ? ' [' + watcher + ']' : ''));

        // During initialization we store the set of VMs that need updates
        // in self.dirtyVms and will add those to the queue when initialization
        // is complete.
        if (!self.ready) {
            if (self.dirtyVms.indexOf(vm_uuid) === -1) {
                self.dirtyVms.push(vm_uuid);
            }
            return;
        }

        self.queueVm(vm_uuid);
    }

    self.watcher.on('VmCreated', function _onCreate(vm_uuid, watcher) {
        _onVmEvent(vm_uuid, 'create', watcher);
    });

    self.watcher.on('VmModified', function _onModify(vm_uuid, watcher) {
        _onVmEvent(vm_uuid, 'modify', watcher);
    });

    self.watcher.on('VmDeleted', function _onDelete(vm_uuid, watcher) {
        _onVmEvent(vm_uuid, 'delete', watcher);
    });

    // NOTE: watcher gets started as part of initialUpdate
};

/*
 * This builds a trimmed down VM object that has been trimmed to only those
 * fields in the "fields" array. The 'source' parameter is intended to indicate
 * where the VM object originated as there are some differences between
 * vmadm and VMAPI VM objects that it tries to smooth out so that they results
 * are actually comparable.
 */
function makeComparable(vmobj, fields, source) {
    var field;
    var fieldIdx;
    var newVmobj = {};

    for (fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
        field = fields[fieldIdx];

        if (vmobj.hasOwnProperty(field)) {
            if (source === 'vmapi'
                && VMAPI.VMAPI_ALWAYS_SET_FIELDS.hasOwnProperty(field)
                && !diff(VMAPI.VMAPI_ALWAYS_SET_FIELDS[field], vmobj[field])) {
                /*
                 * VMAPI always includes some fields, even when unset. So we
                 * skip those here so that the comparison can work.
                 */
                continue;
            }
            newVmobj[field] = vmobj[field];
        }
    }

    return (newVmobj);
}

VmAgent.prototype.initialUpdate = function initialUpdate(callback) {
    var self = this;
    var vms = {};

    vasync.pipeline({arg: {}, funcs: [
        function _getVmapiVms(stash, cb) {
            var startLookup = (new Date()).getTime();

            self.vmapiClient.getVms(self.server_uuid,
                function _getVmsCb(err, vmobjs) {
                    var doneLookup = (new Date()).getTime();
                    var vmIdx;

                    self.log.debug({
                        action: 'VMAPI.lookup',
                        elapsed: (doneLookup - startLookup),
                        err: err,
                        vmCount: (vmobjs ? vmobjs.length : 0)
                    }, 'completed VMAPI.lookup() for VmAgent() init');

                    if (err) {
                        cb(err);
                        return;
                    }

                    stash.vmapiVms = {
                        compareVms: {},
                        fullVms: {}
                    };

                    // vmobjs is an array of VM objects
                    for (vmIdx = 0; vmIdx < vmobjs.length; vmIdx++) {
                        stash.vmapiVms.fullVms[vmobjs[vmIdx].uuid]
                            = vmobjs[vmIdx];
                        stash.vmapiVms.compareVms[vmobjs[vmIdx].uuid]
                            = makeComparable(vmobjs[vmIdx],
                            self.comparisonFields, 'vmapi');
                    }
                    cb();
                }
            );
        }, function _startWatcher(stash, cb) {
            /*
             * Just before we do the vmadm lookup we start the watcher which
             * will be dumping changed VMs into the queue. We start it here to
             * avoid a race where things change during or just after the vmadm
             * lookup we're about to do. If something fails in the
             * initialization here and we're going to do a new loop, we stop
             * the watcher and clear the existing queue.
             */

            self.watcher.start();
            cb();
        }, function _getVmadmVms(stash, cb) {
            var ALL_VMS = {}; // no filter means: grab them all
            var opts = {log: self.log};
            var startLookup = (new Date()).getTime();

            // NOTE: vmadm.lookup handles filtering out the do_not_inventory VMs
            vmadm.lookup(ALL_VMS, opts, function _onLookup(err, vmobjs) {
                var doneLookup = (new Date()).getTime();
                var vmIdx;

                self.log.debug({
                    action: 'vmadm.lookup',
                    elapsed: (doneLookup - startLookup),
                    err: err,
                    vmCount: (vmobjs ? Object.keys(vmobjs).length : 0)
                }, 'completed vmadm.lookup() for VmAgent() init');

                if (err) {
                    cb(err);
                    return;
                }

                stash.vmadmVms = {
                    compareVms: {},
                    fullVms: {}
                };

                // vmobjs is an array of VM objects
                for (vmIdx = 0; vmIdx < vmobjs.length; vmIdx++) {
                    stash.vmadmVms.fullVms[vmobjs[vmIdx].uuid]
                        = vmobjs[vmIdx];
                    stash.vmadmVms.compareVms[vmobjs[vmIdx].uuid]
                        = makeComparable(vmobjs[vmIdx], self.comparisonFields,
                        'vmadm');
                }
                cb();
            });
        }, function _findVmsToUpdate(stash, cb) {
            var diffs;
            var updateVms = [];
            var vm;

            /*
             * The payload to VMAPI's PUT /vms?server_uuid=... is:
             *
             *  {
             *    "vms": {
             *      "<uuid>": {
             *        "uuid": "<uuid>",
             *        ...
             *      }, ...
             *    }
             *  }
             *
             * So we build such a structure here for the VMs we need to update.
             */

            diffs = (diff(stash.vmadmVms.compareVms,
                stash.vmapiVms.compareVms) || []);

            self.log.debug({vmDiff: diffs}, 'VMAPI/vmadm diff');
            diffs.forEach(function _diffCb(diffobj) {
                assert.array(diffobj.path, 'diffobj must have path');
                assert.uuid(diffobj.path[0], 'diffobj.path[0] must be uuid: '
                    + diffobj.path[0]);
                if (updateVms.indexOf(diffobj.path[0]) === -1) {
                    updateVms.push(diffobj.path[0]);
                }
            });

            updateVms.forEach(function _updateCb(vm_uuid) {
                if (stash.vmadmVms.fullVms.hasOwnProperty(vm_uuid)) {
                    // either create or update, either case we just put
                    vms[vm_uuid] = stash.vmadmVms.fullVms[vm_uuid];
                } else if (stash.vmapiVms.fullVms.hasOwnProperty(vm_uuid)) {
                    // VM exists in VMAPI but not locally, so update state
                    vm = stash.vmapiVms.fullVms[vm_uuid];
                    vm.state = 'destroyed';
                    vm.zone_state = 'destroyed';
                    vms[vm_uuid] = vm;
                } else {
                    assert.ok(false, 'VM must be either in vmapi or vmadm');
                }
            });

            cb();
        }, function _updateVmapiVms(stash, cb) {
            var startUpdate = (new Date()).getTime();

            if (Object.keys(vms).length === 0) {
                // Nothing to tell VMAPI! Success!
                self.log.info('No difference between vmadm and VMAPI, no need '
                    + 'for PUT /vms');
                cb();
                return;
            }

            self.log.debug({vms: Object.keys(vms)},
                'PUT /vms?server_uuid=' + self.server_uuid);
            self.vmapiClient.updateServerVms(self.server_uuid, vms,
                function _updateServerVmsCb(vmapiErr) {
                    var doneUpdate = (new Date()).getTime();

                    self.log.debug({
                        action: 'VMAPI.updateServerVms',
                        elapsed: (doneUpdate - startUpdate),
                        err: vmapiErr,
                        vmCount: Object.keys(vms).length
                    }, 'completed VMAPI.updateServerVms() for VmAgent() init');

                    cb(vmapiErr);
                }
            );
        }, function _updateLastSeen(stash, cb) {
            // We keep track of the last set of VMs we loaded any time we do a
            // full lookup so that when a VM is deleted we have the object's
            // properties to use in a PUT.
            self.lastSeenVms = stash.vmadmVms.fullVms;
            cb();
        }
    ]}, function _initialUpdateComplete(err) {
        if (err) {
            // On error we're going to get called again so cleanup intermediate
            // state.
            self.dirtyVms = [];
            self.watcher.stop();
        }
        callback(err);
    });
};

VmAgent.prototype.start = function start() {
    var self = this;

    vasync.pipeline({arg: {}, funcs: [
        function _setupWatcher(stash, cb) {
            self.setupWatcher();
            cb();
        }, function _initialUpdate(stash, cb) {
            var startUpdate = (new Date()).getTime();

            function _doInitialUpdate() {
                self.initialUpdate(function _initialUpdateCb(err) {
                    var doneUpdate;

                    if (err) {
                        self.log.warn(err, 'initial update failed, will try '
                            + 'again in ' + self.updateDelay + ' ms');
                        setTimeout(_doInitialUpdate, self.updateDelay);
                        self.updateDelay *= 2;
                        if (self.updateDelay > MAX_UPDATE_DELAY) {
                            self.updateDelay = MAX_UPDATE_DELAY;
                        }
                        return;
                    }

                    doneUpdate = (new Date()).getTime();

                    self.log.debug({
                        action: 'VMAPI.initialUpdate',
                        elapsed: (doneUpdate - startUpdate),
                        err: err
                    }, 'completed VMAPI.initialUpdate for VmAgent() init');

                    cb();
                });
            }

            _doInitialUpdate();
        }
    ]}, function _startCb(err) {
        assert.ifError(err, 'unexpected error in VmAgent.start');

        // uncork the update queue now that we're ready
        self.ready = true;

        // queue an update for all the VMs that were dirtied while during init.
        self.dirtyVms.forEach(function _queueDirtyVm(vm) {
            self.queueVm(vm);
        });

        self.log.info('startup complete');
    });
};

/*
 * This stops the running watchers, kills the queue and tries to ensure that
 * this VmAgent won't do more work and won't block the caller from shutting
 * down.
 *
 * It is not currently expected that you can call .start() again after stopping.
 */
VmAgent.prototype.stop = function stop() {
    var self = this;

    self.initializeProperties();
};

module.exports = VmAgent;
