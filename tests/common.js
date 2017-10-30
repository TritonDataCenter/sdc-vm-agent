/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Common functions used by tests.
 */

var execFile = require('child_process').execFile;

var assert = require('assert-plus');

// GLOBAL
var BUFFER_SIZE = 32 * 1024 * 1024; // eslint-disable-line

// How frequently to poll the 'events' array when we're waiting for an event
// in waitEvent.
var EVENTS_POLL_FREQ = 100; // ms

function testFindSmartosImage(t, callback) {
    var args = ['list', '-H', '-j', '-o', 'uuid,tags', 'os=smartos'];
    var idx;
    var img;
    var imgs = {};
    var latest;
    var opts = {maxBuffer: BUFFER_SIZE};
    var smartosImageUUID;

    execFile('/usr/sbin/imgadm', args, opts, function _onImgadm(err, stdout) {
        t.ifError(err, 'load images from imgadm');
        if (err) {
            callback(err, smartosImageUUID);
            return;
        }

        try {
            imgs = JSON.parse(stdout);
        } catch (e) {
            callback(e);
            return;
        }

        for (idx = 0; idx < imgs.length; idx++) {
            img = imgs[idx];
            if (img && img.manifest && img.manifest.tags
                && img.manifest.tags.smartdc
                && (!latest || img.manifest.published_at > latest)) {
                // found a newer SmartOS img!
                smartosImageUUID = img.manifest.uuid;
                latest = img.manifest.published_at;
            }
        }

        t.ok(smartosImageUUID, 'found SmartOS image_uuid: ' + smartosImageUUID);
        callback(null, smartosImageUUID);
    });
}

function waitEvent(t, evtWant, vmUuid, events, eventIdx) {
    var loops = 0;

    assert(t, 't');
    assert.string(evtWant, 'evtWant');
    assert.uuid(vmUuid, 'vmUuid');
    assert.arrayOfObject(events, 'events');
    assert.number(eventIdx, 'eventIdx');

    function _waitEvent() {
        var found = events.slice(eventIdx).some(function _findEvent(ev) {
            return (ev.vmUuid === vmUuid && ev.event === evtWant);
        });

        if (found) {
            t.ok(true, 'Watcher saw expected ' + evtWant
                + ' (' + (loops * EVENTS_POLL_FREQ) + ' ms)');
            t.end();
            return;
        }

        loops++;
        setTimeout(_waitEvent, EVENTS_POLL_FREQ);
    }

    _waitEvent();
}

module.exports = {
    testFindSmartosImage: testFindSmartosImage,
    waitEvent: waitEvent
};
