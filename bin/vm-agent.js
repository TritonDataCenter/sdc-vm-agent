/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * vm-agent.js
 */

var bunyan = require('bunyan');
var execFile = require('child_process').execFile;
var fs = require('fs');
var vasync = require('vasync');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({name: 'vm-agent', level: logLevel});

var VmAgent = require('../lib');

var config = {log: logger};
var sdcConfig;
var agentConfig;
var sysinfo;


function loadConfig(arg, callback) {
    var configPath = '/opt/smartdc/agents/etc/vm-agent.config.json';

    try {
        agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        logger.error(e, 'Could not parse agent config: "%s", '
            + 'attempting to load from /lib/sdc/config.sh now', e.message);
    }

    return callback(null);
}

// If we are unable to read a config-agent managed configuration, then we
// have to rely on sdc/config.sh
function loadSdcConfig(arg, callback) {
    if (!agentConfig) {
        callback();
        return;
    }

    execFile('/bin/bash', ['/lib/sdc/config.sh', '-json'],
        function _loadConfig(err, stdout, stderr) {
            if (err) {
                logger.fatal(err, 'Could not load sdc config: ' + stderr);
                return callback(err);
            }

            try {
                sdcConfig = JSON.parse(stdout);
                agentConfig = {
                    vmapi: {url: 'http://' + sdcConfig.vmapi_domain}
                };
            } catch (e) {
                logger.fatal(e, 'Could not parse sdc config: ' + e.message);
                return callback(e);
            }

            return callback(null);
        }
    );
}


// Run the sysinfo script and return the captured stdout, stderr, and exit
// status code.
function loadSysinfo(arg, callback) {
    execFile('/usr/bin/sysinfo', [], function _sysinfoCb(err, stdout, stderr) {
        if (err) {
            logger.fatal('Could not load sysinfo: ' + stderr.toString());
            return callback(err);
        }

        try {
            sysinfo = JSON.parse(stdout);
        } catch (e) {
            logger.fatal(e, 'Could not parse sysinfo: ' + e.message);
            return callback(e);
        }

        return callback(null);
    });
}


vasync.pipeline({funcs: [
    loadConfig,
    loadSdcConfig,
    loadSysinfo
]}, function _pipelineComplete(err) {
    var vmagent;

    if (err) {
        logger.fatal('Failed to initialize vm-agent configuration');
        process.exit(1);
    }

    if (!sysinfo.UUID) {
        logger.fatal('Could not find "UUID" in `sysinfo` output.');
        process.exit(1);
    }

    config.server_uuid = sysinfo.UUID;
    config.url = agentConfig.vmapi.url;

    if (!config.url) {
        logger.fatal('config.url is required');
        process.exit(1);
    }

    vmagent = new VmAgent(config);
    vmagent.start();
});
