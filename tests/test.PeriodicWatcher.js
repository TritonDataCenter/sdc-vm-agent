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


// How frequently to poll the 'events' array when we're waiting for an event.
var EVENTS_POLL_FREQ = 100; // ms
var PERIODIC_INTERVAL = 1000; // ms, faster than usual because tests

var events = [];
var existingVms = [];
var kvmVmUUID;
var smartosImageUUID;
var smartosVmUUID;
var watcher;


function waitEvent(t, evt, vmUuid, eventIdx) {
    var loops = 0;

    assert.string(evt, 'evt');
    assert.uuid(vmUuid, 'vmUuid');
    assert.number(eventIdx, 'eventIdx');

    function _waitEvent() {
        var i;

        if (events.length > eventIdx) {
            // we've had some new events, check for our create
            for (i = eventIdx; i < events.length; i++) {
                if (events[i].vmUuid === vmUuid && events[i].event === evt) {
                    t.ok(true, 'PeriodicWatcher saw expected ' + evt
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
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
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
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
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
            waitEvent(t, 'delete', smartosVmUUID, eventIdx);
        }
    });
});

test('unset do_not_inventory', function _test(t) {
    var eventIdx = events.length;

    // We have to use zonecfg to unset do_not_inventory because node-vmadm won't
    // see it (on purpose).
    execFile('/usr/sbin/zonecfg',
        ['-z', smartosVmUUID, 'remove attr name=do-not-inventory'],
        function _unsetDoNotInventoryCb(err, stdout, stderr) {
            if (err) {
                err.stderr = stderr;
                err.stdout = stdout;
            }
            t.ifError(err, 'unset do_not_inventory for VM ' + smartosVmUUID);
            if (err) {
                t.end();
            } else {
                waitEvent(t, 'create', smartosVmUUID, eventIdx);
            }
        }
    );
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
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
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
            waitEvent(t, 'delete', smartosVmUUID, eventIdx);
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
            waitEvent(t, 'create', kvmVmUUID, eventIdx);
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
            waitEvent(t, 'modify', kvmVmUUID, eventIdx);
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
            waitEvent(t, 'modify', kvmVmUUID, eventIdx);
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
            waitEvent(t, 'modify', kvmVmUUID, eventIdx);
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
            waitEvent(t, 'delete', kvmVmUUID, eventIdx);
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
