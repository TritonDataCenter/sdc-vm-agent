/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var vmadm = require('vmadm');

function determineEventSource(opts, cb) {
    var vmadmEventsOpts;

    assert.object(opts, 'opts');
    assert(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    // Figure out the best event source for the system.  Basically, this checks
    // to see if vminfod is supported by looking for `vmadm events` support.
    vmadmEventsOpts = {
        log: opts.log,
        name: 'VM Agent determineEventSource'
    };

    vmadm.events(vmadmEventsOpts,
        function vmadmEventsHandler() {
            /*
             * We don't care about any events seen here - we are only
             * starting this event stream to see if it is supported on the
             * current platform to best determine the event source to use for
             * all events.
             */
        }, function vmadmEventsReady(err, obj) {
            if (err) {
                // vmadm events is not supported, use default eventSource.
                cb(null, 'default');
                return;
            }

            // vmadm events is supported! stop this stream and use the
            // `vmadm-events` eventSource.
            obj.stop();
            cb(null, 'vmadm-events');
        }
    );
}

module.exports = determineEventSource;