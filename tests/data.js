/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This file contains test data for other tests to use.
 */

var smartosPayloads = [
    {
        zonename: '6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c',
        autoboot: true,
        brand: 'joyent-minimal',
        limit_priv: 'default',
        v: 1,
        create_timestamp: '2015-11-27T05:01:25.838Z',
        image_uuid: 'cd2d08a0-83f1-11e5-8684-f383641a9854',
        cpu_shares: 128,
        max_lwps: 1000,
        max_msg_ids: 4096,
        max_sem_ids: 4096,
        max_shm_ids: 4096,
        max_shm_memory: 128,
        zfs_io_priority: 10,
        max_physical_memory: 128,
        max_locked_memory: 128,
        max_swap: 256,
        cpu_cap: 100,
        billing_id: '73a1ca34-1e30-48c7-8681-70314a9c67d3',
        owner_uuid: '930896af-bf8c-48d4-885c-6573a94b1853',
        package_name: 'sdc_128',
        package_version: '1.0.0',
        tmpfs: 128,
        dns_domain: 'local',
        archive_on_delete: true,
        maintain_resolvers: true,
        resolvers: [
            '10.192.0.11'
        ],
        alias: 'testvm',
        nics: [
            {
                interface: 'net0',
                mac: '92:88:1a:79:75:71',
                vlan_id: 0,
                nic_tag: 'admin',
                netmask: '255.192.0.0',
                ip: '10.192.0.8',
                ips: [
                    '10.192.0.8/10'
                ],
                primary: true
            }
        ],
        uuid: '6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c',
        zone_state: 'running',
        zonepath: '/zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c',
        zoneid: 9,
        last_modified: '2015-11-27T06:19:37.000Z',
        firewall_enabled: false,
        server_uuid: '564dfd57-1dd4-6fc0-d973-4f137ee12afe',
        datacenter_name: 'coal',
        platform_buildstamp: '20151126T011339Z',
        state: 'running',
        boot_timestamp: '2015-11-28T07:56:44.000Z',
        pid: 5200,
        customer_metadata: {},
        internal_metadata: {},
        routes: {},
        tags: {},
        quota: 25,
        zfs_root_recsize: 131072,
        zfs_filesystem: 'zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c',
        zpool: 'zones',
        snapshots: []
    }
];

/*
 * This is the minimum VM you can see from VMAPI. For a VM that looks like:
 *
 *  {
 *      "uuid": "f23dab00-980e-11e5-887b-c9e599b7177b"
 *  }
 *
 * in Moray.
 */
var minimalVmapiVm = {
    uuid: 'f23dab00-980e-11e5-887b-c9e599b7177b',
    alias: null,
    autoboot: null,
    brand: null,
    billing_id: null,
    cpu_cap: null,
    cpu_shares: null,
    create_timestamp: null,
    customer_metadata: {},
    datasets: [],
    destroyed: null,
    firewall_enabled: false,
    internal_metadata: {},
    last_modified: null,
    limit_priv: null,
    max_locked_memory: null,
    max_lwps: null,
    max_physical_memory: null,
    max_swap: null,
    nics: [],
    owner_uuid: null,
    platform_buildstamp: null,
    quota: null,
    ram: null,
    resolvers: null,
    server_uuid: null,
    snapshots: [],
    state: null,
    tags: {},
    zfs_filesystem: null,
    zfs_io_priority: null,
    zone_state: null,
    zonepath: null,
    zpool: null,
    image_uuid: null
};

module.exports = {
    minimalVmapiVm: minimalVmapiVm,
    smartosPayloads: smartosPayloads
};
