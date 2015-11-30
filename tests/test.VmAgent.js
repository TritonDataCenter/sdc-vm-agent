/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var diff = require('deep-diff').diff;
var EventEmitter = require('events').EventEmitter;
var test = require('tape');
var util = require('util');
var VmAgent = require('../lib/vm-agent');

var logStub = {
    child: function () { return logStub; },
    trace: function () { return true; },
    debug: function () { return true; },
    info:  function () { return true; },
    warn:  function () { return true; },
    error: function (err) { console.log(err); return true; }
};

// GLOBAL
var fakeWatcher;
var vmAgent;
var vmadmErr;
var vmadmVms = [];
var vmapiErr;
var vmapiVms = [];

var standardVm = {
    "zonename": "6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "autoboot": true,
    "brand": "joyent-minimal",
    "limit_priv": "default",
    "v": 1,
    "create_timestamp": "2015-11-27T05:01:25.838Z",
    "image_uuid": "cd2d08a0-83f1-11e5-8684-f383641a9854",
    "cpu_shares": 128,
    "max_lwps": 1000,
    "max_msg_ids": 4096,
    "max_sem_ids": 4096,
    "max_shm_ids": 4096,
    "max_shm_memory": 128,
    "zfs_io_priority": 10,
    "max_physical_memory": 128,
    "max_locked_memory": 128,
    "max_swap": 256,
    "cpu_cap": 100,
    "billing_id": "73a1ca34-1e30-48c7-8681-70314a9c67d3",
    "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
    "package_name": "sdc_128",
    "package_version": "1.0.0",
    "tmpfs": 128,
    "dns_domain": "local",
    "archive_on_delete": true,
    "maintain_resolvers": true,
    "resolvers": [
      "10.192.0.11"
    ],
    "alias": "testvm",
    "nics": [
      {
        "interface": "net0",
        "mac": "92:88:1a:79:75:71",
        "vlan_id": 0,
        "nic_tag": "admin",
        "netmask": "255.192.0.0",
        "ip": "10.192.0.8",
        "ips": [
          "10.192.0.8/10"
        ],
        "primary": true
      }
    ],
    "uuid": "6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zone_state": "running",
    "zonepath": "/zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zoneid": 9,
    "last_modified": "2015-11-27T06:19:37.000Z",
    "firewall_enabled": false,
    "server_uuid": "564dfd57-1dd4-6fc0-d973-4f137ee12afe",
    "datacenter_name": "coal",
    "platform_buildstamp": "20151126T011339Z",
    "state": "running",
    "boot_timestamp": "2015-11-28T07:56:44.000Z",
    "pid": 5200,
    "customer_metadata": {},
    "internal_metadata": {},
    "routes": {},
    "tags": {},
    "quota": 25,
    "zfs_root_recsize": 131072,
    "zfs_filesystem": "zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zpool": "zones",
    "snapshots": []
};

function Coordinator(opts) {
    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(Coordinator, EventEmitter);

var coordinator = new Coordinator();

// Fake vmadm for testing

var fakeVmadm = {
    lookup: function (search, opts, callback) {
        //console.error('vmadm.lookup');
        if (vmadmErr) {
            callback(vmadmErr);
            return;
        }
        callback(null, vmadmVms);
    }
};

// Fake VMAPI for testing

var fakeVmapi = function (options) {
    //console.log('userAgent: ' + options.userAgent);
};

fakeVmapi.prototype.getVms = function (server_uuid, callback) {
    //console.error('vmapi.getVms');
    if (vmapiErr) {
        callback(vmapiErr);
        return;
    }
    callback(null, vmapiVms);
};

fakeVmapi.prototype.updateServerVms = function (server_uuid, vmobjs, callback) {
    //console.error('vmapi.updateServerVms');
    coordinator.emit('vmapi.updateServerVms', vmobjs, server_uuid);
    callback(); // err?
};

fakeVmapi.prototype.updateVm = function (vmobj, callback) {
    //console.error('vmapi.updateVm');
    coordinator.emit('vmapi.updateVm', vmobj);
    callback(); // err?
};

// Fake VmWatcher for testing

function fakeVmWatcher(opts) {
    fakeWatcher = this;
    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(fakeVmWatcher, EventEmitter);

fakeVmWatcher.prototype.start = function () {
    //console.error('vmwatcher.start');
};
fakeVmWatcher.prototype.stop = function () {
    //console.error('vmwatcher.start');
};
fakeVmWatcher.prototype.doEmit = function (action, vm_uuid) {
    var self = this;
    self.emit(action, vm_uuid);
};

    //self.vmapiClient = new VMAPI({...userAgent: userAgent});
       //vmapiClient.updateVm(options.cachedVm, callback);
            //self.vmapiClient.getVms(self.server_uuid, function (err, vmobjs) {
        //vmapiClient.updateServerVms(self.server_uuid, sample, function (vmapiErr) {


function createVm(template, properties) {
    var vmobj = JSON.parse(JSON.stringify(template));

    // new UUID
    // random Alias
}


/*
 * Validate that when VmAgent starts up and vmadm lookup returns a VM that
 * "GET /vms?state=active&server_uuid=..." did not, that this missing VM is
 * included in the "PUT /vms" as part of initialization.
 */
test('Startup VmAgent with VM missing from VMAPI', function (t) {
    var config = {
        log: logStub,
        server_uuid: '823250b0-9730-11e5-80bd-28cfe91a3271',
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };
    var missing_vm;

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        coordinator.removeAllListeners('vmapi.updateServerVms');
        t.equal(diff(vmobjs, vmadmVms), undefined, '"PUT /vms" includes missing VM');
        t.end();
    });

    vmapiVms = [];
    vmadmVms = [JSON.parse(JSON.stringify(standardVm))];

    missing_vm = 
    vmAgent = new VmAgent(config);
    vmAgent.start();
    vmAgent.stop(); // TODO: cleanup
});

/*
 * Validate that when VmAgent starts up and vmadm lookup is missing a VM that
 * "GET /vms?state=active&server_uuid=..." included, that this missing VM is
 * included in the "PUT /vms" as part of initialization and 'has' state and
 * 'zone_state' set to 'destroyed'.
 */
test('Startup VmAgent with VM missing from vmadm', function (t) {
    var config = {
        log: logStub,
        server_uuid: '823250b0-9730-11e5-80bd-28cfe91a3271',
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        var expected = JSON.parse(JSON.stringify(standardVm));
        expected.state = 'destroyed';
        expected.zone_state = 'destroyed';

        coordinator.removeAllListeners('vmapi.updateServerVms');
        t.equal(diff(vmobjs, [expected]), undefined, '"PUT /vms" trying to destroy VM');
        t.end();
    });

    vmadmVms = [];
    vmapiVms = [JSON.parse(JSON.stringify(standardVm))];
    vmAgent = new VmAgent(config);
    vmAgent.start();
});


//
// test w/ set of VMs then:
//
//    - create one
//    - delete one
//    - modify one
//
// all of these should result in PUT /vms/<uuid>
//

// Test w/ fake VMAPI down initially (returning errors), agent should retry
// and once retry works, then it should vmadm lookup. Perhaps also test with
// that then failing?

// Test w/ updates happening after running for a bit, and VMAPI returning errors
// also with modifications ongoing. The VMs should be loaded and PUT when VMAPI
// recovers.

// Test w/ updates happening while init is retrying. Ensure these are queued and
// processed when we finally are up. XXX: do we need to clear on each init loop
// since we're doing a full reload anyway?? Maybe start just before vmadm lookup
// and clear on error?

// Test with no differences between the two and that we don't bother sending an
// update.

// TODO: real vmadm + fake VMAPI:
//      - create a new VM -- should be sent to VMAPI
//      - delete a VM -- shouldbe updated in VMAPI as destroyed
//      - do all the modifications can think of on a VM:
//         - mdata-put/delete
//         - stop/start/reboot
//         - modify quota using zfs
//         - modify properties using vmadm
//         - etc.
//
