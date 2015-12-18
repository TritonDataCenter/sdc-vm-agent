/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This module contains the VmapiClient object which has functions for
 * interaction with VMAPI.
 *
 */

var assert = require('assert-plus');
var restify = require('restify-clients');


/*
 * VMAPI has default values for some fields when the fields are not actually
 * in the VM objects in Moray. For some of those fields such as:
 *
 *  autoboot: null
 *  brand: null
 *  firewall_enabled: false
 *  nics: []
 *  platform_buildstamp: null
 *  resolvers: []
 *  server_uuid: null
 *  snapshots: []
 *  state: null
 *  tags: {}
 *  zone_state: null
 *  zonepath: null
 *
 * vmadm *also* always has these, so any time they're different we still want to
 * do an update. The ones VMAPI always includes that are *not* always in vmadm
 * objects are put into VMAPI_ALWAYS_SET_FIELDS here so that we can detect their
 * default values and not force an update when the vmadm object does not have
 * these but the VMAPI object does and has the default value.
 *
 * If we did do that update, we'd be updating such a VM on every restart since
 * VMAPI would always give us an object with these properties even if the
 * correct object were in Moray.
 *
 * We have also excluded:
 *
 *  customer_metadata: {}
 *  internal_metadata: {}
 *
 * since these are not in the WATCHED_FIELDS of VmWatcher with the current set
 * of watchers. If they're added we'll need to do a bit more complicated
 * comparison since we'll have to treat {} from VMAPI and not having either of
 * these from vmadm as equivalent.
 *
 */
var VMAPI_ALWAYS_SET_FIELDS = {
    alias: null,
    billing_id: null,
    cpu_cap: null,
    cpu_shares: null,
    create_timestamp: null,
    datasets: [],
    destroyed: null,
    image_uuid: null,
    last_modified: null,
    limit_priv: null,
    max_locked_memory: null,
    max_lwps: null,
    max_physical_memory: null,
    max_swap: null,
    owner_uuid: null,
    quota: null,
    ram: null,
    zfs_filesystem: null,
    zfs_io_priority: null,
    zpool: null
};

// Fields VMAPI adds if not set
var VMAPI_DEFAULT_FIELDS;


// Builds and returns a new object which includes all the keys from both a and b
function mergeObjs(a, b) {
    var c = {};
    var keyIdx;
    var keys;

    keys = Object.keys(a);
    for (keyIdx = 0; keyIdx < keys.length; keyIdx++) {
        c[keys[keyIdx]] = a[keys[keyIdx]];
    }

    keys = Object.keys(b);
    for (keyIdx = 0; keyIdx < keys.length; keyIdx++) {
        c[keys[keyIdx]] = b[keys[keyIdx]];
    }

    return (c);
}

/*
 * This will be the list of all the default fields an object will have in VMAPI
 * including both those that are added even if they're unset, and those that are
 * always set.
 */
VMAPI_DEFAULT_FIELDS = mergeObjs(VMAPI_ALWAYS_SET_FIELDS, {
    autoboot: null,
    brand: null,
    customer_metadata: {},
    firewall_enabled: false,
    internal_metadata: {},
    nics: [],
    platform_buildstamp: null,
    resolvers: null,
    server_uuid: null,
    snapshots: [],
    state: null,
    tags: {},
    zone_state: null,
    zonepath: null
});

function VmapiClient(options) {
    this.options = options;
    this.log = options.log;

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.string(options.url, 'options.url');

    this.client = restify.createJsonClient({
        url: options.url,
        log: options.log,
        userAgent: options.userAgent
    });
}

/*
 * Updates all VMs for a server on VMAPI
 *
 */
VmapiClient.prototype.updateServerVms = // eslint-disable-line
function updateServerVms(server, vms, callback) {
    var log = this.log;
    var query = {server_uuid: server};
    var opts = {path: '/vms', query: query};

    assert.uuid(server, 'server');
    assert.object(vms, 'vms');
    assert.func(callback, 'callback');

    this.client.put(opts, {vms: vms}, function _putVmsCb(err /* , req, res */) {
        if (err) {
            log.error(err, 'Could not update VMs for server');
            return callback(err);
        }

        log.info('VMs updated for server');
        return callback();
    });
};

/*
 * Updates a VM on VMAPI
 *
 */
VmapiClient.prototype.updateVm = function updateVm(vm, callback) {
    var log = this.log;
    var opts = {path: '/vms/' + vm.uuid};

    assert.object(vm, 'vm');
    assert.uuid(vm.uuid, 'vm.uuid');
    assert.optionalString(vm.state, 'vm.state');
    assert.optionalString(vm.last_modified, 'vm.last_modified');
    assert.func(callback, 'callback');

    this.client.put(opts, vm, function _putVmCb(err /* , req, res */) {
        if (err) {
            log.error(err, 'Could not update VM %s', vm.uuid);
            return callback(err);
        }

        log.info('VM (uuid=%s, state=%s, last_modified=%s) updated',
            vm.uuid, vm.state, vm.last_modified);
        return callback();
    });
};

/*
 * Get this server's list of VMs.
 *
 */
VmapiClient.prototype.getVms = function getVms(server, callback) {
    var query = {server_uuid: server, state: 'active'};
    var opts = {path: '/vms', query: query};

    assert.uuid(server, 'server');
    assert.func(callback, 'callback');

    this.client.get(opts, function _getCb(err, req, res, vmobjs) {
        if (err) {
            callback(err);
            return;
        }

        // if we didn't have an error, vmobjs must be an array of VM objects
        assert.arrayOfObject(vmobjs, 'vmobjs');

        callback(null, vmobjs);
    });
};

VmapiClient.VMAPI_DEFAULT_FIELDS = VMAPI_DEFAULT_FIELDS;
VmapiClient.VMAPI_ALWAYS_SET_FIELDS = VMAPI_ALWAYS_SET_FIELDS;

module.exports = VmapiClient;
