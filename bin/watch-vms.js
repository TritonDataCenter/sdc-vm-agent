#!/opt/smartdc/agents/lib/node_modules/vm-agent/node/bin/node

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This is a tool mostly for testing/debugging. When run it will list the set of
 * events it sees, and which watcher saw them.
 *
 * Run as:
 *
 *   /opt/smartdc/agents/lib/node_modules/vm-agent/bin/watch-vms.js
 *
 * where you have vm-agent installed.
 */

/* eslint-disable no-console */

var mocks = require('../tests/mocks');
var VmWatcher = require('../lib/vm-watcher');

var log = mocks.Logger;
var types = ['VmCreated', 'VmModified', 'VmDeleted'];
var vmWatcher;

log.trace = function _traceLog() {
    var logobj;
    var now = (new Date()).toISOString();

    if (arguments[0] && arguments[0].modifiedFields) {
        logobj = arguments[0];
        console.log(now + ' [' + logobj.watcher + ']: ' + logobj.event + ' '
            + logobj.vm + ' => ' + JSON.stringify(logobj.modifiedFields));
    }
};

vmWatcher = new VmWatcher({log: mocks.Logger});

// each type gets its own closure
types.forEach(function _watcherCb(type) {
    vmWatcher.on(type, function _onEvent(vmUuid, watcher) {
        console.log((new Date()).toISOString() + ' [' + watcher + ']: '
            + type + ' => ' + vmUuid);
    });
});

vmWatcher.start();
