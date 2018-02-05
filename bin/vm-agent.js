/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Loads the config and creates a VmAgent instance. See lib/vm-agent.js for more
 * detailed information on operation.
 *
 */

var bunyan = require('bunyan');

var VmAgent = require('../lib');


// GLOBALS
var logger = bunyan.createLogger({
    name: 'vm-agent',
    level: (process.env.LOG_LEVEL || 'debug')
});


// Start the agent with our fresh config
var vmagent = new VmAgent({
    // allow overriding the backend via environment (for testing)
    backendName: process.env.VM_AGENT_BACKEND,
    log: logger
});

vmagent.start();
