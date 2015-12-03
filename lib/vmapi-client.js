/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * vmapi-client.js
 */

var restify = require('restify-clients');


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
VmapiClient.prototype.updateServerVms = // eslint-disable-line
function updateServerVms(server, vms, callback) {
    var log = this.log;
    var query = {server_uuid: server};
    var opts = {path: '/vms', query: query};

    this.client.put(opts, {vms: vms}, function _putVmsCb(err /* , req, res */) {
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
VmapiClient.prototype.updateVm = function updateVm(vm, callback) {
    var log = this.log;
    var opts = {path: '/vms/' + vm.uuid};

    this.client.put(opts, vm, function _putVmCb(err /* , req, res */) {
        if (err) {
            log.error(err, 'Could not update VM %s', vm.uuid);
            return callback(err);
        }

        log.info('VM (uuid=%s, state=%s, last_modified=%s) updated',
            vm.uuid, vm.state, vm.last_modified);
        return callback();
    });
};


/*
 * Get this server's list of VMs.
 *
 */
VmapiClient.prototype.getVms = function getVms(server, callback) {
    var query = {server_uuid: server, state: 'active'};
    var opts = {path: '/vms', query: query};

    this.client.get(opts, function _getCb(err, req, res, vmobjs) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, vmobjs);
    });
};


module.exports = VmapiClient;
