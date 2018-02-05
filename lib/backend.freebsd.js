/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This provides the system-specific configuration functions for FreeBSD
 * platforms.
 */

var fs = require('fs');

var assert = require('assert-plus');
var vasync = require('vasync');


function FreebsdBackend(opts) {
    var self = this;

    self.log = opts.log;
    self.name = opts.backendName;
}

FreebsdBackend.prototype.loadConfig = function loadConfig(callback) {
    var newConfig = {
        cueballHttpAgent: {
            initialDomains: [],
            maximum: 100,
            recovery: {
                default: {
                    delay: 250,
                    maxDelay: 1000,
                    maxTimeout: 8000,
                    retries: 5,
                    timeout: 2000
                }
            },
            resolvers: [],
            spares: 4
        },
        no_rabbit: true
    };

    assert.func(callback);

    vasync.pipeline({funcs: [
        function _loadConfigJson(_, cb) {
            fs.readFile('/opt/smartdc/etc/config.json',
                function _onRead(err, data) {
                    var config;

                    assert.ifError(err, 'should be able to load config.json');

                    // This will throw if JSON is bad
                    config = JSON.parse(data);

                    assert.object(config, 'config');
                    assert.optionalString(config.datacenter_name,
                        'config.datacenter_name');
                    assert.optionalString(config.dns_domain,
                        'config.dns_domain');

                    newConfig.cueballHttpAgent.initialDomains.push('vmapi.'
                        + config.datacenter_name + '.' + config.dns_domain);
                    newConfig.cueballHttpAgent.resolvers.push('binder.'
                        + config.datacenter_name + '.' + config.dns_domain);
                    newConfig.vmapi_url = 'http://vmapi.'
                        + config.datacenter_name + '.' + config.dns_domain;

                    cb();
                }
            );
        }, function _loadSysinfoJson(_, cb) {
            // We assume someone created this already, the alternative is
            // sharing the sysinfo code from cn-agent's freebsd backend which we
            // should do once that's more stabilized.
            fs.readFile('/tmp/.sysinfo.json',
                function _onRead(err, data) {
                    var sysinfo;

                    assert.ifError(err, 'should be able to load sysinfo.json');

                    // This will throw if JSON is bad
                    sysinfo = JSON.parse(data);

                    assert.object(sysinfo, 'sysinfo');
                    assert.uuid(sysinfo.UUID, 'sysinfo.UUID');

                    newConfig.server_uuid = sysinfo.UUID;

                    cb();
                }
            );
        }
    ]}, function _afterPipeline(err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, newConfig);
    });
};

module.exports = FreebsdBackend;
