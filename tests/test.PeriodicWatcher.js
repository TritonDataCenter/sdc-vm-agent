/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var assert = require('assert-plus');
var test = require('tape');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');
var PeriodicWatcher = require('../lib/watchers/periodic-watcher');


var PERIODIC_INTERVAL = 1000; // ms, faster than usual because tests

var events = [];
var existingVms = [];
var kvmVmUUID;
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

test('starting PeriodicWatcher', function _test(t) {
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

    watcher = new PeriodicWatcher({
        log: mocks.Logger,
        periodicInterval: PERIODIC_INTERVAL,
        updateVm: _onVmUpdate
    });

    watcher.start();
    t.ok(watcher, 'created PeriodicWatcher');

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

test('create snapshot', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;
    opts.snapshot_name = 'hellosnapshot';

    vmadm.create_snapshot(opts, function _vmadmCreateSnapCb(err) {
        t.ifError(err, 'created snapshot for VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
        }
    });
});

test('delete snapshot', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;
    opts.snapshot_name = 'hellosnapshot';

    vmadm.delete_snapshot(opts, function _vmadmDeleteSnapCb(err) {
        t.ifError(err, 'deleted snapshot for VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
        }
    });
});

test('set do_not_inventory', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;
    opts.do_not_inventory = true;

    vmadm.update(opts, function _vmadmSetDoNotInventoryCb(err) {
        t.ifError(err, 'set do_not_inventory for VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            // Since the watcher itself has no concept of do_not_inventory and
            // that's all we're testing here, we should see a modify. It's
            // VmAgent that should realize when it goes to update based on this
            // event that it should be ignored.
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
        }
    });
});

test('unset do_not_inventory', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;
    opts.include_dni = true;
    opts.do_not_inventory = false;

    vmadm.update(opts, function _vmadmUnsetDNI(err) {
        t.ifError(err, 'unset do_not_inventory for VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
        }
    });
});

test('reboot VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = smartosVmUUID;

    vmadm.reboot(opts, function _vmadmRebootCb(err) {
        t.ifError(err, 'rebooted VM ' + smartosVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', smartosVmUUID, events, eventIdx);
        }
    });
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

test('create KVM VM', function _test(t) {
    var eventIdx;
    var payload = {
        alias: 'vm-agent_testkvm',
        autoboot: false,
        brand: 'kvm'
    };

    // start with an exmpt set of events
    events = [];
    eventIdx = 0;

    payload.log = mocks.Logger;

    vmadm.create(payload, function _vmadmKvmCreateCb(err, info) {
        t.ifError(err, 'create VM');
        if (!err && info) {
            t.ok(info.uuid, 'VM has uuid: ' + info.uuid);
            kvmVmUUID = info.uuid;
            common.waitEvent(t, 'create', kvmVmUUID, events, eventIdx);
        } else {
            t.end();
        }
    });
});

test('add KVM VM disk', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = kvmVmUUID;
    opts.add_disks = [{size: 10, model: 'scsi'}];

    vmadm.update(opts, function _vmadmAddDiskCb(err) {
        t.ifError(err, 'add disk to VM ' + kvmVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', kvmVmUUID, events, eventIdx);
        }
    });
});

test('modify KVM VM disk', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = kvmVmUUID;
    opts.update_disks = [{
        path: '/dev/zvol/rdsk/zones/' + kvmVmUUID + '-disk0',
        model: 'ide'
    }];

    vmadm.update(opts, function _vmadmModDiskCb(err) {
        t.ifError(err, 'modify disk on VM ' + kvmVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', kvmVmUUID, events, eventIdx);
        }
    });
});

test('remove KVM VM disk', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = kvmVmUUID;
    opts.remove_disks = [
        '/dev/zvol/rdsk/zones/' + kvmVmUUID + '-disk0'
    ];

    vmadm.update(opts, function _vmadmDelDiskCb(err) {
        t.ifError(err, 'delete disk on VM ' + kvmVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'modify', kvmVmUUID, events, eventIdx);
        }
    });
});

test('delete KVM VM', function _test(t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = mocks.Logger;
    opts.uuid = kvmVmUUID;

    vmadm.delete(opts, function _vmadmKvmDeleteCb(err) {
        t.ifError(err, 'deleted VM ' + kvmVmUUID);
        if (err) {
            t.end();
        } else {
            common.waitEvent(t, 'delete', kvmVmUUID, events, eventIdx);
        }
    });
});

test('stop PeriodicWatcher', function _test(t) {
    watcher.stop();
    t.ok(true, 'stopped watcher');
    t.end();
});

test('check KVM VM\'s events', function _test(t) {
    var evts = [];

    // Add the KVM VM uuid to existingVms so we ignore any more events that
    // happen to come through, then we'll clear the events loop after we do our
    // check.
    existingVms.push(kvmVmUUID);

    events.forEach(function _pushEvent(evt) {
        if (evt.vmUuid === kvmVmUUID) {
            evts.push(evt.event);
        }
    });

    t.ok(true, 'saw: ' + evts.join(','));
    t.end();
});
