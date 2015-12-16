/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
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
 *
 *
 * Because we often get a set of changes as a bunch, we "debounce" the changes
 * with the following process:
 *
 *   * when we get an event, we set a timer (XXX 500ms?) and update the zone's
 *     last state.
 *   * if we get an event while there's a timer, we just update the last state.
 *   * when the timer fires, we send the modify for the last seen state.
 *
 * note that this module doesn't deal with 'state'. The VmAgent will make an
 * attempt to guess the expected state if the zone_state changes.
 *
 * XXX By:
 *
 *   if new zone_state === old zone_state, leave state alone
 *   if old state === provisioning, leave state alone
 *   if old state === failed, leave state alone
 *   if old state === old zone_state, set state = new zone_state
 */

var spawn = require('child_process').spawn;

var assert = require('assert-plus');
var LineStream = require('lstream');


function ZoneeventWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');

    // Yay bunyan!
    self.log = opts.log;

    self.updateVm = opts.updateVm;

    self.watcher = null;
    self.lstream = null;
}

ZoneeventWatcher.prototype.processUpdateObj = // eslint-disable-line
function processUpdateObj(updateObj) {
    var self = this;
    var vmUuid = updateObj.zonename;

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
    }
};

ZoneeventWatcher.prototype.start = function start() {
    var self = this;
    var log = self.log;

    self.lstream = new LineStream({encoding: 'utf8'});

    self.lstream.on('error', function _onLstreamError(err) {
        throw (err);
    });

    self.lstream.on('line', function _onLstreamLine(line) {
        var trimmedLine = line.trim();
        var updateObj;

        if (!trimmedLine) {
            return;
        }
        // just let it throw if not JSON: that's a bug
        updateObj = JSON.parse(trimmedLine);

        self.processUpdateObj(updateObj);
    });

    self.watcher = spawn('/usr/vm/sbin/zoneevent', [], {stdio: 'pipe'});
    log.info('zoneevent running with pid ' + self.watcher.pid);

    self.watcher.stdout.pipe(self.lstream);
    self.watcher.stdin.end();

    self.watcher.on('exit', function _onWatcherExit(code, signal) {
        log.warn({code: code, signal: signal}, 'zoneevent watcher exited');
        self.stop();
        process.nextTick(function _restartZoneevent() {
            self.start();
        });
    });
};

ZoneeventWatcher.prototype.getPid = function getPid() {
    var self = this;

    return (self.watcher.pid);
};

ZoneeventWatcher.prototype.stop = function stop() {
    var self = this;

    self.lstream = null;

    if (self.watcher) {
        self.watcher.removeAllListeners('exit');
        self.watcher.kill();
        self.watcher = null;
    }
};

ZoneeventWatcher.FIELDS = ['state', 'zone_state'];

module.exports = ZoneeventWatcher;
