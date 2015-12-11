/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var VMAPI = require('../lib/vmapi-client');

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
        if (err.stderrLines && err.stderrLines[err.stderrLines.length - 1]
            .match(/^Requested unique lookup but found 0 results./)) {
            // ignore non-existent errors
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


/*
 * VMAPI translates the VM objects when reading from Moray (see sdc-vmapi
 * lib/common/vm-common.js) and we want to be able to make VMs look like they
 * would from VMAPI so we've copied that logic here.
 *
 */
function vmapifyVm(vmobj) {
    var defaultFields = JSON.parse(JSON.stringify(VMAPI.VMAPI_DEFAULT_FIELDS));
    var newObj = JSON.parse(JSON.stringify(vmobj));

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
    var newObj = JSON.parse(JSON.stringify(vmobj));

    assert.uuid(vmobj.uuid, 'vmobj.uuid');
    assert.string(vmobj.brand, 'vmobj.brand');
    assert.string(vmobj.state, 'vmobj.state');
    assert.string(vmobj.zone_state, 'vmobj.zone_state');

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
    process.nextTick(function _delayedLookupEmit() {
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

    process.nextTick(function _delayedLoadEmit() {
        coordinator.emit('vmadm.load', opts, err);
    });

    callback(err, vmobj);
};


// These last functions don't exist in the real vmadm client, but we use them to
// manage the set of expected VMs / errors for our fake VMAPI.
fakeVmadm.addVm = function addVm(vmobj) {
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


/*
 * Fake VMAPI for testing
 *
 * NOTE: We never use the real VMAPI, so we don't check current.vmapi
 *
 */

function fakeVmapi() {
}


fakeVmapi.prototype.getVms = function getVms(server_uuid, callback) {
    process.nextTick(function _delayedGetEmit() {
        coordinator.emit('vmapi.getVms', server_uuid);
    });
    if (vmapiGetErr) {
        callback(vmapiGetErr);
        return;
    }
    callback(null, vmapiVms);
};


fakeVmapi.prototype.updateServerVms = // eslint-disable-line
function updateServerVms(server_uuid, vmobjs, callback) {
    process.nextTick(function _delayedUpdateVmsEmit() {
        coordinator.emit('vmapi.updateServerVms', vmobjs, server_uuid);
    });
    if (vmapiPutErr) {
        callback(vmapiPutErr);
        return;
    }
    callback();
};


fakeVmapi.prototype.updateVm = function updateVm(vmobj, callback) {
    process.nextTick(function _delayedUpdateVmEmit() {
        coordinator.emit('vmapi.updateVm', vmobj,
            (vmapiPutErr ? vmapiPutErr : null));
    });
    if (vmapiPutErr) {
        callback(vmapiPutErr);
        return;
    }
    callback();
};


// These last functions don't exist in the real vmapi client, but we use them to
// manage the set of expected VMs / errors for our fake VMAPI.
fakeVmapi.addVm = function addVm(vmobj) {
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


fakeVmapi.getPutError = function getPutError() {
    return (vmapiPutErr);
};


fakeVmapi.VMAPI_DEFAULT_FIELDS = VMAPI.VMAPI_DEFAULT_FIELDS;
fakeVmapi.VMAPI_UNSET_FIELDS = VMAPI.VMAPI_UNSET_FIELDS;


// Fake VmWatcher for testing

function fakeVmWatcher() {
    var self = this;

    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(self);
}
util.inherits(fakeVmWatcher, EventEmitter);


fakeVmWatcher.prototype.start = function start() {
    // console.error('vmwatcher.start');
};


fakeVmWatcher.prototype.stop = function stop() {
    // console.error('vmwatcher.start');
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
    coordinator: coordinator,
    Logger: Logger,
    resetState: resetState,
    Vmadm: fakeVmadm,
    vmadmifyVm: vmadmifyVm,
    Vmapi: fakeVmapi,
    vmapifyVm: vmapifyVm,
    VmWatcher: fakeVmWatcher
};
