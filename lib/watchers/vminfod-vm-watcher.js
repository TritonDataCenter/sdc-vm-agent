/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');

var vminfod;
var VMINFOD_AVAILABLE;

try {
    /* eslint-disable */
    vminfod = require('/usr/vm/node_modules/vminfod/client');
    /* eslint-enable */
    VMINFOD_AVAILABLE = true;
} catch (e) {
    VMINFOD_AVAILABLE = false;
}

function VminfodVmWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');

    self.log = opts.log.child({watcher: 'vminfo-vm-watcher'});
    self.updateVm = opts.updateVm;
}

VminfodVmWatcher.prototype.start = function start(cb) {
    var self = this;

    assert.optionalFunc(cb, 'cb');
    assert(!self.vminfodWatcher, 'watcher already created');

    self.vminfodWatcher = new vminfod.VminfodWatcher({
        name: 'VM Agent - VminfodVMWatcher',
        log: self.log
    });

    self.vminfodWatcher.on('create', function vmOnCreate(ev) {
        assert.uuid(ev.zonename, 'ev.zonename');
        assert.object(ev.vm, 'ev.vm');
        self.updateVm(ev.zonename, 'create', ev.vm);
    });
    self.vminfodWatcher.on('modify', function vmOnModify(ev) {
        assert.uuid(ev.zonename, 'ev.zonename');
        assert.object(ev.vm, 'ev.vm');
        self.updateVm(ev.zonename, 'modify', ev.vm);
    });
    self.vminfodWatcher.on('delete', function vmOnDelete(ev) {
        assert.uuid(ev.zonename, 'ev.zonename');
        self.updateVm(ev.zonename, 'delete', {});
    });

    self.vminfodWatcher.once('ready', function vmOnReady() {
        if (cb) {
            cb();
            return;
        }
    });
};

VminfodVmWatcher.prototype.stop = function stop() {
    var self = this;

    if (self.vminfodWatcher) {
        self.vminfodWatcher.stop();
        delete self.vminfodWatcher;
    }
};

VminfodVmWatcher.FIELDS = [];
VminfodVmWatcher.VMINFOD_AVAILABLE = VMINFOD_AVAILABLE;

module.exports = VminfodVmWatcher;
