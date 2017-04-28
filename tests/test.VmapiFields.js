/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This exist to test that VMAPI_ALWAYS_SET_FIELDS has not changed. It includes
 * however a subset of fields that VMADM always has set so that we can remove
 * those before comparing. (As we don't include them in VMAPI_ALWAYS_SET_FIELDS)
 */

var fs = require('fs');

var diff = require('deep-diff').diff;
var test = require('tape');
var node_uuid = require('node-uuid');
var restify = require('restify-clients');

var VMAPI = require('../lib/vmapi-client');

// GLOBAL
var testVmobj;
var testVmUuid = node_uuid.v4();
var VMADM_ALWAYS_SET_FIELDS = {
    autoboot: null,
    brand: null, // actually always set to a value in vmadm
    customer_metadata: {},
    firewall_enabled: false,
    internal_metadata: {},
    nics: [],
    platform_buildstamp: null, // actually always set to value in vmadm
    resolvers: null, // actually defaults to [] in vmadm
    server_uuid: null, // actually always set to a value in vmadm
    snapshots: [],
    state: null, // actually always set to a value in vmadm
    tags: {},
    uuid: testVmUuid,
    zone_state: null, // actually always set to a value in vmadm
    zonepath: null // actually always set to a value in vmadm
};
var vmapi;


test('Setup VMAPI handle', function _test(t) {
    var config;
    var configPath = '/opt/smartdc/agents/etc/vm-agent.config.json';

    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    t.ok(config, 'loaded vm-agent config file');
    t.ok(config.vmapi_url, 'config has vmapi_url');

    if (config.vmapi_url) {
        vmapi = restify.createJsonClient({
            url: config.vmapi_url,
            userAgent: 'vm-agent-test/0.0.0'
                + ' (node/' + process.versions.node + ')'
        });
        t.ok(vmapi, 'created VMAPI handle');
    }

    t.end();
});

test('PUT VM', function _test(t) {
    var opts = {path: '/vms/' + testVmUuid};
    var vmobj = {uuid: testVmUuid};

    if (!vmapi) {
        t.fail('Missing vmapi handle, cannot continue');
        t.end();
        return;
    }

    vmapi.put(opts, vmobj, function _putVmCb(err /* , req, res */) {
        t.ifError(err, 'vmapi PUT ' + testVmUuid);
        t.end();
    });
});

test('GET VM', function _test(t) {
    var opts = {path: '/vms/' + testVmUuid};

    if (!vmapi) {
        t.fail('Missing vmapi handle, cannot continue');
        t.end();
        return;
    }

    vmapi.get(opts, function _getCb(err, req, res, vmobj) {
        t.ifError(err, 'vmapi GET ' + testVmUuid);
        testVmobj = vmobj;
        t.equal(testVmobj.uuid, testVmUuid, 'VMAPI VM matches UUID');
        t.end();
    });
});

test('Compare VMAPI VM to VMAPI_ALWAYS_SET_FIELDS', function _test(t) {
    var comparableVmobj = {};

    Object.keys(testVmobj).forEach(function _attemptAddCompareField(field) {
        if (VMADM_ALWAYS_SET_FIELDS.hasOwnProperty(field)
            && !diff(VMADM_ALWAYS_SET_FIELDS[field], testVmobj[field])) {
            // remove fields that are also always set in vmadm
            return;
        }
        comparableVmobj[field] = testVmobj[field];
    });

    // diff returns 'undefined' when objects are equivalent
    t.deepEqual(comparableVmobj, VMAPI.VMAPI_ALWAYS_SET_FIELDS,
        'VMAPI VM has expected fields added');
    t.end();
});

// ZAPI-782 broke DELETE, so we do a PUT here instead with
//
// vm.state = 'destroyed';
// vm.zone_state = 'destroyed';
// vm.destroyed = new Date().toString();
//
// which matches what VMAPI did until ZAPI-782.
test('DELETE VM', function _test(t) {
    var opts = {path: '/vms/' + testVmUuid};
    var vmobj = {
        destroyed: new Date().toString(),
        state: 'destroyed',
        uuid: testVmUuid,
        zone_state: 'destroyed'
    };

    if (!vmapi) {
        t.fail('Missing vmapi handle, cannot continue');
        t.end();
        return;
    }

    vmapi.put(opts, vmobj, function _putVmCb(err /* , req, res */) {
        t.ifError(err, 'vmapi PUT (to destroy) ' + testVmUuid);
        t.end();
    });
});

test('Close VMAPI handle', function _test(t) {
    if (!vmapi) {
        t.fail('Missing vmapi handle, cannot continue');
        t.end();
        return;
    }

    vmapi.close();
    t.ok(true, 'closed VMAPI handle');
    t.end();
});
