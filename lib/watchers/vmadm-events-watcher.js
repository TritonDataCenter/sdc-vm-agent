/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');

// Time to wait before restarting `vmadm.events` if it has an error.
var RESTART_TIMEOUT = 1000;

function noop() {}

function VmadmEventsWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');
    assert.ok(opts.vmadm, 'opts.vmadm');

    self.vmadm = opts.vmadm;
    self.log = opts.log.child({watcher: 'vmadm-events-watcher'});
    self.updateVm = opts.updateVm;
    self.vms = null;
    self.restarted = false;
}

VmadmEventsWatcher.prototype.start = function start(_cb) {
    var self = this;

    var opts;
    var cb = _cb || noop;
    var watcher;

    assert.func(cb, 'cb');
    assert(!self.stopWatcher, 'watcher already created');

    opts = {
        log: self.log,
        name: 'VM Agent'
    };

    function handler(ev) {
        assert.object(ev, 'ev');
        assert.string(ev.type, 'ev.type');
        assert.uuid(ev.zonename, 'ev.zonename');

        switch (ev.type) {
            case 'create':
                assert.object(ev.vm, 'ev.vm');
                self.vms[ev.zonename] = ev.vm;
                self.updateVm(ev.zonename, 'create', ev.vm);
                break;
            case 'modify':
                assert.object(ev.vm, 'ev.vm');
                self.vms[ev.zonename] = ev.vm;
                self.updateVm(ev.zonename, 'modify', ev.vm);
                break;
            case 'delete':
                delete self.vms[ev.zonename];
                self.updateVm(ev.zonename, 'delete', {});
                break;
            default:
                assert(false, 'unknown vmadm event type: ' + ev.type);
                break;
        }
    }

    function ready(err, obj) {
        /*
         * This error is only encountered in the case where `vmadm.events` is
         * not supported.
         */
        if (err) {
            cb(err);
            return;
        }

        assert.object(obj, 'obj');
        assert.func(obj.stop, 'obj.stop');
        assert.object(obj.ev, 'obj.ev');
        assert.object(obj.ev.vms, 'obj.ev.vms');

        self.stopWatcher = obj.stop;

        if (self.restarted) {
            assert.object(self.vms, 'self.vms');
            self._sendMissedUpdates(self.vms, obj.ev.vms);
        }

        self.vms = obj.ev.vms;

        cb(null, obj.ev);
    }

    watcher = self.vmadm.events(opts, handler, ready);

    watcher.once('error', function vmadmEventsOnceError(err) {
        self.log.error(err, 'vmadm.events error - restarting watcher');
        self.stop();
        setTimeout(function vmadmEventsRestart() {
            self.restarted = true;
            self.start();
        }, RESTART_TIMEOUT);
    });
};

VmadmEventsWatcher.prototype.stop = function stop() {
    var self = this;

    if (self.stopWatcher) {
        self.stopWatcher();
        delete self.stopWatcher;
    }
};

/*
 * Figure out all the VMs that have been modified since the last
 * time `vmadm.events` ran and send the proper update - this
 * ensures no events are missed.
 *
 * The basic idea here is to calculate the difference between VMs known before
 * `vmadm.events` stopped and VMs known now that it is running again (vminfod
 * sends a full update when the stream is created).  Any VM UUID known now that
 * wasn't known before is considered a `create`, any VM UUID not known now that
 * was known before is considered a 'delete', and any VM known then and now is
 * considered a 'modify' if the objects are different.
 */
VmadmEventsWatcher.prototype._sendMissedUpdates = // eslint-disable-line
function _sendMissedUpdates(oldVms, newVms) {
    var self = this;

    var oldVmUUIDs = Object.keys(oldVms);
    var newVmUUIDs = Object.keys(newVms);

    var createdVms = newVmUUIDs.filter(function findCreatedVms(uuid) {
        return !jsprim.hasKey(oldVms, uuid);
    });
    var modifiedVms = newVmUUIDs.filter(function findModifiedVms(uuid) {
        return jsprim.hasKey(oldVms, uuid);
    });
    var deletedVms = oldVmUUIDs.filter(function findDeletedVms(uuid) {
        return !jsprim.hasKey(newVms, uuid);
    });

    self.log.debug({
        createdVms: createdVms,
        modifiedVms: modifiedVms,
        deletedVms: deletedVms
    }, 'sending vmadm.events update after restart');

    createdVms.forEach(function addCreatedVm(uuid) {
        var vm = newVms[uuid];

        assert.object(vm, 'vm');
        self.updateVm(uuid, 'create', vm);
    });

    modifiedVms.forEach(function updateModifiedVm(uuid) {
        var oldVm = oldVms[uuid];
        var newVm = newVms[uuid];

        assert.object(oldVm, 'oldVm');
        assert.object(newVm, 'newVm');

        if (jsprim.deepEqual(oldVm, newVm)) {
            self.log.debug('skipping unmodified vm %s', uuid);
        } else {
            self.updateVm(uuid, 'modify', newVm);
        }
    });

    deletedVms.forEach(function removeDeletedVm(uuid) {
        self.updateVm(uuid, 'delete', {});
    });
};

VmadmEventsWatcher.FIELDS = [];

module.exports = VmadmEventsWatcher;
