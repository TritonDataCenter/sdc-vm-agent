/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var mocks = require('./mocks');
var test = require('tape');
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
