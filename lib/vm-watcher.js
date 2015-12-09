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
 * In order to function vm-watcher uses some number of "watcher" submodules.
 * These watchers implement an interface where they have:
 *
 *  * a constructor that takes an 'opts' object that contains at least:
 *     * a 'log' bunyan logger
 *     * an 'updateVm' function (vmUuid, updateType, updateObj) where:
 *         * vmUuid is the VM that changed
 *         * updateType is one of: create, modify, delete
 *         * updateObj contains any fields we know to be changed by this update
 *  * a .start() method
 *  * a .stop() method
 *
 * After the .start() is called, these are expected to call the passed updateVm
 * function any time they see a change in the VMs on this CN and include any
 * modified properties they know about.
 *
 * For example, since the 'FsWatcher' watcher only watches for timestamp changes
 * on the zone's files, when it sees a create or modify event, the updateObj
 * will include only the 'last_modified' field and the value that it thinks
 * the object should have after this change.
 *
 * The VmWatcher object here keeps track of the current expected state of the
 * VMs so that it can attempt to avoid sending modifications twice when
 * different modules notice them. In the above example, when FsWatcher noticed
 * the 'last_modified' changed we would have updated our example object (in
 * self.knownVms) with the new last_modified value. If we get a subsequent
 * update from the PeriodicWatcher that only modifed last_modified and only set
 * it to the same value, this update can safely be ignored.
 *
 * The way consumers receive the events VmWatcher intends them to see is through
 * the EventEmitter interface. Callers can run:
 *
 *   vmWatcher = new VmWatcher({log: Logger});
 *   vmWatcher.on('VmCreated', function _onCreated(vm_uuid, watcher) {
 *       ...
 *   });
 *
 * in order to have their _onCreated function called whenever an change has
 * occurred. Possible events to watch are:
 *
 *   VmCreated
 *   VmModified
 *   VmDeleted
 *
 * For debugging the name of the watcher which saw the change is included as the
 * second argument to the event emitter listener.
 *
 *
 * FUTURE WORK:
 *
 *  - When vminfod is available, we should be able to use that watcher
 *    exclusively on those platforms, as vminfod already watches for all
 *    property changes.
 *
 */

var assert = require('assert-plus');
var diff = require('deep-diff').diff;
var EventEmitter = require('events').EventEmitter;
var FsWatcher = require('../lib/fs-watcher');
var PeriodicWatcher = require('../lib/periodic-watcher');
var util = require('util');


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
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.known_vms, 'opts.known_vms');

    // for periodic watcher
    assert.optionalArray(opts.periodic_fields, 'opts.periodic_fields');
    assert.optionalNumber(opts.periodic_interval, 'opts.periodic_interval');

    // Yay bunyan!
    self.log = opts.log;

    // This is used to try to avoid emitting the same event twice when just
    // noticed by different watchers. How it works is that when we see an update
    // via the updateVm() function, the watcher passes us a list of properties
    // it thinks should have changed. We can then update the entry for that VM
    // in knownVms so that further updates can be skipped if they just report
    // the same change.
    self.knownVms = {};

    self.fsWatcher = new FsWatcher({
        log: opts.log,
        updateVm: self.newUpdateHandler('fs')
    });

    self.periodicWatcher = new PeriodicWatcher({
        log: opts.log,
        periodic_fields: opts.periodic_fields,
        periodic_interval: opts.periodic_interval,
        updateVm: self.newUpdateHandler('periodic')
    });

    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(VmWatcher, EventEmitter);

/*
 * Update knownVm with the properties from updateObj if knownVm has no
 * last_modified or if knownVm.last_modified is older than the one in updateObj.
 *
 * Returns an array of the names of the properties that were updated in knownVm.
 */
function updateIfNewer(vmUuid, log, knownVm, updateObj) {
    var prop;
    var propIdx;
    var props;
    var updated = [];

    if (knownVm.last_modified && updateObj.last_modified
        && (knownVm.last_modified > updateObj.last_modified)) {
        // Special case: refuse to update to something with a last_modified
        // that's older than what we already have.
        log.warn({
            currentLastModified: knownVm.last_modified,
            proposedLastModified: updateObj.last_modified,
            vm: vmUuid
        }, 'Refusing to update VM ' + vmUuid + ' to older last_modified');

        return (updated);
    }

    // In case this "create" event has more properties than the previous one, we
    // update the properties of our object now that we've ensured last_modified
    // is monotonic.
    props = Object.keys(updateObj);
    for (propIdx = 0; propIdx < props.length; propIdx++) {
        prop = props[propIdx];
        // diff() returns undefined when the properties *are the same*
        if (diff(knownVm[prop], updateObj[prop])) {
            knownVm[prop] = updateObj[prop];
            updated.push(prop);
        }
    }

    return (updated);
}

VmWatcher.prototype.dispatchCreate = // eslint-disable-line
function dispatchCreate(vmUuid, updateVmobj, watcher) {
    var self = this;
    var updated;

    if (self.knownVms.hasOwnProperty(vmUuid)
        && self.knownVms[vmUuid].destroyed) {
        // The VM was previously, destroyed: delete since this is a new one.
        delete self.knownVms[vmUuid];
    }

    // We only emit if the VM did *not* previously exist. It might have been
    // noticed by a different watcher first for example.
    if (!self.knownVms.hasOwnProperty(vmUuid)) {
        self.emit('VmCreated', vmUuid, watcher);
        self.knownVms[vmUuid] = {};
    }

    updated = updateIfNewer(vmUuid, self.log, self.knownVms[vmUuid],
        updateVmobj);

    if (updated.length > 0) {
        self.log.trace({
            event: 'create',
            modifiedFields: updated,
            vm: vmUuid,
            watcher: watcher
        }, 'VM has changed');
    }
};

VmWatcher.prototype.dispatchModify = // eslint-disable-line
function dispatchModify(vmUuid, updateVmobj, watcher) {
    var self = this;
    var updated;

    if (!self.knownVms.hasOwnProperty(vmUuid)) {
        self.knownVms[vmUuid] = {};
    }

    if (self.knownVms[vmUuid].destroyed) {
        // We don't modify destroyed VMs. Wait for a create first.
        self.log.warn({
            updateVmobj: updateVmobj,
            vm: vmUuid,
            watcher: watcher
        }, 'Skipping modify for already destroyed VM ' + vmUuid);

        return;
    }

    updated = updateIfNewer(vmUuid, self.log, self.knownVms[vmUuid],
        updateVmobj);

    if (updated.length > 0) {
        self.log.trace({
            event: 'modify',
            modifiedFields: updated,
            vm: vmUuid,
            watcher: watcher
        }, 'VM has changed');

        self.emit('VmModified', vmUuid, watcher);
    }
};

VmWatcher.prototype.dispatchDelete = // eslint-disable-line
function dispatchDelete(vmUuid, updateVmobj, watcher) {
    var self = this;

    if (!self.knownVms.hasOwnProperty(vmUuid)) {
        self.knownVms[vmUuid] = {};
    }

    if (self.knownVms[vmUuid].destroyed) {
        // The VM was already destroyed
        self.log.warn({
            updateVmobj: updateVmobj,
            vm: vmUuid,
            watcher: watcher
        }, 'Skipping delete for already destroyed VM ' + vmUuid);

        return;
    }

    self.knownVms[vmUuid].destroyed = (new Date()).getTime();
    self.emit('VmDeleted', vmUuid, watcher);
};

VmWatcher.prototype.newUpdateHandler = function newUpdateHandler(watcher) {
    var self = this;

    return (function _updateHandler(vmUuid, updateType, updateObj) {
        if (updateType === 'create') {
            self.dispatchCreate(vmUuid, updateObj, watcher);
        } else if (updateType === 'modify') {
            self.dispatchModify(vmUuid, updateObj, watcher);
        } else if (updateType === 'delete') {
            self.dispatchDelete(vmUuid, updateObj, watcher);
        } else {
            throw (new Error('unknown update type: ' + updateType));
        }
    });
};

VmWatcher.prototype.start = function start() {
    var self = this;

    self.fsWatcher.start();
    self.periodicWatcher.start();
    // ... other watchers
};


VmWatcher.prototype.stop = function stop() {
    var self = this;

    self.fsWatcher.stop();
    self.periodicWatcher.stop();
    // ... other watchers

    self.removeAllListeners();
};

module.exports = VmWatcher;
