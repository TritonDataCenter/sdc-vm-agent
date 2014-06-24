/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * vmapi-client.js
 */

var async = require('async');
var restify = require('restify');


function VmapiClient(options) {
    this.options = options;
    this.log = options.log;

    this.client = restify.createJsonClient({
        url: options.url,
        log: options.log,
        userAgent: options.userAgent
    });
}


/*
 * Updates all VMs for a server on VMAPI
 *
 */
VmapiClient.prototype.updateServerVms = function (server, vms, callback) {
    var log = this.log;
    var query = { server_uuid: server };
    var opts = { path: '/vms', query: query };

    this.client.put(opts, { vms: vms }, function (err, req, res) {
        if (err) {
            log.error(err, 'Could not update VMs for server');
            return callback(err);
        }

        log.info('VMs updated for server');
        return callback();
    });
};


/*
 * Updates a VM on VMAPI
 *
 */
VmapiClient.prototype.updateVm = function (vm, callback) {
    var log = this.log;
    var opts = { path: '/vms/' + vm.uuid };

    this.client.put(opts, vm, function (err, req, res) {
        if (err) {
            log.error(err, 'Could not update VM %s', vm.uuid);
            return callback(err);
        }

        log.info('VM (uuid=%s, state=%s, last_modified=%s) updated',
            vm.uuid, vm.state, vm.last_modified);
        return callback();
    });
};


module.exports = VmapiClient;
