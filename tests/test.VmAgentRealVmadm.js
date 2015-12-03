/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var diff = require('deep-diff').diff;
var execFile = require('child_process').execFile;
var mockery = require('mockery');
var mocks = require('./mocks');
var test = require('tape');
var node_uuid = require('node-uuid');
var vasync = require('vasync');
var vmadm = require('vmadm');


// GLOBAL
var coordinator = mocks.coordinator;
var smartosImageUUID;
var VmAgent;


/*
 * Create a VmAgent with VMAPI mocked out using mocks.Vmapi
 */
mockery.enable({useCleanCache: true, warnOnUnregistered: false});
mockery.registerMock('./vmapi-client', mocks.Vmapi);
VmAgent = require('../lib/vm-agent');
mockery.disable();


function newConfig() {
    var config = {
        log: mocks.Logger,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/'
    };

    return (config);
}

function resetGlobalState(vmAgent) {
    if (vmAgent) {
        vmAgent.stop();
    }
    mocks.resetState();
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
        // If this fails you should import a SmartOS image and try again
        t.ok(smartosImageUUID, 'found SmartOS image_uuid: '
            + smartosImageUUID);
        t.end();
    });
});

//
// TODO: more modifiers:
//   - stop/start/reboot
//   - snapshots
//   - add a nic
//
// TODO?: KVM?
//   - add kvm disks
//

/*
 * Create an initially empty fake VMAPI. Allow it to fill with the existing VMs
 * on the system. Then create a new VM using the real vmadm and ensure we're
 * able to detect the change with the real VmWatcher.
 *
 * We perform several changes to the VM using vmadm, zfs and zlogin/mdata-put
 * and then ensure that each of these results in the correct update. When all
 * updates are complete, we delete the VM.
 *
 */
test('Real vmadm, fake VMAPI', function (t) {
    var config = newConfig();
    var done = false;
    var exampleVm;
    var modifiers;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        uuid: node_uuid.v4(),
        log: mocks.Logger
    };
    var smartosVmUUID;
    var vmAgent;

    function _setVmadmProperty(exVm, prop, value, cb) {
        var update = {
            log: config.log,
            uuid: exVm.uuid
        };
        update[prop] = value;

        vmadm.update(update, function _onVmadmUpdate(err) {
            t.ifError(err, 'vmadm.update ' + prop + '=' + value);
            if (!err) {
                // we expect prop to be updated now.
                exVm[prop] = value;
            }
            cb(err);
        });
    }

    // Create the list of modifications we're going to do here.
    modifiers = [
        function _setQuotaVmadm(exVm, cb) {
            var newQuota = (exVm.quota || 10) * 2;
            _setVmadmProperty(exVm, 'quota', newQuota, cb);
        }, function _setQuotaZfs(exVm, cb) {
            var newQuota = (exVm.quota || 10) * 2;

            execFile('/usr/sbin/zfs',
                ['set', 'quota=' + newQuota + 'g', 'zones/' + exVm.uuid],
                function (err, stdout, stderr) {
                    t.ifError(err, 'zfs set quota=' + newQuota + ': '
                        + (err ? stderr : 'success'));
                    if (!err) {
                        // we expect quota to be updated now.
                        exVm.quota = newQuota;
                    }
                    cb(err);
                }
            );
        }, function _mdataPut(exVm, cb) {
            execFile('/usr/sbin/zlogin',
                [exVm.uuid, 'mdata-put', 'hello', 'world'],
                function (err, stdout, stderr) {
                    t.ifError(err, 'zlogin mdata-put hello=world: '
                        + (err ? stderr : 'success'));
                    if (!err) {
                        // we expect metadata to be updated now.
                        exVm.customer_metadata.hello = 'world';
                    }
                    cb(err);
                }
            );
        }, function _setAliasVmadm(exVm, cb) {
            var newAlias = exVm.alias + '-HACKED';

            _setVmadmProperty(exVm, 'alias', newAlias, cb);
        }
    ];

    // 1. When the agent starts up, we'll wait until it updates us with the
    //    list of VMs. Note that these are real VMs on this node because we're
    //    not faking vmadm.
    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        t.ok(true, 'saw PUT /vms: (' + Object.keys(vmobjs.vms).length + ')');

        Object.keys(vmobjs.vms).forEach(function _addVmToVmapi(vm) {
            mocks.Vmapi.addVm(vmobjs.vms[vm]);
        });

        // 2. Create a VM, this should trigger the first vmapi.updateVm call.
        smartosVmUUID = payload.uuid;
        vmadm.create(payload, function (err, info) {
            t.ifError(err, 'create VM');
            if (!err && info) {
                t.ok(info.uuid, 'new VM has uuid: ' + info.uuid);
            } else {
                t.fail('bailing early: vmadm.create failed');
                done = true;
            }
        });
    });

    // 3. After startup the work will be done by performing an update and then
    // ensuring the vmapi.updateVm operation occurs for that change.
    coordinator.on('vmapi.updateVm', function (vmobj) {
        if (vmobj.uuid !== smartosVmUUID) {
            // ignore changes that are from other VMs on this system
            return;
        }
        vasync.pipeline({arg: {}, funcs: [
            function (arg, cb) {
                // load the VM from vmadm if we've not done so
                if (exampleVm) {
                    cb();
                    return;
                }
                vmadm.load({log: config.log, uuid: smartosVmUUID},
                    function (e, vm) {
                        t.ifError(e, 'load VM');
                        if (!e) {
                            exampleVm = vm;
                        }
                        cb(e);
                    }
                );
            }, function _fixLastModified(arg, cb) {
                // The one exception to our comparison is last_modified because
                // last_modified will be updated when other fields are updated
                // through vmadm. So if last_modified was updated we update the
                // example with that so our comparison doesn't break.
                if (vmobj.last_modified > exampleVm.last_modified) {
                    exampleVm.last_modified = vmobj.last_modified;
                }
                cb();
            }, function _compareVm(arg, cb) {
                var diffs = diff(vmobj, exampleVm);

                // diffs is undefined when they match
                t.notOk(diffs, 'update matches exampleVm');
                if (!diffs) {
                    cb();
                    return;
                }
                cb(new Error('PUT to VMAPI doesn\'t match current expected'));
            }, function _determineMode(arg, cb) {
                // We'll be in one of 3 modes here:
                //
                //  a) we have modifiers to apply
                //  b) modifications are complete and we should delete
                //  c) we're waiting for the deletion update
                //
                if (modifiers.length > 0) {
                    arg.mode = 'modify'; // a)
                } else if (vmobj.state !== 'destroyed'
                    || vmobj.zone_state !== 'destroyed') {
                    arg.mode = 'destroy'; // b)
                } else {
                    arg.mode = 'destroy_wait'; // c)
                }
                cb();
            }, function _applyModifier(arg, cb) {
                if (arg.mode !== 'modify') {
                    cb();
                    return;
                }
                // If there are still modifications to be done, do the next one.
                (modifiers.shift())(exampleVm, function _onMod(err) {
                    t.ifError(err, 'modifier returned: '
                        + (err ? err.message : 'success'));
                    if (err) {
                        modifiers = [];
                    }
                    cb(err);
                });
            }, function _destroyVm(arg, cb) {
                if (arg.mode !== 'destroy') {
                    cb();
                    return;
                }
                // 4. With all modifications complete, we now delete the VM which
                //    should result in one more updateVm with 'destroyed'.
                t.ok(true, 'all modifications complete');
                vmadm.delete({log: config.log, uuid: exampleVm.uuid},
                    function _onDelete(err) {
                        t.ifError(err, 'delete VM: '
                            + (err ? err.message : 'success'));

                        if (!err) {
                            // expect one final update with state = destroyed
                            exampleVm.state = 'destroyed';
                            exampleVm.zone_state = 'destroyed';
                        }

                        cb(err);
                    }
                );
            }, function _waitDestroy(arg, cb) {
                if (arg.mode !== 'destroy_wait') {
                    cb();
                    return;
                }
                // 5. The VM has been destroyed and all is right with the world.
                t.ok(true, 'VmAgent told us VM was destroyed');
                done = true;
                cb();
            }
        ]}, function (err) {
            if (err) {
                done = true;
                return;
            }
        });
    });

    coordinator.on('vmadm.lookup', function () {
        t.fail('should not have seen vmadm.lookup, should have real vmadm');
        done = true;
    });

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            resetGlobalState(vmAgent); // so it's clean for the next test
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});
