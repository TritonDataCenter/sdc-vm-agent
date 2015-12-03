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
var VmWatcher = require('../lib/vm-watcher');

// How frequently to poll the 'events' array when we're waiting for an event.
var EVENTS_POLL_FREQ = 100; // ms

// TODO:
// take/delete snapshot
// add/remove do_not_inventory (destroy/create)
// reboot
//
// create KVM VM
// modify disks
// destroy KVM VM

var logStub = {
    trace: function () { return true; },
    debug: function () { return true; },
    info: function () { return true; },
    warn: function () { return true; },
    error: function (err) { console.log(err); return true; }
};

var events = [];
var existingVms = [];
var smartosImageUUID;
var smartosVmUUID;
var watcher;

function waitEvent(t, evt, vm_uuid, eventIdx) {
    loops = 0;

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

test('find SmartOS image', function (t) {
    var args = ['list', '-H', '-j', '-o', 'uuid,tags', 'os=smartos'];
    var img;
    var imgs = {};
    var latest;

    execFile('/usr/sbin/imgadm', args, function (err, stdout) {
        t.ifError(err, 'load images from imgadm');
        if (!err) {
            imgs = JSON.parse(stdout);
            for (idx in imgs) {
                img = imgs[idx];
                if (img.manifest.tags.smartdc) {
                    if (!latest || img.manifest.published_at > latest) {
                        smartosImageUUID = img.manifest.uuid;
                        latest = img.manifest.published_at;
                    }
                }
            }
        }
        t.ok(smartosImageUUID, 'found SmartOS image_uuid: '
            + smartosImageUUID);
        t.end();
    });
});

test('load existing VMs', function (t) {
    var opts = {};

    opts.fields = ['uuid'];
    opts.log = logStub;

    vmadm.lookup({}, opts, function _onLookup(err, vms) {
        t.ifError(err, 'vmadm lookup');
        if (vms) {
            vms.forEach(function (vm) {
                existingVms.push(vm.uuid);
            });
        }
        t.end();
    });
});

test('starting VmWatcher', function (t) {
    watcher = new VmWatcher({log: logStub});

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

    watcher.on('VmCreated', function _onCreate(vm_uuid) {
        _onVmEvent(vm_uuid, 'create');
    });

    watcher.on('VmModified', function _onModify(vm_uuid) {
        _onVmEvent(vm_uuid, 'modify');
    });

    watcher.on('VmDeleted', function _onDelete(vm_uuid) {
        _onVmEvent(vm_uuid, 'delete');
    });

    watcher.start();

    t.end();
});

test('create VM', function (t) {
    var eventIdx = events.length;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        quota: 10
    };

    payload.log = logStub;

    vmadm.create(payload, function (err, info) {
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

test('stop VM', function (t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = logStub;
    opts.uuid = smartosVmUUID;

    vmadm.stop(opts, function (err) {
        t.ifError(err, 'stop VM');
        if (!err) {
            // state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        } else {
            t.end();
        }
    });
});

test('start VM', function (t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = logStub;
    opts.uuid = smartosVmUUID;

    vmadm.start(opts, function (err) {
        t.ifError(err, 'start VM');
        if (!err) {
            // state should change
            waitEvent(t, 'modify', smartosVmUUID, eventIdx);
        } else {
            t.end();
        }
    });
});

test('modify quota using ZFS', function (t) {
    var eventIdx = events.length;

    execFile('/usr/sbin/zfs', ['set', 'quota=20g', 'zones/' + smartosVmUUID],
        function (err, stdout, stderr) {
            t.ifError(err, 'update quota');
            if (!err) {
                waitEvent(t, 'modify', smartosVmUUID, eventIdx);
            } else {
                t.end();
            }
        }
    );
});

test('put metadata using mdata-put', function (t) {
    var eventIdx = events.length;

    execFile('/usr/sbin/zlogin',
        [smartosVmUUID, '/usr/sbin/mdata-put', 'hello', 'world'],
        function (err, stdout, stderr) {
            t.ifError(err, 'mdata-put');
            if (!err) {
                waitEvent(t, 'modify', smartosVmUUID, eventIdx);
            } else {
                t.end();
            }
        }
    );
});

test('delete VM', function (t) {
    var eventIdx = events.length;
    var opts = {};

    opts.log = logStub;
    opts.uuid = smartosVmUUID;

    vmadm.delete(opts, function (err) {
        t.ifError(err, 'deleted VM ' + smartosVmUUID);
        if (!err) {
            waitEvent(t, 'delete', smartosVmUUID, eventIdx);
        } else {
            t.end();
        }
    });
});

test('stop VmWatcher', function (t) {
    watcher.stop();
    t.ok(true, 'stopped watcher');
    t.end();
});

test('check SmartOS VM\'s events', function (t) {
    var evts = [];
    events.forEach(function (evt) {
        if (evt.vm_uuid === smartosVmUUID) {
            evts.push(evt.event);
        }
    });

    t.ok(true, 'saw: ' + evts.join(','));
    t.end();
});
