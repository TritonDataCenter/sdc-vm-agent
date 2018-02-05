/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var util = require('util');

var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;

var VMAPI = require('../lib/vmapi-client');
var VmWatcher = require('../lib/vm-watcher');

// GLOBAL
var coordinator;
var Logger = {
    child: function _child() {
        return Logger;
    },
    trace: function _trace() {
    },
    debug: function _debug() {
    },
    info: function _info() {
    },
    warn: function _warn() {
    },
    error: function _error(err) {
        var stderrLines = err.stderrLines;

        if (stderrLines) {
            if (stderrLines[stderrLines.length - 1]
                .match(/^Requested unique lookup but found 0 results./)) {
                // VM doesn't exist, not really an error
                return;
            } else if (stderrLines[stderrLines.length - 1]
                .match(/^ENOENT, open.*\.xml/)) {
                // VM doesn't exist, not really an error
                return;
            }
        } else if (err.stderr && (err.stderr.match(/^ENOENT, open.*\.xml/)
            || (err.stderr.match(/unable to load \/etc\/zones\/.*.xml/)))) {
            // VM doesn't exist, not really an error
            return;
        }
        console.log(err); // eslint-disable-line
    }
};
var vmadmVms = [];
var vmadmErr = null;
var vmapiVms = [];
var vmapiGetErr = null;
var vmapiPutErr = null;
var vmapiErrVms = {};


/*
 * VMAPI translates the VM objects when reading from Moray (see sdc-vmapi
 * lib/common/vm-common.js) and we want to be able to make VMs look like they
 * would from VMAPI so we've copied that logic here.
 *
 */
function vmapifyVm(vmobj) {
    var defaultFields = JSON.parse(JSON.stringify(VMAPI.VMAPI_DEFAULT_FIELDS));
    var newObj;

    assert.object(vmobj);

    newObj = JSON.parse(JSON.stringify(vmobj));
    if (newObj.brand === 'kvm') {
        [
            'cpu_type',
            'disks',
            'vcpus'
        ].forEach(function _addKvmDefaultField(f) {
            defaultFields[f] = null;
        });
    } else {
        defaultFields.image_uuid = null;
    }

    Object.keys(defaultFields).forEach(function _addMissingField(field) {
        if (!newObj.hasOwnProperty(field)) {
            newObj[field] = defaultFields[field];
        }
    });

    if (!newObj.ram && newObj.max_physical_memory) {
        newObj.ram = newObj.max_physical_memory;
    }

    return (newObj);
}

function vmadmifyVm(vmobj) {
    var newObj;

    assert.object(vmobj, 'vmobj');
    assert.uuid(vmobj.uuid, 'vmobj.uuid');
    assert.string(vmobj.brand, 'vmobj.brand');
    assert.string(vmobj.state, 'vmobj.state');
    assert.string(vmobj.zone_state, 'vmobj.zone_state');

    newObj = JSON.parse(JSON.stringify(vmobj));
    if (!vmobj.snapshots) {
        newObj.snapshots = [];
    }

    return (newObj);
}


/*
 * This coordinator is an event emitter that we use from within the mocks to
 * tell us when those functions have occurred. Tests can watch for events which
 * indicate the calling of each function. and the event will include the
 * relevant function parameters.
 */
function Coordinator() {
    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(Coordinator, EventEmitter);
coordinator = new Coordinator();


/*
 * vmadm mock
 */

function fakeVmadm() {
}

fakeVmadm.lookup = function fakeVmadmLookup(search, opts, callback) {
    setImmediate(function _emitImmediately() {
        coordinator.emit('vmadm.lookup', search, opts);
    });
    if (vmadmErr) {
        callback(vmadmErr);
        return;
    }
    callback(null, vmadmVms);
};

fakeVmadm.load = function fakeVmadmLoad(opts, callback) {
    var err;
    var vmobj;
    var vmobjIdx;

    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    for (vmobjIdx = 0; vmobjIdx < vmadmVms.length; vmobjIdx++) {
        if (vmadmVms[vmobjIdx].uuid === opts.uuid) {
            vmobj = vmadmVms[vmobjIdx];
        }
    }

    if (!vmobj) {
        err = new Error('vmadm lookup ' + opts.uuid + ' failed: No such zone');
        err.restCode = 'VmNotFound';
        err.stderr = 'fake vmadm does not include ' + opts.uuid;
    }

    // Force an error if the caller wanted one.
    if (vmadmErr) {
        err = vmadmErr;
        vmobj = null;
    }

    setImmediate(function _emitImmediately() {
        coordinator.emit('vmadm.load', opts, err);
    });

    callback(err, vmobj);
};

// These last functions don't exist in the real vmadm client, but we use them to
// manage the set of expected VMs / errors for our fake VMAPI.
fakeVmadm.putVm = function putVm(vmobj) {
    var vmIdx;

    assert.object(vmobj, 'vmobj');
    assert.uuid(vmobj.uuid, 'vmobj.uuid');

    for (vmIdx = 0; vmIdx < vmadmVms.length; vmIdx++) {
        if (vmadmVms[vmIdx].uuid === vmobj.uuid) {
            // If the VM is already here, we just replace the existing object
            vmadmVms[vmIdx] = vmadmifyVm(vmobj);
            return;
        }
    }

    vmadmVms.push(vmadmifyVm(vmobj));
};

fakeVmadm.clearVms = function clearVms() {
    vmadmVms = [];
};

fakeVmadm.peekVms = function peekVms() {
    return (vmadmVms);
};

fakeVmadm.setError = function setError(err) {
    vmadmErr = err;
};

fakeVmadm.getError = function getError() {
    return (vmadmErr);
};

fakeVmadm.events = function vmadmEvents(opts, handler, cb) {
    cb(new Error('Not Implemented'));
};


/*
 * Fake VMAPI for testing
 *
 * NOTE: We never use the real VMAPI, so we don't check current.vmapi
 *
 */

function fakeVmapi() {
}

fakeVmapi.prototype.getVms = function getVms(server_uuid, callback) {
    assert.uuid(server_uuid, 'server_uuid');
    assert.func(callback, 'callback');

    setImmediate(function _emitImmediately() {
        coordinator.emit('vmapi.getVms', server_uuid,
            (vmapiGetErr ? vmapiGetErr : null));
    });
    if (vmapiGetErr) {
        callback(vmapiGetErr);
        return;
    }
    callback(null, vmapiVms);
};

fakeVmapi.prototype.updateServerVms = // eslint-disable-line
function updateServerVms(server_uuid, vmobjs, callback) {
    assert.uuid(server_uuid, 'server_uuid');
    assert.object(vmobjs, 'vmobjs');
    assert.func(callback, 'callback');

    setImmediate(function _emitImmediately() {
        coordinator.emit('vmapi.updateServerVms', vmobjs, server_uuid,
            (vmapiPutErr ? vmapiPutErr : null));
    });
    if (vmapiPutErr) {
        callback(vmapiPutErr);
        return;
    }
    callback();
};

fakeVmapi.prototype.updateVm = function updateVm(vmobj, callback) {
    var err;

    assert.object(vmobj, 'vmobj');
    assert.func(callback, 'callback');

    if (vmapiPutErr) {
        err = vmapiPutErr;
    } else if (vmapiErrVms[vmobj.uuid]) {
        err = vmapiErrVms[vmobj.uuid];
    }

    setImmediate(function _emitImmediately() {
        coordinator.emit('vmapi.updateVm', vmobj,
            (err ? err : null));
    });

    callback(err);
};

// These last functions don't exist in the real vmapi client, but we use them to
// manage the set of expected VMs / errors for our fake VMAPI.
fakeVmapi.putVm = function putVm(vmobj) {
    var vmIdx;

    assert.object(vmobj, 'vmobj');

    for (vmIdx = 0; vmIdx < vmapiVms.length; vmIdx++) {
        if (vmapiVms[vmIdx].uuid === vmobj.uuid) {
            // If the VM is already here, we just replace the existing object
            vmapiVms[vmIdx] = vmapifyVm(vmobj);
            return;
        }
    }

    vmapiVms.push(vmapifyVm(vmobj));
};

fakeVmapi.clearVms = function clearVms() {
    vmapiVms = [];
};

fakeVmapi.peekVms = function peekVms() {
    return (vmapiVms);
};

fakeVmapi.setGetError = function setGetError(err) {
    vmapiGetErr = err;
};

fakeVmapi.getGetError = function getGetError() {
    return (vmapiGetErr);
};

fakeVmapi.setPutError = function setPutError(err) {
    vmapiPutErr = err;
};

fakeVmapi.setVmError = function setVmError(vmUuid, err) {
    assert.uuid(vmUuid, 'vmUuid');

    if (!err) {
        delete vmapiErrVms[vmUuid];
        return;
    }
    vmapiErrVms[vmUuid] = err;
};

fakeVmapi.getPutError = function getPutError() {
    return (vmapiPutErr);
};

fakeVmapi.VMAPI_DEFAULT_FIELDS = VMAPI.VMAPI_DEFAULT_FIELDS;
fakeVmapi.VMAPI_ALWAYS_SET_FIELDS = VMAPI.VMAPI_ALWAYS_SET_FIELDS;


// Fake VmWatcher for testing

function fakeVmWatcher() {
    var self = this;

    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(self);
}
util.inherits(fakeVmWatcher, EventEmitter);

fakeVmWatcher.prototype.start = function start(cb) {
    // console.error('vmwatcher.start');
    if (cb) {
        cb();
        return;
    }
};

fakeVmWatcher.prototype.stop = function stop() {
    // console.error('vmwatcher.start');
};

fakeVmWatcher.WATCHED_FIELDS = VmWatcher.WATCHED_FIELDS;


function fakeBackend(opts) {
    var self = this;

    self.config = opts.config;
    self.log = opts.log;
    self.name = 'fakeBackend';
}

fakeBackend.prototype.loadConfig = function loadConfig(callback) {
    var self = this;

    callback(null, self.config);
};


// Anything tests should do between runs to cleanup should go in resetState().
function resetState() {
    coordinator.removeAllListeners();
    vmadmErr = null;
    vmadmVms = [];
    vmapiGetErr = null;
    vmapiPutErr = null;
    vmapiVms = [];
}

module.exports = {
    backend: fakeBackend,
    coordinator: coordinator,
    Logger: Logger,
    resetState: resetState,
    Vmadm: fakeVmadm,
    vmadmifyVm: vmadmifyVm,
    Vmapi: fakeVmapi,
    vmapifyVm: vmapifyVm,
    VmWatcher: fakeVmWatcher
};
