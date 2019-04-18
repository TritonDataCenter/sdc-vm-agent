/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var assert = require('assert-plus');
var test = require('tape');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');
var FsWatcher = require('../lib/watchers/fs-watcher');

var events = [];
var existingVms = [];
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
            assert.arrayOfObject(vms, 'vms');
            vms.forEach(function _pushVm(vm) {
                existingVms.push(vm.uuid);
            });
        }
        t.end();
    });
});

test('starting FsWatcher', function _test(t) {
    function _onVmUpdate(vmUuid, updateType /* , updateObj */) {
        assert.uuid(vmUuid, 'vmUuid');
        assert.string(updateType, 'updateType');

        // ignore events from VMs that existed when we started
        if (existingVms.indexOf(vmUuid) === -1) {
            events.push({
                event: updateType,
                timestamp: (new Date()).toISOString(),
                vmUuid: vmUuid
            });
        }
    }

    watcher = new FsWatcher({
        log: mocks.Logger,
        updateVm: _onVmUpdate
    });

    t.ok(watcher, 'created FsWatcher');

    watcher.start();

    t.end();
});

test('create VM', function _test(t) {
    var eventIdx = events.length;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        quota: 10,
        cpu_cap: 100
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

test('stop FsWatcher', function _test(t) {
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
