/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var fs = require('fs');
var vasync = require('vasync');

// When the /config directory disappears, these control how frequently (in ms)
// we poll to check for config to come back and how long before we give up (also
// in ms)
var configPollRecreateDelay = 300;
var configPollRecreateTimeout = 60000;

// when to retry if startup fails (in ms)
var retryDelay = 10000;


function FsWatcher(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.updateVm, 'opts.updateVm');

    // Yay bunyan!
    self.log = opts.log.child({watcher: 'fs-watcher'});

    self.updateVm = opts.updateVm;

    self.configWatchers = {};

    self.isDirty = false;
    self.isProcessing = false;

    // lastSeenVms will contain a map of uuid -> timestamp with the latest
    // timestamp seen for any of:
    //
    //  /etc/zones/<uuid>.xml
    //  /zones/<uuid>/config/metadata.json
    //  /zones/<uuid>/config/routes.json
    //  /zones/<uuid>/config/tags.json
    //
    // It gets populated initially when we first load the VM data.
    self.lastSeenVms = null;
    self.zonesWatcher = null;
}

function findVmUuidFromFilename(filename) {
    var match;
    var re;
    var vm = null;
    var xmlFilenameLength = 40;

    assert.string(filename, 'filename');

    re = /(^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}).xml$/;

    if (filename && filename.length === xmlFilenameLength) {
        match = filename.match(re);

        if (match) {
            vm = match[1];
        }
    }

    return (vm);
}

/*
 * Finds the last modified timestamp for VMs via /etc/zones/<uuid>.xml and
 * /zones/<uuid>/config/{metadata,routes,tags}.json and calls callback(err,
 * results) with a results object that looks like:
 *
 *  {
 *      "<uuid>": <last_modified>,
 *      ...
 *  }
 *
 * with <last_modified> being an integer ala (new Date()).getTime(). If there is
 * an error, the err parameter will be passed and the "results" should not be
 * used.
 */
FsWatcher.prototype.getCurrentZones = function getCurrentZones(callback) {
    var self = this;
    var results = {};
    var startLookup = (new Date()).getTime();
    var vms = [];

    assert.func(callback, 'callback');

    fs.readdir('/etc/zones', function _onReaddir(err, files) {
        var fileIdx;
        var vmUuid;

        if (err) {
            callback(err);
            return;
        }

        // if there was no error, files must be an array
        assert.array(files, 'files');

        for (fileIdx = 0; fileIdx < files.length; fileIdx++) {
            vmUuid = findVmUuidFromFilename(files[fileIdx]);
            if (vmUuid) {
                vms.push(vmUuid);
            }
        }

        vasync.forEachParallel({
            inputs: vms,
            func: function _statXmlFile(vm, cb) {
                fs.stat('/etc/zones/' + vm + '.xml', function _onStat(e, st) {
                    if (e) {
                        if (e.code === 'ENOENT') {
                            // If file disappeared, that's fine.
                            cb();
                            return;
                        }
                        cb(e);
                        return;
                    }

                    self.getConfigTimestamp(vm,
                        function _getConfigTimestampCb(error, latestCfg) {
                            if (error) {
                                cb(error);
                                return;
                            }
                            // Thanks Javascript... NaN > X, where X is a
                            // number. So we '|| 0' here to work around it.
                            results[vm] = Math.max(st.mtime.getTime() || 0,
                                latestCfg || 0);
                            cb();
                        }
                    );
                });
            }
        }, function _afterStats(e) {
            var doneLookup = (new Date()).getTime();

            self.log.trace({
                action: 'getCurrentZones',
                elapsed: (doneLookup - startLookup),
                err: e,
                vmCount: (vms ? Object.keys(vms).length : 0)
            }, 'completed lookup of latest timestamps');

            callback(e, results);
        });
    });
};

FsWatcher.prototype.getConfigTimestamp = // eslint-disable-line
function getConfigTimestamp(vmUuid, callback) {
    var self = this;
    var timestamps = [];

    assert.uuid(vmUuid, 'vmUuid');
    assert.func(callback, 'callback');

    vasync.forEachParallel({
        inputs: [
            '/zones/' + vmUuid + '/config/metadata.json',
            '/zones/' + vmUuid + '/config/routes.json',
            '/zones/' + vmUuid + '/config/tags.json'
        ],
        func: function _statConfigFile(filename, cb) {
            fs.stat(filename, function _onStat(e, st) {
                if (!e) {
                    timestamps.push(st.mtime.getTime());
                } else if (e.code !== 'ENOENT') {
                    // If stat has an error we'll just log it since there's not
                    // much else for us to do about it.
                    self.log.warn(e, 'fs.stat error');
                }
                cb();
            });
        }
    }, function _afterConfigFileStats(err) {
        var latest = timestamps.sort().pop();

        callback(err, latest);
    });
};

/*
 * With OS-5975 we delete the config directory as part of provisioning. This
 * means it's now possible for the config to be deleted out from under us
 * without the VM also going away. When the watcher notices the config directory
 * disappear, it will call this function to wait until either:
 *
 *  1. the VM is deleted (in which case, it will do nothing further)
 *  2. the config directory shows back up (in which case we'll watch again)
 *  3. we've tried for some amount of time and neither of the above is true (in
 *     which case we'll log an error and then give up)
 */
FsWatcher.prototype.waitThenWatch = function waitThenWatch(vmUuid) {
    var self = this;
    var waitTime = 0;

    function checkPathExists(path, callback) {
        fs.stat(path, function _onStat(statErr) {
            if (statErr) {
                if (statErr.code === 'ENOENT') {
                    callback(null, false);
                    return;
                }
                callback(statErr);
                return;
            }

            callback(null, true);
        });
    }

    // checkExists looks for VM with uuid 'vm_uuid' then calls:
    //
    //  callback(err, xmlExists, configExists);
    //
    // where err is an error (in which case, ignore the *Exists values),
    // and:
    //
    //  xmlExists is a boolean indicating whether /etc/zones/<uuid>.xml exists
    //  configExists is a boolean indicating whether /zones/<uuid>/config exists
    //
    function checkExists(_vmUuid, callback) {
        checkPathExists('/etc/zones/' + _vmUuid + '.xml',
            function xmlExistsCb(xmlErr, xmlExists) {
                if (xmlErr) {
                    callback(xmlErr);
                    return;
                }

                checkPathExists('/zones/' + _vmUuid + '/config',
                    function checkConfigExists(configErr, configExists) {
                        callback(configErr, xmlExists, configExists);
                    }
                );
            }
        );
    }

    function tryWatchingLater() {
        setTimeout(function tryWatching() {
            waitTime += configPollRecreateDelay;

            // If we're past our timeout, give up without resetting timer.
            if (waitTime > configPollRecreateTimeout) {
                self.log.error({vmUuid: vmUuid}, 'timed out waiting for '
                    + 'config directory to be recreated');
                return;
            }

            self.log.trace({waitTime: waitTime},
                'checking whether config dir was recreated');

            checkExists(vmUuid,
                function existsCallback(err, xmlExists, configExists) {
                    if (err || (xmlExists && !configExists)) {
                        // schedule a retry
                        tryWatchingLater();
                        return;
                    }

                    if (!xmlExists) {
                        // the VM is gone altogether
                        self.log.info({waitTime: waitTime, vmUuid: vmUuid},
                            'VM with missing config dir disappeared');
                        return;
                    }

                    self.log.info({waitTime: waitTime, vmUuid: vmUuid},
                        'missing config dir reappeared');

                    // It exists, so we'll start watching again. Note: this
                    // function is expected to be idempotent, so if the watcher
                    // was already created because of the /etc/zones watch
                    // noticing some change and a run through the processState
                    // pipeline, this will be a noop which is fine.
                    self.watchConfig(vmUuid);
                }
            );
        }, configPollRecreateDelay);
    }

    tryWatchingLater();
};

/*
 * For config we only watch for change events because when a VM is created we'll
 * always see the .xml file but we may or may not see config. Since xml is
 * always there we'll just rely on that.
 *
 */
FsWatcher.prototype.watchConfig = function watchConfig(vmUuid) {
    var self = this;
    var path;

    assert.uuid(vmUuid, 'vmUuid');

    if (self.configWatchers.hasOwnProperty(vmUuid) &&
        self.configWatchers[vmUuid] !== null) {
        // already watching
        return;
    }

    path = '/zones/' + vmUuid + '/config';
    try {
        self.configWatchers[vmUuid] = fs.watch(path,
            function _watchHandler(evt) {
                if (evt === 'rename') {
                    // If a directory is renamed, we remove the watcher.
                    // We'll attempt to re-add on next event if VM exists.
                    if (self.configWatchers[vmUuid]) {
                        self.configWatchers[vmUuid].close();
                        self.configWatchers[vmUuid] = null;
                    }
                } else if (evt === 'change') {
                    // Files other than our config files get modified in this
                    // dir. Such as ipf.conf. So we need to do a readdir and
                    // find the most recent timestamp of *.json files we care
                    // about.
                    self.log.trace('fs.watch(' + path + ') saw: ' + evt);

                    self.getConfigTimestamp(vmUuid,
                        function _getTimestampCb(_e, newest) {
                            if (!newest || !self.lastSeenVms) {
                                return;
                            }
                            if (self.lastSeenVms.hasOwnProperty(vmUuid) &&
                                (newest > self.lastSeenVms[vmUuid])) {
                                // the VM timestamp changed, send a modify event
                                self.updateVm(vmUuid, 'modify', {
                                    last_modified: new Date(newest)
                                        .toISOString()
                                });

                                self.log.trace('newest for ' + path + ' is now:'
                                    + ' ' + newest);

                                // Update *our* last seen value since we already
                                // updated the caller.
                                self.lastSeenVms[vmUuid] = newest;
                            }
                        }
                    );
                } else {
                    // API doesn't define this
                    throw new Error('InvalidEvent: ' + evt);
                }
            }
        );

        // If a directory is renamed, we remove the watcher.
        // We'll attempt to re-add on next event if VM exists.
        self.configWatchers[vmUuid].on('error', function onWatcherError(err) {
            // We'll try again if we can, so cleanup the current watcher (which
            // is now useless).
            if (self.configWatchers[vmUuid]) {
                self.configWatchers[vmUuid].close();
                self.configWatchers[vmUuid] = null;
            }

            self.log.warn({err: err, vmUuid: vmUuid},
                'caught error in configWatcher');

            // When the directory is removed, we'll get an ENOENT error.
            // In that case we want to remove the watcher and when the
            if (err.code === 'ENOENT') {
                setImmediate(function callWaitThenWatch() {
                    self.waitThenWatch(vmUuid);
                });
            }
        });
    } catch (e) {
        // we'll try again next time processState runs anyway, so just clear the
        // current watcher.
        if (self.configWatchers[vmUuid]) {
            self.configWatchers[vmUuid].close();
            self.configWatchers[vmUuid] = null;
        }

        if (e.code === 'ENOENT') {
            // config dir doesn't exist. This could happen if a VM is in the
            // middle of provisioning when we happen to start up. We will try
            // again just as we do when the directory disappears.
            setImmediate(function callWaitThenWatch() {
                self.waitThenWatch(vmUuid);
            });
            return;
        }

        self.log.error(e, 'FAILED to watch ' + path);
    }
};

FsWatcher.prototype.processState = function processState(callback) {
    var self = this;
    var currentVms = {};

    self.isDirty = false;
    self.isProcessing = true;

    assert.optionalFunc(callback, 'callback');

    vasync.pipeline({arg: {}, funcs: [
        function _getCurrentVms(_, cb) {
            // load the current set of zones
            self.getCurrentZones(function _onGetCurrentZones(err, vms) {
                if (err) {
                    cb(err);
                    return;
                }

                currentVms = vms;
                cb();
            });
        }, function _addConfigWatchers(_, cb) {
            // add config watchers for each currentVms that don't have one
            vasync.forEachParallel({
                inputs: Object.keys(currentVms),
                func: function _addConfigWatcher(arg, next) {
                    // closure so we have the right self.
                    self.watchConfig(arg);
                    next();
                }
            }, function _addConfigWatchersCb(err) {
                cb(err);
            });
        }, function _delConfigWatchers(_, cb) {
            // del config watchers that don't exist in currentVms
            vasync.forEachParallel({
                inputs: Object.keys(self.configWatchers),
                func: function _delConfigWatcher(vmUuid, next) {
                    if (!currentVms[vmUuid] && self.configWatchers[vmUuid]) {
                        self.configWatchers[vmUuid].close();
                        self.configWatchers[vmUuid] = null;
                    }
                    next();
                }
            }, function _delConfigWatchersCb(err) {
                cb(err);
            });
        }, function _emitDisappearedVms(_, cb) {
            // send 'deleted' for VMs which disappeared
            if (!self.lastSeenVms) {
                cb();
                return;
            }
            vasync.forEachParallel({
                inputs: Object.keys(self.lastSeenVms),
                func: function _emitDelete(vmUuid, next) {
                    if (!currentVms[vmUuid]) {
                        self.updateVm(vmUuid, 'delete', {});
                    }
                    next();
                }
            }, function _emitDisappearedCb(err) {
                cb(err);
            });
        }, function _emitAppearedVms(_, cb) {
            // send 'created' for VMs which appeared
            if (!self.lastSeenVms) {
                // If we don't have a set to compare, we don't send create
                // events
                cb();
                return;
            }

            vasync.forEachParallel({
                inputs: Object.keys(currentVms),
                func: function _emitCreate(vmUuid, next) {
                    if (!self.lastSeenVms[vmUuid]) {
                        self.updateVm(vmUuid, 'create', {
                            last_modified: new Date(currentVms[vmUuid])
                                .toISOString()
                        });
                    }
                    next();
                }
            }, function _emitAppearedCb(err) {
                cb(err);
            });
        }, function _emitChangedVms(_, cb) {
            // send 'modified' for VMs which have changed
            if (!self.lastSeenVms) {
                // If we don't have a set to compare, we don't send modify
                // events
                cb();
                return;
            }

            vasync.forEachParallel({
                inputs: Object.keys(currentVms),
                func: function _emitChanged(vmUuid, next) {
                    assert.uuid(vmUuid, 'vmUuid');

                    if (self.lastSeenVms[vmUuid] &&
                        (currentVms[vmUuid] > self.lastSeenVms[vmUuid])) {
                        // we've seen this before and it's newer
                        self.updateVm(vmUuid, 'modify', {
                            last_modified: new Date(currentVms[vmUuid])
                                .toISOString()
                        });
                    }
                    next();
                }
            }, function _emitChangedCb(err) {
                cb(err);
            });
        }, function _updateLastSeen(_, cb) {
            // If we made it this far, we made it through the whole update so we
            // store the currentVms as lastSeen for next time.
            self.lastSeenVms = currentVms;
            cb();
        }
    ]}, function _processStateCb(err) {
        if (self.isDirty) {
            process.nextTick(function _rerunProcessState() {
                // closure so we have 'self'
                self.processState();
            });
        } else {
            self.isProcessing = false;
        }
        if (callback) {
            callback(err);
            return;
        }
    });
};

FsWatcher.prototype.start = function start() {
    var self = this;

    if (!self.zonesWatcher) {
        self.zonesWatcher = fs.watch('/etc/zones', function _onZoneEvent(evt) {
            assert.string(evt, 'evt');

            self.log.trace('fs.watch(/etc/zones) saw: ' + evt);
            self.isDirty = true;
            if (self.isProcessing) {
                return;
            }
            self.processState();
        });
    }

    self.processState(function _onProcessedState(err) {
        if (err) {
            // If processing failed, try again in retryDelay ms
            self.log.warn('initial update failed, retrying in '
                + retryDelay + ' ms');
            setTimeout(function _retryStartup() {
                self.start();
            }, retryDelay);

            return;
        }
        self.log.debug('initial update complete');
    });
};

FsWatcher.prototype.stop = function stop() {
    var self = this;
    var configIdx;
    var configVms;
    var vmUuid;

    if (self.zonesWatcher) {
        self.zonesWatcher.close();
        self.zonesWatcher = null;
    }

    configVms = Object.keys(self.configWatchers);
    for (configIdx = 0; configIdx < configVms.length; configIdx++) {
        vmUuid = configVms[configIdx];

        if (self.configWatchers[vmUuid]) {
            self.configWatchers[vmUuid].close();
            self.configWatchers[vmUuid] = null;
        }
    }

    self.configWatchers = {};
    self.isDirty = false;
    self.isProcessing = false;
    self.lastSeenVms = null;
};

FsWatcher.FIELDS = ['last_modified'];

module.exports = FsWatcher;
