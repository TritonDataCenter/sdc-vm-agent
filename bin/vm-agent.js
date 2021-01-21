/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * Loads the config and creates a VmAgent instance. See lib/vm-agent.js for more
 * detailed information on operation.
 *
 */

var fs = require('fs');
var execFile = require('child_process').execFile;

var assert = require('assert-plus');
var bunyan = require('bunyan');
var vasync = require('vasync');

var VmAgent = require('../lib');


// GLOBALS
var logger = bunyan.createLogger({
    name: 'vm-agent',
    level: (process.env.LOG_LEVEL || 'debug')
});


/*
 * This loads the config file (managed by config-agent) and adds all the
 * key/value pairs to the config object for those keys which do not already
 * exist in config.
 */
function loadConfig(config, callback) {
    var _config;
    var configPath = '/opt/smartdc/agents/etc/vm-agent.config.json';

    assert.object(config);
    assert.func(callback);

    try {
        _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        // not fatal, because we'll attempt to get the config by other means
        logger.error(e, 'Could not parse agent config: %s', configPath);
    }

    if (_config) {
        Object.keys(_config).forEach(function _copyToConfig(key) {
            // we'll not clobber existing keys, order of precedence can then be
            // established via ordering of the waterfall.
            if (!config[key]) {
                config[key] = _config[key];
            }
        });
    }

    // pass (potentially modified) config to next function in waterfall
    return callback(null, config);
}

// If we are unable to read a config-agent managed configuration, then we
// have to rely on sdc/config.sh to get the VMAPI URL.
function loadSdcConfig(config, callback) {
    assert.object(config);
    assert.func(callback);

    if (config.hasOwnProperty('vmapi_url')) {
        // we already have the vmapi URL, no need to fallback to config.sh
        callback(null, config);
        return;
    }

    fs.readFile('/usr/triton/config/node.config', function _onRead(err, data) {
        if (err) {
            callback(err);
            return;
        }

        var match = String(data).match(/vmapi_domain='(.*?)'/);
        if (match) {
            config.vmapi_url = 'http://' + match[1];
        } else {
            logger.warn('CN node.config did not include vmapi_domain');
            config.vmapi_url = 'http://vmapi';
        }

        // pass (potentially modified) config to next function in waterfall
        callback(null, config);
        return;
    });
}

// Load this server's UUID from sysinfo and add to the config.
function loadSysinfo(config, callback) {
    var sysinfo;

    assert.object(config);
    assert.func(callback);

    // XXX: TODO: Use sysinfo JS module.
    execFile('/usr/triton/bin/sysinfo', [],
            function _sysinfoCb(err, stdout, stderr) {
        if (err) {
            logger.fatal('Could not load sysinfo: ' + stderr.toString());
            callback(err);
            return;
        }

        try {
            sysinfo = JSON.parse(stdout);
        } catch (e) {
            logger.fatal(e, 'Could not parse sysinfo: ' + e.message);
            callback(e);
            return;
        }

        if (!sysinfo.UUID) {
            logger.fatal('Could not find "UUID" in `sysinfo` output.');
            callback(new Error('No UUID in `sysinfo`'));
            return;
        }

        config.server_uuid = sysinfo.UUID;
        config.sysinfo = sysinfo;

        callback(null, config);
        return;
    });
}

/*
 * This waterfall should be ordered by config precedence. Each of the functions
 * will avoid clobbering keys, so the first value loaded by any of these
 * functions for a given key will be the value in the final config object.
 */
vasync.waterfall([
    function _createConfig(callback) {
        var config = {};

        assert.func(callback, 'callback');

        // This first function exists because the first function in the
        // waterfall is "special" in that it doesn't get a first arg. So all we
        // do here is create the config the other functions will add to.
        callback(null, config);
    },
    loadConfig,
    loadSdcConfig,
    loadSysinfo
], function _waterfallComplete(err, config) {
    var vmagent;

    assert.ifError(err, 'Failed to load configuration');
    assert.object(config, 'config');
    assert.uuid(config.server_uuid, 'config.server_uuid');
    assert.string(config.vmapi_url, 'config.vmapi_url');
    assert.optionalNumber(config.periodic_interval);
    assert.ok(!config.log, 'config.log must not be set');

    logger.info({config: config}, 'loaded vm-agent configuration');

    // Pass along our logger
    config.log = logger;

    // Start the agent with our fresh config
    vmagent = new VmAgent(config);
    vmagent.start();
});
