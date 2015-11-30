/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('tape');
var VmWatcherInternal = require('../lib/vm-watcher').__testonly__;


// these are exposed just for us!
var cmpVm = VmWatcherInternal.cmpVm;
var compareVms = VmWatcherInternal.compareVms;

test('cmpVm', function (t) {
    t.equal(cmpVm({}, {}), true, 'cmpVm(): empty objects');
    t.equal(cmpVm({hello: 'world'}, {}), false, 'cmpVm(): unbalanced: empty b');
    t.equal(cmpVm({}, {hello: 'world'}), false, 'cmpVm(): unbalanced: empty a');
    t.equal(cmpVm(
        { alias: 'aliasA' },
        { alias: 'aliasB' }
    ), false, 'cmpVm(): same key, diff value');
    t.equal(cmpVm(
        { firewall_enabled: true },
        { firewall_enabled: false }
    ), false, 'cmpVm(): diff boolean');
    t.equal(cmpVm(
        { firewall_enabled: true },
        { firewall_enabled: true }
    ), true, 'cmpVm(): same boolean');

    t.end();
});
