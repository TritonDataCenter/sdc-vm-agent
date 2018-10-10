/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
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
 * double on each failure, up to some maximum value. (MAX_UPDATE_DELAY_MS)
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
 * to some maximum value (MAX_UPDATE_DELAY_MS) but the delay will be reset on a
 * sucessful update.
 *
 *
 * Important Notes
 * ===============
 *
 * VMs which have the 'do_not_inventory' property set will be ignored. If they
 * are created with do_not_inventory from the beginning, they should never be
 * sent by vm-agent, if the do_not_inventory flage is added to an existing VM,
 * we will not send any updates for this VM.
 *
 */

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var cueball = require('cueball');
var diff = require('deep-diff').diff;
var vasync = require('vasync');
var vmadm = require('vmadm');

var determineEventSource = require('./event-source');
var VmWatcher = require('./vm-watcher');
var VMAPI = require('./vmapi-client');


// After a DNI VM is deleted, how long to wait before purging our knowledge that
// it was a DNI VM? (in ms). We need to delay before purging these because we
// may get multiple delete events from the watcher and if we've already purged
// from knownDniVms, we'll not know that this one should be ignored.
var DNI_PURGE_DELAY_MS = 5 * 60 * 1000; // eslint-disable-line

// initial and maximum values to delay between VMAPI retries. (in ms)
var INITIAL_UPDATE_DELAY_MS = 500;
var MAX_UPDATE_DELAY_MS = 30000;


function VmAgent(options) {
    var self = this;
    var agent;
    var packageJson = path.join(path.dirname(__dirname), 'package.json');
    var userAgent;

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalNumber(options.periodic_interval,
        'options.periodic_interval');
    assert.uuid(options.server_uuid, 'options.server_uuid');
    assert.string(options.vmapi_url, 'options.vmapi_url');
    assert.optionalObject(options.cueballHttpAgent, 'options.cueballHttpAgent');

    self.vmadm = options.vmadm ? options.vmadm : vmadm;

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

    if (options.cueballHttpAgent) {
        agent = new cueball.HttpAgent(options.cueballHttpAgent);
    }

    userAgent = 'vm-agent/' + self.version
        + ' (node/' + process.versions.node + ')'
        + ' server/' + self.server_uuid;

    self.vmapiClient = new VMAPI({
        agent: agent,
        log: options.log,
        url: options.vmapi_url,
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

    // NOTE: we don't cleanup the self.watcher here because we want to continue
    // to get events from it.

    // vasync doesn't allow us to clear a queue, so kill and create a new one.
    if (self.queue) {
        self.queue.kill();
    }

    self.queue = vasync.queue(function _updateVmapiVm(vmUuid, callback) {
        // closure so self is correct here
        if (!self.ready) {
            callback();
            return;
        }
        self.updateVmapiVm(vmUuid, callback);
    }, 1);

    // set values to defaults
    self.updateDelay = INITIAL_UPDATE_DELAY_MS;
    self.dirtyVms = [];
    self.retryDelays = {};
    self.ready = false;
    self.lastSeenVms = {};
    self.lastPutVms = {};
    self.knownDniVms = {};
};

VmAgent.prototype.updateVmapiVm = function updateVmapiVm(vmUuid, callback) {
    var self = this;

    assert.uuid(vmUuid, 'vmUuid');
    assert.func(callback, 'callback');
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
            var opts = {log: self.log, uuid: vmUuid, include_dni: true};
            var startLoad = (new Date()).getTime();

            function _handleLoadErr(_vmUuid, err, next) {
                var loadErr;

                if (err && err.restCode === 'VmNotFound') {
                    if (self.knownDniVms[_vmUuid]) {
                        // DNI VM was deleted, we don't send this to VMAPI but
                        // we do want to purge it from the list after some delay
                        // in case other delete events are emitted, we still
                        // need to know that this was DNI.
                        if (!self.knownDniVms[_vmUuid].timer) {
                            self.knownDniVms[_vmUuid].timer = setTimeout(
                                function _purgeDeletedDNI() {
                                    self.log.debug({vmUuid: _vmUuid},
                                        'purging DNI knowledge');
                                    delete self.knownDniVms[_vmUuid];
                                },
                                DNI_PURGE_DELAY_MS
                            ).unref();
                        }
                        loadErr = new Error('deleted VM had do_not_inventory');
                        loadErr.restCode = 'VmNotInventoriable';
                        self.log.warn({vmUuid: _vmUuid},
                            'ignoring deleted VM with do_not_inventory');
                    } else if (self.lastSeenVms.hasOwnProperty(_vmUuid)) {
                        //
                        // We need the VM to have been seen either when it was
                        // created, or when we initially started up. Otherwise,
                        // we don't have the VM object to post to VMAPI. If we
                        // don't have a VM object we can't tell VMAPI anything
                        // about this VM.
                        //
                        // There are two known cases where we can get into this
                        // situation. Both involve the VM being deleted soon
                        // after creation, while we're still trying to load it.
                        //
                        // If we hit either of these cases, an operator can do
                        // a:
                        //
                        //  GET /vms?sync=true
                        //
                        // on VMAPI to fix any inconsistency.
                        //
                        //
                        // Case 1) Destroy job through the APIs
                        //
                        // In this case, a Destroy was sent soon after a Create
                        // and somehow we were unable to load the new VM
                        // (possibly missed sysevent delayed our noticing the
                        // VM) before it had been destroyed. In this scenario,
                        // the Destroy job if it succeeded should have marked
                        // the VM as destroyed in VMAPI. So the fact that we
                        // can't do that will only matter in the case the
                        // destroy job had a bug.
                        //
                        //
                        // Case 2) Destroy happened locally via vmadm or similar
                        //
                        // In this case a VM was destroyed manually by an
                        // operator without using the APIs and we could not load
                        // the VM after creation but before the VM was
                        // destroyed.
                        //
                        // If this VM was created through the APIs, the Operator
                        // is working outside the system by deleting it and is
                        // therefore also responsible for ensuring VMAPI data
                        // makes sense.
                        //
                        // Alternatively, if the VM was created manually by the
                        // operator without the APIs (e.g. vmadm create) and
                        // disappeared before we were able to load it, it should
                        // never have been in VMAPI anyway, so there's no point
                        // in trying to update VMAPI about it. The only way
                        // manually created VMs get to VMAPI is if we notice
                        // them and notify VMAPI.
                        //
                        //
                        // The reason we won't update VMAPI in either of these
                        // cases is that the way we update VMAPI is by doing a
                        // PUT on the VM which replaces all existing fields.
                        // Since our load failed, the only information we have
                        // about the VM is:
                        //
                        //  * the uuid
                        //  * the server_uuid
                        //  * the fact that it was destroyed
                        //
                        // If VMAPI has any more information than we do
                        // (importantly owner_uuid, billing_id, etc) we don't
                        // want to wipe that information out (since we don't
                        // have it to include in our PUT). The most benefit we
                        // would get from the PUT in this case is setting the
                        // state to destroyed, but that should already happen
                        // unless there are bugs or manual intervention as
                        // outlined above. As such, we ignore the VM here and
                        // leave the state update to other processes.
                        //
                        self.lastSeenVms[_vmUuid].state = 'destroyed';
                        self.lastSeenVms[_vmUuid].zone_state = 'destroyed';
                        stash.vmobj = self.lastSeenVms[_vmUuid];
                    } else {
                        self.log.warn({vmUuid: _vmUuid}, 'no VM object for VM '
                            + _vmUuid + ' and no longer exists.');

                        loadErr = new Error('VM no longer exists');
                        loadErr.restCode = 'VmCreationMissed';
                    }

                    next(loadErr);
                    return;
                }

                // Not an err we know how to handle, pass back up the chain
                next(err);
                return;
            }

            self.vmadm.load(opts, function _onVmLoad(err, vmobj) {
                var doneLoad = (new Date()).getTime();
                var loadErr;

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

                self.log.trace({vmUuid: vmUuid, vmobj: vmobj},
                    'vmadm.load results');

                if (err) {
                    _handleLoadErr(vmUuid, err, cb);
                    return;
                } else if (vmobj.do_not_inventory) {
                    loadErr = new Error('VM has do_not_inventory set');
                    loadErr.restCode = 'VmNotInventoriable';
                    self.log.warn({vmUuid: vmUuid},
                        'ignoring VM with do_not_inventory');
                    self.knownDniVms[vmUuid] = {};
                    cb(loadErr);
                    return;
                }

                // no error, so we must have a VM object, and it's not DNI
                assert.object(vmobj, 'vmobj');
                delete self.knownDniVms[vmUuid];

                self.lastSeenVms[vmUuid] = vmobj;
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

            assert.object(stash.vmobj, 'stash.vmobj');

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
        var ignore = false;

        // We don't sent updates for VMs that have do_not_inventory set or which
        // disappeared while loading.
        if (err && [
            'VmCreationMissed',
            'VmNotInventoriable'
        ].indexOf(err.restCode) !== -1) {
            ignore = true;
        }

        if (ignore || !err || !self.ready) {
            // on success or if we're ignoring this VM, we clear the retryDelay
            // for next time.
            if (self.retryDelays[vmUuid]) {
                clearTimeout(self.retryDelays[vmUuid].timer);
                delete self.retryDelays[vmUuid];
            }

            callback();
            return;
        }

        self.log.warn({err: err, vmUuid: vmUuid},
            'update failed, scheduling retry');
        self.scheduleRetryUpdate(vmUuid);

        callback(err);
    });
};

/*
 * This is called when a VM has failed an update. It is responsible for waiting
 * for (and incrementing) the delay and then re-queuing the update if there's
 * not already a timer doing the same thing.
 */
VmAgent.prototype.scheduleRetryUpdate = function scheduleRetryUpdate(vmUuid) {
    var self = this;
    var delay;

    assert.uuid(vmUuid, 'vmUuid');

    if (self.retryDelays[vmUuid] && self.retryDelays[vmUuid].timer) {
        // Had an error, but we also already have a timer, so don't start
        // another one, or increment the delay.
        return;
    }

    // On any error when we don't already have a timer running, we set a
    // timer to re-queue the VM. This is always safe since in the worst
    // case we do an extra update with the latest data.
    if (!self.retryDelays[vmUuid]) {
        self.retryDelays[vmUuid] = {delay: INITIAL_UPDATE_DELAY_MS};
    }
    delay = self.retryDelays[vmUuid].delay;

    // Increment for next time.
    self.retryDelays[vmUuid].delay *= 2;
    if (self.retryDelays[vmUuid].delay > MAX_UPDATE_DELAY_MS) {
        self.retryDelays[vmUuid].delay = MAX_UPDATE_DELAY_MS;
    }

    self.log.trace('scheduling retry for ' + vmUuid + ' in ' + delay + ' ms');
    self.retryDelays[vmUuid].timer = setTimeout(function _delayedRetry() {
        if (self.retryDelays[vmUuid]) {
            delete self.retryDelays[vmUuid].timer;
        }
        self.queueVm(vmUuid);
    }, delay);
};

/*
 * The fact that we use this queue serially has the additional advantage
 * currently of debouncing updates that are coming in frequently. For example if
 * a VM is under heavy modification and posting 'modify' events multiple times
 * per second, most of the time we'll never have more than one update pending in
 * the queue.
 */
VmAgent.prototype.queueVm = function queueVm(vmUuid) {
    var self = this;
    var alreadyQueued = false;
    var queueIdx;

    assert.uuid(vmUuid, 'vmUuid');

    // If we don't already have a queued update for this VM, queue one.
    //
    // NOTE: the queue.queued does not include any vmUuid that is currently
    // being processed, which is fine because we may be past the lookup and
    // in the waiting for VMAPI phase. We need to update again when we can.
    //
    for (queueIdx in self.queue.queued) {
        if (self.queue.queued[queueIdx].task === vmUuid) {
            alreadyQueued = true;
        }
    }
    if (!alreadyQueued) {
        self.queue.push(vmUuid);
    }
};

VmAgent.prototype.setupWatcher = function setupWatcher(callback) {
    var self = this;

    assert.func(callback, 'callback');

    function _onVmEvent(vmUuid, name, watcher) {
        assert.uuid(vmUuid, 'vmUuid');
        assert.string(name, 'name');
        assert.string(watcher, 'watcher');

        self.log.debug('Saw ' + name + ': ' + vmUuid
            + (watcher ? ' [' + watcher + ']' : ''));

        // During initialization we store the set of VMs that need updates
        // in self.dirtyVms and will add those to the queue when initialization
        // is complete.
        if (!self.ready) {
            if (self.dirtyVms.indexOf(vmUuid) === -1) {
                self.dirtyVms.push(vmUuid);
            }
            return;
        }

        self.queueVm(vmUuid);
    }

    determineEventSource({log: self.log, vmadm: self.vmadm},
        function determinedEventSource(err, eventSource) {
            if (err) {
                callback(err);
                return;
            }

            // Setup the watcher that will notice VM changes and add to the
            // update-to-VMAPI queue.
            self.log.info('determined best eventSource: %s', eventSource);

            self.watcher = new VmWatcher({
                log: self.log,
                eventSource: eventSource,
                vmadm: self.vmadm,
                periodicInterval: self.periodicInterval // may be undefined
            });

            self.watcher.on('VmCreated', function _onCreate(vmUuid, watcher) {
                assert.uuid(vmUuid, 'vmUuid');
                assert.string(watcher, 'watcher');
                _onVmEvent(vmUuid, 'create', watcher);
            });

            self.watcher.on('VmModified', function _onModify(vmUuid, watcher) {
                assert.uuid(vmUuid, 'vmUuid');
                assert.string(watcher, 'watcher');
                _onVmEvent(vmUuid, 'modify', watcher);
            });

            self.watcher.on('VmDeleted', function _onDelete(vmUuid, watcher) {
                assert.uuid(vmUuid, 'vmUuid');
                assert.string(watcher, 'watcher');
                _onVmEvent(vmUuid, 'delete', watcher);
            });

            callback();
        }
    );

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

    assert.object(vmobj, 'vmobj');
    assert.array(fields, 'fields');
    assert.string(source, 'source');

    for (fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
        field = fields[fieldIdx];

        if (vmobj.hasOwnProperty(field)) {
            if (source === 'vmapi' &&
                VMAPI.VMAPI_ALWAYS_SET_FIELDS.hasOwnProperty(field) &&
                !diff(VMAPI.VMAPI_ALWAYS_SET_FIELDS[field], vmobj[field])) {
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

    assert.func(callback, 'callback');

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

                    // if there was no error, vmobjs must be an array
                    assert.arrayOfObject(vmobjs, 'vmobjs');

                    stash.vmapiVms = {
                        compareVms: {},
                        fullVms: {}
                    };

                    // vmobjs is an array of VM objects
                    for (vmIdx = 0; vmIdx < vmobjs.length; vmIdx++) {
                        stash.vmapiVms.fullVms[vmobjs[vmIdx].uuid]  =
                            vmobjs[vmIdx];
                        stash.vmapiVms.compareVms[vmobjs[vmIdx].uuid] =
                            makeComparable(vmobjs[vmIdx],
                            self.comparisonFields, 'vmapi');
                    }
                    cb();
                }
            );
        }, function _startWatcher(_stash, cb) {
            /*
             * Just before we do the vmadm lookup we start the watcher which
             * will be dumping changed VMs into the queue. We start it here to
             * avoid a race where things change during or just after the vmadm
             * lookup we're about to do. If something fails in the
             * initialization here and we're going to do a new loop, we stop
             * the watcher and clear the existing queue.
             */
            self.watcher.start(cb);
        }, function _getVmadmVms(stash, cb) {
            var ALL_VMS = {}; // no filter means: grab them all
            var opts = {log: self.log, include_dni: true};
            var startLookup = (new Date()).getTime();

            // NOTE: vmadm.lookup handles filtering out the do_not_inventory VMs
            self.vmadm.lookup(ALL_VMS, opts, function _onLookup(err, vmobjs) {
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

                // if there was no error, vmobjs must be an array
                assert.arrayOfObject(vmobjs, 'vmobjs');

                stash.vmadmVms = {
                    compareVms: {},
                    fullVms: {}
                };

                // vmobjs is an array of VM objects
                for (vmIdx = 0; vmIdx < vmobjs.length; vmIdx++) {
                    if (vmobjs[vmIdx].do_not_inventory) {
                        // Keep track of the fact that this VM is DNI in case
                        // it's deleted later.
                        self.knownDniVms[vmobjs[vmIdx].uuid] = {};
                    } else {
                        // not DNI, so include in the list
                        stash.vmadmVms.fullVms[vmobjs[vmIdx].uuid] =
                            vmobjs[vmIdx];
                        stash.vmadmVms
                            .compareVms[vmobjs[vmIdx].uuid] = makeComparable(
                                vmobjs[vmIdx], self.comparisonFields, 'vmadm');
                    }
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
                assert.object(diffobj, 'diffobj');
                assert.array(diffobj.path, 'diffobj must have path');
                assert.uuid(diffobj.path[0], 'diffobj.path[0] must be uuid: '
                    + diffobj.path[0]);
                if (updateVms.indexOf(diffobj.path[0]) === -1) {
                    updateVms.push(diffobj.path[0]);
                }
            });

            updateVms.forEach(function _updateCb(vmUuid) {
                assert.uuid(vmUuid);

                if (stash.vmadmVms.fullVms.hasOwnProperty(vmUuid)) {
                    vms[vmUuid] = stash.vmadmVms.fullVms[vmUuid];
                } else if (stash.vmapiVms.fullVms.hasOwnProperty(vmUuid)) {
                    // VM exists in VMAPI but not locally, so update state
                    vm = stash.vmapiVms.fullVms[vmUuid];
                    vm.state = 'destroyed';
                    vm.zone_state = 'destroyed';
                    vms[vmUuid] = vm;
                } else {
                    assert.ok(false, 'VM must be either in vmapi or vmadm');
                }
            });

            cb();
        }, function _updateVmapiVms(_stash, cb) {
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

            // Stop the watcher since we failed and will restart it again on
            // the next loop, but don't wipe out the listeners we setup via
            // self.setupWatcher() from VmAgent.prototype.start().
            self.watcher.stop({keepListeners: true});
        }
        callback(err);
    });
};

VmAgent.prototype.start = function start(callback) {
    var self = this;

    assert.optionalFunc(callback, 'callback');

    vasync.pipeline({arg: {}, funcs: [
        function _setupWatcher(_stash, cb) {
            // initialize the watcher if we've not already done so
            if (self.watcher) {
                cb();
                return;
            }

            self.setupWatcher(cb);
        }, function _initialUpdate(_stash, cb) {
            var startUpdate = (new Date()).getTime();

            function _doInitialUpdate() {
                self.initialUpdate(function _initialUpdateCb(err) {
                    var doneUpdate;

                    if (err) {
                        self.log.warn(err, 'initial update failed, will try '
                            + 'again in ' + self.updateDelay + ' ms');

                        setTimeout(_doInitialUpdate, self.updateDelay);
                        self.updateDelay *= 2;
                        if (self.updateDelay > MAX_UPDATE_DELAY_MS) {
                            self.updateDelay = MAX_UPDATE_DELAY_MS;
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
        if (callback) {
            callback();
            return;
        }
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

    if (self.watcher) {
        self.watcher.stop();
        self.watcher = null;
    }
    self.initializeProperties();
};

module.exports = VmAgent;
