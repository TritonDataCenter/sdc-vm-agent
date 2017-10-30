/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var vmadm = require('vmadm');

function noop() {}

function VmadmEventsWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');

    self.log = opts.log.child({watcher: 'vmadm-events-watcher'});
    self.updateVm = opts.updateVm;
}

VmadmEventsWatcher.prototype.start = function start(_cb) {
    var self = this;

    var opts;
    var cb = _cb || noop;

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
                self.updateVm(ev.zonename, 'create', ev.vm);
                break;
            case 'modify':
                assert.object(ev.vm, 'ev.vm');
                self.updateVm(ev.zonename, 'modify', ev.vm);
                break;
            case 'delete':
                self.updateVm(ev.zonename, 'delete', {});
                break;
            default:
                assert(false, 'unknown vmadm event type: ' + ev.type);
                break;
        }
    }

    function ready(err, obj) {
        if (err) {
            cb(err);
            return;
        }

        assert.object(obj, 'obj');
        assert.func(obj.stop, 'obj.stop');
        assert.object(obj.ev, 'obj.ev');

        self.stopWatcher = obj.stop;
        cb(null, obj.ev);
    }

    vmadm.events(opts, handler, ready);
};

VmadmEventsWatcher.prototype.stop = function stop() {
    var self = this;

    if (self.stopWatcher) {
        self.stopWatcher();
        delete self.stopWatcher;
    }
};

VmadmEventsWatcher.FIELDS = [];

module.exports = VmadmEventsWatcher;
