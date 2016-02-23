/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This watcher runs /usr/vm/sbin/zoneevent and notices when VMs change state.
 * On newer platforms (OS-5011 or newer) it would be possible to emit create and
 * delete events, but we already emit those events from other watchers and
 * for future platforms we'll have vminfod. So currently, for all platforms we
 * just emit a 'modify' event when the zone_state of the zone changes either to
 * uninitialized (stopped) or running.
 *
 * There are a lot of intermediate events that we might get (for example, going
 * from oldstate=shutting_down to newstate=shutting_down quite a few times is
 * common when stopping a zone. These are all currently ignored.
 *
 */

var spawn = require('child_process').spawn;

var assert = require('assert-plus');
var LineStream = require('lstream');

// number of events to keep in memory for debugging
var RINGBUFFER_SIZE = 100;

function ZoneeventWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.optionalBool(opts.debugEvents, 'opts.debugEvents');
    assert.optionalNumber(opts.highWaterMark, 'opts.highWaterMark');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');

    // For testing we'd like to be able to see all events that we get from
    // zoneevent. We'd also like to be able to set the highWaterMark for the
    // lstream module.
    self.debugEvents = Boolean(opts.debugEvents);
    if (opts.hasOwnProperty('highWaterMark')) {
        self.highWaterMark = opts.highWaterMark;
    }
    self.totalLen = 0;
    self.totalEvents = 0;

    // flag so we know if we should restart on exit or not
    self.stopped = true;

    // Keep a ring buffer with the last RINGBUFFER_SIZE events and a timestamp
    // of when we saw them. (for debugging) You can pull these out of a core
    // with:
    //
    // ::findjsobjects -p event_ringbuffer -p debugEvents \
    //     | ::jsprint event_ringbuffer
    //
    self.event_ringbuffer = [];

    // Yay bunyan!
    self.log = opts.log.child({watcher: 'zoneevent-watcher'});

    self.updateVm = opts.updateVm;

    self.watcher = null;
    self.lstream = null;
}

ZoneeventWatcher.prototype.processUpdateObj = // eslint-disable-line
function processUpdateObj(updateObj) {
    var self = this;
    var vmUuid;

    assert.object(updateObj, 'updateObj');
    assert.uuid(updateObj.zonename, 'updateObj.zonename');

    vmUuid = updateObj.zonename;

    if (updateObj.newstate === 'running') {
        // emit 'running', 'running'

        self.updateVm(vmUuid, 'modify', {
            state: 'running',
            zone_state: 'running'
        });
    } else if (updateObj.newstate === 'uninitialized') {
        // emit 'stopped', 'stopped'

        self.updateVm(vmUuid, 'modify', {
            state: 'stopped',
            zone_state: 'stopped'
        });
    } else if (self.debugEvents) {
        // This event is normally hidden, but when we're trying to debug events,
        // it's useful to emit it.

        self.updateVm(vmUuid, 'hidden', {
            zone_state: updateObj.newstate
        });
    }
};

ZoneeventWatcher.prototype.start = function start() {
    var self = this;
    var log = self.log;
    var lstreamOpts = {encoding: 'utf8'};

    if (typeof (self.highWaterMark) !== 'undefined') {
        lstreamOpts.highWaterMark = self.highWaterMark;
    }

    self.lstream = new LineStream(lstreamOpts);

    self.lstream.on('readable', function _onLstreamReadable() {
        var line;
        var updateObj;

        if (!self.lstream) {
            log.trace('cannot read from lstream after stop()');
            return;
        }

        // read the first line
        line = self.lstream.read();

        while (line !== null) {
            assert.string(line, 'line');

            // Write the event and a timestamp to the event_ringbuffer so that
            // we have them in a core for debugging.
            self.event_ringbuffer.push({
                event_line: line,
                event_timestamp: new Date()
            });
            if (self.event_ringbuffer.length > RINGBUFFER_SIZE) {
                self.event_ringbuffer.shift();
            }

            // also for debugging/testing, track the events we've handled.
            self.totalLen += line.length;
            self.totalEvents++;

            // just let it throw if not JSON: that's a bug
            updateObj = JSON.parse(line.trim());

            self.processUpdateObj(updateObj);

            // read the next line
            line = self.lstream.read();
        }
    });

    self.watcher = spawn('/usr/vm/sbin/zoneevent', [], {stdio: 'pipe'});
    log.info('zoneevent running with pid ' + self.watcher.pid);

    self.watcher.stdout.pipe(self.lstream);
    self.watcher.stdin.end();

    self.stopped = false;

    self.watcher.on('exit', function _onWatcherExit(code, signal) {
        log.warn({code: code, signal: signal}, 'zoneevent exited');
        self.reset();
        if (!self.stopped) {
            process.nextTick(function _restartZoneevent() {
                self.start();
            });
        }
    });
};

ZoneeventWatcher.prototype.getPid = function getPid() {
    var self = this;

    return (self.watcher.pid);
};

ZoneeventWatcher.prototype.reset = function stop() {
    var self = this;

    self.log.trace('ZoneeventWatcher.reset() called');
    self.lstream = null;

    if (self.watcher) {
        self.watcher.removeAllListeners('exit');
        self.watcher.kill();
        self.watcher = null;
    }
};

ZoneeventWatcher.prototype.stop = function stop() {
    var self = this;

    self.log.trace('ZoneeventWatcher.stop() called');

    self.stopped = true;

    self.reset();
};

ZoneeventWatcher.FIELDS = ['state', 'zone_state'];

module.exports = ZoneeventWatcher;
