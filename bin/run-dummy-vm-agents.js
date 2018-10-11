/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */
/* eslint no-console: 0 */  // --> OFF
'use strict';

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const assert = require('assert-plus');
const bunyan = require('bunyan');
const DummyVmadm = require('vmadm/lib/index.dummy_vminfod');
const vasync = require('vasync');

const VmAgent = require('../lib');


function mdataGetSync(key) {
    assert.string(key);

    return child_process
        .execSync(`/usr/sbin/mdata-get ${key}`, {encoding: 'utf8'})
        .trim();
}


function mockCloudRoot() {
    try {
        return mdataGetSync('mockcloudRoot');
    } catch (err) {
        // The old default for backward compatibility.
        const oldDefault = '/opt/custom/virtual';

        console.warn('warning: dummy backend could not get '
                     + '"mockcloudRoot" dir from mdata, using default %s: %s',
                     oldDefault, err);
        return oldDefault;
    }
}
const SERVER_ROOT = path.join(mockCloudRoot(), 'servers');


function runAgent(opts, cb) {
    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.string(opts.sdcDcName, 'opts.sdcDcName');
    assert.string(opts.dnsDomain, 'opts.dnsDomain');

    const log = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'debug'),
        name: 'vm-agent-' + opts.serverUuid
    });

    // these values are based on a sample from a running coal instance
    const config = {
        cueballHttpAgent: {
            initialDomains: [
                `vmapi.${opts.sdcDcName}.${opts.dnsDomain}`
            ],
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
            resolvers: [`binder.${opts.sdcDcName}.${opts.dnsDomain}`],
            spares: 4
        },

        vmapi_url: `http://vmapi.${opts.sdcDcName}.${opts.dnsDomain}`,
        no_rabbit: true,
        server_uuid: opts.serverUuid
    };

    console.log(`config skeletop for agent ${opts.serverUuid}`,
               util.inspect(config, {depth: null}));

    config.vmadm = new DummyVmadm({serverUuid: opts.serverUuid,
                                   serverRoot: SERVER_ROOT, log: log});
    config.log = log;

    const vmagent = new VmAgent(config);

    vmagent.start(cb);
}


function main() {
    const dirs = fs.readdirSync(SERVER_ROOT);

    console.log('server uuids:', dirs);

    const sdcDcName = mdataGetSync('sdc:datacenter_name');
    const dnsDomain = mdataGetSync('dnsDomain');

    console.log(`sdc:datacenter_name=${sdcDcName} dnsDomain=${dnsDomain}`);

    vasync.forEachPipeline({
        func: runAgent,
        inputs: dirs.map(function m(dir) {
            return {serverUuid: dir, sdcDcName: sdcDcName,
                    dnsDomain: dnsDomain};
        })
    }, function _pipelineComplete(_pipelineErr) {
        assert.ifError(_pipelineErr);
        console.log('started all servers');
    });
}


main();
