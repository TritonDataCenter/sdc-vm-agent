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
 * CN. Except in case of errors, operations performed on the CN through APIs
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
 *
 * General Theory of Operation
 * ===========================
 *
 * On startup vm-agent will begin watching for VM changes on the local CN. When
 * a change occurs, the modified VM's uuid is placed in a queue. Objects will be
 * processed from the queue and PUT into VMAPI. This watcher is started first in
 * order that changes occuring while we're doing the initial update are not
 * missed. Once the initial update is complete the queue will be started.
 *
 * On startup vm-agent must also let VMAPI know the current state of the VMs on
 * this CN. Since vm-agent does not store state about what it has already told
 * VMAPI, it must update the state for all VMs on the CN. Because VMAPI may have
 * VMs that no longer exist on this CN, we need to gather VMAPIs view of the set
 * of VMs that belong on this CN in order that we can correct it.
 *
 * Having gathered the set of VMs VMAPI expects on the CN, that list must be
 * compared against the list of VMs actually on the CN. The classes of VM
 * are:
 *
 *  a) Has the same values on both VMAPI and the CN (nothing to do)
 *
 *      - nothing is done
 *
 *  b) Has different values in VMAPI and the CN (need to update VMAPI)
 *
 *      - the VMAPI values will be PUT to VMAPI
 *
 *  c) Exists in VMAPI but not on the CN (needs to be marked destroyed in VMAPI)
 *
 *      - The object from VMAPI will be taken and the 'state' and 'zone_state'
 *        fields will be set to to 'destroyed'. The resulting object will be PUT
 *        into VMAPI. It is necessary to use the object received from VMAPI
 *        because the VM no longer exists locally.
 *
 *  d) Exists on the CN but not in VMAPI (needs to be put to VMAPI)
 *
 *      - the VMAPI values will be PUT to VMAPI
 *
 * There is an additional special case and that is where a VM has
 * 'do_not_inventory' set. This flag tells us that we should treat the VM as
 * though it does not exist on this CN. As such, vm-agent will behave as though
 * it were not in the list when loading the set of local VMs.
 *
 * Once all the objects are compared, vm-agent builds a single array which it
 * will pass to VMAPI through 'PUT /vms?server_uuid=<this CN's server_uuid>'.
 *
 * Once the initial update has been sent, vm-agent begins processing the queue
 * of updates. These are processed by taking a uuid off the queue and loading
 * the *current* state of that VM and immediately attempting to put the state
 * to VMAPI. In the case of 'delete' events, we will read the current object
 * from the in-memory cache of vm-agent and send that with the 'state' and
 * 'zone_state' fields set to 'destroyed'. If there are problems with the
 * update, the uuid is re-queued with just the uuid so that we will gather the
 * latest data when it is retried later.
 *
 */

var assert = require('assert-plus');
var diff = require('deep-diff').diff;
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');
var vmadm = require('vmadm');
var VmWatcher = require('../lib/vm-watcher').VmWatcher;
var VMAPI = require('./vmapi-client');

// initial and maximum values to delay between VMAPI retries. (in ms)
var INITIAL_UPDATE_DELAY = 500;
var MAX_UPDATE_DELAY = 30000;

/*
 * NOTE: VMAPI doesn't show us:
 *
 * 'zfs_data_recsize',
 * 'zfs_root_recsize',
 * 'zoneid'
 *
 * otherwise these would be on the list.
 *
 * XXX compare to vmwatcher's PERIODIC_FIELDS
 */
var COMPARISON_FIELDS = [
    'boot_timestamp',
    'brand',
    'datasets',
    'disks',
    'indestructible_delegated',
    'indestructible_zoneroot',
    'last_modified',
    'pid',
    'quota',
    'snapshots',
    'state',
    'uuid',
    'zfs_data_compression',
    'zfs_root_compression',
    'zone_state'
];

function VmAgent(options) {
    var self = this;
    var packageJson = path.dirname(__dirname) + '/package.json';
    var userAgent;

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.uuid(options.server_uuid, 'options.server_uuid');
    assert.string(options.url, 'options.url');

    // For tests we want to be able to mock out vmadm/vmapi/vmwatcher
    assert.optionalObject(options.vmadm, 'options.vmadm');
    assert.optionalFunc(options.vmapi, 'options.vmapi');
    assert.optionalFunc(options.vmwatcher, 'options.vmwatcher');
    if (options.vmadm) {
        vmadm = options.vmadm;
    }
    if (options.vmapi) {
        VMAPI = options.vmapi;
    }
    if (options.vmwatcher) {
        VmWatcher = options.vmwatcher;
    }

    self.options = options;
    self.log = options.log;
    self.server_uuid = options.server_uuid;
    self.version = JSON.parse(fs.readFileSync(packageJson)).version;

    self.updateDelay = INITIAL_UPDATE_DELAY;

    assert(self.version, 'missing package.json version');

    userAgent = 'vm-agent/' + self.version
        + ' (node/' + process.versions.node + ')'
        + ' server/' + self.server_uuid;

    self.vmapiClient = new VMAPI({
        url: options.url,
        log: options.log,
        userAgent: userAgent
    });

    // This is the queue for VM updates
    self.queue = vasync.queue(function _updateVmapiVm(vm_uuid, callback) {
        // closure so self is correct here
        self.updateVmapiVm(vm_uuid, callback);
    }, 1);

    // This is used during initialization to store VMs we need to add to the
    // queue once initialization has completed.
    self.dirtyVms = [];

    // This is used when a PUT fails to keep track of a delay for retries.
    self.retryDelays = {};

    // Until we have sent our initial update to VMAPI, we don't want to process
    // other changes locally. This will be set true when we're ready.
    self.initializationComplete = false;
}

VmAgent.prototype.updateVmapiVm = function (vm_uuid, callback) {
    var self = this;

    self.log.info({initComplete: self.initializationComplete}, 'WTF');
    assert.equal(self.initializationComplete, true,
        'must not do updates until init complete');

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

                self.log.debug({
                    action: 'vmadm.load',
                    elapsed_ms: (doneLoad - startLoad),
                    err: err
                }, 'completed vmadm.load() for updateVmapiVm()');

                if (err && err.restCode === 'VmNotFound') {
                    assert.ok(self.lastSeenVms.hasOwnProperty(vm_uuid),
                        'VM must have been seen before.');

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

            assert.object(stash.vmobj, 'require VM object');

            self.vmapiClient.updateVm(stash.vmobj, function _onVmUpdate(err) {
                var doneUpdate = (new Date()).getTime();

                self.log.debug({
                    action: 'VMAPI.updateVm',
                    elapsed_ms: (doneUpdate - startUpdate),
                    err: err
                }, 'completed VMAPI.updateVm() for updateVmapiVm()');

                cb(err);
            });
        }
    ]}, function _updateVmComplete(err) {
        var delay;

        if (err) {
            // On any error, we re-queue the VM. This is always safe since in
            // the worst case we do an extra update with the latest data.
            delay = (self.retryDelays[vm_uuid] || INITIAL_UPDATE_DELAY);
            self.log.warn({err: err, vm_uuid: vm_uuid}, 'update failed, will '
                + 'try again in ' + delay + ' ms');
            setTimeout(function () {
                self.queueVm(vm_uuid);
                self.retryDelays[vm_uuid] *= 2;
                if (self.retryDelays[vm_uuid] > MAX_UPDATE_DELAY) {
                    self.retryDelays[vm_uuid] = MAX_UPDATE_DELAY;
                }
            }, delay);
        } else {
            // on success we clear the retryDelay for next time.
            delete self.retryDelays[vm_uuid];
        }

        callback(err);
    });
};

VmAgent.prototype.queueVm = function (vm_uuid) {
    var self = this;
    var alreadyQueued = false;
    var queueIdx;

    // If we don't already have a queued update for this VM, queue one.
    for (queueIdx in self.queue.queued) {
        if (self.queue.queued[queueIdx].task === vm_uuid) {
            alreadyQueued = true;
        }
    }
    if (!alreadyQueued) {
        self.queue.push(vm_uuid);
    }
};

VmAgent.prototype.setupWatcher = function () {
    var self = this;

    // Setup the watcher that will notice VM changes and add to the
    // update-to-VMAPI queue.
    self.watcher = new VmWatcher({log: self.log});

    function _onVmEvent(vm_uuid, name) {
        self.log.debug('Saw ' + name + ': ' + vm_uuid);

        // During initialization we store the set of VMs that need updates
        // in self.dirtyVms and will add those to the queue when initialization
        // is complete.
        if (!self.initializationComplete) {
            if (self.dirtyVms.indexOf(vm_uuid) === -1) {
                self.dirtyVms.push(vm_uuid);
            }
            return;
        }

        self.queueVm(vm_uuid);
    }

    self.watcher.on('VmCreated', function _onCreate(vm_uuid) {
        _onVmEvent(vm_uuid, 'create');
    });

    self.watcher.on('VmModified', function _onModify(vm_uuid) {
        _onVmEvent(vm_uuid, 'modify');
    });

    self.watcher.on('VmDeleted', function _onDelete(vm_uuid) {
        _onVmEvent(vm_uuid, 'delete');
    });

    // NOTE: watcher gets started as part of initialUpdate
};

// XXX needs a better name, too complex?
function vmobjsToArrays(vmobjs, source) {
    var field;
    var fieldIdx;
    var results = {
        compareVms: {},
        fullVms: {}
    };
    var vmIdx;
    var vmobj;

    for (vmIdx in vmobjs) {
        vmobj = {};

        for (fieldIdx in COMPARISON_FIELDS) {
            field = COMPARISON_FIELDS[fieldIdx];
            if (vmobjs[vmIdx].hasOwnProperty(field)) {
                vmobj[field] = vmobjs[vmIdx][field];
            }
        }

        if (source === 'vmapi') {
            /*
             * VMAPI always includes some fields, even when unset. So we
             * remove those here so that the comparison can work.
             */
            if (vmobj.datasets && vmobj.datasets.length === 0) {
                delete vmobj.datasets;
            }
        }

        results.compareVms[vmobj.uuid] = vmobj;
        results.fullVms[vmobj.uuid] = vmobjs[vmIdx];
    }

    return (results);
}

// XXX: rename to initialize?
VmAgent.prototype.initialUpdate = function (callback) {
    var self = this;
    var vmapiPut = {vms: {}};

    vasync.pipeline({arg: {}, funcs: [
        function (stash, cb) {
            var startLookup = (new Date()).getTime();

            self.vmapiClient.getVms(self.server_uuid, function (err, vmobjs) {
                var doneLookup = (new Date()).getTime();

                self.log.debug({
                    action: 'VMAPI.lookup',
                    elapsed_ms: (doneLookup - startLookup),
                    err: err,
                    vmCount: (vmobjs ? Object.keys(vmobjs).length : 0)
                }, 'completed VMAPI.lookup() for VmAgent() init');

                if (err) {
                    cb(err);
                    return;
                }

                stash.vmapiVms = vmobjsToArrays(vmobjs, 'vmapi');
                cb();
            });
        }, function (stash, cb) {
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
        }, function (stash, cb) {
            var ALL_VMS = {}; // no filter means: grab them all
            var opts = {log: self.log};
            var startLookup = (new Date()).getTime();

            // NOTE: vmadm.lookup handles filtering out the do_not_inventory VMs
            vmadm.lookup(ALL_VMS, opts, function _onLookup(err, vmobjs) {
                var doneLookup = (new Date()).getTime();

                self.log.debug({
                    action: 'vmadm.lookup',
                    elapsed_ms: (doneLookup - startLookup),
                    err: err,
                    vmCount: (vmobjs ? Object.keys(vmobjs).length : 0)
                }, 'completed vmadm.lookup() for VmAgent() init');

                if (err) {
                    cb(err);
                    return;
                }

                stash.vmadmVms = vmobjsToArrays(vmobjs, 'vmadm');
                cb();
            });
        }, function (stash, cb) {
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
                    vmapiPut.vms[vm_uuid] = stash.vmadmVms.fullVms[vm_uuid];
                } else if (stash.vmapiVms.fullVms.hasOwnProperty(vm_uuid)) {
                    // VM exists in VMAPI but not locally, so update state
                    vm = stash.vmapiVms.fullVms[vm_uuid];
                    vm.state = 'destroyed';
                    vm.zone_state = 'destroyed';
                    vmapiPut.vms[vm_uuid] = vm;
                } else {
                    assert.ok(false, 'VM must be either in vmapi or vmadm');
                }
            });

            cb();
        }, function (stash, cb) {
            var startUpdate = (new Date()).getTime();

            if (Object.keys(vmapiPut.vms).length === 0) {
                // Nothing to tell VMAPI! Success!
                self.log.info('No difference between vmadm and VMAPI, no need '
                    + 'for PUT /vms');
                cb();
                return;
            }

            self.log.debug({vmapiPut: vmapiPut}, 'PUT');
            self.vmapiClient.updateServerVms(self.server_uuid, vmapiPut,
                function (vmapiErr) {
                    var doneUpdate = (new Date()).getTime();

                    self.log.debug({
                        action: 'VMAPI.updateServerVms',
                        elapsed_ms: (doneUpdate - startUpdate),
                        err: vmapiErr,
                        vmCount: Object.keys(vmapiPut.vms).length
                    }, 'completed VMAPI.updateServerVms() for VmAgent() init');

                    cb(vmapiErr);
                }
            );
        }, function (stash, cb) {
            // We keep track of the last set of VMs we loaded any time we do a
            // full lookup so that when a VM is deleted we have the object's
            // properties to use in a PUT.
            self.lastSeenVms = stash.vmadmVms.fullVms;
            cb();
        }
    ]}, function (err) {
        if (err) {
            // On error we're going to get called again so cleanup intermediate
            // state.
            self.dirtyVms = [];
            self.watcher.stop();
        }
        callback(err);
    });
};

VmAgent.prototype.start = function () {
    var self = this;

    vasync.pipeline({arg: {}, funcs: [
        function (stash, cb) {
            self.setupWatcher();
            cb();
        }, function (stash, cb) {
            var startUpdate = (new Date()).getTime();

            function _doInitialUpdate() {
                self.initialUpdate(function (err) {
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
                        elapsed_ms: (doneUpdate - startUpdate),
                        err: err
                    }, 'completed VMAPI.initialUpdate for VmAgent() init');

                    cb();
                });
            }

            _doInitialUpdate();
        }
    ]}, function (err) {
        assert.ifError(err, 'unexpected error in VmAgent.start');

        // TODO: is there some stuff we can free now?

        // uncork the update queue now that we're ready
        self.initializationComplete = true;

        // queue an update for all the VMs that were dirtied while during init.
        self.dirtyVms.forEach(self.queueVm);

        self.log.info('startup complete');
    });
};

VmAgent.prototype.stop = function () {
    // TODO
};

module.exports = VmAgent;
