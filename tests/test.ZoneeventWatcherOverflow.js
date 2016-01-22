/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var test = require('tape');
var vasync = require('vasync');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');
var ZoneeventWatcher = require('../lib/watchers/zoneevent-watcher');

var createdVms = [];
var debugData = {totalEvents: 0, totalLen: 0};
var smartosImageUUID;
var watcher;
var vmEvents = {};


// "CONFIG"
var CHARS_PER_LINE = 200;  // at least this many chars in a zoneevent line
var STRAGGLER_WAIT = 5000; // wait this many ms for events after delete
var OVERHEAD_EVENTS = 15;  // events we expect for create/delete
var RESTART_EVENTS = 9;    // events we expect for each restart
var NUM_RESTARTS_PER_VM = 25;
var NUM_VMS = 10;


/*
 * This test exists to confirm that AGENT-987 is fixed.
 *
 * Basically it proves that we can successfully handle at least (NUM_VMS *
 * NUM_RESTARTS_PER_VM * 9) + (NUM_VMS * 15) events.
 *
 * To test this, we create NUM_VMS VMs and reboot them in parallel
 * NUM_RESTARTS_PER_VM times.
 *
 * This should result in that number of start + stop events for each of them
 * along with 7 other intermediate events per restart and 15 events per VM for
 * the create/destroy.
 *
 */

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

test('starting ZoneeventWatcher', function _test(t) {
    function _onVmUpdate(vmUuid, updateType, updateObj) {
        if (!vmEvents.hasOwnProperty(vmUuid)) {
            vmEvents[vmUuid] = {start: 0, stop: 0, other: 0};
        }

        if (updateObj.zone_state === 'running') {
            vmEvents[vmUuid].start++;
        } else if (updateObj.zone_state === 'stopped') {
            vmEvents[vmUuid].stop++;
        } else {
            vmEvents[vmUuid].other++;
        }
    }

    watcher = new ZoneeventWatcher({
        debugEvents: true,
        highWaterMark: 32, // default is 16k! takes too long to get there.
        log: mocks.Logger,
        updateVm: _onVmUpdate
    });

    watcher.start();
    t.ok(watcher, 'created ZoneeventWatcher [' + watcher.getPid() + ']');

    t.end();
});

test('create VMs', function _test(t) {
    var numVms = NUM_VMS;
    var vmsToCreate = [];

    while (numVms > 0) {
        vmsToCreate.push(numVms--);
    }

    function _createVm(idx, cb) {
        var payload = {
            alias: 'vm-agent_testvm-overflow-' + idx,
            autoboot: true,
            brand: 'joyent-minimal',
            image_uuid: smartosImageUUID,
            quota: 10
        };

        payload.log = mocks.Logger;

        vmadm.create(payload, function _vmadmCreateCb(err, info) {
            t.ifError(err, 'create VM'
                + ((!err && info) ? ': ' + info.uuid : ''));
            if (!err && info) {
                createdVms.push(info.uuid);
            }
            cb(err);
        });
    }

    vasync.forEachParallel({
        inputs: vmsToCreate,
        func: _createVm
    }, function _afterForEachParallel(err) {
        t.ifError(err, 'done creating');
        t.end();
    });
});

test('restart VMs', function _test(t) {
    // restart with zoneadm because we're doing this a lot and we want maximum
    // fastness.
    function _restartVm(uuid, cb) {
        var args = ['-z', uuid, 'reboot', '-X'];
        var cmd = '/usr/sbin/zoneadm';

        execFile(cmd, args, function _onExecFile(err, stdout, stderr) {
            var starts = vmEvents[uuid] ? vmEvents[uuid].start : 0;
            var stops = vmEvents[uuid] ? vmEvents[uuid].stop : 0;
            var others = vmEvents[uuid] ? vmEvents[uuid].other : 0;

            t.ifError(err, 'reboot VM ' + uuid + ' (' + starts + '/' + stops
                + '/' + others + ')');
            if (err) {
                console.error('zoneadm: ' + stderr); // eslint-disable-line
            }
            cb(err);
        });
    }

    function _multiRestartVm(uuid, cb) {
        var restarts = NUM_RESTARTS_PER_VM;
        var vmRestarts = [];

        while (restarts > 0) {
            vmRestarts.push(uuid);
            restarts--;
        }

        vasync.forEachPipeline({
            func: _restartVm,
            inputs: vmRestarts
        }, function _afterMultiRestartVm(err) {
            cb(err);
        });
    }

    vasync.forEachParallel({
        inputs: createdVms,
        func: _multiRestartVm
    }, function _afterForEachParallel(err) {
        t.ifError(err, 'done restarting');
        t.end();
    });
});

test('delete VMs', function _test(t) {
    function _deleteVm(uuid, cb) {
        var opts = {};

        opts.log = mocks.Logger;
        opts.uuid = uuid;

        vmadm.delete(opts, function _vmadmDeleteCb(err) {
            t.ifError(err, 'delete VM ' + uuid);
            cb(err);
        });
    }

    vasync.forEachParallel({
        inputs: createdVms,
        func: _deleteVm
    }, function _afterForEachParallel(err) {
        t.ifError(err, 'done deleting');
        t.end();
    });
});

test('stop ZoneeventWatcher', function _test(t) {
    // grab the totals so we can compare to expected in final check.
    debugData = {
        totalEvents: watcher.totalEvents,
        totalLen: watcher.totalLen
    };

    // give stragglers a chance and then stop the watcher
    setTimeout(function _afterWaiting() {
        t.ok(true, 'stopped watcher');
        watcher.stop();
        t.end();
    }, STRAGGLER_WAIT);
});

test('check final state', function _test(t) {
    var expectedTotal = (NUM_VMS * OVERHEAD_EVENTS)
        + (NUM_VMS * NUM_RESTARTS_PER_VM * RESTART_EVENTS);

    t.ok(debugData.totalEvents >= expectedTotal, debugData.totalEvents + ' >= '
        + expectedTotal);
    // lines are > CHARS_PER_LINE characters each, so we have at least this much
    t.ok(debugData.totalLen >= (expectedTotal * CHARS_PER_LINE),
        debugData.totalLen + ' >= ' + (expectedTotal * CHARS_PER_LINE));
    t.end();
});

