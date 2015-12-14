/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Common functions used by tests.
 */

var execFile = require('child_process').execFile;


function testFindSmartosImage(t, callback) {
    var args = ['list', '-H', '-j', '-o', 'uuid,tags', 'os=smartos'];
    var idx;
    var img;
    var imgs = {};
    var latest;
    var smartosImageUUID;

    execFile('/usr/sbin/imgadm', args, function _onImgadm(err, stdout) {
        t.ifError(err, 'load images from imgadm');
        if (err) {
            callback(smartosImageUUID);
            return;
        }

        imgs = JSON.parse(stdout);
        for (idx = 0; idx < imgs.length; idx++) {
            img = imgs[idx];
            if (img.manifest.tags.smartdc
                && (!latest || img.manifest.published_at > latest)) {
                // found a newer SmartOS img!
                smartosImageUUID = img.manifest.uuid;
                latest = img.manifest.published_at;
            }
        }

        t.ok(smartosImageUUID, 'found SmartOS image_uuid: ' + smartosImageUUID);
        callback(smartosImageUUID);
    });
}

module.exports = {
    testFindSmartosImage: testFindSmartosImage
};
