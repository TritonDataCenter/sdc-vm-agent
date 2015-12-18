/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('tape');

var mocks = require('./mocks');
var PeriodicWatcher = require('../lib/watchers/periodic-watcher');


var innards = (new PeriodicWatcher({
    log: mocks.Logger,
    updateVm: function _updateVm() {
        throw new Error('should not be reached');
    }
})).__testonly__;

// these are exposed just for us!
var cmpVm = innards.cmpVm;
var compareVms = innards.compareVms;


test('cmpVm', function _cmpVm(t) {
    t.equal(cmpVm({}, {}), true, 'cmpVm(): empty objects');
    t.equal(cmpVm({hello: 'world'}, {}), false, 'cmpVm(): unbalanced: empty b');
    t.equal(cmpVm({}, {hello: 'world'}), false, 'cmpVm(): unbalanced: empty a');
    t.equal(cmpVm(
        {alias: 'aliasA'},
        {alias: 'aliasB'}
    ), false, 'cmpVm(): same key, diff value');
    t.equal(cmpVm(
        {firewall_enabled: true},
        {firewall_enabled: false}
    ), false, 'cmpVm(): diff boolean');
    t.equal(cmpVm(
        {firewall_enabled: true},
        {firewall_enabled: true}
    ), true, 'cmpVm(): same boolean');

    t.end();
});

test('compareVms', function _compareVms(t) {
    var knownVms;
    var newList;

    knownVms = {
        '9e0feb4e-c0db-4b7d-8099-9964d302fa53': {
            brand: 'joyent-minimal',
            ram: 256,
            uuid: '9e0feb4e-c0db-4b7d-8099-9964d302fa53'
        }, '1029bcd7-b5e2-4f16-b4bc-43c39eb8fbe2': {
            brand: 'joyent',
            ram: 256,
            uuid: '9e0feb4e-c0db-4b7d-8099-9964d302fa53'
        }, '7642054e-396c-403a-9bae-13b71e17b677': {
            brand: 'lx',
            ram: 256,
            uuid: '7642054e-396c-403a-9bae-13b71e17b677'
        }
    };

    /* New list with:
     *
     *  - first one is new
     *  - second one has changed ram
     *  - last VM here is unchanged from knownVms
     *  - 1029bcd7... from above is missing
     *
     */
    newList = [{
        uuid: '03ffdcbe-af78-493c-9baa-64012d59fe68',
        ram: 1024,
        brand: 'kvm'
    }, {
        brand: 'joyent-minimal',
        ram: 512,
        uuid: '9e0feb4e-c0db-4b7d-8099-9964d302fa53'
    }, {
        brand: 'lx',
        ram: 256,
        uuid: '7642054e-396c-403a-9bae-13b71e17b677'
    }];

    compareVms(newList, knownVms,
        function _compareCb(created, deleted, modified) {
            t.equal(created.length, 1, '1 VM created');
            t.equal(created[0].uuid, newList[0].uuid,
                'Correct VM was "created"');
            t.equal(deleted.length, 1, '1 VM deleted');
            t.equal(deleted[0].uuid, '1029bcd7-b5e2-4f16-b4bc-43c39eb8fbe2',
                'Correct VM was "deleted"');
            t.equal(modified.length, 1, '1 VM modified');
            t.equal(modified[0].uuid, newList[1].uuid,
                'Correct VM was "modified"');
            t.equal(modified[0].ram, newList[1].ram,
                'RAM was correct on modified VM');
            t.end();
        }
    );
});
