/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This module exists to allow consumers to get events when VM changes occur on
 * a CN. This is updated to work on all currently supported platform versions of
 * SDC.
 *
 * FUTURE WORK:
 *
 *  - when vminfod is available, set that up as a watcher and disable or make
 *    much less frequent the periodic watcher
 *
 */

var assert = require('assert-plus');
var diff = require('deep-diff').diff;
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var vmadm = require('vmadm');


/*
 * To just detect whether there has been a change to a VM we don't need to load
 * all the fields each time. Any fields we don't load save some overhead in both
 * gathering and processing. Most updates will modify last_modified for the VM,
 * so mostly it is the fields that don't which we need to load. These include:
 *
 *  - datasets
 *  - disks (refreservation,etc)
 *  - indestructible_delegated
 *  - indestructible_zoneroot
 *  - pid
 *  - quota
 *  - snapshots
 *  - state
 *  - zfs_data_compression
 *  - zfs_data_recsize
 *  - zfs_root_compression
 *  - zfs_root_recsize
 *  - zone_state
 *  - zoneid
 *
 * So we grab all of those along with 'last_modified' and the 'brand' and 'uuid'
 * to identify the zone.
 *
 */
var PERIODIC_FIELDS = [
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
    'zfs_data_recsize',
    'zfs_root_compression',
    'zfs_root_recsize',
    'zone_state',
    'zoneid'
];
var PERIODIC_INTERVAL = 5000; // ms


/*
 * The VmWatcher will emit these events:
 *
 * - VmCreated:   A VM has been created
 * - VmDestroyed: A VM has been destroyed
 * - VmModified:  A VM has been modified
 *
 * The first argument passed to the listener is the UUID of the VM that incurred
 * the event.
 *
 */
function VmWatcher(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalArray(opts.periodic_fields, 'opts.periodic_fields');
    assert.optionalNumber(opts.periodic_interval, 'opts.periodic_interval');
    assert.optionalObject(opts.known_vms, 'opts.known_vms');

    // Yay bunyan!
    this.log = opts.log;

    if (opts.periodic_fields) {
        this.periodic_fields = opts.periodic_fields;
    } else {
        this.periodic_fields = PERIODIC_FIELDS;
    }

    if (opts.periodic_interval) {
        this.periodic_interval = opts.periodic_interval;
    } else {
        this.periodic_interval = PERIODIC_INTERVAL;
    }

    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}

util.inherits(VmWatcher, EventEmitter);


VmWatcher.prototype.start = function start() {
    this.startPeriodicWatcher();
    // ... other watchers
};


VmWatcher.prototype.stop = function stop() {
    this.stopPeriodicWatcher();
    // ... other watchers

    this.removeAllListeners();
};


/*
 * Takes two VM objects, returns true if the VMs match, false otherwise.
 */
function cmpVm(a, b) {
    var _diff;

    // diff() returns undefined on equal, use []
    _diff = (diff(a, b) || []);

    if (_diff.length > 0) {
        return false;
    }

    return true;
}


/*
 * Takes an array of new VM objects (from vmadm lookup -j) and compares to an
 * object (knownVms) which includes a mapping of uuid => objects. It calls
 * callback with:
 *
 *     callback(created, deleted, modified)
 *
 * where all 3 arguments are arrays that contain a subset of VM objects
 * (possibly empty) from newList. For deleted VMs the objects will only contain
 * the uuid property.
 *
 */
function compareVms(newList, knownVms, callback) {
    var created = [];
    var deleted = [];
    var modified = [];
    var seenVms = {};

    assert.object(newList, 'newList');
    assert.object(knownVms, 'knownVms');
    assert.func(callback, 'callback');

    // loop through once to pull out VMs that have changed or are new
    newList.forEach(function _compareVm(vm) {
        if (knownVms.hasOwnProperty(vm.uuid)) {
            // check if modified
            if (!cmpVm(vm, knownVms[vm.uuid])) {
                modified.push(vm);
            }
        } else {
            created.push(vm);
        }

        seenVms[vm.uuid] = true;
    });

    // now try to find any that were deleted
    Object.keys(knownVms).forEach(function _findDeleted(vm_uuid) {
        if (!seenVms.hasOwnProperty(vm_uuid)) {
            // haven't seen, so it's gone!
            deleted.push({uuid: vm_uuid});
        }
    });

    callback(created, deleted, modified);
}


/*
 * The PeriodicWatcher periodically does a vmadm lookup to find changes. It
 * loads the current set of VMs and compares the loaded fields to the previous
 * known set. When VMs have been added, removed or modified we will emit an
 * event.
 *
 */
VmWatcher.prototype.startPeriodicWatcher = function startPeriodicWatcher() {
    var self = this;
    var ALL_VMS = {}; // no filter means: grab them all

    self.disablePeriodicWatcher = false;

    function handleVmobjs(vmobjs, cb) {
        var idx;

        if (!self.knownVms) {
            // When we get the first sample, we only populate knownVms. The next
            // comparison will be against this initial list.

            self.knownVms = {};
            for (idx in vmobjs) {
                self.knownVms[vmobjs[idx].uuid] = vmobjs[idx];
            }
            cb();
            return;
        }

        compareVms(vmobjs, self.knownVms,
            function _changedVms(created, deleted, modified) {
                var changes = {
                    created: created.length,
                    deleted: deleted.length,
                    modified: modified.length
                };

                created.forEach(function _handleCreated(vm) {
                    self.emit('VmCreated', vm.uuid);
                    self.knownVms[vm.uuid] = vm;
                });

                deleted.forEach(function _handleDeleted(vm) {
                    self.emit('VmDeleted', vm.uuid);
                    delete self.knownVms[vm.uuid];
                });

                modified.forEach(function _handleModified(vm) {
                    self.emit('VmModified', vm.uuid);
                    self.knownVms[vm.uuid] = vm;
                });

                cb(null, changes);
            }
        );
    }

    function doLookup() {
        var start_lookup = (new Date()).getTime();

        // NOTE: vmadm.lookup handles filtering out the do_not_inventory VMs
        vmadm.lookup(ALL_VMS, {fields: self.periodic_fields, log: self.log},
            function _periodicLookupCb(err, vmobjs) {
                var done_lookup = (new Date()).getTime();

                self.log.debug({
                    action: 'vmadm.lookup',
                    elapsed_ms: done_lookup - start_lookup,
                    err: err,
                    vmCount: (vmobjs ? Object.keys(vmobjs).length : 0)
                }, 'completed vmadm.lookup() for PeriodicWatcher()');

                if (err) {
                    // We're going to try again, so we just log the error for
                    // an operator and/or monitoring system to look into.
                    self.log.error(err, 'failed to vmadm.lookup()');

                    // schedule the next lookup
                    if (!self.disablePeriodicWatcher) {
                        self.periodicTimer
                            = setTimeout(doLookup, self.periodic_interval);
                    }
                } else {
                    handleVmobjs(vmobjs, function _handleVmobjs(e, changes) {
                        var done_handling = (new Date()).getTime();

                        if (changes && (changes.created > 0
                            || changes.deleted > 0 || changes.modified > 0)) {
                            // something changed
                            self.log.debug({
                                action: 'handleVmobjs',
                                changes: changes,
                                elapsed_ms: (done_handling - done_lookup),
                                err: e
                            }, 'finished handling VMs for PeriodicWatcher()');
                        }

                        if (e) {
                            // We're going to try again, so we just log the
                            // error for an operator and/or monitoring system
                            // to look into.
                            self.log.error(e, 'handleVmobjs() failed');
                        }

                        // schedule the next lookup
                        if (!self.disablePeriodicWatcher) {
                            self.periodicTimer
                                = setTimeout(doLookup, self.periodic_interval);
                        }
                    });
                }
            }
        );
    }

    // kick off the first lookup
    doLookup();
};


VmWatcher.prototype.stopPeriodicWatcher = function stopPeriodicWatcher() {
    var self = this;

    // prevent new timers from being created, then stop existing if there is one
    self.disablePeriodicWatcher = true;

    if (self.periodicTimer) {
        clearTimeout(self.periodicTimer);
    }
};

VmWatcher.prototype.__testonly__ = {
    compareVms: compareVms,
    cmpVm: cmpVm
};

/*
 * If a caller somehow has missed a 'VmDeleted' event, they may have a list of
 * VMs that includes a VM we have already marked as deleted. They will not
 * receive another such event from us, so this function allows a caller to pass
 * in a list of VMs they have and we'll let them know.
 *
 * Hmmm... is it a good idea?
 *
 *  - what about unexpected create/modified?
 *  - how do we know their object contains all the fields we care about?
 *
 * XXX
 */


module.exports = VmWatcher;
