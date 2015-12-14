/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

var diff = require('deep-diff').diff;
var mockery = require('mockery');
var test = require('tape');
var node_uuid = require('node-uuid');
var vasync = require('vasync');
var vmadm = require('vmadm');

var common = require('./common');
var mocks = require('./mocks');


// GLOBAL
var coordinator = mocks.coordinator;
var updates = [];
var smartosImageUUID;
var VmAgent;

// For tests we can lower the frequency the periodic watcher polls so we finish
// in more reasonable time.
var PERIODIC_INTERVAL = 1000;
// Frequency to poll the updates array for changes. (ms)
var UPDATES_POLL_FREQ = 50;


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
        periodicInterval: PERIODIC_INTERVAL,
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

test('find SmartOS image', function _test(t) {
    common.testFindSmartosImage(t, function _findSmartosCb(latest) {
        smartosImageUUID = latest;
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

function createCmpObj(params, updateObj) {
    var cmpObj = {};
    var keyIdx;
    var keys;

    keys = Object.keys(params);
    for (keyIdx = 0; keyIdx < keys.length; keyIdx++) {
        if (updateObj.hasOwnProperty(keys[keyIdx])) {
            cmpObj[keys[keyIdx]] = updateObj[keys[keyIdx]];
        }
    }

    return (cmpObj);
}

function waitForUpdate(startIdx, params, cb) {
    var cmpObj;
    var diffObj;
    var foundMatch = false;
    var idx;

    for (idx = startIdx; !foundMatch && (idx < updates.length); idx++) {
        // Build a cmpObj from the update with just the keys that are in params
        // so that a comparison is only on those fields.
        cmpObj = createCmpObj(params, updates[idx]);
        diffObj = diff(params, cmpObj);
        if (!diffObj) {
            foundMatch = true;
        }
    }

    if (!foundMatch) {
        setTimeout(function _retryWaitForUpdate() {
            waitForUpdate(startIdx, params, cb);
        }, UPDATES_POLL_FREQ);
        return;
    }

    cb();
}

function performThenWait(performFn, callback) {
    var startIdx = updates.length;

    performFn(function _performCb(err, params) {
        if (err) {
            callback(err);
            return;
        }
        waitForUpdate(startIdx, params, callback);
    });
}

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
test('Real vmadm, fake VMAPI', function _test(t) {
    var config = newConfig();
    var modifiers;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID,
        uuid: node_uuid.v4(),
        log: mocks.Logger
    };
    var smartosVmUUID = 'deadbeef';
    var vmAgent;

    function _setVmadmProperty(vmUuid, prop, value, cb) {
        var expected = {};
        var update = {
            log: config.log,
            uuid: vmUuid
        };

        update[prop] = value;
        expected[prop] = value;

        vmadm.update(update, function _onVmadmUpdate(err) {
            t.ifError(err, 'vmadm.update ' + prop + '=' + value);
            cb(err, expected);
        });
    }

    // Create the list of modifications we're going to do here.
    modifiers = [
        function _setQuotaVmadm(vmUuid, cb) {
            var newQuota = 33;

            _setVmadmProperty(vmUuid, 'quota', newQuota, cb);
        }, function _setQuotaZfs(vmUuid, cb) {
            var newQuota = 66;

            execFile('/usr/sbin/zfs',
                ['set', 'quota=' + newQuota + 'g', 'zones/' + vmUuid],
                function _onZfs(err, stdout, stderr) {
                    t.ifError(err, 'zfs set quota=' + newQuota + ': '
                        + (err ? stderr : 'success'));
                    cb(err, {quota: newQuota});
                }
            );
        }, function _mdataPut(vmUuid, cb) {
            execFile('/usr/sbin/zlogin',
                [vmUuid, 'mdata-put', 'hello', 'world'],
                function _onZlogin(err, stdout, stderr) {
                    t.ifError(err, 'zlogin mdata-put hello=world: '
                        + (err ? stderr : 'success'));
                    cb(err, {customer_metadata: {hello: 'world'}});
                }
            );
        }, function _setAliasVmadm(vmUuid, cb) {
            var newAlias = payload.alias + '-HACKED';

            _setVmadmProperty(vmUuid, 'alias', newAlias, cb);
        }
    ];

    vasync.pipeline({arg: {}, funcs: [
        function _waitInitialUpdateVms(arg, cb) {
            // Wait for VmAgent init and it'll send the initial PUT /vms, these
            // are real VMs on the node because we're not faking vmadm.
            coordinator.once('vmapi.updateServerVms',
            function _onUpdateVms(vmobjs /* , server_uuid */) {
                t.ok(true, 'saw PUT /vms: (' + Object.keys(vmobjs).length
                    + ')');

                Object.keys(vmobjs).forEach(function _addVmToVmapi(vm) {
                    // ignore updates from VMs that existed when we started
                    mocks.Vmapi.addVm(vmobjs[vm]);
                });

                cb();
            });
        }, function _createVm(arg, cb) {
            // Create a VM then wait for the PUT /vm that includes it
            smartosVmUUID = payload.uuid;
            performThenWait(function _performCreate(next) {
                vmadm.create(payload, function _vmadmCreateCb(err, info) {
                    t.ifError(err, 'create VM');
                    if (!err && info) {
                        t.ok(info.uuid, 'new VM has uuid: ' + info.uuid);
                    }
                    next(err, {
                        alias: payload.alias,
                        brand: payload.brand,
                        uuid: smartosVmUUID
                    });
                });
            }, cb);
        }, function _applyModifiers(arg, cb) {
            var vmUuid = smartosVmUUID;

            function _applyModifier(modFn, _cb) {
                performThenWait(function _performMod(next) {
                    modFn(vmUuid, function _onMod(e, updateObj) {
                        t.ifError(e, 'modifier returned: '
                            + (e ? e.message : 'success'));
                        next(e, updateObj);
                    });
                }, _cb);
            }

            vasync.forEachPipeline({
                func: _applyModifier,
                inputs: modifiers
            }, function _appliedModifiers(err) {
                t.ifError(err, 'applied modifiers');
                cb(err);
            });
        }, function _destroyVm(arg, cb) {
            //  With all modifications complete, we now delete the VM which
            //  should result in one more updateVm with 'destroyed'.

            performThenWait(function _performCreate(next) {
                vmadm.delete({log: config.log, uuid: smartosVmUUID},
                    function _vmadmDeleteCb(err) {
                        t.ifError(err, 'delete VM: '
                            + (err ? err.message : 'success'));
                        next(err, {
                            uuid: smartosVmUUID,
                            state: 'destroyed',
                            zone_state: 'destroyed'
                        });
                    }
                );
            }, cb);
        }
    ]}, function _pipelineComplete(err) {
        t.ifError(err, 'pipeline complete');
        resetGlobalState(vmAgent); // so it's clean for the next test
        t.end();
    });

    coordinator.on('vmapi.updateVm', function _onVmapiUpdateVm(vmobj) {
        if (vmobj.uuid !== smartosVmUUID) {
            // ignore changes that are from other VMs on this system
            return;
        }
        updates.push(vmobj);
    });

    coordinator.on('vmadm.lookup', function _onVmadmLookup() {
        t.fail('should not have seen vmadm.lookup, should have real vmadm');
    });

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();
});
