/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
 *  - Add ability to watch for actions that cn-agent is currently performing
 *    and skip doing PUT's for those VMs in that window. This will allow us to
 *    avoid putting intermediate states. We then would also want a way to update
 *    our object at the same time that action completes since cn-agent will
 *    gather the VM object and the workflow will do a PUT.
 *
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var diff = require('deep-diff').diff;

var FsWatcher = require('../lib/watchers/fs-watcher');
var PeriodicWatcher = require('../lib/watchers/periodic-watcher');
var ZoneeventWatcher = require('../lib/watchers/zoneevent-watcher');
var VmadmEventsWatcher = require('../lib/watchers/vmadm-events-watcher');

/*
 * Globals
 */
var MS_PER_SEC = 1000;

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
    assert.optionalNumber(opts.periodicInterval, 'opts.periodicInterval');
    assert.optionalString(opts.eventSource, 'opts.eventSource');

    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);

    // Yay bunyan!
    self.log = opts.log;

    // Event Source
    self.eventSource = opts.eventSource;

    // This is used to try to avoid emitting the same event twice when just
    // noticed by different watchers. How it works is that when we see an update
    // via the updateVm() function, the watcher passes us a list of properties
    // it thinks should have changed. We can then update the entry for that VM
    // in knownVms so that further updates can be skipped if they just report
    // the same change.
    self.knownVms = {};

    switch (self.eventSource) {

        case 'vmadm-events':
            assert.ok(opts.vmadm, 'opts.vmadm');
            self.vmadmEventsWatcher = new VmadmEventsWatcher({
                vmadm: opts.vmadm,
                log: opts.log,
                updateVm: self.newUpdateHandler('vmadm')
            });
            break;
        case 'default':
            self.fsWatcher = new FsWatcher({
                log: opts.log,
                updateVm: self.newUpdateHandler('fs')
            });

            self.zoneeventWatcher = new ZoneeventWatcher({
                log: opts.log,
                updateVm: self.newUpdateHandler('zoneevent')
            });

            // FUTURE: If someone only wants last_modified, we can avoid
            // starting up the periodic watcher?

            self.periodicWatcher = new PeriodicWatcher({
                log: opts.log,
                periodicInterval: opts.periodicInterval, // might be undefined
                updateVm: self.newUpdateHandler('periodic')
            });
            break;
        default:
            assert(false, 'unknown eventSource: ' + self.eventSource);
            break;
    }
}
util.inherits(VmWatcher, EventEmitter);

/*
 * Update knownVm with the properties from updateObj if knownVm has no
 * last_modified or if knownVm.last_modified is older than the one in updateObj.
 *
 * Returns an array of the names of the properties that were updated in knownVm.
 */
function updateIfNewer(vmUuid, log, knownVm, updateObj) {
    var curModified;
    var newModified;
    var prop;
    var propIdx;
    var props;
    var updated = [];

    assert.uuid(vmUuid, 'vmUuid');
    assert.object(log, 'log');
    assert.object(knownVm, 'knownVm');
    assert.object(updateObj, 'updateObj');

    if (knownVm.last_modified && updateObj.last_modified) {
        curModified = Date.parse(knownVm.last_modified);
        newModified = Date.parse(updateObj.last_modified);

        assert.number(curModified, 'curModified');
        assert.number(newModified, 'newModified');

        if (newModified % MS_PER_SEC === 0) {
            /*
             * Note to the future:
             *
             * Unfortunately on node 0.10 that the platform uses, we don't have
             * more than a second of resolution on fs.stat(), so the
             * last_modified we get from vmadm will currently always end with
             * 000Z. Since with vm-agent we can use a newer node that has
             * milisecond mtime support, when we get 000Z from vmadm, we don't
             * know if that's really 000Z or actually 789Z or whatever. So we
             * err on the side of caution and treat it as though the update
             * happened at the *end* of that second instead of the beginning.
             * When we have a newer node in all deployed SDC platforms, this
             * conditional can be removed and we can just compare the
             * timestamps.
             */
            newModified += (MS_PER_SEC - 1); // move to the end of the second.
        }

        if (curModified > newModified) {
            // Special case: refuse to update to something with a last_modified
            // that's older than what we already have.
            log.warn({
                currentLastModified: knownVm.last_modified,
                proposedLastModified: updateObj.last_modified,
                vm: vmUuid
            }, 'Refusing to update VM ' + vmUuid + ' to older last_modified');

            return (updated);
        }
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

    assert.uuid(vmUuid, 'vmUuid');
    assert.object(updateVmobj, 'updateVmobj');
    assert.string(watcher, 'watcher');

    if (self.knownVms.hasOwnProperty(vmUuid) &&
        self.knownVms[vmUuid].destroyed) {
        // The VM was previously, destroyed: delete since this is a new one.
        delete self.knownVms[vmUuid];
    }

    // We only emit if the VM did *not* previously exist. It might have been
    // noticed by a different watcher first for example.
    if (!self.knownVms.hasOwnProperty(vmUuid)) {
        setImmediate(function _emitImmediately() {
            self.emit('VmCreated', vmUuid, watcher);
        });
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
    var SPECIAL_STATES = ['failed', 'provisioning'];
    var updated;

    assert.uuid(vmUuid, 'vmUuid');
    assert.object(updateVmobj, 'updateVmobj');
    assert.string(watcher, 'watcher');

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

    if (watcher !== 'periodic' &&
        SPECIAL_STATES.indexOf(self.knownVms[vmUuid].state) !== -1) {
        // when we're in one of the 'special' states, zone_state and state don't
        // match. Since watchers other than periodic don't go through vmadm,
        // they won't know about the correct 'state' in these cases, so we leave
        // it to the periodic watcher to update the state for them.
        delete updateVmobj.state;
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

        setImmediate(function _emitImmediately() {
            self.emit('VmModified', vmUuid, watcher);
        });
    }
};

VmWatcher.prototype.dispatchDelete = // eslint-disable-line
function dispatchDelete(vmUuid, updateVmobj, watcher) {
    var self = this;

    assert.uuid(vmUuid, 'vmUuid');
    assert.object(updateVmobj, 'updateVmobj');
    assert.string(watcher, 'watcher');

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
    setImmediate(function _emitImmediately() {
        self.emit('VmDeleted', vmUuid, watcher);
    });
};

VmWatcher.prototype.newUpdateHandler = function newUpdateHandler(watcher) {
    var self = this;

    assert.string(watcher, 'watcher');

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

VmWatcher.prototype.start = function start(cb) {
    var self = this;

    assert.optionalFunc(cb, 'cb');

    self.log.debug({eventSource: self.eventSource}, 'Starting VmWatcher');

    switch (self.eventSource) {
        case 'vmadm-events':
            self.vmadmEventsWatcher.start(cb);
            break;
        case 'default':
            self.fsWatcher.start();
            self.periodicWatcher.start();
            self.zoneeventWatcher.start();
            if (cb) {
                cb();
                return;
            }
            break;
        default:
            assert(false, 'unknown eventSource: ' + self.eventSource);
            break;
    }
};

VmWatcher.prototype.stop = function stop(opts) {
    var self = this;
    var keepListeners = false;

    self.log.debug({eventSource: self.eventSource}, 'Stopping VmWatcher');

    if (opts && opts.keepListeners) {
        keepListeners = true;
    }

    switch (self.eventSource) {
        case 'vmadm-events':
            self.vmadmEventsWatcher.stop();
            break;
        case 'default':
            self.fsWatcher.stop();
            self.periodicWatcher.stop();
            self.zoneeventWatcher.stop();
            break;
        default:
            assert(false, 'unknown eventSource: ' + self.eventSource);
            break;
    }

    if (!keepListeners) {
        self.removeAllListeners();
    }
};

function uniqueElements() {
    var allElements = [];
    var argIdx;
    var unique;

    for (argIdx = 0; argIdx < arguments.length; argIdx++) {
        assert.array(arguments[argIdx]);
        allElements = allElements.concat(arguments[argIdx]);
    }

    unique = allElements.filter(function _filterElement(e, i, array) {
        return (array.lastIndexOf(e) === i);
    });

    return (unique.sort());
}

VmWatcher.WATCHED_FIELDS = uniqueElements(
    FsWatcher.FIELDS,
    PeriodicWatcher.FIELDS,
    ZoneeventWatcher.FIELDS
);

module.exports = VmWatcher;
