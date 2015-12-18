/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('tape');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');
var ZoneeventWatcher = require('../lib/watchers/zoneevent-watcher');

// How frequently to poll the 'events' array when we're waiting for an event.
var EVENTS_POLL_FREQ = 100; // ms

var events = [];
var existingVms = [];
var smartosImageUUID;
var smartosVmUUID;
var watcher;


function waitEvent(t, evt, vmUuid, eventIdx) {
    var loops = 0;

    function _waitEvent() {
        var i;

        if (events.length > eventIdx) {
            // we've had some new events, check for our create
            for (i = eventIdx; i < events.length; i++) {
                if (events[i].vmUuid === vmUuid && events[i].event === evt) {
                    t.ok(true, 'ZoneeventWatcher saw expected ' + evt
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

test('starting ZoneeventWatcher', function _test(t) {
    function _onVmUpdate(vmUuid, updateType /* , updateObj */) {
        // ignore events from VMs that existed when we started
        if (existingVms.indexOf(vmUuid) === -1) {
            events.push({
                event: updateType,
                timestamp: (new Date()).toISOString(),
                vmUuid: vmUuid
            });
        }
    }

    watcher = new ZoneeventWatcher({
        log: mocks.Logger,
        updateVm: _onVmUpdate
    });

    watcher.start();
    t.ok(watcher, 'created ZoneeventWatcher [' + watcher.getPid() + ']');

    t.end();
});

test('create VM', function _test(t) {
    var eventIdx = events.length;
    var payload = {
        alias: 'vm-agent_testvm',
        autoboot: false,
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        quota: 10
    };
    var waitAfterCreate = 5000;

    payload.log = mocks.Logger;

    vmadm.create(payload, function _vmadmCreateCb(err, info) {
        t.ifError(err, 'create VM');
        if (!err && info) {
            t.ok(info.uuid, 'VM has uuid: ' + info.uuid);
            smartosVmUUID = info.uuid;
            // should have not seen an event, wait 5s to make sure
            setTimeout(function _checkAfterCreate() {
                t.equal(events.length, eventIdx, 'expected no create event');
                t.end();
            }, waitAfterCreate);
        } else {
            t.end();
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
            // state+zone_state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        }
    });
});

test('kill zoneevent (it should restart)', function _test(t) {
    var oldPid = watcher.getPid();
    var waitPidTime = 2000;

    process.kill(oldPid);
    setTimeout(function checkPid() {
        var newPid = watcher.getPid();

        t.notEqual(oldPid, newPid, 'PID changed ' + oldPid + ' => ' + newPid);
        t.end();
    }, waitPidTime);
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
            // state+zone_state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        }
    });
});

test('delete VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};
    var waitAfterDelete = 5000;

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;

    vmadm.delete(opts, function _vmadmDeleteCb(err) {
        t.ifError(err, 'deleted VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            // should have not seen an event, wait 5s to make sure
            setTimeout(function _checkAfterDelete() {
                t.equal(events.length, eventIdx, 'expected no delete event');
                t.end();
            }, waitAfterDelete);
        }
    });
});

test('stop ZoneeventWatcher', function _test(t) {
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
