/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var test = require('tape');
var vmadm = require('vmadm');

var common = require('./common');
var determineEventSource = require('../lib/event-source');
var mocks = require('./mocks');
var VmWatcher = require('../lib/vm-watcher');


// For tests we can lower the frequency the periodic watcher polls so we finish
// in more reasonable time.
var PERIODIC_INTERVAL = 1000;

var events = [];
var existingVms = [];
var eventSource;
var smartosImageUUID;
var smartosVmUUID;
var watcher;


test('find SmartOS image', function _test(t) {
    common.testFindSmartosImage(t, function _findSmartosCb(err, latest) {
        t.ifError(err, 'find SmartOS Image');
        if (err) {
            throw new Error('Cannot continue without SmartOS Image');
        }
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

test('determine best event source', function _test(t) {
    var opts = {
        log: mocks.Logger,
        vmadm: vmadm
    };

    determineEventSource(opts,
        function determinedEventSource(err, _eventSource) {
            t.ifError(err, 'determineEventSource err');

            eventSource = _eventSource;
            t.ok(eventSource,
                'determineEventSource eventSource: ' + eventSource);

            t.end();
        }
    );
});

test('starting VmWatcher', function _test(t) {
    watcher = new VmWatcher({
        log: mocks.Logger,
        eventSource: eventSource,
        periodicInterval: PERIODIC_INTERVAL,
        vmadm: vmadm
    });

    t.ok(watcher, 'created VmWatcher');

    function _onVmEvent(vmUuid, name) {
        // ignore events from VMs that existed when we started
        if (existingVms.indexOf(vmUuid) === -1) {
            events.push({
                event: name,
                timestamp: (new Date()).toISOString(),
                vmUuid: vmUuid
            });
        }
    }

    watcher.on('VmCreated', function _onCreate(vmUuid, watcherName) {
        _onVmEvent(vmUuid, 'create', watcherName);
    });

    watcher.on('VmModified', function _onModify(vmUuid, watcherName) {
        _onVmEvent(vmUuid, 'modify', watcherName);
    });

    watcher.on('VmDeleted', function _onDelete(vmUuid, watcherName) {
        _onVmEvent(vmUuid, 'delete', watcherName);
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
            common.waitEvent(t, 'create', smartosVmUUID, events, eventIdx);
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
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
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
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
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
                common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
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
                common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
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
            common.waitEvent(t, 'delete', smartosVmUUID, events, eventIdx);
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
        if (evt.vmUuid === smartosVmUUID) {
            evts.push(evt.event);
        }
    });

    t.ok(true, 'saw: ' + evts.join(','));
    t.end();
});
