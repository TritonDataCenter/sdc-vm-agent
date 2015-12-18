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
        periodic_interval: PERIODIC_INTERVAL,
        vmapi_url: 'http://127.0.0.1/'
    };

    return (config);
}

function resetGlobalState(vmAgent) {
    if (vmAgent) {
        vmAgent.stop();
    }
    mocks.resetState();
    updates = [];
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

function createCmpObj(params, updateObj) {
    var cmpObj = {};
    var keyIdx;
    var keys;

    keys = Object.keys(params);
    for (keyIdx = 0; keyIdx < keys.length; keyIdx++) {
        if (updateObj.hasOwnProperty(keys[keyIdx])) {
            if (keys[keyIdx] === 'snapshots') {
                // just keep 'name' for snapshot since we don't really care to
                // match created_at
                cmpObj[keys[keyIdx]] = updateObj[keys[keyIdx]].map(
                    function _mapSnapshot(snap) {
                        return ({name: snap.name});
                    }
                );
            } else {
                cmpObj[keys[keyIdx]] = updateObj[keys[keyIdx]];
            }
        }
    }

    return (cmpObj);
}

function waitForUpdate(startIdx, params, cb) {
    var cmpObj;
    var diffObj;
    var filteredDiff;
    var foundMatch = false;
    var idx;

    for (idx = startIdx; !foundMatch && (idx < updates.length); idx++) {
        // Build a cmpObj from the update with just the keys that are in params
        // so that a comparison is only on those fields.
        cmpObj = createCmpObj(params, updates[idx]);
        diffObj = diff(params, cmpObj);
        if (diffObj) {
            filteredDiff = diffObj.filter(function _removeNotDiffs(_diff) {
                if (typeof (_diff.lhs) === 'string' && _diff.rhs
                    && _diff.lhs[0] === '!'
                    && _diff.lhs.slice(1) !== _diff.rhs.toString()) {
                    // This matches the negation
                    return (false);
                }
                return (true);
            });

            if (filteredDiff.length === 0) {
                foundMatch = true;
            }
        } else {
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
        }, function _stopVm(vmUuid, cb) {
            var opts = {
                log: config.log,
                uuid: payload.uuid
            };

            vmadm.stop(opts, function _vmadmStopCb(err) {
                t.ifError(err, 'stop VM');
                cb(err, {state: 'stopped', zone_state: 'installed'});
            });
        }, function _startVm(vmUuid, cb) {
            var opts = {
                log: config.log,
                uuid: payload.uuid
            };

            vmadm.start(opts, function _vmadmStartCb(err) {
                t.ifError(err, 'start VM');
                cb(err, {state: 'running', zone_state: 'running'});
            });
        }, function _rebootVm(vmUuid, cb) {
            var opts = {
                log: config.log,
                uuid: payload.uuid
            };

            vmadm.reboot(opts, function _vmadmRebootCb(err) {
                var lastIdx = updates.length - 1;
                var prevPid = updates[lastIdx].pid;
                var prevBootTimestamp = updates[lastIdx].boot_timestamp;

                t.ifError(err, 'reboot VM');

                cb(err, {
                    boot_timestamp: '!' + prevBootTimestamp,
                    pid: '!' + prevPid
                });
            });
        }, function _snapshotVm(vmUuid, cb) {
            var opts = {
                log: config.log,
                snapshot_name: 'snappy',
                uuid: payload.uuid
            };

            vmadm.create_snapshot(opts, function _vmadmCreateSnapCb(err) {
                t.ifError(err, 'created snapshot for VM ' + smartosVmUUID);

                cb(err, {
                    snapshots: [{name: 'snappy'}]
                });
            });
        }, function _rollbackVm(vmUuid, cb) {
            var lastIdx = updates.length - 1;
            var opts = {
                log: config.log,
                snapshot_name: 'snappy',
                uuid: payload.uuid
            };
            var prevPid = updates[lastIdx].pid;
            var prevBootTimestamp = updates[lastIdx].boot_timestamp;

            vmadm.rollback_snapshot(opts, function _vmadmRollbackSnapCb(err) {
                t.ifError(err, 'rollback snapshot for VM ' + smartosVmUUID);

                cb(err, {
                    boot_timestamp: '!' + prevBootTimestamp,
                    pid: '!' + prevPid,
                    snapshots: [{name: 'snappy'}]
                });
            });
        }, function _deleteSnapshot(vmUuid, cb) {
            var opts = {
                log: config.log,
                snapshot_name: 'snappy',
                uuid: payload.uuid
            };

            vmadm.delete_snapshot(opts, function _vmadmDeleteSnapCb(err) {
                t.ifError(err, 'delete snapshot for VM ' + smartosVmUUID);

                cb(err, {
                    snapshots: []
                });
            });
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

                Object.keys(vmobjs).forEach(function _putVmToVmapi(vm) {
                    // ignore updates from VMs that existed when we started
                    mocks.Vmapi.putVm(vmobjs[vm]);
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

            performThenWait(function _performDelete(next) {
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

/*
 * Test w/ VMAPI returning 409, but only for *1* VM, all others should be
 * updating successfully. Ensures that when 1 VM is broken and can't update to
 * VMAPI, other changes still go through.
 */

test('Real vmadm, fake VMAPI: 1 invalid VM', function _test(t) {
    var brokenVmUuid;
    var config = newConfig();
    var createUnbrokenVms = 5;
    var payload = {
        alias: 'vm-agent_testvm',
        brand: 'joyent-minimal',
        image_uuid: smartosImageUUID
    };
    var vmAgent;
    var vms = [];
    var waitForUpdatesAfterFixing = 95000; // max delay is 30s, so catch 3+

    vasync.pipeline({arg: {}, funcs: [
        function _waitInitialUpdateVms(arg, cb) {
            // Wait for VmAgent init and it'll send the initial PUT /vms, these
            // are real VMs on the node because we're not faking vmadm.
            coordinator.once('vmapi.updateServerVms',
            function _onUpdateVms(vmobjs /* , server_uuid */) {
                t.ok(true, 'saw PUT /vms: (' + Object.keys(vmobjs).length
                    + ')');

                Object.keys(vmobjs).forEach(function _putVmToVmapi(vm) {
                    // ignore updates from VMs that existed when we started
                    mocks.Vmapi.putVm(vmobjs[vm]);
                });

                cb();
            });
        }, function _createBrokenVm(arg, cb) {
            // Create a VM then wait for the PUT /vm that includes it (which
            // should fail)
            var thisPayload = JSON.parse(JSON.stringify(payload));
            var vmapiErr;

            thisPayload.uuid = node_uuid.v4();
            thisPayload.alias = payload.alias + '-' + vms.length;
            thisPayload.log = config.log;
            brokenVmUuid = thisPayload.uuid;

            // simulate 409 ValidationFailed
            vmapiErr = new Error('Invalid Parameters');
            vmapiErr.code = 'ValidationFailed';
            mocks.Vmapi.setVmError(brokenVmUuid, vmapiErr);

            // this will wait for the first attempt on this VM
            performThenWait(function _performCreate(next) {
                vmadm.create(thisPayload, function _vmadmCreateCb(err, info) {
                    t.ifError(err, 'create broken VM');
                    if (!err && info) {
                        t.ok(info.uuid, 'new broken VM has uuid: ' + info.uuid);
                    }
                    vms.push(info.uuid);
                    next(err, {
                        alias: thisPayload.alias,
                        brand: thisPayload.brand,
                        uuid: thisPayload.uuid
                    });
                });
            }, cb);
        }, function _createOtherVms(arg, cb) {
            var uuids = [];

            function _createOneVm(uuid, _createOneCb) {
                var thisPayload = JSON.parse(JSON.stringify(payload));

                thisPayload.uuid = uuid;
                thisPayload.alias = payload.alias + '-' + vms.length;
                thisPayload.log = config.log;

                performThenWait(function _performCreate(next) {
                    vmadm.create(thisPayload,
                        function _vmadmCreateCb(err, info) {
                            t.ifError(err, 'create VM');
                            if (!err && info) {
                                t.ok(info.uuid, 'new VM has uuid: '
                                    + info.uuid);
                            }
                            vms.push(info.uuid);
                            next(err, {
                                alias: thisPayload.alias,
                                brand: thisPayload.brand,
                                uuid: thisPayload.uuid
                            });
                        }
                    );
                }, _createOneCb);
            }

            while (uuids.length < createUnbrokenVms) {
                uuids.push(node_uuid.v4());
            }

            // create those VMs
            vasync.forEachPipeline({inputs: uuids, func: _createOneVm}, cb);
        }, function _checkVmapiForBrokenVm(arg, cb) {
            var foundBroken = 0;
            var foundNonBroken = 0;
            var vmapiVms = mocks.Vmapi.peekVms();

            vmapiVms.forEach(function _checkVm(vm) {
                if (vm.uuid === brokenVmUuid) {
                    foundBroken++;
                } else if (vms.indexOf(vm.uuid) !== -1) {
                    foundNonBroken++;
                }
            });

            t.equal(foundBroken, 0, 'broken VM should not be in VMAPI');
            t.equal(foundNonBroken, createUnbrokenVms,
                'all non-broken VMs should be in VMAPI');

            cb();
        }, function _checkBrokenRetrying(arg, cb) {
            var updateIdx = updates.length;

            setTimeout(function _afterWaitingForUpdates() {
                var idx;
                var newBrokenUpdates = 0;
                var oldBrokenUpdates = 0;

                for (idx = 0; idx < updates.length; idx++) {
                    if (idx < updateIdx && updates[idx].uuid === brokenVmUuid) {
                        // updates for this VM, from before our delay
                        oldBrokenUpdates++;
                    } else if (updates[idx].uuid === brokenVmUuid) {
                        // updates for this VM, after our delay
                        newBrokenUpdates++;
                    }
                }

                t.ok(newBrokenUpdates > 0, 'saw ' + newBrokenUpdates
                    + ' update attempts for broken VM (was still trying)');
                t.ok(true, 'total updates for VM: ' + newBrokenUpdates
                    + oldBrokenUpdates);
                cb();
            }, waitForUpdatesAfterFixing);
        }, function _clearProblem(arg, cb) {
            // Tell fake VMAPI that this VM is no longer a problem, then wait
            // for it to get an update and have this VM.
            performThenWait(function _performClearProblem(next) {
                mocks.Vmapi.setVmError(brokenVmUuid, null);
                next(null, {
                    uuid: brokenVmUuid
                });
            }, function _problemCleared(err) {
                var found = false;
                var vmapiVms = mocks.Vmapi.peekVms();

                t.ifError(err, 'cleared problem for broken VM');

                // now: make sure that it exists in VMAPI
                vmapiVms.forEach(function _checkEachVm(vm) {
                    if (vm.uuid === brokenVmUuid) {
                        found = true;
                    }
                });

                t.ok(found, 'found previously broken VM in VMAPI after problem'
                    + ' was cleared');
                cb();
            });
        }, function _destroyVms(arg, cb) {
            //  With all modifications complete, we now delete the VM which
            //  should result in one more updateVm with 'destroyed'.

            function _destroyOneVm(uuid, _destroyOneCb) {
                performThenWait(function _performDelete(next) {
                    vmadm.delete({log: config.log, uuid: uuid},
                        function _vmadmDeleteCb(err) {
                            t.ifError(err, 'delete VM ' + uuid + ': '
                                + (err ? err.message : 'success'));
                            next(err, {
                                uuid: uuid,
                                state: 'destroyed',
                                zone_state: 'destroyed'
                            });
                        }
                    );
                }, _destroyOneCb);
            }

            // destroy them all
            vasync.forEachPipeline({inputs: vms, func: _destroyOneVm}, cb);
        }
    ]}, function _pipelineComplete(err) {
        t.ifError(err, 'pipeline complete');
        resetGlobalState(vmAgent); // so it's clean for the next test
        t.end();
    });

    coordinator.on('vmapi.updateVm', function _onVmapiUpdateVm(vmobj, err) {
        if (!err) {
            mocks.Vmapi.putVm(vmobj);
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
