/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This provides the system-specific configuration functions for SmartOS
 * platforms.
 */

var fs = require('fs');
var execFile = require('child_process').execFile;

var assert = require('assert-plus');
var vasync = require('vasync');

var VM_AGENT_CONFIG = '/opt/smartdc/agents/etc/vm-agent.config.json';


function SmartosBackend(opts) {
    var self = this;

    self.log = opts.log;
    self.name = opts.backendName;
}

// Load the configuration, starting with the agent config (managed by
// config-agent) and then filling in missing data from sysinfo and the SDC
// config if necessary.
SmartosBackend.prototype.loadConfig = function loadConfig(callback) {
    var self = this;
    var config;

    assert.func(callback);

    vasync.pipeline({funcs: [
        function _loadAgentConfig(_, cb) {
            try {
                config = JSON.parse(fs.readFileSync(VM_AGENT_CONFIG, 'utf-8'));
            } catch (e) {
                // not fatal, because we'll attempt to get the config by other
                // means
                self.log.error(e, 'Could not parse agent config: %s',
                    VM_AGENT_CONFIG);
                cb(e);
                return;
            }

            cb();
        }, function _loadSdcConfig(_, cb) {
            // If vm-agent config didn't include vmapi_url, we'll attempt to
            // figure that out from SDC config.
            if (config.vmapi_url) {
                cb();
                return;
            }

            execFile('/bin/bash', ['/lib/sdc/config.sh', '-json'],
                function _loadConfig(err, stdout, stderr) {
                    var sdcConfig;

                    if (err) {
                        self.log.fatal(err, 'Could not load sdc config: '
                            + stderr);
                        cb(err);
                        return;
                    }

                    try {
                        sdcConfig = JSON.parse(stdout);
                    } catch (e) {
                        self.log.fatal(e, 'Could not parse sdc config: '
                            + e.message);
                        cb(e);
                        return;
                    }

                    config.vmapi_url = 'http://' + sdcConfig.vmapi_domain;

                    cb();
                }
            );
        }, function _loadSysinfo(_, cb) {
            // If vm-agent config didn't include a server_uuid, get that from
            // sysinfo.
            if (config.server_uuid) {
                cb();
                return;
            }

            execFile('/usr/bin/sysinfo', [],
                function _sysinfoCb(err, stdout, stderr) {
                    var sysinfo;

                    if (err) {
                        self.log.fatal('Could not load sysinfo: '
                            + stderr.toString());
                        cb(err);
                        return;
                    }

                    try {
                        sysinfo = JSON.parse(stdout);
                    } catch (e) {
                        self.log.fatal(e, 'Could not parse sysinfo: '
                            + e.message);
                        cb(e);
                        return;
                    }

                    config.server_uuid = sysinfo.UUID;
                    cb();
                }
            );
        }
    ]}, function _afterPipeline(err) {
        callback(err, config);
    });
};

module.exports = SmartosBackend;
