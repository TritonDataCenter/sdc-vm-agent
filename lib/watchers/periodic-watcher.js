/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * This module exists to allow consumers to get events when VM changes occur on
 * a CN. It works by running 'vmadm lookup -j -o ...' periodically and comparing
 * the output for the set of fields defined. When a change is noticed, it calls
 * the opts.updateVm function that is passed in.
 *
 * This function is described in more detail in lib/vm-watcher.js.
 *
 */

var assert = require('assert-plus');
var diff = require('deep-diff').diff;


/*
 * To just detect whether there has been a change to a VM we don't need to load
 * all the fields each time. Any fields we don't load save some overhead in both
 * gathering and processing. Most updates will modify last_modified for the VM,
 * so as an optimization, we can avoid loading those fields that will always
 * result in a new last_modified. Instead we only load the last_modified field
 * itself, and those fields that can be updated independent of last_modified.
 * These include:
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
 *  - zfs_snapshot_limit
 *  - zone_state
 *  - zoneid
 *
 * We've removed zoneid and pid from this list as these will always change only
 * with an accompanying state change and high-resolution state change notices
 * are required there's another watcher for that. Additionally 'zoneid' and
 * zfs_data_recsize and 'zfs_root_recsize', are not visible in VMAPI.
 * 'zfs_root_compression' is also hidden in VMAPI, but there's ZAPI-714 for
 * fixing.
 *
 * So we grab all of the set of fields that are changing and visible in VMAPI,
 * along with 'last_modified' and the 'brand' and 'uuid' to identify the zone.
 *
 */
var PERIODIC_FIELDS = [
    'brand',
    'datasets',
    'disks',
    'indestructible_delegated',
    'indestructible_zoneroot',
    'last_modified',
    'quota',
    'snapshots',
    'state',
    'uuid',
    'zfs_data_compression',
    'zfs_snapshot_limit',
    'zone_state'
];
var PERIODIC_INTERVAL = 60000; // ms


function PeriodicWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalNumber(opts.periodicInterval, 'opts.periodicInterval');
    assert.func(opts.updateVm, 'opts.updateVm');
    assert.object(opts.vmadm, 'opts.vmadm');

    // Yay bunyan!
    self.log = opts.log.child({watcher: 'periodic-watcher'});

    self.updateVm = opts.updateVm;
    self.vmadm = opts.vmadm;

    if (opts.periodicInterval) {
        self.periodic_interval = opts.periodicInterval;
    } else {
        self.periodic_interval = PERIODIC_INTERVAL;
    }

    // FUTURE: maybe these should be configurable?
    self.periodic_fields = PERIODIC_FIELDS;
}

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
PeriodicWatcher.prototype.start = function start() {
    var self = this;
    var ALL_VMS = {}; // no filter means: grab them all

    self.disabled = false;

    function handleVmobjs(vmobjs, cb) {
        var idx;

        assert.arrayOfObject(vmobjs, 'vmobjs');
        assert.func(cb, 'cb');

        if (!self.knownVms) {
            // When we get the first sample, we only populate knownVms. The next
            // comparison will be against this initial list.

            self.knownVms = {};
            for (idx in vmobjs) {
                if (vmobjs.hasOwnProperty(idx)) {
                    self.knownVms[vmobjs[idx].uuid] = vmobjs[idx];
                }
            }
            cb();
            return;
        }

        compareVms(vmobjs, self.knownVms,
            function _changedVms(created, deleted, modified) {
                var changes;

                assert.arrayOfObject(created, 'created');
                assert.arrayOfObject(deleted, 'deleted');
                assert.arrayOfObject(modified, 'modified');

                changes = {
                    created: created.length,
                    deleted: deleted.length,
                    modified: modified.length
                };

                created.forEach(function _handleCreated(vm) {
                    self.updateVm(vm.uuid, 'create', vm);
                    self.knownVms[vm.uuid] = vm;
                });

                deleted.forEach(function _handleDeleted(vm) {
                    self.updateVm(vm.uuid, 'delete', {});
                    delete self.knownVms[vm.uuid];
                });

                modified.forEach(function _handleModified(vm) {
                    self.updateVm(vm.uuid, 'modify', vm);
                    self.knownVms[vm.uuid] = vm;
                });

                cb(null, changes);
            }
        );
    }

    function doLookup() {
        var lookupOpts = {
            fields: self.periodic_fields,
            log: self.log,
            include_dni: true
        };
        var start_lookup = (new Date()).getTime();

        // NOTE: vmadm.lookup handles filtering out the do_not_inventory VMs
        self.vmadm.lookup(ALL_VMS, lookupOpts,
            function _periodicLookupCb(err, vmobjs) {
                var done_lookup = (new Date()).getTime();

                self.log.debug({
                    action: 'vmadm.lookup',
                    elapsed_ms: done_lookup - start_lookup,
                    err: err,
                    vmCount: (vmobjs ? Object.keys(vmobjs).length : 0)
                }, 'completed vmadm.lookup()');

                if (err) {
                    // We're going to try again, so we just log the error for
                    // an operator and/or monitoring system to look into.
                    self.log.error(err, 'failed to vmadm.lookup()');

                    // schedule the next lookup
                    if (!self.disabled) {
                        self.periodicTimer =
                            setTimeout(doLookup, self.periodic_interval);
                    }
                } else {
                    handleVmobjs(vmobjs, function _handleVmobjs(e, changes) {
                        var done_handling = (new Date()).getTime();

                        if (changes && (changes.created > 0 ||
                            changes.deleted > 0 || changes.modified > 0)) {
                            // something changed
                            self.log.debug({
                                action: 'handleVmobjs',
                                changes: changes,
                                elapsed_ms: (done_handling - done_lookup),
                                err: e
                            }, 'finished handling VMs');
                        }

                        if (e) {
                            // We're going to try again, so we just log the
                            // error for an operator and/or monitoring system
                            // to look into.
                            self.log.error(e, 'handleVmobjs() failed');
                        }

                        // schedule the next lookup
                        if (!self.disabled) {
                            self.periodicTimer =
                                setTimeout(doLookup, self.periodic_interval);
                        }
                    });
                }
            }
        );
    }

    // kick off the first lookup
    doLookup();
};

PeriodicWatcher.prototype.stop = function stop() {
    var self = this;

    // prevent new timers from being created, then stop existing if there is one
    self.disabled = true;

    if (self.periodicTimer) {
        clearTimeout(self.periodicTimer);
    }
};

PeriodicWatcher.prototype.__testonly__ = {
    compareVms: compareVms,
    cmpVm: cmpVm
};

PeriodicWatcher.FIELDS = PERIODIC_FIELDS;

module.exports = PeriodicWatcher;
