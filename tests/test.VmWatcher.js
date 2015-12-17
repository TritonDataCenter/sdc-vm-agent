/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var test = require('tape');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');
var VmWatcher = require('../lib/vm-watcher');


// For tests we can lower the frequency the periodic watcher polls so we finish
// in more reasonable time.
var PERIODIC_INTERVAL = 1000;
// How frequently to poll the 'events' array when we're waiting for an event.
var EVENTS_POLL_FREQ = 100; // ms

var events = [];
var existingVms = [];
var smartosImageUUID;
var smartosVmUUID;
var watcher;


function waitEvent(t, evt, vm_uuid, eventIdx) {
    var loops = 0;

    function _waitEvent() {
        var i;

        if (events.length > eventIdx) {
            // we've had some new events, check for our create
            for (i = eventIdx; i < events.length; i++) {
                if (events[i].vm_uuid === vm_uuid && events[i].event === evt) {
                    t.ok(true, 'VmWatcher saw expected ' + evt
                        + ' (' + (loops * EVENTS_POLL_FREQ) + ' ms)');
                    t.end();
                    return;
                }
            }
        }

        loops++;
        setTimeout(_waitEvent, EVENTS_POLL_FREQ);
    }

    _waitEvent();
}

test('find SmartOS image', function _test(t) {
    common.testFindSmartosImage(t, function _findSmartosCb(latest) {
        smartosImageUUID = latest;
        t.end();
    });
});

test('load existing VMs', function _test(t) {
    var opts = {};

    opts.fields = ['uuid'];
    opts.log = mocks.Logger;

    vmadm.lookup({}, opts, function _onLookup(err, vms) {
        t.ifError(err, 'vmadm lookup');
        if (vms) {
            vms.forEach(function _pushVm(vm) {
                existingVms.push(vm.uuid);
            });
        }
        t.end();
    });
});

test('starting VmWatcher', function _test(t) {
    watcher = new VmWatcher({
        log: mocks.Logger,
        periodicInterval: PERIODIC_INTERVAL
    });

    t.ok(watcher, 'created VmWatcher');

    function _onVmEvent(vm_uuid, name) {
        // ignore events from VMs that existed when we started
        if (existingVms.indexOf(vm_uuid) === -1) {
            events.push({
                event: name,
                timestamp: (new Date()).toISOString(),
                vm_uuid: vm_uuid
            });
        }
    }

    watcher.on('VmCreated', function _onCreate(vm_uuid, watcherName) {
        _onVmEvent(vm_uuid, 'create', watcherName);
    });

    watcher.on('VmModified', function _onModify(vm_uuid, watcherName) {
        _onVmEvent(vm_uuid, 'modify', watcherName);
    });

    watcher.on('VmDeleted', function _onDelete(vm_uuid, watcherName) {
        _onVmEvent(vm_uuid, 'delete', watcherName);
    });

    watcher.start();

    t.end();
});

test('create VM', function _test(t) {
    var eventIdx = events.length;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        quota: 10
    };

    payload.log = mocks.Logger;

    vmadm.create(payload, function _vmadmCreateCb(err, info) {
        t.ifError(err, 'create VM');
        if (!err && info) {
            t.ok(info.uuid, 'VM has uuid: ' + info.uuid);
            smartosVmUUID = info.uuid;
            waitEvent(t, 'create', smartosVmUUID, eventIdx);
        } else {
            t.end();
        }
    });
});

test('stop VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;

    vmadm.stop(opts, function _vmadmStopCb(err) {
        t.ifError(err, 'stop VM');
        if (err) {
            t.end();
        } else {
            // state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        }
    });
});

test('start VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;

    vmadm.start(opts, function _vmadmStartCb(err) {
        t.ifError(err, 'start VM');
        if (err) {
            t.end();
        } else {
            // state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        }
    });
});

test('modify quota using ZFS', function _test(t) {
    var eventIdx = events.length;

    execFile('/usr/sbin/zfs', ['set', 'quota=20g', 'zones/' + smartosVmUUID],
        function _zfsCb(err /* , stdout, stderr */) {
            t.ifError(err, 'update quota');
            if (err) {
                t.end();
            } else {
                waitEvent(t, 'modify', smartosVmUUID, eventIdx);
            }
        }
    );
});

test('put metadata using mdata-put', function _test(t) {
    var eventIdx = events.length;

    execFile('/usr/sbin/zlogin',
        [smartosVmUUID, '/usr/sbin/mdata-put', 'hello', 'world'],
        function _mdataPutCb(err /* , stdout, stderr */) {
            t.ifError(err, 'mdata-put');
            if (err) {
                t.end();
            } else {
                waitEvent(t, 'modify', smartosVmUUID, eventIdx);
            }
        }
    );
});

test('delete VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;

    vmadm.delete(opts, function _vmadmDeleteCb(err) {
        t.ifError(err, 'deleted VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            waitEvent(t, 'delete', smartosVmUUID, eventIdx);
        }
    });
});

test('stop VmWatcher', function _test(t) {
    watcher.stop();
    t.ok(true, 'stopped watcher');
    t.end();
});

test('check SmartOS VM\'s events', function _test(t) {
    var evts = [];

    events.forEach(function _pushEvent(evt) {
        if (evt.vm_uuid === smartosVmUUID) {
            evts.push(evt.event);
        }
    });

    t.ok(true, 'saw: ' + evts.join(','));
    t.end();
});